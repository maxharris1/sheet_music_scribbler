import { getSupabase } from '@/lib/supabase';
import { getDb } from '@/sync/db';
import type { CachedScoreAnalysis } from '@/sync/db';
import type { ScoreAnalysisStatus } from '@/types/database';
import { parseScoreData } from '@/types/scoreData';

/**
 * Client access to score_analyses. Free-plan discipline: polling reads the
 * lifecycle columns only — the ScoreData jsonb travels once, when the row is
 * ready, and then lives in the Dexie scoreCache for offline replays.
 */

export interface ScoreAnalysisStatusRow {
    status: ScoreAnalysisStatus;
    error: string | null;
    progress: number | null;
    updatedAt: string;
}

/**
 * The svc-<n> this client expects. Keep in step with ENGINE_VERSION in
 * services/omr-service/src/job.ts: an analysis produced by an older engine
 * still plays, but is missing whatever that bump added, and nothing else in
 * the system ever re-runs it — so the reader has to be offered the choice.
 *
 * This number follows the service's only when the bump changed what a score
 * SOUNDS like. svc-6 was page sharding — the same PDF in, byte-for-byte the
 * same ScoreData out, only sooner — so it deliberately stayed behind at 5
 * rather than asking every reader to regenerate an identical analysis. svc-7
 * (D.C./D.S. roadmaps, the tempo map surviving a shard merge, pedal) changes
 * the performance, so it is worth the interruption. svc-8 seeds expression
 * across the page-cut seam, which changes what every 4+ page score sounds like.
 * svc-9 realises ornaments, appoggiaturas, tempo-relative graces and swing.
 */
export const CURRENT_ENGINE_GENERATION = 9;

const engineGeneration = (engineVersion: string | null): number | null => {
    const match = /\+svc-(\d+)$/.exec(engineVersion ?? '');
    if (!match?.[1]) {
        return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
};

/** True when this analysis predates the current engine and could be improved. */
export const analysisIsStale = (engineVersion: string | null): boolean => {
    const generation = engineGeneration(engineVersion);
    // Absent or unreadable means it predates version stamping, so it is the
    // oldest data there is. This is only ever asked of a READY analysis, where
    // a missing stamp cannot mean "not finished yet". Five rows in the live
    // database are in exactly this state and would otherwise never be offered
    // a re-run — the documents most in need of one.
    return generation === null || generation < CURRENT_ENGINE_GENERATION;
};

/** A processing row untouched for this long is a lost job (service died/recycled). */
export const STALE_PROCESSING_MS = 20 * 60 * 1000;

export const isProcessingStale = (updatedAt: string): boolean =>
    Date.now() - new Date(updatedAt).getTime() > STALE_PROCESSING_MS;

/** Lifecycle-only poll — never pulls the jsonb. Null = no analysis row yet. */
export const fetchScoreAnalysisStatus = async (docId: string): Promise<ScoreAnalysisStatusRow | null> => {
    const { data, error } = await getSupabase()
        .from('score_analyses')
        .select('status, error, progress, updated_at')
        .eq('document_id', docId)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not check play-along status: ${error.message}`);
    }
    if (!data) {
        return null;
    }
    return { status: data.status, error: data.error, progress: data.progress, updatedAt: data.updated_at };
};

/** Full row (including ScoreData), validated and mirrored into the Dexie cache. */
export const fetchScoreAnalysisFull = async (docId: string): Promise<CachedScoreAnalysis | null> => {
    const { data, error } = await getSupabase()
        .from('score_analyses')
        .select('*')
        .eq('document_id', docId)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not load play-along data: ${error.message}`);
    }
    if (!data) {
        return null;
    }
    const previous = await getDb().scoreCache.get(docId);
    const cached: CachedScoreAnalysis = {
        docId,
        status: data.status,
        error: data.error,
        score: data.score ? parseScoreData(data.score) : null,
        engineVersion: data.engine_version,
        bpmDefault: data.bpm_default,
        fetchedAt: new Date().toISOString(),
        ...(previous?.bpmOverride !== undefined ? { bpmOverride: previous.bpmOverride } : {}),
    };
    await getDb().scoreCache.put(cached);
    return cached;
};

export const loadCachedScoreAnalysis = async (docId: string): Promise<CachedScoreAnalysis | null> => {
    return (await getDb().scoreCache.get(docId)) ?? null;
};

/** Remember the user's practice tempo for this score across sessions. */
export const saveBpmOverride = async (docId: string, bpm: number): Promise<void> => {
    const cached = await getDb().scoreCache.get(docId);
    if (cached) {
        await getDb().scoreCache.put({ ...cached, bpmOverride: bpm });
    }
};

export interface RequestAnalysisResult {
    ok: boolean;
    /** Machine code when not ok (e.g. already_running, too_large, service_unreachable). */
    code?: string;
}

/** Kick off (or retry) analysis via the score-analyze Edge Function. */
export const requestScoreAnalysis = async (docId: string): Promise<RequestAnalysisResult> => {
    const { data, error } = await getSupabase().functions.invoke<{ ok: boolean; code?: string }>('score-analyze', {
        body: { documentId: docId },
    });
    if (error) {
        const context = (error as { context?: Response }).context;
        if (context) {
            try {
                const body = (await context.json()) as { code?: string };
                if (typeof body.code === 'string') {
                    return { ok: false, code: body.code };
                }
            } catch {
                // fall through
            }
        }
        return { ok: false, code: 'service_unreachable' };
    }
    if (data && data.ok === false) {
        return { ok: false, code: data.code ?? 'internal' };
    }
    return { ok: true };
};
