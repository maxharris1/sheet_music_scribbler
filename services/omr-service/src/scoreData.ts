import { z } from 'zod';

/**
 * ScoreData contract — KEEP IN LOCKSTEP with src/types/scoreData.ts in the
 * app (the app validates everything it reads with its own copy; drift shows
 * up as scores silently failing to parse client-side).
 */

/** Writer version for newly built analyses. */
export const SCORE_DATA_VERSION = 4;
export const TICKS_PER_QUARTER = 480;

/**
 * Velocity for a note the score never gave a dynamic — roughly mezzo-forte.
 * Both the writer (as the base an accent lifts from) and the reader (for notes
 * carrying no `v` at all) must agree on this, or an accented note in an
 * unmarked score is measured against a level nothing else plays at.
 */
export const DEFAULT_VELOCITY = 0.75;

export const HAND_RH = 0;
export const HAND_LH = 1;

const scoreNoteSchema = z.object({
    t: z.number().int().nonnegative(),
    d: z.number().int().positive(),
    p: z.number().int().min(0).max(127),
    h: z.union([z.literal(0), z.literal(1)]),
    v: z.number().min(0).max(1).optional(),
});

/** An engraved chord column: x normalized on the page, t ticks from the measure start. */
const scoreSlotSchema = z.object({
    x: z.number().min(0).max(1),
    t: z.number().int().nonnegative(),
});

const scoreMeasureSchema = z.object({
    n: z.number().int(),
    tick: z.number().int().nonnegative(),
    dTicks: z.number().int().positive(),
    page: z.number().int().min(-1),
    sys: z.number().int().min(-1),
    x0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    /**
     * Which PRINTED measure this entry performs. Equal to the array index for a
     * linear score; on a repeat, several entries share one srcIndex because they
     * sweep the same engraved bar. Anything reasoning about the PAGE rather than
     * the performance must group by it. v3+.
     */
    srcIndex: z.number().int().nonnegative().optional(),
    /** Chord columns from the engraving — lets the playhead sweep note-accurately. */
    sl: z.array(scoreSlotSchema).max(64).optional(),
});

const scoreStaffBandSchema = z.object({
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
});

const scoreSystemSchema = z.object({
    page: z.number().int().nonnegative(),
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    /** Per-staff bands in score order (0 = upper/RH, 1 = lower/LH). */
    staves: z.array(scoreStaffBandSchema).max(4).optional(),
});

const scoreTimeSigSchema = z.object({
    tick: z.number().int().nonnegative(),
    num: z.number().int().positive(),
    den: z.number().int().positive(),
});

const scoreKeySigSchema = z.object({
    tick: z.number().int().nonnegative(),
    fifths: z.number().int().min(-7).max(7),
});

const scoreClefSchema = z.object({
    tick: z.number().int().nonnegative(),
    staff: z.union([z.literal(0), z.literal(1)]),
    sign: z.enum(['G', 'F', 'C']),
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
    k: z.enum(['down', 'up']),
});

export const scoreDataSchema = z.object({
    version: z.number().int(),
    ticksPerQuarter: z.literal(TICKS_PER_QUARTER),
    defaultBpm: z.number().positive().nullable(),
    timeSignatures: z.array(scoreTimeSigSchema).max(64),
    keySignatures: z.array(scoreKeySigSchema).max(64).optional(),
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
