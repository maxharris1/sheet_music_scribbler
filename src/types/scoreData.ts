import { z } from 'zod';

/**
 * ScoreData — the derived musical model of a chart, produced by the OMR
 * service (Audiveris → MusicXML + pixel geometry) and stored in
 * `score_analyses.score`. It is everything playback needs: note events split
 * by hand, and the measure/system geometry that anchors the moving playhead
 * to the rendered PDF. v2 also carries per-staff bands, key signatures, and
 * clefs so the fingering populator can synthesize notehead bboxes. v3 adds a
 * tempo map and fermata holds, so playback can follow the score's own tempo
 * instead of one number for the whole piece. v4 adds sustain-pedal edges.
 *
 * All geometry is normalized 0–1 against its page (the same contract as
 * annotations), so it is zoom/DPI/rotation invariant.
 *
 * KEEP IN LOCKSTEP with services/omr-service/src/scoreData.ts.
 */

/** Current writer version. Readers accept 1 through 4 (see parseScoreData). */
export const SCORE_DATA_VERSION = 4;
/** Oldest ScoreData version the client still serves from cache. */
export const SCORE_DATA_MIN_VERSION = 1;

/** Canonical tick resolution — every duration is normalized to 480 ticks per quarter note. */
export const TICKS_PER_QUARTER = 480;

/**
 * Velocity for a note the score never gave a dynamic — roughly mezzo-forte.
 * Both the writer (as the base an accent lifts from) and the reader (for notes
 * carrying no `v` at all) must agree on this, or an accented note in an
 * unmarked score is measured against a level nothing else plays at.
 */
export const DEFAULT_VELOCITY = 0.75;

/** Right hand (upper staff). */
export const HAND_RH = 0;
/** Left hand (lower staff). */
export const HAND_LH = 1;

const scoreNoteSchema = z.object({
    /** Start, in ticks. */
    t: z.number().int().nonnegative(),
    /** Duration, in ticks (ties already merged). */
    d: z.number().int().positive(),
    /** MIDI pitch 0–127. */
    p: z.number().int().min(0).max(127),
    /** Hand: 0 = right (upper staff), 1 = left (lower staff). */
    h: z.union([z.literal(0), z.literal(1)]),
    /** Velocity 0–1 (optional; playback defaults apply). */
    v: z.number().min(0).max(1).optional(),
});

const scoreMeasureSchema = z.object({
    /** Display number as printed (pickup measures are 0). */
    n: z.number().int(),
    /** Start, in ticks. */
    tick: z.number().int().nonnegative(),
    /** Length, in ticks (pickups keep their real, shorter length). */
    dTicks: z.number().int().positive(),
    /** Page index, or -1 when this measure has no geometry. */
    page: z.number().int().min(-1),
    /** Index into `systems`, or -1 when this measure has no geometry (playhead hides). */
    sys: z.number().int().min(-1),
    /** Horizontal span on the page, normalized 0–1. */
    x0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    /**
     * Which PRINTED measure this entry performs. Equal to the array index for a
     * linear score; on a repeat, several entries share one srcIndex because they
     * sweep the same engraved bar. Anything reasoning about the PAGE rather than
     * the performance must group by it. v3+.
     */
    srcIndex: z.number().int().nonnegative().optional(),
    /** Engraved chord columns ({x: page-normalized, t: ticks from measure start},
     * ascending) — lets the playhead sweep note-accurately instead of linearly. */
    sl: z
        .array(
            z.object({
                x: z.number().min(0).max(1),
                t: z.number().int().nonnegative(),
            }),
        )
        .max(64)
        .optional(),
});

const scoreStaffBandSchema = z.object({
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
});

const scoreSystemSchema = z.object({
    page: z.number().int().nonnegative(),
    /** Vertical band of the system on its page, normalized 0–1. */
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    /** Per-staff bands in score order (0 = upper/RH, 1 = lower/LH). v2+. */
    staves: z.array(scoreStaffBandSchema).max(4).optional(),
});

const scoreTimeSigSchema = z.object({
    tick: z.number().int().nonnegative(),
    num: z.number().int().positive(),
    den: z.number().int().positive(),
});

const scoreKeySigSchema = z.object({
    tick: z.number().int().nonnegative(),
    /** Circle-of-fifths: sharps positive, flats negative (−7…7). */
    fifths: z.number().int().min(-7).max(7),
});

