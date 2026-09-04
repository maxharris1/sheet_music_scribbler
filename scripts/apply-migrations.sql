-- Combined migrations for the Supabase SQL editor (generated from supabase/migrations/*.sql)
-- Paste and run this whole file once in: Dashboard → SQL Editor → New query

-- ===== supabase/migrations/20260801160752_schema.sql =====
-- Cleffy — core schema.
-- The PDF is immutable; annotations are vector rows keyed to
-- (document, page, normalized coords). Soft deletes only (tombstones) so
-- offline clients converge; `seq` is the server-authoritative sync watermark.

create table public.documents (
    id uuid primary key, -- client-generated (storage path is derived from it pre-insert)
    owner_id uuid not null references auth.users (id) on delete cascade,
    title text not null,
    storage_path text not null, -- object path within the 'scores' bucket: '{id}/original.pdf'
    page_count int,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.document_members (
    document_id uuid not null references public.documents (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    role text not null check (role in ('owner', 'editor', 'viewer')),
    created_at timestamptz not null default now(),
    primary key (document_id, user_id)
);

create index document_members_user on public.document_members (user_id);

create table public.share_links (
    -- 22-char base64url token, generated server-side.
    token text primary key default rtrim(
        replace(replace(encode(extensions.gen_random_bytes(16), 'base64'), '+', '-'), '/', '_'),
        '='
    ),
    document_id uuid not null references public.documents (id) on delete cascade,
    role text not null check (role in ('editor', 'viewer')),
    created_by uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked_at timestamptz
);

create index share_links_document on public.share_links (document_id);

-- Monotonic ordering authority for annotation writes (LWW merge + pull watermark).
create sequence public.annotations_seq;

create table public.annotations (
    id uuid primary key, -- client-generated
    document_id uuid not null references public.documents (id) on delete cascade,
    page int not null check (page >= 0),
    kind text not null check (kind in ('stroke', 'highlight', 'text')),
    color text not null,
    payload jsonb not null,
    created_by uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), -- server-set via trigger
    deleted_at timestamptz, -- tombstone; rows are never hard-deleted
    seq bigint not null default 0 -- server-set via trigger
);

create index annotations_doc_seq on public.annotations (document_id, seq);

create index annotations_doc_page on public.annotations (document_id, page) where deleted_at is null;

-- Server stamps ordering on every write: deterministic LWW immune to client clocks.
-- SECURITY DEFINER so nextval() needs no per-role sequence grants.
create or replace function public.annotations_stamp () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    new.updated_at := now();
    new.seq := nextval('public.annotations_seq');
    return new;
end;
$$;

create trigger annotations_stamp before insert or update on public.annotations
for each row execute function public.annotations_stamp ();

-- Owner membership materializes automatically. SECURITY DEFINER: the inserting
-- user has no direct write policy on document_members (all membership writes go
-- through definer paths), so without it every document creation would fail.
create or replace function public.documents_owner_membership () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    insert into public.document_members (document_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict (document_id, user_id) do update set role = 'owner';
    return new;
end;
$$;

create trigger documents_owner_membership after insert on public.documents
for each row execute function public.documents_owner_membership ();

create or replace function public.touch_updated_at () returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger documents_touch before update on public.documents
for each row execute function public.touch_updated_at ();

-- ===== supabase/migrations/20260801160754_rls.sql =====
-- Row Level Security: owner / editor / viewer via document_members.
-- Design notes (plan §RLS):
--  * document_role() is SECURITY DEFINER so policies never recurse into
--    document_members' own RLS.
--  * Editors may edit/erase ANYONE's annotations (the product requirement) —
--    but inserts must be attributed to the author (created_by = auth.uid()).
--  * No DELETE policy on annotations at all: deletes are tombstone updates.
--  * Anonymous users are role `authenticated` with an is_anonymous JWT claim;
--    they may join/annotate via share links but never create documents.

alter table public.documents enable row level security;

alter table public.document_members enable row level security;

alter table public.share_links enable row level security;

alter table public.annotations enable row level security;

create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select role from public.document_members
    where document_id = doc and user_id = auth.uid();
$$;

grant execute on function public.document_role (uuid) to authenticated;

-- documents ---------------------------------------------------------------
-- Owner is visible WITHOUT the membership join: during INSERT … RETURNING
-- (PostgREST return=representation) the AFTER-trigger membership row does not
-- exist yet, so a membership-only SELECT policy rejects the returned row.
create policy documents_select on public.documents for select to authenticated
using (
    owner_id = auth.uid()
    or public.document_role (id) is not null
);

create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

create policy documents_update on public.documents for update to authenticated
using (public.document_role (id) = 'owner')
with check (owner_id = auth.uid());

create policy documents_delete on public.documents for delete to authenticated
using (public.document_role (id) = 'owner');

-- document_members ----------------------------------------------------------
-- Members can see who else is on a document. NO direct write policies:
-- membership writes happen only via SECURITY DEFINER paths (owner trigger,
-- redeem_share_link).
create policy members_select on public.document_members for select to authenticated
using (public.document_role (document_id) is not null);

-- share_links ---------------------------------------------------------------
create policy share_links_select on public.share_links for select to authenticated
using (public.document_role (document_id) = 'owner');

create policy share_links_insert on public.share_links for insert to authenticated
with check (
    public.document_role (document_id) = 'owner'
    and created_by = auth.uid()
);

create policy share_links_update on public.share_links for update to authenticated
using (public.document_role (document_id) = 'owner');

create policy share_links_delete on public.share_links for delete to authenticated
using (public.document_role (document_id) = 'owner');

-- annotations ---------------------------------------------------------------
create policy annotations_select on public.annotations for select to authenticated
using (public.document_role (document_id) is not null);

create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = auth.uid()
);

create policy annotations_update on public.annotations for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (public.document_role (document_id) in ('owner', 'editor'));

-- Share-link redemption -----------------------------------------------------
-- Never reads share_links under the caller's RLS; upserts membership without
-- ever downgrading an existing owner/editor role.
create or replace function public.redeem_share_link (p_token text) returns table (document_id uuid, granted_role text) language plpgsql security definer
set search_path = public as $$
-- OUT params (document_id) collide with column names inside the body (e.g.
-- the ON CONFLICT target) — let columns win; the OUTs are only set positionally.
#variable_conflict use_column
declare
    link record;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select sl.document_id, sl.role into link
    from public.share_links sl
    where sl.token = p_token
      and sl.revoked_at is null
      and (sl.expires_at is null or sl.expires_at > now());

    if not found then
        raise exception 'invalid or expired share link' using errcode = 'P0002';
    end if;

    insert into public.document_members (document_id, user_id, role)
    values (link.document_id, auth.uid(), link.role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' then 'editor'
            else excluded.role
        end;

    return query
        select link.document_id,
               (select dm.role from public.document_members dm
                where dm.document_id = link.document_id and dm.user_id = auth.uid());
end;
$$;

grant execute on function public.redeem_share_link (text) to authenticated;

-- storage: private 'scores' bucket; object path is '{documentId}/original.pdf'
-- (bucket itself is created via dashboard/API — hosted storage.buckets writes
-- from migrations can hit ownership errors post-lockdown).
create policy scores_read on storage.objects for select to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) is not null
);

create policy scores_insert on storage.objects for insert to authenticated
with check (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

create policy scores_update on storage.objects for update to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

create policy scores_delete on storage.objects for delete to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

-- ===== supabase/migrations/20260801162310_realtime.sql =====
-- Realtime: one private channel per document, topic 'doc:{documentId}'.
--  * Committed annotations fan out via broadcast-from-database (exactly-one
--    fan-out that also fires for offline flushes; no postgres_changes
--    per-subscriber overhead). Gap-fill on (re)connect is the watermark pull.
--  * Live in-progress ink + presence are client events on the same channel.
--  * realtime.messages policies mirror document membership; send is split by
--    extension so viewers appear in presence but can never broadcast ink.

-- Safe topic → role resolution ('doc:{uuid}' only; never throws on foreign topics).
create or replace function public.topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc:%' then
        return null;
    end if;
    begin
        doc := split_part(topic, ':', 2)::uuid;
    exception when invalid_text_representation then
        return null;
    end;
    return public.document_role(doc);
end;
$$;

grant execute on function public.topic_document_role (text) to authenticated;

-- Broadcast every committed annotation write to the document's channel.
-- SECURITY DEFINER: the writing user has no direct insert grant on
-- realtime.messages — the documented broadcast_changes trigger pattern.
create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc:' || new.document_id::text, -- topic
        tg_op,                           -- event name ('INSERT' | 'UPDATE')
        tg_op,                           -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    return null;
end;
$$;

create trigger annotations_broadcast after insert or update on public.annotations
for each row execute function public.broadcast_annotation_changes ();

-- Receive: any member of the document, both broadcast and presence.
create policy doc_topic_receive on realtime.messages for select to authenticated
using (public.topic_document_role (realtime.topic ()) is not null);

-- Send presence: any member (viewers must appear in the presence bar).
create policy doc_topic_send_presence on realtime.messages for insert to authenticated
with check (
    realtime.messages.extension = 'presence'
    and public.topic_document_role (realtime.topic ()) is not null
);

-- Send broadcast (live ink): editors and owners only.
create policy doc_topic_send_broadcast on realtime.messages for insert to authenticated
with check (
    realtime.messages.extension = 'broadcast'
    and public.topic_document_role (realtime.topic ()) in ('owner', 'editor')
);

-- ===== supabase/migrations/20260802032051_annotation_snapshots.sql =====
-- Daily annotation starting-point snapshots (lesson history).
-- One row per (document, local calendar day). Payload is the full live
-- annotation set captured before the first edit of that day.

create table public.annotation_snapshots (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    captured_on date not null,
    label text,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    created_by uuid references auth.users (id) on delete set null,
    unique (document_id, captured_on)
);

create index annotation_snapshots_doc_day on public.annotation_snapshots (document_id, captured_on desc);

alter table public.annotation_snapshots enable row level security;

create policy annotation_snapshots_select on public.annotation_snapshots for select to authenticated
using (public.document_role (document_id) is not null);

create policy annotation_snapshots_insert on public.annotation_snapshots for insert to authenticated
with check (public.document_role (document_id) in ('owner', 'editor'));

-- Snapshots are immutable starting points — no update/delete policies.

-- ===== supabase/migrations/20260802044133_free_plan_efficiency.sql =====
-- Free-plan efficiency: shared Edge rate limits, RLS initplan, FK indexes,
-- and optional tombstone compaction.

-- ---------------------------------------------------------------------------
-- Shared rate-limit buckets (Edge Functions call via service role / RPC)
-- ---------------------------------------------------------------------------
create table public.edge_rate_buckets (
    key text primary key,
    count int not null,
    reset_at timestamptz not null
);

create or replace function public.check_edge_rate_limit (
    p_key text,
    p_limit int,
    p_window_ms int
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    now_ts timestamptz := clock_timestamp();
    bucket public.edge_rate_buckets%rowtype;
    retry_sec int;
begin
    if p_limit < 1 or p_window_ms < 1 then
        return jsonb_build_object('ok', false, 'retryAfterSec', 1);
    end if;

    select * into bucket from public.edge_rate_buckets where key = p_key for update;
    if not found or bucket.reset_at <= now_ts then
        insert into public.edge_rate_buckets (key, count, reset_at)
        values (p_key, 1, now_ts + make_interval(secs => p_window_ms / 1000.0))
        on conflict (key) do update
            set count = 1,
                reset_at = excluded.reset_at;
        return jsonb_build_object('ok', true);
    end if;

    if bucket.count >= p_limit then
        retry_sec := greatest(1, ceil(extract(epoch from (bucket.reset_at - now_ts))));
        return jsonb_build_object('ok', false, 'retryAfterSec', retry_sec);
    end if;

    update public.edge_rate_buckets set count = count + 1 where key = p_key;
    return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.check_edge_rate_limit (text, int, int) from public;
grant execute on function public.check_edge_rate_limit (text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Batch annotation inserts (security invoker → RLS still applies)
-- ---------------------------------------------------------------------------
create or replace function public.insert_annotations_batch (p_rows jsonb) returns void language plpgsql security invoker
set search_path = public as $$
begin
    if jsonb_typeof(p_rows) is distinct from 'array' then
        raise exception 'p_rows must be a JSON array';
    end if;

    insert into public.annotations (
        id,
        document_id,
        page,
        kind,
        color,
        payload,
        created_by,
        created_at,
        deleted_at
    )
    select
        (elem ->> 'id')::uuid,
        (elem ->> 'document_id')::uuid,
        (elem ->> 'page')::int,
        elem ->> 'kind',
        elem ->> 'color',
        elem -> 'payload',
        (elem ->> 'created_by')::uuid,
        coalesce((elem ->> 'created_at')::timestamptz, now()),
        (elem ->> 'deleted_at')::timestamptz
    from jsonb_array_elements(p_rows) as elem
    on conflict (id) do nothing;
end;
$$;

revoke all on function public.insert_annotations_batch (jsonb) from public;
grant execute on function public.insert_annotations_batch (jsonb) to authenticated;

create or replace function public.patch_annotations_batch (p_patches jsonb) returns void language plpgsql security invoker
set search_path = public as $$
declare
    elem jsonb;
begin
    if jsonb_typeof(p_patches) is distinct from 'array' then
        raise exception 'p_patches must be a JSON array';
    end if;

    for elem in select value from jsonb_array_elements(p_patches)
    loop
        update public.annotations
        set
            color = coalesce(elem ->> 'color', color),
            payload = case when elem ? 'payload' then elem -> 'payload' else payload end,
            deleted_at = case
                when elem ? 'deleted_at' then (elem ->> 'deleted_at')::timestamptz
                else deleted_at
            end
        where id = (elem ->> 'id')::uuid
          and document_id = (elem ->> 'document_id')::uuid;
    end loop;
end;
$$;

revoke all on function public.patch_annotations_batch (jsonb) from public;
grant execute on function public.patch_annotations_batch (jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Tombstone compaction (call periodically or from a future cron)
-- ---------------------------------------------------------------------------
create or replace function public.compact_annotation_tombstones (p_older_than interval default interval '90 days')
returns int language plpgsql security definer
set search_path = public as $$
declare
    deleted_count int;
begin
    delete from public.annotations
    where deleted_at is not null
      and deleted_at < now() - p_older_than;
    get diagnostics deleted_count = row_count;
    return deleted_count;
end;
$$;

revoke all on function public.compact_annotation_tombstones (interval) from public;
grant execute on function public.compact_annotation_tombstones (interval) to service_role;

-- ---------------------------------------------------------------------------
-- RLS initplan: evaluate auth.* once per query
-- ---------------------------------------------------------------------------
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
using (
    owner_id = (select auth.uid())
    or public.document_role (id) is not null
);

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
using (public.document_role (id) = 'owner')
with check (owner_id = (select auth.uid()));

drop policy if exists share_links_insert on public.share_links;
create policy share_links_insert on public.share_links for insert to authenticated
with check (
    public.document_role (document_id) = 'owner'
    and created_by = (select auth.uid())
);

drop policy if exists annotations_insert on public.annotations;
create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
);

-- ---------------------------------------------------------------------------
-- Missing FK indexes (performance advisors)
-- ---------------------------------------------------------------------------
create index if not exists annotations_created_by_idx on public.annotations (created_by);
create index if not exists documents_owner_id_idx on public.documents (owner_id);
create index if not exists share_links_created_by_idx on public.share_links (created_by);
create index if not exists annotation_snapshots_created_by_idx on public.annotation_snapshots (created_by);

-- ===== supabase/migrations/20260802045146_batch_rpc_revoke_public.sql =====
-- Harden batch annotation RPCs: revoke PUBLIC (and anon) before authenticated grant.
-- Matches check_edge_rate_limit / compact_annotation_tombstones pattern.

revoke all on function public.insert_annotations_batch (jsonb) from public;
revoke all on function public.insert_annotations_batch (jsonb) from anon;
grant execute on function public.insert_annotations_batch (jsonb) to authenticated;

revoke all on function public.patch_annotations_batch (jsonb) from public;
revoke all on function public.patch_annotations_batch (jsonb) from anon;
grant execute on function public.patch_annotations_batch (jsonb) to authenticated;

-- ===== supabase/migrations/20260802110000_document_favorites.sql =====
-- Per-user favorites. A flag on documents would be shared state (a student's
-- star would flip the owner's), so favorites are their own RLS-scoped table.
create table public.document_favorites (
    document_id uuid not null references public.documents (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (document_id, user_id)
);

create index document_favorites_user on public.document_favorites (user_id);

alter table public.document_favorites enable row level security;

create policy favorites_select on public.document_favorites for select to authenticated
using (user_id = auth.uid());

create policy favorites_insert on public.document_favorites for insert to authenticated
with check (
    user_id = auth.uid()
    and public.document_role (document_id) is not null
);

create policy favorites_delete on public.document_favorites for delete to authenticated
using (user_id = auth.uid());

-- ===== supabase/migrations/20260802172249_edge_rate_rls_and_revoke_execute.sql =====
-- Log-hardening: RLS on edge_rate_buckets + revoke EXECUTE on trigger-only /
-- service-only defs; harden client RPCs like batch_rpc_revoke_public.

-- ---------------------------------------------------------------------------
-- edge_rate_buckets: service-role / SECURITY DEFINER only (no client access)
-- ---------------------------------------------------------------------------
alter table public.edge_rate_buckets enable row level security;

revoke all on table public.edge_rate_buckets from public;
revoke all on table public.edge_rate_buckets from anon;
revoke all on table public.edge_rate_buckets from authenticated;

-- ---------------------------------------------------------------------------
-- Trigger-only functions: must not be callable via /rest/v1/rpc
-- ---------------------------------------------------------------------------
revoke all on function public.annotations_stamp () from public;
revoke all on function public.annotations_stamp () from anon;
revoke all on function public.annotations_stamp () from authenticated;

revoke all on function public.documents_owner_membership () from public;
revoke all on function public.documents_owner_membership () from anon;
revoke all on function public.documents_owner_membership () from authenticated;

revoke all on function public.broadcast_annotation_changes () from public;
revoke all on function public.broadcast_annotation_changes () from anon;
revoke all on function public.broadcast_annotation_changes () from authenticated;

-- ---------------------------------------------------------------------------
-- Service-only RPCs: belt-and-suspenders revoke from client roles
-- ---------------------------------------------------------------------------
revoke all on function public.check_edge_rate_limit (text, int, int) from anon;
revoke all on function public.check_edge_rate_limit (text, int, int) from authenticated;

revoke all on function public.compact_annotation_tombstones (interval) from anon;
revoke all on function public.compact_annotation_tombstones (interval) from authenticated;

-- ---------------------------------------------------------------------------
-- Client RPCs: revoke PUBLIC/anon, keep authenticated (incl. anonymous users)
-- ---------------------------------------------------------------------------
revoke all on function public.document_role (uuid) from public;
revoke all on function public.document_role (uuid) from anon;
grant execute on function public.document_role (uuid) to authenticated;

revoke all on function public.topic_document_role (text) from public;
revoke all on function public.topic_document_role (text) from anon;
grant execute on function public.topic_document_role (text) to authenticated;

revoke all on function public.redeem_share_link (text) from public;
revoke all on function public.redeem_share_link (text) from anon;
grant execute on function public.redeem_share_link (text) to authenticated;

-- ===== supabase/migrations/20260802180000_smart_import.sql =====
-- Smart import: adopt pre-existing handwritten annotations as native marks.
--
-- content_rev: documents' PDF bytes were immutable until now. The import
-- flow can replace the stored file with a cleaned copy; content_rev lets
-- clients detect a stale Dexie pdfCache (cache stores the rev it holds).
alter table public.documents
add column content_rev int not null default 0;

-- One row per document tracking the import offer/decision, so a declined
-- prompt never nags again across devices, and the backup object is findable.
create table public.document_imports (
    document_id uuid primary key references public.documents (id) on delete cascade,
    status text not null check (status in ('prompted', 'declined', 'imported')),
    backup_path text, -- '{id}/pre-import-original.pdf' once a clean+replace ran
    pages_cleaned int[] not null default '{}',
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Fan the replacement out to open viewers on the existing per-doc topic
-- (same mechanism as annotations_broadcast). Gated on content_rev so
-- renames/page-count patches don't generate realtime traffic.
create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc:' || new.id::text, -- topic
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    return null;
end;
$$;

create trigger documents_broadcast
after update on public.documents for each row
when (old.content_rev is distinct from new.content_rev)
execute function public.broadcast_document_changes ();

alter table public.document_imports enable row level security;

create policy document_imports_select on public.document_imports for select to authenticated
using (public.document_role (document_id) is not null);

create policy document_imports_insert on public.document_imports for insert to authenticated
with check (public.document_role (document_id) = 'owner');

create policy document_imports_update on public.document_imports for update to authenticated
using (public.document_role (document_id) = 'owner')
with check (public.document_role (document_id) = 'owner');

-- ===== supabase/migrations/20260802182000_library_tags.sql =====
-- Per-user library tags (labels). Personal organization — not shared across
-- document collaborators, same rationale as document_favorites.

create table public.library_tags (
    id uuid primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    constraint library_tags_name_nonempty check (length(trim(name)) > 0)
);

create unique index library_tags_user_name_lower on public.library_tags (user_id, lower(name));
create index library_tags_user on public.library_tags (user_id);

create table public.document_tags (
    document_id uuid not null references public.documents (id) on delete cascade,
    tag_id uuid not null references public.library_tags (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (document_id, tag_id)
);

create index document_tags_tag on public.document_tags (tag_id);

alter table public.library_tags enable row level security;
alter table public.document_tags enable row level security;

create policy library_tags_select on public.library_tags for select to authenticated
using (user_id = (select auth.uid()));

create policy library_tags_insert on public.library_tags for insert to authenticated
with check (user_id = (select auth.uid()));

create policy library_tags_update on public.library_tags for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy library_tags_delete on public.library_tags for delete to authenticated
using (user_id = (select auth.uid()));

create policy document_tags_select on public.document_tags for select to authenticated
using (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
);

create policy document_tags_insert on public.document_tags for insert to authenticated
with check (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
    and public.document_role (document_id) is not null
);

create policy document_tags_delete on public.document_tags for delete to authenticated
using (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
);

-- ===== supabase/migrations/20260803000000_score_analyses.sql =====
-- Play-along score analyses: one row per document holding the OMR-derived
-- ScoreData (note events split by hand + measure/system geometry in
-- normalized page coordinates) and its processing lifecycle. The row is
-- created 'pending' by the score-analyze Edge Function on behalf of the
-- caller; the OMR service (service role, bypasses RLS) heartbeats
-- 'processing' progress and writes the terminal 'ready'/'failed' state.

create table public.score_analyses (
    document_id uuid primary key references public.documents (id) on delete cascade,
    status text not null check (status in ('pending', 'processing', 'ready', 'failed')),
    error text, -- machine code, e.g. 'omr_timeout', 'no_staves_found' (see services/omr-service/src/errors.ts)
    progress int, -- pages processed so far (service heartbeat; also refreshes updated_at for staleness checks)
    engine_version text,
    bpm_default int,
    score jsonb, -- ScoreData v1 (src/types/scoreData.ts); null until ready
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger score_analyses_touch before update on public.score_analyses
for each row execute function public.touch_updated_at ();

alter table public.score_analyses enable row level security;

-- Any member may read (viewers can play along); only owner/editor may
-- request or retry an analysis. No delete policy — rows die with the
-- document via the FK cascade.
create policy score_analyses_select on public.score_analyses for select to authenticated
using (public.document_role (document_id) is not null);

create policy score_analyses_insert on public.score_analyses for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
);

create policy score_analyses_update on public.score_analyses for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (public.document_role (document_id) in ('owner', 'editor'));

-- New tables are no longer auto-exposed to the Data API on current projects
-- (see auto_expose_new_tables note in supabase/config.toml) — grant explicitly.
grant select, insert, update on public.score_analyses to authenticated;
grant all on public.score_analyses to service_role;

-- ===== supabase/migrations/20260803120000_score_analyses_write_guard.sql =====
-- Clients (owner/editor via user JWT, including score-analyze) may only
-- request/retry analyses. They must not forge status='ready' or write ScoreData.
-- The OMR service uses the service_role JWT and retains full write access.

create or replace function public.guard_score_analyses_client_write()
returns trigger
language plpgsql
as $$
begin
    -- Service role (OMR write-back) may write any lifecycle fields.
    if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.status not in ('pending', 'failed') then
            raise exception 'score_analyses: clients may only insert pending or failed';
        end if;
        if new.score is not null then
            raise exception 'score_analyses: clients may not write score';
        end if;
        if new.status = 'pending' then
            new.score := null;
            new.progress := null;
            new.engine_version := null;
            new.bpm_default := null;
        end if;
        return new;
    end if;

    -- UPDATE: request/retry only.
    if new.status not in ('pending', 'failed') then
        raise exception 'score_analyses: clients may only set pending or failed';
    end if;
    if new.score is not null then
        raise exception 'score_analyses: clients may not write score';
    end if;
    -- Preserve original requester attribution across retries.
    new.created_by := old.created_by;
    if new.status = 'pending' then
        new.score := null;
        new.progress := null;
        new.error := null;
        new.engine_version := null;
        new.bpm_default := null;
    end if;
    return new;
end;
$$;

drop trigger if exists score_analyses_client_write_guard on public.score_analyses;
create trigger score_analyses_client_write_guard
before insert or update on public.score_analyses
for each row
execute function public.guard_score_analyses_client_write();

-- ===== supabase/migrations/20260803130000_set_document_page_count.sql =====
-- Allow owners and editors to backfill a missing documents.page_count
-- (needed before score-analyze). Does not overwrite an existing positive count.

create or replace function public.set_document_page_count (doc uuid, pages int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if pages is null or pages < 1 then
        raise exception 'invalid page count';
    end if;
    if public.document_role (doc) is distinct from 'owner'
        and public.document_role (doc) is distinct from 'editor' then
        raise exception 'forbidden';
    end if;
    update public.documents
    set page_count = pages
    where id = doc
      and (page_count is null or page_count < 1);
end;
$$;

revoke all on function public.set_document_page_count (uuid, int) from public;
grant execute on function public.set_document_page_count (uuid, int) to authenticated;

-- ===== supabase/migrations/20260806110000_score_cache_timings.sql =====
-- Content-hash result cache + timings column on score_analyses.
-- ENGINE_VERSION key invalidates cache automatically on parser/engine bumps.

alter table public.score_analyses
add column if not exists timings jsonb;

create table public.score_cache (
    content_hash text not null,
    engine_version text not null,
    score jsonb not null,
    bpm_default int,
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    use_count int not null default 1,
    primary key (content_hash, engine_version)
);

alter table public.score_cache enable row level security;
-- Zero policies — service_role only.
grant all on public.score_cache to service_role;

create or replace function public.score_cache_get (p_hash text, p_engine_version text)
returns table (score jsonb, bpm_default int)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
    update public.score_cache sc
    set last_used_at = now(), use_count = sc.use_count + 1
    where sc.content_hash = p_hash
      and sc.engine_version = p_engine_version
    returning sc.score, sc.bpm_default;
end;
$$;

create or replace function public.score_cache_put (
    p_hash text,
    p_engine_version text,
    p_score jsonb,
    p_bpm_default int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.score_cache (content_hash, engine_version, score, bpm_default)
    values (p_hash, p_engine_version, p_score, p_bpm_default)
    on conflict (content_hash, engine_version) do update
    set
        score = excluded.score,
        bpm_default = excluded.bpm_default,
        last_used_at = now(),
        use_count = public.score_cache.use_count + 1;
end;
$$;

create or replace function public.score_cache_purge_stale (p_max_age_days int default 180)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    deleted int;
begin
    delete from public.score_cache
    where last_used_at < now() - make_interval(days => greatest(p_max_age_days, 1));
    get diagnostics deleted = row_count;
    return deleted;
end;
$$;

revoke all on function public.score_cache_get (text, text) from public, anon, authenticated;
revoke all on function public.score_cache_put (text, text, jsonb, int) from public, anon, authenticated;
revoke all on function public.score_cache_purge_stale (int) from public, anon, authenticated;
grant execute on function public.score_cache_get (text, text) to service_role;
grant execute on function public.score_cache_put (text, text, jsonb, int) to service_role;
grant execute on function public.score_cache_purge_stale (int) to service_role;

-- ===== supabase/migrations/20260806120000_omr_jobs.sql =====
-- Durable OMR job queue (service-role only). score_analyses stays the
-- client-facing status projection / result cache; workers claim rows here
-- with FOR UPDATE SKIP LOCKED and never put leases on score_analyses.

create table public.omr_jobs (
    id bigint generated always as identity primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    status text not null default 'queued'
        check (status in ('queued', 'running', 'succeeded', 'failed_permanent', 'dead')),
    priority smallint not null default 0,
    attempt int not null default 0,
    max_attempts int not null default 3,
    run_after timestamptz not null default now(),
    claimed_at timestamptz,
    worker_id text,
    lease_expires_at timestamptz,
    storage_path text not null,
    page_count int not null,
    last_error text,
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index omr_jobs_one_active_per_doc
    on public.omr_jobs (document_id)
    where status in ('queued', 'running');

create index omr_jobs_claim_idx
    on public.omr_jobs (priority desc, id)
    where status = 'queued';

create trigger omr_jobs_touch before update on public.omr_jobs
for each row execute function public.touch_updated_at ();

alter table public.omr_jobs enable row level security;
-- Zero policies for authenticated — service_role only.
grant all on public.omr_jobs to service_role;
grant usage, select on sequence public.omr_jobs_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Claim / heartbeat / complete / fail / reap
-- ---------------------------------------------------------------------------

create or replace function public.omr_claim_job (p_worker_id text, p_lease_seconds int default 300)
returns public.omr_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
    claimed public.omr_jobs;
begin
    if p_worker_id is null or length(trim(p_worker_id)) = 0 then
        raise exception 'omr_claim_job: worker_id required';
    end if;

    select *
    into claimed
    from public.omr_jobs
    where status = 'queued'
      and run_after <= now()
    order by priority desc, id
    for update skip locked
    limit 1;

    if claimed.id is null then
        return null;
    end if;

    update public.omr_jobs
    set
        status = 'running',
        attempt = claimed.attempt + 1,
        claimed_at = now(),
        worker_id = p_worker_id,
        lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
        last_error = null
    where id = claimed.id
    returning * into claimed;

    return claimed;
end;
$$;

create or replace function public.omr_heartbeat_job (
    p_job_id bigint,
    p_worker_id text,
    p_lease_seconds int default 300
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    updated int;
begin
    update public.omr_jobs
    set lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60))
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id;
    get diagnostics updated = row_count;
    return updated > 0;
end;
$$;

-- Atomic success: job succeeded + score_analyses ready in one transaction.
create or replace function public.omr_complete_job (
    p_job_id bigint,
    p_worker_id text,
    p_score jsonb,
    p_bpm_default int,
    p_engine_version text,
    p_timings jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    job public.omr_jobs;
    updated int;
begin
    update public.omr_jobs
    set
        status = 'succeeded',
        worker_id = null,
        lease_expires_at = null,
        last_error = null
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id
    returning * into job;
    get diagnostics updated = row_count;
    if updated = 0 then
        return false;
    end if;

    insert into public.score_analyses as sa (
        document_id,
        status,
        error,
        progress,
        engine_version,
        bpm_default,
        score,
        timings,
        created_by,
        updated_at
    )
    values (
        job.document_id,
        'ready',
        null,
        null,
        p_engine_version,
        p_bpm_default,
        p_score,
        p_timings,
        job.created_by,
        now()
    )
    on conflict (document_id) do update
    set
        status = excluded.status,
        error = null,
        progress = null,
        engine_version = excluded.engine_version,
        bpm_default = excluded.bpm_default,
        score = excluded.score,
        timings = excluded.timings,
        updated_at = now();

    return true;
end;
$$;

-- Shared requeue / terminal failure used by omr_fail_job and the reaper.
create or replace function public.omr_apply_failure (
    p_job_id bigint,
    p_error text,
    p_permanent boolean
) returns text -- resulting status
language plpgsql
security definer
set search_path = public
as $$
declare
    job public.omr_jobs;
    next_status text;
    backoff_secs int;
begin
    select * into job from public.omr_jobs where id = p_job_id for update;
    if job.id is null then
        return null;
    end if;

    if p_permanent or job.attempt >= job.max_attempts then
        next_status := case when p_permanent then 'failed_permanent' else 'dead' end;
        update public.omr_jobs
        set
            status = next_status,
            last_error = p_error,
            worker_id = null,
            lease_expires_at = null,
            claimed_at = null
        where id = p_job_id;

        insert into public.score_analyses as sa (
            document_id, status, error, progress, score, timings, created_by, updated_at
        )
        values (
            job.document_id, 'failed', p_error, null, null, null, job.created_by, now()
        )
        on conflict (document_id) do update
        set
            status = 'failed',
            error = excluded.error,
            progress = null,
            score = null,
            timings = null,
            engine_version = null,
            bpm_default = null,
            updated_at = now();
    else
        -- Transient: requeue with exponential backoff 60s / 5min / 15min.
        backoff_secs := least(900, 60 * power(5, greatest(job.attempt - 1, 0))::int);
        next_status := 'queued';
        update public.omr_jobs
        set
            status = 'queued',
            last_error = p_error,
            worker_id = null,
            lease_expires_at = null,
            claimed_at = null,
            run_after = now() + make_interval(secs => backoff_secs)
        where id = p_job_id;

        update public.score_analyses
        set status = 'pending', error = null, progress = null, updated_at = now()
        where document_id = job.document_id;
    end if;

    return next_status;
end;
$$;

create or replace function public.omr_fail_job (
    p_job_id bigint,
    p_worker_id text,
    p_error text,
    p_permanent boolean
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    owned int;
begin
    update public.omr_jobs
    set updated_at = now() -- touch so we know we still own it
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id;
    get diagnostics owned = row_count;
    if owned = 0 then
        return null;
    end if;
    return public.omr_apply_failure (p_job_id, p_error, p_permanent);
end;
$$;

-- Reap expired leases; touch score_analyses.updated_at for live queued/running
-- rows so the client's 20-min staleness rule does not false-fail deep backlogs.
-- Returns count of jobs currently queued (for the sweeper poke decision).
create or replace function public.omr_reap_expired_leases ()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    expired record;
    queued_count int;
begin
    for expired in
        select id
        from public.omr_jobs
        where status = 'running'
          and lease_expires_at is not null
          and lease_expires_at < now()
        for update skip locked
    loop
        perform public.omr_apply_failure (expired.id, 'worker_lost', false);
    end loop;

    -- Keep-alive for client staleness: only updated_at (status/progress unchanged
    -- → realtime trigger stays silent under IS DISTINCT FROM gate).
    update public.score_analyses sa
    set updated_at = now()
    where exists (
        select 1
        from public.omr_jobs j
        where j.document_id = sa.document_id
          and j.status in ('queued', 'running')
    )
    and sa.status in ('pending', 'processing');

    select count(*)::int into queued_count
    from public.omr_jobs
    where status = 'queued'
      and run_after <= now();

    return queued_count;
end;
$$;

-- Per-user active backlog count for admission control.
create or replace function public.omr_user_active_job_count (p_user_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
    select count(*)::int
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');
$$;

revoke all on function public.omr_claim_job (text, int) from public, anon, authenticated;
revoke all on function public.omr_heartbeat_job (bigint, text, int) from public, anon, authenticated;
revoke all on function public.omr_complete_job (bigint, text, jsonb, int, text, jsonb) from public, anon, authenticated;
revoke all on function public.omr_apply_failure (bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.omr_fail_job (bigint, text, text, boolean) from public, anon, authenticated;
revoke all on function public.omr_reap_expired_leases () from public, anon, authenticated;
revoke all on function public.omr_user_active_job_count (uuid) from public, anon, authenticated;

grant execute on function public.omr_claim_job (text, int) to service_role;
grant execute on function public.omr_heartbeat_job (bigint, text, int) to service_role;
grant execute on function public.omr_complete_job (bigint, text, jsonb, int, text, jsonb) to service_role;
grant execute on function public.omr_apply_failure (bigint, text, boolean) to service_role;
grant execute on function public.omr_fail_job (bigint, text, text, boolean) to service_role;
grant execute on function public.omr_reap_expired_leases () to service_role;
grant execute on function public.omr_user_active_job_count (uuid) to service_role;
-- Edge function uses service-role for the cap check too.

-- ===== supabase/migrations/20260806130000_score_analyses_broadcast.sql =====
-- Trimmed score_analyses lifecycle fan-out on the existing doc:{id} topic.
-- Never broadcast the score jsonb — only status/error/progress/updated_at.
-- Gate inside the function (INSERT triggers cannot reference OLD in WHEN).

create or replace function public.broadcast_score_analysis_changes () returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.progress is not distinct from new.progress then
        return null;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'score_analyses',
            'document_id', new.document_id,
            'status', new.status,
            'error', new.error,
            'progress', new.progress,
            'updated_at', new.updated_at
        ),
        'score_analysis', -- event
        'doc:' || new.document_id::text, -- topic
        true -- private
    );
    return null;
end;
$$;

drop trigger if exists score_analyses_broadcast on public.score_analyses;
create trigger score_analyses_broadcast
after insert or update on public.score_analyses
for each row
execute function public.broadcast_score_analysis_changes ();

-- ===== supabase/migrations/20260806140000_omr_cron.sql =====
-- OMR sweeper: enable pg_cron + pg_net, reap expired leases, wake workers.
-- Vault secrets omr_service_url / omr_service_secret must be created out-of-band
-- (see SETUP_SUPABASE.md). If missing, the poke is a no-op; reap still runs.
--
-- Day-one check (2026-08-06): pg_cron 1.6.4 and pg_net 0.20.4 available but
-- not installed; supabase_vault already installed. Enabling both here.
-- Fallback if enable fails on a future project: Cloud Scheduler → POST /poke
-- and have the worker call omr_reap_expired_leases() at the top of each poke.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.omr_sweep ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    queued int;
    svc_url text;
    svc_secret text;
begin
    queued := public.omr_reap_expired_leases ();
    perform public.score_cache_purge_stale (180);

    if queued is null or queued <= 0 then
        return;
    end if;

    select decrypted_secret into svc_url
    from vault.decrypted_secrets
    where name = 'omr_service_url'
    limit 1;

    select decrypted_secret into svc_secret
    from vault.decrypted_secrets
    where name = 'omr_service_secret'
    limit 1;

    if svc_url is null or svc_secret is null or length(trim(svc_url)) = 0 then
        raise notice 'omr_sweep: vault secrets omr_service_url/omr_service_secret missing — skip poke';
        return;
    end if;

    perform net.http_post(
        url := rtrim(svc_url, '/') || '/poke',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-omr-secret', svc_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
    );
end;
$$;

revoke all on function public.omr_sweep () from public, anon, authenticated;
grant execute on function public.omr_sweep () to service_role;

-- Schedule every minute. Unschedule prior job of the same name if re-applied.
do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname = 'omr-sweep';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('omr-sweep', '* * * * *', $$select public.omr_sweep ()$$);

-- ===== supabase/migrations/20260806150000_omr_enqueue_and_fail_policy.sql =====
-- Atomic enqueue + SQL-owned retry permanence (review fixes).

-- Permanence policy lives here only (mirrors services/omr-service/src/errors.ts tests).
create or replace function public.omr_error_is_permanent (p_error text, p_attempt int)
returns boolean
language sql
immutable
as $$
    select case
        when p_error in (
            'too_large', 'page_count_unknown', 'no_staves_found',
            'musicxml_parse_failed', 'backlog_full'
        ) then true
        when p_error in ('omr_crash', 'omr_timeout') then p_attempt >= 2
        else false
    end;
$$;

-- Fail without client-supplied permanence; SQL decides.
create or replace function public.omr_fail_job (
    p_job_id bigint,
    p_worker_id text,
    p_error text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    owned int;
    job public.omr_jobs;
begin
    update public.omr_jobs
    set updated_at = now()
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id
    returning * into job;
    get diagnostics owned = row_count;
    if owned = 0 then
        return null;
    end if;
    return public.omr_apply_failure (
        p_job_id,
        p_error,
        public.omr_error_is_permanent (p_error, job.attempt)
    );
end;
$$;

revoke all on function public.omr_fail_job (bigint, text, text, boolean) from public, anon, authenticated, service_role;
drop function if exists public.omr_fail_job (bigint, text, text, boolean);

revoke all on function public.omr_fail_job (bigint, text, text) from public, anon, authenticated;
grant execute on function public.omr_fail_job (bigint, text, text) to service_role;
grant execute on function public.omr_error_is_permanent (text, int) to service_role;

-- Cap + pending upsert + job insert in one transaction.
create or replace function public.omr_enqueue_job (
    p_document_id uuid,
    p_user_id uuid,
    p_storage_path text,
    p_page_count int,
    p_cap int default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    active_count int;
    inserted_id bigint;
begin
    -- Clear zombie running rows before admission so Generate is not blocked
    -- for a full lease after a worker crash.
    perform public.omr_reap_expired_leases();

    perform pg_advisory_xact_lock (hashtext('omr_enqueue:' || p_user_id::text));

    select count(*)::int into active_count
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');

    if active_count >= p_cap then
        return jsonb_build_object('ok', false, 'code', 'backlog_full');
    end if;

    if exists (
        select 1 from public.omr_jobs
        where document_id = p_document_id
          and status in ('queued', 'running')
    ) then
        return jsonb_build_object('ok', false, 'code', 'already_running');
    end if;

    insert into public.score_analyses as sa (
        document_id, created_by, status, progress, error, score, updated_at
    )
    values (
        p_document_id, p_user_id, 'pending', null, null, null, now()
    )
    on conflict (document_id) do update
    set
        status = 'pending',
        progress = null,
        error = null,
        score = null,
        engine_version = null,
        bpm_default = null,
        timings = null,
        updated_at = now();

    begin
        insert into public.omr_jobs (
            document_id, status, storage_path, page_count, created_by, priority
        )
        values (
            p_document_id, 'queued', p_storage_path, p_page_count, p_user_id, 0
        )
        returning id into inserted_id;
    exception
        when unique_violation then
            return jsonb_build_object('ok', false, 'code', 'already_running');
    end;

    return jsonb_build_object('ok', true, 'code', 'queued', 'job_id', inserted_id);
end;
$$;

revoke all on function public.omr_enqueue_job (uuid, uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.omr_enqueue_job (uuid, uuid, text, int, int) to service_role;

-- ===== supabase/migrations/20260806160000_omr_enqueue_persist_backlog_full.sql =====
-- Persist backlog_full onto score_analyses so client remount/rehydrate still
-- shows the admission rejection (without clobbering an existing ready analysis).

create or replace function public.omr_enqueue_job (
    p_document_id uuid,
    p_user_id uuid,
    p_storage_path text,
    p_page_count int,
    p_cap int default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    active_count int;
    inserted_id bigint;
begin
    -- Clear zombie running rows before admission so Generate is not blocked
    -- for a full lease after a worker crash.
    perform public.omr_reap_expired_leases();

    perform pg_advisory_xact_lock (hashtext('omr_enqueue:' || p_user_id::text));

    select count(*)::int into active_count
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');

    if active_count >= p_cap then
        insert into public.score_analyses as sa (
            document_id, created_by, status, progress, error, score, updated_at
        )
        values (
            p_document_id, p_user_id, 'failed', null, 'backlog_full', null, now()
        )
        on conflict (document_id) do update
        set
            status = 'failed',
            progress = null,
            error = 'backlog_full',
            updated_at = now()
        where sa.status is distinct from 'ready';
        return jsonb_build_object('ok', false, 'code', 'backlog_full');
    end if;

    if exists (
        select 1 from public.omr_jobs
        where document_id = p_document_id
          and status in ('queued', 'running')
    ) then
        return jsonb_build_object('ok', false, 'code', 'already_running');
    end if;

    insert into public.score_analyses as sa (
        document_id, created_by, status, progress, error, score, updated_at
    )
    values (
        p_document_id, p_user_id, 'pending', null, null, null, now()
    )
    on conflict (document_id) do update
    set
        status = 'pending',
        progress = null,
        error = null,
        score = null,
        engine_version = null,
        bpm_default = null,
        timings = null,
        updated_at = now();

    begin
        insert into public.omr_jobs (
            document_id, status, storage_path, page_count, created_by, priority
        )
        values (
            p_document_id, 'queued', p_storage_path, p_page_count, p_user_id, 0
        )
        returning id into inserted_id;
    exception
        when unique_violation then
            return jsonb_build_object('ok', false, 'code', 'already_running');
    end;

    return jsonb_build_object('ok', true, 'code', 'queued', 'job_id', inserted_id);
end;
$$;

-- ===== supabase/migrations/20260826193902_billing.sql =====
-- Billing: Stripe customers/subscriptions, academy seats, metered usage, and the
-- free-tier cloud-score cap.
--
-- Design notes:
--  * Stripe price IDs live in Edge Function env, never in the database. The
--    webhook resolves price -> tier and stores the RESOLVED tier here, which is
--    why Founding Teacher needs no schema support: it is a second price on the
--    Teacher product, so a founding subscription is simply tier 'teacher'.
--  * The seat tables keep their original names (studios, studio_members); only
--    the tier they entitle was renamed, from the v1 studio tier to academy. The
--    same goes for the studio_member entitlement source, which names the table
--    the seat row lives in rather than the tier.
--  * tier_limits() is the single source of truth for the numbers. The TS mirror
--    in supabase/functions/_shared/entitlements.ts is drift-guarded by
--    tests/billing/limitsInSync.test.ts, which parses this file.
--  * cloud_scores and students are STOCKS (a live count of non-archived
--    documents, and of roster rows), not flows, so they are enforced where the
--    row is written and never reach usage_counters. The other metrics are
--    monthly flows. pdf_exports is a flow with a caveat: the export itself runs
--    on-device, so its gate is honest-UI plus this server-side counter, and it
--    never applies to anonymous guests or provisioned students.
--  * A provisioned student is not a customer. get_entitlements() answers tier
--    'student' (source 'managed') straight from app_metadata, before any
--    subscription lookup, so the roster features in 20260826194426_roster.sql
--    work for an account that will never have a Stripe row.
--  * Lapsing NEVER deletes data. Scores beyond the free cap get archived_at set;
--    they stay readable and exportable, only annotation writes are blocked.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.billing_customers (
    user_id uuid primary key references auth.users (id) on delete cascade,
    stripe_customer_id text not null unique,
    created_at timestamptz not null default now()
);

create table public.subscriptions (
    stripe_subscription_id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    tier text not null check (tier in ('free', 'personal', 'teacher', 'academy')),
    status text not null,
    price_id text,
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index subscriptions_user on public.subscriptions (user_id);

create table public.studios (
    id uuid primary key,
    owner_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    seat_limit int not null default 5 check (seat_limit > 0),
    created_at timestamptz not null default now()
);

create index studios_owner on public.studios (owner_id);

create table public.studio_members (
    studio_id uuid not null references public.studios (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (studio_id, user_id)
);

create index studio_members_user on public.studio_members (user_id);

-- Monthly metered usage. `month` is the first day of the calendar month, so a
-- rollover is simply a new conflict key -- last month's row is never touched.
create table public.usage_counters (
    user_id uuid not null references auth.users (id) on delete cascade,
    metric text not null,
    month date not null,
    count int not null default 0,
    updated_at timestamptz not null default now(),
    primary key (user_id, metric, month)
);

-- Webhook idempotency ledger, keyed by Stripe's own event id.
create table public.stripe_events (
    id text primary key,
    type text not null,
    processed_at timestamptz not null default now()
);

-- Active = archived_at is null. Archived scores stay viewable and exportable.
alter table public.documents add column archived_at timestamptz;

create index documents_owner_active on public.documents (owner_id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Tier limits -- the single source of truth for the numbers (-1 = unlimited)
-- ---------------------------------------------------------------------------
create or replace function public.tier_limits (p_tier text) returns jsonb language sql immutable
set search_path = public as $$
    select case p_tier
        -- students = 0 is what makes Personal a solo plan: no roster, no seats.
        when 'personal' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', 0
        )
        when 'teacher' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        when 'academy' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        -- Not purchasable: a provisioned student account. It creates nothing of
        -- its own -- every score it can reach is one a teacher assigned -- and it
        -- is never export-gated, because there is nobody to sell an upgrade to.
        when 'student' then jsonb_build_object(
            'cloud_scores', 0, 'omr_runs', 0, 'vision_reads', 0, 'smart_imports', 0, 'pdf_exports', -1, 'students', 0
        )
        else jsonb_build_object(
            'cloud_scores', 3, 'omr_runs', 3, 'vision_reads', 5, 'smart_imports', 2, 'pdf_exports', 1, 'students', 3
        )
    end;
$$;

-- ---------------------------------------------------------------------------
-- Effective entitlements, resolving Academy seat membership
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so it can read subscriptions/studios past their own RLS.
-- That makes the caller check mandatory: a signed-in user may only ask about
-- themselves; service-role callers (auth.uid() is null) must name a user.
create or replace function public.get_entitlements (p_user uuid default null) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_user uuid;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_sub record;
begin
    if v_caller is null then
        if p_user is null then
            raise exception 'get_entitlements requires p_user when unauthenticated' using errcode = '22023';
        end if;
        v_user := p_user;
    else
        if p_user is not null and p_user <> v_caller then
            raise exception 'cannot read another user''s entitlements' using errcode = '42501';
        end if;
        v_user := v_caller;
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic metered consume -- check and increment in ONE statement
-- ---------------------------------------------------------------------------
create or replace function public.consume_quota (p_user uuid, p_metric text, p_limit int) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_month date := date_trunc('month', now())::date;
    v_count int;
begin
    if p_user is null or p_metric is null or p_limit is null then
        raise exception 'consume_quota requires p_user, p_metric and p_limit' using errcode = '22023';
    end if;

    -- A zero limit can never be satisfied, and must be rejected BEFORE the
    -- insert: the first write of a month has no conflict, so DO UPDATE's WHERE
    -- never runs and count = 1 would slip straight past the cap.
    if p_limit = 0 then
        return jsonb_build_object('ok', false, 'count', 0, 'limit', p_limit);
    end if;

    -- The WHERE on DO UPDATE is what makes this race-free: on conflict Postgres
    -- takes a row lock and re-evaluates the predicate against the locked row, so
    -- concurrent callers serialize with no check-then-write window. Zero rows
    -- back means the cap was hit AND nothing was incremented.
    insert into public.usage_counters (user_id, metric, month, count)
    values (p_user, p_metric, v_month, 1)
    on conflict (user_id, metric, month) do update
        set count = usage_counters.count + 1,
            updated_at = now()
        where p_limit < 0 or usage_counters.count < p_limit
    returning count into v_count;

    if v_count is null then
        select uc.count into v_count
        from public.usage_counters uc
        where uc.user_id = p_user and uc.metric = p_metric and uc.month = v_month;
        return jsonb_build_object('ok', false, 'count', coalesce(v_count, 0), 'limit', p_limit);
    end if;

    return jsonb_build_object('ok', true, 'count', v_count, 'limit', p_limit);
end;
$$;

-- Refund a consumed unit when the work it paid for failed. Never goes below 0.
create or replace function public.release_quota (p_user uuid, p_metric text) returns void language sql security definer
set search_path = public as $$
    update public.usage_counters
    set count = greatest(0, count - 1), updated_at = now()
    where user_id = p_user
      and metric = p_metric
      and month = date_trunc('month', now())::date;
$$;

-- The PDF export runs entirely on-device, so nothing here can stop it: this is
-- the honest-UI counter the client calls before exporting, not a hard gate. It
-- is the one consume path granted to authenticated -- an export has no Edge
-- Function to meter it -- which is safe because the worst a caller can do by
-- calling it directly is spend their own allowance.
create or replace function public.consume_pdf_export () returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_ent jsonb;
    v_limit int;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- A share-link guest is someone else's visitor, with no plan of their own to
    -- draw down and no way to upgrade. Never gated.
    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        return jsonb_build_object('ok', true, 'exempt', 'anonymous');
    end if;

    v_ent := public.get_entitlements ();

    -- Students print what they were assigned. That is the product working, not
    -- usage to meter.
    if v_ent ->> 'tier' = 'student' then
        return jsonb_build_object('ok', true, 'exempt', 'student');
    end if;

    v_limit := (v_ent -> 'limits' ->> 'pdf_exports')::int;
    if v_limit < 0 then
        return jsonb_build_object('ok', true);
    end if;

    return public.consume_quota (v_user, 'pdf_exports', v_limit);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cloud-score cap (a stock, not a flow) + archived read-only
-- ---------------------------------------------------------------------------
create or replace function public.document_is_archived (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select coalesce((select d.archived_at is not null from public.documents d where d.id = doc), false);
$$;

-- Uploads are a direct browser PostgREST insert (see documentsService.uploadDocument),
-- so the cap lives in a trigger rather than an Edge Function. A WITH CHECK
-- expression could reject the row but could not carry the structured payload the
-- client needs, so this raises with a machine-readable DETAIL instead.
--
-- AFTER, not BEFORE, and behind a per-owner advisory lock: counting is otherwise
-- check-then-write, the very window consume_quota goes out of its way to close.
-- A BEFORE trigger counts against a snapshot that cannot include the row being
-- written, so ten rows in one INSERT would each see the same pre-statement count
-- and all ten would land. AFTER ROW triggers fire once the statement's rows are
-- in, so the count includes them; the advisory lock does the same job across
-- concurrent transactions, since a second inserter blocks here and then re-counts
-- (a volatile function takes a fresh snapshot per statement) against the winner's
-- committed row. Both cases end in the same rollback a BEFORE raise would give.
create or replace function public.documents_enforce_score_cap () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_ent jsonb;
    v_tier text;
    v_limit int;
    v_count int;
begin
    -- Only a row that is (or becomes) active claims a slot.
    if new.archived_at is not null then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.archived_at is null then
        return null; -- already active; nothing new is being claimed
    end if;

    v_ent := public.get_entitlements (new.owner_id);
    v_tier := v_ent ->> 'tier';
    v_limit := (v_ent -> 'limits' ->> 'cloud_scores')::int;

    if v_limit < 0 then
        return null;
    end if;

    -- Taken only on a capped tier, and only once the cheap exits are past: an
    -- unlimited plan never serializes against itself. Released at commit.
    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(new.owner_id::text));

    -- The new row is already in, so it counts itself: the test is `>`, not `>=`.
    select count(*)::int into v_count
    from public.documents d
    where d.owner_id = new.owner_id
      and d.archived_at is null;

    if v_count > v_limit then
        raise exception 'limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object(
                      'code', 'limit_reached',
                      'metric', 'cloud_scores',
                      'limit', v_limit,
                      'tier', v_tier
                  )::text,
                  hint = 'Upgrade for unlimited cloud scores.';
    end if;

    return null;
end;
$$;

create trigger documents_enforce_score_cap after insert or update on public.documents
for each row execute function public.documents_enforce_score_cap ();

-- Archived scores are read-only. Enforced in RLS rather than in the client so it
-- also holds for share-link students and for the batch RPCs (which are SECURITY
-- INVOKER precisely so policies like this keep applying to bulk writes).
drop policy if exists annotations_insert on public.annotations;

create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
    and not public.document_is_archived (document_id)
);

drop policy if exists annotations_update on public.annotations;

create policy annotations_update on public.annotations for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and not public.document_is_archived (document_id)
);

-- Archiving is a plan event, not a touch. The pre-existing documents_touch
-- trigger stamps updated_at = now() on every UPDATE, which apply_free_tier_archival
-- below would otherwise fire on every score it archives -- making the read-only
-- ones the NEWEST rows in the library (listDocuments orders by updated_at desc
-- and stops at 100), and destroying the last-touched signal the keep-set below
-- sorts on. Same drop-and-recreate as the annotations policies above; the shared
-- touch_updated_at() is left alone because library_tags, managed_students,
-- assignments and practice_notes all still want the plain behaviour.
create or replace function public.documents_touch_updated_at () returns trigger language plpgsql
set search_path = public as $$
begin
    if new.archived_at is distinct from old.archived_at then
        new.updated_at := old.updated_at;
        return new;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists documents_touch on public.documents;

create trigger documents_touch before update on public.documents
for each row execute function public.documents_touch_updated_at ();

revoke all on function public.documents_touch_updated_at () from public;

revoke all on function public.documents_touch_updated_at () from anon;

revoke all on function public.documents_touch_updated_at () from authenticated;

-- Called by the webhook when a subscription lapses. Keeps the most recently
-- touched scores active and archives the rest -- never deletes.
create or replace function public.apply_free_tier_archival (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_archived int;
begin
    v_limit := (public.get_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
    if v_limit < 0 then
        return 0;
    end if;

    with keep as (
        select d.id
        from public.documents d
        where d.owner_id = p_user and d.archived_at is null
        order by d.updated_at desc, d.id
        limit v_limit
    )
    update public.documents d
    set archived_at = now()
    where d.owner_id = p_user
      and d.archived_at is null
      and not exists (select 1 from keep k where k.id = d.id);

    get diagnostics v_archived = row_count;
    return v_archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- Academy seat management (on the studios/studio_members tables, v1 names kept)
-- ---------------------------------------------------------------------------
create or replace function public.studios_enforce_seat_limit () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_used int;
begin
    select st.seat_limit into v_limit from public.studios st where st.id = new.studio_id;
    if v_limit is null then
        raise exception 'studio not found' using errcode = 'P0002';
    end if;

    -- The owner occupies a seat, so members may fill at most seat_limit - 1.
    select count(*)::int into v_used
    from public.studio_members sm
    where sm.studio_id = new.studio_id and sm.user_id <> new.user_id;

    if v_used + 1 > v_limit - 1 then
        raise exception 'seat_limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object('code', 'seat_limit_reached', 'limit', v_limit)::text;
    end if;

    return new;
end;
$$;

create trigger studio_members_seat_limit before insert on public.studio_members
for each row execute function public.studios_enforce_seat_limit ();

-- SECURITY DEFINER for exactly the reason document_role() is (see
-- 20260801160754_rls.sql): a studios policy that reads studio_members and a
-- studio_members policy that reads studios are MUTUALLY recursive, and Postgres
-- refuses both with "infinite recursion detected in policy" -- which is every
-- read either table has, taking the whole Academy seats screen with it. Routing
-- both through one definer function is what breaks the cycle.
create or replace function public.studio_role (p_studio uuid) returns text language sql stable security definer
set search_path = public as $$
    select case
        when exists (
            select 1 from public.studios st where st.id = p_studio and st.owner_id = auth.uid()
        ) then 'owner'
        when exists (
            select 1 from public.studio_members sm where sm.studio_id = p_studio and sm.user_id = auth.uid()
        ) then 'member'
    end;
$$;

-- auth.users is not client-readable, so seat invites resolve the email here.
create or replace function public.studio_invite_member (p_studio uuid, p_email text) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
    v_target uuid;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can add seats' using errcode = '42501';
    end if;

    -- Owning a studio is not the same as paying for one, and anyone may create a
    -- studio row. Without this, the distinct "no Cleffy account" raise below is a
    -- free, unrate-limited oracle over auth.users for any signed-in caller -- and
    -- a way to push a stranger into a studio they never joined. Seats only exist
    -- on Academy, so that is where the lookup lives.
    if (public.get_entitlements () ->> 'tier') is distinct from 'academy' then
        raise exception 'an Academy subscription is required to add seats'
            using errcode = '42501',
                  detail = json_build_object('code', 'academy_required')::text;
    end if;

    select u.id into v_target from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
    if v_target is null then
        raise exception 'no Cleffy account with that email'
            using errcode = 'P0002',
                  detail = json_build_object('code', 'user_not_found')::text;
    end if;

    -- The owner already holds a seat implicitly; adding a row for them would
    -- double-count against seat_limit.
    if v_target = v_owner then
        raise exception 'the studio owner already holds a seat'
            using errcode = 'P0001',
                  detail = json_build_object('code', 'owner_already_seated')::text;
    end if;

    insert into public.studio_members (studio_id, user_id)
    values (p_studio, v_target)
    on conflict (studio_id, user_id) do nothing;

    return v_target;
end;
$$;

-- Seat roster with emails, owner only. studio_members holds ids, and auth.users
-- is not client-readable, so the join has to happen behind a definer boundary.
create or replace function public.studio_roster (p_studio uuid) returns table (user_id uuid, email text) language plpgsql stable security definer
set search_path = public as $$
-- OUT params (user_id, email) share names with the columns below; let columns win,
-- same hazard redeem_share_link documents.
#variable_conflict use_column
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
begin
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_caller is null or v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can list seats' using errcode = '42501';
    end if;

    return query
        select sm.user_id, u.email::text
        from public.studio_members sm
        join auth.users u on u.id = sm.user_id
        where sm.studio_id = p_studio
        order by u.email;
end;
$$;

create or replace function public.studio_remove_member (p_studio uuid, p_user uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
begin
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_caller is null or v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can remove seats' using errcode = '42501';
    end if;

    delete from public.studio_members where studio_id = p_studio and user_id = p_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS -- users read only their own rows; every write is service-role/definer
-- ---------------------------------------------------------------------------
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.studios enable row level security;
alter table public.studio_members enable row level security;
alter table public.usage_counters enable row level security;
alter table public.stripe_events enable row level security;

create policy billing_customers_select on public.billing_customers for select to authenticated
using (user_id = (select auth.uid()));

create policy subscriptions_select on public.subscriptions for select to authenticated
using (user_id = (select auth.uid()));

create policy usage_counters_select on public.usage_counters for select to authenticated
using (user_id = (select auth.uid()));

-- Owners manage their studio; members may see the studio they belong to. The
-- owner branch is direct rather than through studio_role() for the reason
-- documents_select keeps its own: an owner holds no studio_members row at all,
-- and INSERT ... RETURNING has to see the row it just wrote.
create policy studios_select on public.studios for select to authenticated
using (
    owner_id = (select auth.uid())
    or public.studio_role (id) = 'member'
);

-- Same two exclusions documents_insert carries: a share-link guest has no plan
-- of their own and a provisioned student creates nothing, so neither has an
-- academy to own. The column grants below are what keep seat_limit out of reach.
create policy studios_insert on public.studios for insert to authenticated
with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'user_type', '') <> 'student'
);

create policy studios_update on public.studios for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy studio_members_select on public.studio_members for select to authenticated
using (
    user_id = (select auth.uid())
    or public.studio_role (studio_id) = 'owner'
);

-- ---------------------------------------------------------------------------
-- Privilege hardening (same convention as edge_rate_rls_and_revoke_execute)
-- ---------------------------------------------------------------------------
revoke all on table public.billing_customers from public;
revoke all on table public.billing_customers from anon;
revoke all on table public.billing_customers from authenticated;
grant select on table public.billing_customers to authenticated;

revoke all on table public.subscriptions from public;
revoke all on table public.subscriptions from anon;
revoke all on table public.subscriptions from authenticated;
grant select on table public.subscriptions to authenticated;

revoke all on table public.usage_counters from public;
revoke all on table public.usage_counters from anon;
revoke all on table public.usage_counters from authenticated;
grant select on table public.usage_counters to authenticated;

revoke all on table public.stripe_events from public;
revoke all on table public.stripe_events from anon;
revoke all on table public.stripe_events from authenticated;

revoke all on table public.studios from public;
revoke all on table public.studios from anon;
revoke all on table public.studios from authenticated;
grant select on table public.studios to authenticated;
-- Column-scoped on purpose: seat_limit is the SOLE input to
-- studios_enforce_seat_limit, so a table-wide insert/update grant would make the
-- Academy seat cap self-service -- one $49 subscription entitling any number of
-- teachers through get_entitlements()'s seat branch. The policies above only
-- check owner_id, and the CHECK constraint only asks for > 0, so nothing else
-- stands between an owner and `{"seat_limit": 100000}`. Nothing legitimate wants
-- it either: createStudio posts {id, owner_id, name} and StudioSeats only reads.
grant insert (id, owner_id, name), update (name) on table public.studios to authenticated;

revoke all on table public.studio_members from public;
revoke all on table public.studio_members from anon;
revoke all on table public.studio_members from authenticated;
grant select on table public.studio_members to authenticated;

-- Trigger-only functions: never callable via /rest/v1/rpc.
revoke all on function public.documents_enforce_score_cap () from public;
revoke all on function public.documents_enforce_score_cap () from anon;
revoke all on function public.documents_enforce_score_cap () from authenticated;

revoke all on function public.studios_enforce_seat_limit () from public;
revoke all on function public.studios_enforce_seat_limit () from anon;
revoke all on function public.studios_enforce_seat_limit () from authenticated;

-- Service-only RPCs: metering and lapse handling are Edge Function concerns.
revoke all on function public.consume_quota (uuid, text, int) from public;
revoke all on function public.consume_quota (uuid, text, int) from anon;
revoke all on function public.consume_quota (uuid, text, int) from authenticated;
grant execute on function public.consume_quota (uuid, text, int) to service_role;

revoke all on function public.release_quota (uuid, text) from public;
revoke all on function public.release_quota (uuid, text) from anon;
revoke all on function public.release_quota (uuid, text) from authenticated;
grant execute on function public.release_quota (uuid, text) to service_role;

revoke all on function public.apply_free_tier_archival (uuid) from public;
revoke all on function public.apply_free_tier_archival (uuid) from anon;
revoke all on function public.apply_free_tier_archival (uuid) from authenticated;
grant execute on function public.apply_free_tier_archival (uuid) to service_role;

-- Client RPCs: revoke PUBLIC/anon, keep authenticated.
revoke all on function public.get_entitlements (uuid) from public;
revoke all on function public.get_entitlements (uuid) from anon;
grant execute on function public.get_entitlements (uuid) to authenticated;
grant execute on function public.get_entitlements (uuid) to service_role;

revoke all on function public.tier_limits (text) from public;
revoke all on function public.tier_limits (text) from anon;
grant execute on function public.tier_limits (text) to authenticated;

-- Unlike consume_quota, this one IS a client RPC: the export it counts happens
-- in the browser, so there is no server-side caller to keep it away from.
revoke all on function public.consume_pdf_export () from public;
revoke all on function public.consume_pdf_export () from anon;
grant execute on function public.consume_pdf_export () to authenticated;

revoke all on function public.document_is_archived (uuid) from public;
revoke all on function public.document_is_archived (uuid) from anon;
grant execute on function public.document_is_archived (uuid) to authenticated;

revoke all on function public.studio_invite_member (uuid, text) from public;
revoke all on function public.studio_invite_member (uuid, text) from anon;
grant execute on function public.studio_invite_member (uuid, text) to authenticated;

revoke all on function public.studio_remove_member (uuid, uuid) from public;
revoke all on function public.studio_remove_member (uuid, uuid) from anon;
grant execute on function public.studio_remove_member (uuid, uuid) to authenticated;

revoke all on function public.studio_roster (uuid) from public;
revoke all on function public.studio_roster (uuid) from anon;
grant execute on function public.studio_roster (uuid) to authenticated;

-- Read by the studios/studio_members policies, so authenticated must hold it.
revoke all on function public.studio_role (uuid) from public;
revoke all on function public.studio_role (uuid) from anon;
grant execute on function public.studio_role (uuid) to authenticated;

-- ===== supabase/migrations/20260826194426_roster.sql =====
-- Roster, assignments, and practice notes — the teaching half of pricing v2.
--
-- The model, in one place:
--  * A provisioned student is a REAL Supabase user, flagged with
--    app_metadata.user_type = 'student' by the student-provision Edge Function
--    (admin-set, so it is not user-editable and can be trusted in a policy).
--    managed_students is the teacher's side of that account: the display name
--    they picked, the hash of the login code, and the archive flag that decides
--    whether the row still counts against the `students` stock.
--  * Permissions ride the roles that already exist. Assigning a score upserts a
--    document_members row — 'editor' so the student can annotate their own
--    fingerings and practice marks, or 'viewer' when the teacher flips the
--    assignment to view-only. There is no new member role, and the annotation
--    policies are untouched: a student IS an editor, by the same rules as a
--    share-link collaborator.
--  * practice_notes is the teacher's journal. Notes are private to their author
--    until `shared` is set, which is what lets a teacher write both "watch the
--    left hand in bar 12" for the student and "parents want to move to Tuesdays"
--    for themselves, in the same place.
--  * Students are never gated and never billed. get_entitlements() answers tier
--    'student' for them (see 20260826193902_billing.sql), and nothing in this
--    file consumes a quota — the teacher's roster stock is what pricing meters.
--
-- Ids are caller-generated, matching documents/annotations/library_tags: the
-- provisioning function and the client already hold the uuid they just made.

-- ---------------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------------
create table public.managed_students (
    id uuid primary key,
    teacher_id uuid not null references auth.users (id) on delete cascade,
    -- One roster row per student account: a student belongs to the teacher who
    -- provisioned them, and moving them means archiving and re-provisioning.
    student_user_id uuid not null unique references auth.users (id) on delete cascade,
    display_name text not null,
    -- Never the code itself. The login function hashes and compares.
    login_code_hash text not null,
    parent_email text,
    -- Archived students keep their history and stop counting against `students`.
    archived_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint managed_students_display_name_nonempty check (length(trim(display_name)) > 0)
);

-- The roster stock is "unarchived rows for this teacher", so the index carries
-- the same predicate the count does.
create index managed_students_teacher_active on public.managed_students (teacher_id) where archived_at is null;

create index managed_students_login_code on public.managed_students (login_code_hash);

create trigger managed_students_touch before update on public.managed_students
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------
create table public.assignments (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    student_user_id uuid not null references auth.users (id) on delete cascade,
    assigned_by uuid not null references auth.users (id) on delete cascade,
    note text,
    due_at timestamptz,
    -- 'edit' grants the editor role, 'view' the viewer role. Full edit is the
    -- default: a student who cannot mark their own fingerings has half a score.
    access text not null default 'edit' check (access in ('edit', 'view')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (document_id, student_user_id)
);

create index assignments_student on public.assignments (student_user_id);

create index assignments_document on public.assignments (document_id);

create trigger assignments_touch before update on public.assignments
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Practice notes (the teacher's journal, with an opt-in share flag)
-- ---------------------------------------------------------------------------
create table public.practice_notes (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    -- Null means a note about the score in general rather than about one student.
    student_user_id uuid references auth.users (id) on delete cascade,
    author_id uuid not null references auth.users (id) on delete cascade,
    noted_on date not null default current_date,
    body text not null,
    -- Off by default: a journal the student can read is a different thing from
    -- a journal, so sharing is always a deliberate act.
    shared boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint practice_notes_body_nonempty check (length(trim(body)) > 0)
);

create index practice_notes_doc_day on public.practice_notes (document_id, noted_on desc);

create index practice_notes_student_day on public.practice_notes (student_user_id, noted_on desc);

create trigger practice_notes_touch before update on public.practice_notes
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Assignment RPCs — the only write path for assignments and their membership
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because assigning has to write document_members, which has no
-- client write policy at all (every membership write goes through a definer
-- path: the owner trigger, redeem_share_link, and now this).
create or replace function public.assign_score (
    p_document uuid,
    p_student uuid,
    p_access text default 'edit',
    p_note text default null,
    p_due_at timestamptz default null
) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_role text;
    v_id uuid;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- document_role() reads auth.uid(), which is still the CALLER inside a
    -- definer function — the JWT claim does not change with the executing role.
    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can assign it' using errcode = '42501';
    end if;

    if p_access not in ('edit', 'view') then
        raise exception 'access must be edit or view' using errcode = '22023';
    end if;

    -- A teacher may only assign to their own, unarchived roster: this is what
    -- stops an assignment from reaching a student someone else provisioned.
    if not exists (
        select 1
        from public.managed_students ms
        where ms.teacher_id = v_caller
          and ms.student_user_id = p_student
          and ms.archived_at is null
    ) then
        raise exception 'not on your roster' using errcode = 'P0002';
    end if;

    v_role := case when p_access = 'view' then 'viewer' else 'editor' end;

    insert into public.assignments (id, document_id, student_user_id, assigned_by, note, due_at, access)
    values (gen_random_uuid(), p_document, p_student, v_caller, p_note, p_due_at, p_access)
    on conflict (document_id, student_user_id) do update
        set access = excluded.access,
            note = excluded.note,
            due_at = excluded.due_at,
            updated_at = now()
    returning id into v_id;

    insert into public.document_members (document_id, user_id, role)
    values (p_document, p_student, v_role)
    on conflict (document_id, user_id) do update
        set role = case
            -- Same owner guard as redeem_share_link: assigning a score must never
            -- cost anyone ownership of it.
            when public.document_members.role = 'owner' then 'owner'
            -- Unlike a share link, the teacher's toggle otherwise wins, editor ->
            -- viewer included: flipping an assignment to view-only has to demote.
            else excluded.role
        end;

    return v_id;
end;
$$;

create or replace function public.unassign_score (p_document uuid, p_student uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_withdrawn int;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can unassign it' using errcode = '42501';
    end if;

    delete from public.assignments
    where document_id = p_document
      and student_user_id = p_student;

    get diagnostics v_withdrawn = row_count;

    -- Only what the assignment granted comes back. Guarded on the delete above
    -- actually having removed one: document_members has no client write policy,
    -- so an unguarded delete here would quietly make this the app's general
    -- membership-revocation primitive, accepting any user id -- a share-link
    -- collaborator's editor row would vanish on an unassign that withdrew
    -- nothing, while assign_score is careful to refuse anyone off the roster.
    if v_withdrawn = 0 then
        return;
    end if;

    -- An owner row was never the assignment's to give and is not its to take away.
    delete from public.document_members
    where document_id = p_document
      and user_id = p_student
      and role <> 'owner';
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.managed_students enable row level security;
alter table public.assignments enable row level security;
alter table public.practice_notes enable row level security;

-- The teacher sees their roster; the student sees their own row (it is how the
-- student app learns its display name). NO client write policies: rows are
-- created by the student-provision Edge Function under the service role.
create policy managed_students_select on public.managed_students for select to authenticated
using (
    teacher_id = (select auth.uid())
    or student_user_id = (select auth.uid())
);

-- Both sides of an assignment can read it. Writes go through assign_score /
-- unassign_score so the membership row can never drift from the assignment.
create policy assignments_select on public.assignments for select to authenticated
using (
    student_user_id = (select auth.uid())
    or public.document_role (document_id) = 'owner'
);

create policy practice_notes_select on public.practice_notes for select to authenticated
using (
    author_id = (select auth.uid())
    or (
        shared
        and student_user_id = (select auth.uid())
    )
);

create policy practice_notes_insert on public.practice_notes for insert to authenticated
with check (
    author_id = (select auth.uid())
    and public.document_role (document_id) = 'owner'
    and (
        student_user_id is null
        or exists (
            select 1
            from public.managed_students ms
            where ms.teacher_id = (select auth.uid())
              -- Qualified: unqualified would bind to ms's own column.
              and ms.student_user_id = practice_notes.student_user_id
        )
    )
);

-- The WITH CHECK repeats the insert policy's two guarantees rather than trusting
-- author_id alone: without them document_id, student_user_id and `shared` are all
-- freely mutable after the fact, which dissolves both. A note could be moved onto
-- a score its author does not own and re-aimed at somebody else's student, and
-- the immutability of "who this note is about" -- the thing that stops a note
-- written with nobody named from ever reaching anyone -- would be a client-side
-- type and nothing more. The column grant below is the other half.
create policy practice_notes_update on public.practice_notes for update to authenticated
using (author_id = (select auth.uid()))
with check (
    author_id = (select auth.uid())
    and public.document_role (document_id) = 'owner'
    and (
        student_user_id is null
        or exists (
            select 1
            from public.managed_students ms
            where ms.teacher_id = (select auth.uid())
              -- Qualified: unqualified would bind to ms's own column.
              and ms.student_user_id = practice_notes.student_user_id
        )
    )
);

create policy practice_notes_delete on public.practice_notes for delete to authenticated
using (author_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- documents_insert: students are editors, never creators
-- ---------------------------------------------------------------------------
-- Keeps the owner and is_anonymous conditions from free_plan_efficiency and adds
-- the student clause. A provisioned student's library is exactly what their
-- teacher assigned: letting a student create a score would give them one nobody
-- pays for, that no teacher can see, and that no roster row can reach. The
-- documents table is live, which is why this rides here rather than being edited
-- into an already-applied migration.
drop policy if exists documents_insert on public.documents;

create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'user_type', '') <> 'student'
);

-- ---------------------------------------------------------------------------
-- Privilege hardening (same convention as edge_rate_rls_and_revoke_execute)
-- ---------------------------------------------------------------------------
revoke all on table public.managed_students from public;
revoke all on table public.managed_students from anon;
revoke all on table public.managed_students from authenticated;
-- Every column EXCEPT login_code_hash. The select policy above has a student
-- branch, so a table-wide grant would ship the hash of the code that is also the
-- account's Supabase password down to the student's own browser -- for a value
-- nothing on the client reads, and that only student-login ever compares, under
-- the service role. parent_email stays: it is the teacher's record of who to send
-- the printed card home to, and there is no column grant that can show it to one
-- side of this policy and not the other.
grant select (id, teacher_id, student_user_id, display_name, parent_email, archived_at, created_at, updated_at)
on table public.managed_students to authenticated;

revoke all on table public.assignments from public;
revoke all on table public.assignments from anon;
revoke all on table public.assignments from authenticated;
grant select on table public.assignments to authenticated;

revoke all on table public.practice_notes from public;
revoke all on table public.practice_notes from anon;
revoke all on table public.practice_notes from authenticated;
grant select, insert, delete on table public.practice_notes to authenticated;
-- Exactly the fields PracticeNoteUpdate exposes. document_id, student_user_id and
-- author_id are set once at insert, where the policy vets them, and a table-wide
-- update grant is what would let them be rewritten afterwards.
grant update (body, shared, noted_on) on table public.practice_notes to authenticated;

-- Client RPCs: revoke PUBLIC/anon, keep authenticated.
revoke all on function public.assign_score (uuid, uuid, text, text, timestamptz) from public;
revoke all on function public.assign_score (uuid, uuid, text, text, timestamptz) from anon;
grant execute on function public.assign_score (uuid, uuid, text, text, timestamptz) to authenticated;

revoke all on function public.unassign_score (uuid, uuid) from public;
revoke all on function public.unassign_score (uuid, uuid) from anon;
grant execute on function public.unassign_score (uuid, uuid) to authenticated;

-- ===== supabase/migrations/20260827140000_core_table_grants.sql =====
-- Table-level grants for the core schema.
--
-- Why this exists: on the current Supabase Postgres image, the default ACL for
-- objects created by `postgres` in `public` gives anon/authenticated only
-- Dxtm (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) — no SELECT/INSERT/UPDATE/DELETE.
-- Only objects created by `supabase_admin` get the permissive arwdDxtm default.
-- Migrations run as `postgres`, so every table 0001_schema.sql created is
-- unreadable by the app: PostgREST returns 42501 "permission denied for table
-- documents" before RLS is ever consulted.
--
-- The later migrations (score_analyses, billing, roster) already grant
-- explicitly, which is why only the original core tables were affected.
--
-- Grants below mirror the RLS policies one-for-one — a table gets a privilege
-- only where a policy for that command exists. RLS still decides which ROWS are
-- visible; these grants only open the table-level gate. Tables with no
-- user-facing policy (omr_jobs, score_cache, edge_rate_buckets) are deliberately
-- absent: they stay service_role-only.
--
-- Idempotent: re-granting an existing privilege is a no-op, so this is safe to
-- replay against an environment that already has them.

grant select, insert, update, delete on table public.documents to authenticated;
grant select, insert, update          on table public.annotations to authenticated;
grant select, insert                  on table public.annotation_snapshots to authenticated;
grant select                          on table public.document_members to authenticated;
grant select, insert, update, delete on table public.share_links to authenticated;
grant select, insert, delete         on table public.document_favorites to authenticated;
grant select, insert, delete         on table public.document_tags to authenticated;
grant select, insert, update, delete on table public.library_tags to authenticated;
grant select, insert, update          on table public.document_imports to authenticated;

-- service_role bypasses RLS but still needs the table-level grant.
grant all on table public.documents,
               public.annotations,
               public.annotation_snapshots,
               public.document_members,
               public.share_links,
               public.document_favorites,
               public.document_tags,
               public.library_tags,
               public.document_imports
    to service_role;

-- ===== supabase/migrations/20260827150000_student_credentials.sql =====
-- Student credentials: a code becomes a claim token, and email joins it.
--
-- The model this replaces: the login code was the whole credential — its hash
-- selected the roster row AND it was the synthetic account's Supabase password,
-- forever. That is a password a child reads off a card, cannot change, and
-- shares with whoever picks the card up off the piano.
--
-- The model this establishes: the teacher picks a method per student, once, at
-- creation, and `auth_method` is fixed for the life of the row.
--
--  * 'code' — the zero-email path, for a young child. The printed code is a
--    ONE-TIME CLAIM TOKEN: student-claim spends it to choose a username and a
--    password, and from then on student-login takes those. The synthetic
--    st-<roster-id>@students.cleffy.app address stays, because Supabase needs
--    something to key an auth user on and no inbox is ever asked for.
--  * 'email' — the teacher supplies the student's real address and GoTrue
--    invites it. There is no code, no username and no synthetic address: the
--    student sets a password from the emailed link and signs in client-side,
--    exactly as a teacher does.
--
-- Four states, and this file's CHECK constraint is what makes them the only
-- four. "Invited" always means the same thing on both paths: the auth password
-- is a scramble nobody has ever seen (generateProvisionPassword), so no sign-in
-- path exists for the account at all.
--
--   code  + Invited : login_code_hash set, claimed_at null   -> student-claim
--   code  + Active  : username set, login_code_hash NULL     -> student-login
--   email + Invited : student_email set, claimed_at null     -> the invite link
--   email + Active  : student_email set, claimed_at stamped  -> ordinary sign-in
--
-- A reset returns either row to Invited, and scrambles the password FIRST —
-- that scramble is the actual revocation, exactly as the archive ban is.
-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.managed_students
    add column auth_method text not null default 'code'
        check (auth_method in ('code', 'email')),
    -- Stored canonical-lowercase (normalizeUsername runs before every write and
    -- every lookup), which is what makes the plain unique index below a
    -- CASE-INSENSITIVE uniqueness guarantee without a functional index or a
    -- citext column: two spellings that differ only in case are the same string
    -- by the time either one reaches this table.
    add column username text,
    -- The student's REAL address, on the email path only. Never a synthetic one:
    -- those are derived from the roster id and stored nowhere.
    add column student_email text,
    -- Setup-complete. On the code path the claim stamps it; on the email path
    -- the student does, through mark_student_claimed() below.
    add column claimed_at timestamptz,
    -- Was NOT NULL when the code was a permanent password. It is now absent for
    -- a claimed code student (spent) and for every email student (never minted).
    alter column login_code_hash drop not null;

-- The DB re-checks USERNAME_RE from _shared/studentCodes.ts. A service-role bug
-- that stored an un-normalized spelling would store one student-login could
-- never match — this refuses it at the table instead.
alter table public.managed_students add constraint managed_students_username_shape
    check (username is null or username ~ '^[a-z0-9_]{3,20}$');

-- Plain unique index, not partial: NULLs are distinct in Postgres, so every
-- email row and every unclaimed code row coexists freely.
create unique index managed_students_username_key on public.managed_students (username);

-- The state machine, enforced. Note what is deliberately NOT constrained: an
-- Invited code row may carry a username left over from a previous claim. Reset
-- does not clear it, because the next claim overwrites it and keeping-or-
-- changing the name is the student's call, not the teacher's.
--
-- Existing rows all satisfy the first branch: auth_method defaults to 'code',
-- student_email is null, claimed_at is null, and login_code_hash was NOT NULL.
alter table public.managed_students add constraint managed_students_claim_state check (
    (auth_method = 'code' and student_email is null and (
        (claimed_at is null and login_code_hash is not null)
        or (claimed_at is not null and username is not null and login_code_hash is null)))
    or (auth_method = 'email' and student_email is not null
        and login_code_hash is null and username is null));

-- ---------------------------------------------------------------------------
-- mark_student_claimed — the email student stamps their own setup-complete
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because managed_students has no client write policy at all,
-- by design (see 20260826194426_roster.sql): every write is either a definer
-- function or the service role. A code student's claim is stamped by
-- student-claim under the service role, in the same UPDATE that sets the
-- username; an email student never touches an Edge Function on their way in, so
-- this is the one write they need.
--
-- Scoped to auth.uid(), so the caller can only ever stamp their own row — the
-- function takes no arguments precisely so there is no row to aim it at.
--
-- The auth_method guard is not redundant. Without it, a code student calling
-- this would set claimed_at on a row whose username is still null, the
-- managed_students_claim_state CHECK would reject the UPDATE, and this function
-- would RAISE rather than no-op. Refusing to match the row is the tolerant
-- spelling of the same rule.
create or replace function public.mark_student_claimed () returns void
language sql security definer set search_path = public as $$
    update public.managed_students
    set claimed_at = now()
    where student_user_id = auth.uid()
      and auth_method = 'email'
      and claimed_at is null;
$$;

revoke all on function public.mark_student_claimed () from public;

revoke all on function public.mark_student_claimed () from anon;

grant execute on function public.mark_student_claimed () to authenticated;

-- ---------------------------------------------------------------------------
-- Grants (same convention as roster.sql)
-- ---------------------------------------------------------------------------
-- Additive to roster.sql's column grant, and login_code_hash stays out of it for
-- the same reason it was excluded there: managed_students_select has a student
-- branch, so a table-wide grant would ship the hash of a live claim token down
-- to a browser, for a value nothing on the client reads and that only
-- student-claim ever compares, under the service role.
--
-- The four new columns are all things a client legitimately renders: the student
-- app shows a claimed username on the account screen and the teacher's roster
-- shows which method a student is on, whether they have finished setting up, and
-- which address the invite went to.
grant select (auth_method, username, student_email, claimed_at)
on table public.managed_students to authenticated;

-- roster.sql revoked from public/anon/authenticated but never granted to
-- service_role, which is a no-op hosted (the default ACL is permissive there)
-- and a 42501 locally — the same trap 20260827140000_core_table_grants.sql
-- documents for the core tables. student-claim writes this table under the
-- service role, so it has to hold locally too.
grant all on table public.managed_students to service_role;

-- ===== supabase/migrations/20260828120000_free_tier_no_students.sql =====
-- Free becomes a taste of Personal, not a taste of Teacher.
--
-- Free previously carried students = 3, which made it a miniature teaching
-- plan: a studio could run three students indefinitely without ever reaching
-- the tier that sells the roster. Personal is the individual licence, and Free
-- is the sample of it, so the roster now starts at Teacher.
--
-- Only the 'free' branch changes; every other tier is reproduced exactly as
-- 20260826193902_billing.sql defined it, because create-or-replace rewrites the
-- whole body. tier_limits() stays the single source of truth for the numbers,
-- and the TS mirror in src/features/billing/entitlementsService.ts (FREE_LIMITS)
-- moves with it.
--
-- Existing rows are untouched: a free account that already provisioned students
-- keeps them, and those students keep signing in. What changes is that the
-- account can no longer add more (student-provision returns 402) and the client
-- hides the roster, since limits.students = 0 now reads as "no roster on this
-- plan". Check for such accounts before deploying:
--
--   select ms.teacher_id, count(*)
--   from public.managed_students ms
--   left join public.subscriptions s
--     on s.user_id = ms.teacher_id and s.status = 'active'
--   where s.tier is null
--   group by 1;
create or replace function public.tier_limits (p_tier text) returns jsonb language sql immutable
set search_path = public as $$
    select case p_tier
        -- students = 0 is what makes Personal a solo plan: no roster, no seats.
        when 'personal' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', 0
        )
        when 'teacher' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        when 'academy' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        -- Not purchasable: a provisioned student account. It creates nothing of
        -- its own -- every score it can reach is one a teacher assigned -- and it
        -- is never export-gated, because there is nobody to sell an upgrade to.
        when 'student' then jsonb_build_object(
            'cloud_scores', 0, 'omr_runs', 0, 'vision_reads', 0, 'smart_imports', 0, 'pdf_exports', -1, 'students', 0
        )
        -- Free: the whole practice tool in small amounts, for one player.
        else jsonb_build_object(
            'cloud_scores', 3, 'omr_runs', 3, 'vision_reads', 5, 'smart_imports', 2, 'pdf_exports', 1, 'students', 0
        )
    end;
$$;

-- ===== supabase/migrations/20260828180000_billing_stripe_mode.sql =====
-- Split the billing tables by Stripe account.
--
-- cleffy.io and dev.cleffy.io are two Vercel deploys of one codebase over ONE
-- Supabase project, and at the live flip they stop sharing a Stripe account:
-- production transacts against "Cleffy" (live), dev against "Cleffy sandbox"
-- (test). Two things in here were single-account assumptions that break the
-- moment that is true.
--
-- 1. A Stripe customer id belongs to exactly one account. `billing_customers`
--    allowed one row per user, so a teacher who had ever opened checkout on dev
--    would carry a sandbox `cus_…` into production, and the live Checkout call
--    would fail with "No such customer". A user now gets one customer row per
--    mode.
--
-- 2. A subscription row now records which account created it, so "who is paying"
--    can be answered per account rather than per user. dev.cleffy.io has its own
--    Supabase project, so the two populations are already separate; what this
--    guards is the remaining overlap, where a developer running locally against
--    THIS database checks out in sandbox mode and leaves a test-mode
--    subscription among the real ones.
--
-- Every existing row predates the flip and is therefore sandbox, which is what
-- the 'test' default backfills.

alter table public.billing_customers
    add column mode text not null default 'test' check (mode in ('live', 'test'));

-- One customer per user PER ACCOUNT. stripe_customer_id keeps its own unique
-- constraint: customer ids are globally unique, so it stays a valid lookup key.
alter table public.billing_customers drop constraint billing_customers_pkey;
alter table public.billing_customers add constraint billing_customers_pkey primary key (user_id, mode);

alter table public.subscriptions
    add column mode text not null default 'test' check (mode in ('live', 'test'));

create index if not exists subscriptions_user_mode on public.subscriptions (user_id, mode);

-- Which Stripe account's subscriptions actually entitle.
--
-- Both by default, which is the right answer for every database except one. The
-- `dev` branch project (qdbnlrgylelelvwbkvnm) only ever sees sandbox
-- subscriptions, so narrowing this there would silently drop every dev tester to
-- the free tier — and since that project has its own auth users, a test-mode
-- subscription in it grants nothing on cleffy.io.
--
-- PRODUCTION is the exception, and narrowing it is a step of the live flip
-- (DEPLOY.md §0), run once against jibgwgosihadbjgxdsfe only:
--
--   create or replace function public.entitling_billing_modes () returns text[]
--   language sql immutable set search_path = public as $$
--   select array['live']::text[] $$;
--
-- After that, a sandbox checkout made against production's backend from a
-- non-production origin — localhost, most plausibly — records its subscription
-- but grants nothing, which is what stops a published test card buying a real
-- plan.
create or replace function public.entitling_billing_modes () returns text[] language sql immutable
set search_path = public as $$
select array['live', 'test']::text[]
$$;

revoke all on function public.entitling_billing_modes () from public;
revoke all on function public.entitling_billing_modes () from anon;

-- Re-declared verbatim from 20260826193902_billing.sql except for the two
-- `s.mode = any (...)` predicates, so the diff against that definition is
-- exactly the mode filter and nothing else.
create or replace function public.get_entitlements (p_user uuid default null) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_user uuid;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_sub record;
begin
    if v_caller is null then
        if p_user is null then
            raise exception 'get_entitlements requires p_user when unauthenticated' using errcode = '22023';
        end if;
        v_user := p_user;
    else
        if p_user is not null and p_user <> v_caller then
            raise exception 'cannot read another user''s entitlements' using errcode = '42501';
        end if;
        v_user := v_caller;
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.mode = any (public.entitling_billing_modes ())
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.mode = any (public.entitling_billing_modes ())
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

-- ===== supabase/migrations/20260829130000_support_messages.sql =====
-- Inbound support mail, as received by Resend.
--
-- The endpoint that fills this table (`resend-inbound`) forwards each message on
-- to a human mailbox, but forwarding is delivery, not storage: a forward that
-- bounces is gone, and a mailbox is a poor thing to query. This table is the
-- durable record — the one an agentic triage pass reads from later, rather than
-- re-parsing email.
--
-- `resend_email_id` is UNIQUE and that is load-bearing, exactly as
-- `stripe_events.id` is: Svix retries a delivery until it gets a 2xx, so the
-- same message arrives more than once as a matter of routine, and the insert is
-- what makes the second arrival a no-op instead of a second forwarded email.
--
-- No RLS policy is declared, deliberately. RLS is enabled and every grant is
-- revoked, so the table is reachable only by the service role — i.e. only from
-- an Edge Function. Support mail is written by strangers and can contain
-- anything a customer chose to type: an account number, a password they should
-- not have sent, a complaint about another user. None of it belongs in a
-- browser, so no client role can read it at all.
create table public.support_messages (
    id uuid primary key default gen_random_uuid(),
    -- Resend's id for the received email; the idempotency key.
    resend_email_id text not null unique,
    -- The sending mail system's Message-ID, kept for threading a reply later.
    message_id text,
    from_address text not null,
    to_addresses text[] not null default '{}',
    -- Which of our addresses actually accepted it. With a catch-all domain this
    -- is how triage tells support@ from billing@ without parsing `to`.
    received_for text[] not null default '{}',
    subject text,
    text_body text,
    html_body text,
    -- Metadata only. Attachment bytes stay in Resend; storing them here would
    -- put unscanned stranger-supplied files in our own bucket.
    attachments jsonb not null default '[]'::jsonb,
    -- Null until the forward succeeds. A row with received_at set and
    -- forwarded_at null is precisely the "arrived but nobody was told" case,
    -- which is the one worth alerting on.
    forwarded_at timestamptz,
    forward_error text,
    received_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index support_messages_received on public.support_messages (received_at desc);

-- Finds the arrived-but-not-forwarded rows without scanning the table.
create index support_messages_unforwarded on public.support_messages (received_at desc) where forwarded_at is null;

alter table public.support_messages enable row level security;

revoke all on table public.support_messages from public;

revoke all on table public.support_messages from anon;

revoke all on table public.support_messages from authenticated;

grant all on table public.support_messages to service_role;

-- ===== supabase/migrations/20260830101624_imslp_file_licenses.sql =====
-- Per-file IMSLP license cache: which editions can be downloaded directly.
-- Filled by imslp-work from the rendered work page (the only place IMSLP
-- exposes the regional Non-PD flags); read by imslp-download as a server-side
-- backstop before a smart_imports credit is spent on a restricted file.
-- 30-day staleness window is applied by the readers, not the schema.

create table public.imslp_file_licenses (
    filename text primary key,
    work_title text not null,
    license text not null,
    license_label text,
    restriction text,
    eu_hosted boolean not null default false,
    downloadable boolean not null,
    fetched_at timestamptz not null default now()
);

alter table public.imslp_file_licenses enable row level security;
-- Zero policies — service_role only, like score_cache.
grant all on public.imslp_file_licenses to service_role;
