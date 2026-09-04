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