const scoreClefSchema = z.object({
    tick: z.number().int().nonnegative(),
    /** 0 = upper staff, 1 = lower staff. */
    staff: z.union([z.literal(0), z.literal(1)]),
    sign: z.enum(['G', 'F', 'C']),
    /** Staff line counted from the bottom (MusicXML convention), default 2/4/3. */
    line: z.number().int().min(1).max(5).optional(),
});

/**
 * A tempo in force from `tick` onward, in quarter-notes per minute. Gradual
 * changes (rit., accel.) are pre-discretized into a run of these at build time,
 * which keeps the reader's tick-to-seconds map a plain prefix sum — exactly
 * invertible, with no closed-form integral to get wrong. v3+.
 */
const scoreTempoSchema = z.object({
    tick: z.number().int().nonnegative(),
    /** Quarter-notes per minute. */
    bpm: z.number().min(10).max(400),
    /** Where it came from; 'word' means inferred from an Italian term. */
    src: z.enum(['sound', 'metronome', 'word', 'ramp']).optional(),
});

/**
 * A fermata: on ARRIVING at `tick`, the clock stops for `beats` before moving on.
 * Modelled as a clock stop rather than a tempo dip so it leaves tick space
 * untouched — a dip would also slow the metronome and generate beats inside the
 * hold. Expressed in beats so it scales with the practice tempo. v3+.
 */
const scoreHoldSchema = z.object({
    tick: z.number().int().nonnegative(),
    beats: z.number().positive().max(16),
});

/**
 * One sustain-pedal edge. Edges rather than spans: OMR routinely loses one end
 * of a pedal line, and a missing edge costs a single note's ring instead of
 * invalidating a whole span. A re-catch (MusicXML `change`) is two edges on the
 * same tick, 'up' before 'down' — order carries the meaning, so anything
 * re-sorting this array must sort stably. v4+.
 */
const scorePedalSchema = z.object({
    tick: z.number().int().nonnegative(),
    /** 'down' takes the pedal, 'up' releases it. */
    k: z.enum(['down', 'up']),
});

export const scoreDataSchema = z.object({
    version: z.number().int(),
    ticksPerQuarter: z.literal(TICKS_PER_QUARTER),
    defaultBpm: z.number().positive().nullable(),
    timeSignatures: z.array(scoreTimeSigSchema).max(64),
    /** v2+; absent on v1 caches. */
    keySignatures: z.array(scoreKeySigSchema).max(64).optional(),
    /** v2+; absent on v1 caches. */
    clefs: z.array(scoreClefSchema).max(64).optional(),
    /** v3+; absent on v1/v2 caches, where defaultBpm is the whole story. */
    tempos: z.array(scoreTempoSchema).max(512).optional(),
    /** v3+; fermata holds. */
    holds: z.array(scoreHoldSchema).max(128).optional(),
    /** v4+; sustain-pedal edges in tick order. */
    pedals: z.array(scorePedalSchema).max(256).optional(),
    totalTicks: z.number().int().positive(),
    notes: z.array(scoreNoteSchema).max(50_000),
    measures: z.array(scoreMeasureSchema).max(2_000),
    systems: z.array(scoreSystemSchema).max(500),
    /** Machine-readable degradation notes, e.g. 'repeats_ignored', 'single_staff_all_rh'. */
    warnings: z.array(z.string().max(64)).max(32),
});

export type ScoreNote = z.infer<typeof scoreNoteSchema>;
export type ScoreMeasure = z.infer<typeof scoreMeasureSchema>;
export type ScoreSystem = z.infer<typeof scoreSystemSchema>;
export type ScoreTimeSig = z.infer<typeof scoreTimeSigSchema>;
export type ScoreKeySig = z.infer<typeof scoreKeySigSchema>;
export type ScoreClef = z.infer<typeof scoreClefSchema>;
export type ScoreTempo = z.infer<typeof scoreTempoSchema>;
export type ScoreHold = z.infer<typeof scoreHoldSchema>;
export type ScorePedal = z.infer<typeof scorePedalSchema>;
export type ScoreData = z.infer<typeof scoreDataSchema>;

/**
 * Parse ScoreData arriving from Postgres jsonb or the Dexie cache. Malformed
 * or future-versioned payloads degrade to a warn + null, never a crash
 * (wire.ts discipline). Notes and measures are defensively re-sorted — every
 * consumer binary-searches them. Older caches stay valid: every field added
 * after v1 is optional, so readers use `?? []` rather than a version branch.
 */
export const parseScoreData = (raw: unknown): ScoreData | null => {
    const parsed = scoreDataSchema.safeParse(raw);
    if (!parsed.success) {
        console.warn('Ignoring malformed ScoreData', parsed.error.issues[0]?.message);
        return null;
    }
    if (parsed.data.version < SCORE_DATA_MIN_VERSION || parsed.data.version > SCORE_DATA_VERSION) {
        console.warn(`Ignoring ScoreData with unsupported version ${parsed.data.version}`);
        return null;
    }
    return {
        ...parsed.data,
        notes: [...parsed.data.notes].sort((a, b) => a.t - b.t),
        measures: [...parsed.data.measures].sort((a, b) => a.tick - b.tick),
        timeSignatures: [...parsed.data.timeSignatures].sort((a, b) => a.tick - b.tick),
        keySignatures: parsed.data.keySignatures
            ? [...parsed.data.keySignatures].sort((a, b) => a.tick - b.tick)
            : undefined,
        clefs: parsed.data.clefs ? [...parsed.data.clefs].sort((a, b) => a.tick - b.tick) : undefined,
        tempos: parsed.data.tempos ? [...parsed.data.tempos].sort((a, b) => a.tick - b.tick) : undefined,
        holds: parsed.data.holds ? [...parsed.data.holds].sort((a, b) => a.tick - b.tick) : undefined,
        // Sorting by tick alone is enough because Array#sort is stable: a
        // re-catch writes 'up' then 'down' on one tick and must stay that way.
        pedals: parsed.data.pedals ? [...parsed.data.pedals].sort((a, b) => a.tick - b.tick) : undefined,
    };
};

/** True when the score has any left-hand material (drives the LH mute control). */
export const hasLeftHand = (score: ScoreData): boolean => score.notes.some((note) => note.h === HAND_LH);

/** Key signature in force at a tick (last change at or before it); 0 when unknown. */
export const keySigAt = (score: ScoreData, tick: number): number => {
    let fifths = 0;
    for (const sig of score.keySignatures ?? []) {
        if (sig.tick > tick) {
            break;
        }
        fifths = sig.fifths;
    }
    return fifths;
};

/** Clef in force for a staff at a tick; defaults treble/bass by staff. */
export const clefAt = (score: ScoreData, tick: number, staff: 0 | 1): ScoreClef => {
    let active: ScoreClef = {
        tick: 0,
        staff,
        sign: staff === HAND_LH ? 'F' : 'G',
        line: staff === HAND_LH ? 4 : 2,
    };
    for (const clef of score.clefs ?? []) {
        if (clef.tick > tick) {
            break;
        }
        if (clef.staff === staff) {
            active = clef;
        }
    }
    return active;
};

/**
 * Quarter-BPM in force at a tick. Falls back to `defaultBpm`, so a v1/v2 payload
 * with no tempo map behaves exactly as it always did.
 */
export const tempoAt = (score: ScoreData, tick: number, fallback: number): number => {
    let bpm = score.defaultBpm ?? fallback;
    for (const tempo of score.tempos ?? []) {
        if (tempo.tick > tick) {
            break;
        }
        bpm = tempo.bpm;
    }
    return bpm;
};

/**
 * True when the opening tempo was guessed rather than printed.
 *
 * The warnings are consulted as well as the map, because two real cases have no
 * `tempos[0]` to look at: a shard-merged score whose map was dropped, and a
 * tempo derived from the meter alone, which is deliberately carried as
 * `defaultBpm` + a warning rather than as a tempo entry with a new `src`.
 *
 * They only get a say when no tempo entry sits at tick 0, though: a metronome
 * mark at the top of page 1 must not read as a guess because some later,
 * unmarked stretch of the score carried a warning. The converse is a score
 * whose first printed tempo arrives pages in — its opening really is the
 * guessed `defaultBpm`, and the map having entries further along must not
 * hide that.
 */
export const tempoIsInferred = (score: ScoreData): boolean =>
    score.tempos?.[0]?.src === 'word' ||
    ((score.tempos?.[0]?.tick ?? Number.POSITIVE_INFINITY) > 0 &&
        (score.warnings.includes('tempo_inferred') || score.warnings.includes('tempo_defaulted')));
