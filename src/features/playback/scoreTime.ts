import type { ScoreData, ScoreMeasure, ScoreNote, ScoreTimeSig } from '@/types/scoreData';
import { TICKS_PER_QUARTER } from '@/types/scoreData';

/**
 * Pure tick/measure/beat math shared by the playback engine, the playhead,
 * and the transport. Everything here is side-effect free and unit tested —
 * keep it that way (geometry.ts discipline).
 */

/** Seconds per tick at a given quarter-note BPM. */
export const secondsPerTick = (bpm: number): number => 60 / (bpm * TICKS_PER_QUARTER);

/** Ticks per beat for a time-signature denominator (den 4 → 480, den 8 → 240). */
export const ticksPerBeat = (den: number): number => (TICKS_PER_QUARTER * 4) / den;

const DEFAULT_TIME_SIG: ScoreTimeSig = { tick: 0, num: 4, den: 4 };

/** The time signature in effect at a tick (last change at or before it). */
export const timeSigAt = (timeSignatures: readonly ScoreTimeSig[], tick: number): ScoreTimeSig => {
    let active = timeSignatures[0] ?? DEFAULT_TIME_SIG;
    for (const sig of timeSignatures) {
        if (sig.tick > tick) {
            break;
        }
        active = sig;
    }
    return active;
};

/**
 * Index of the measure containing `tick` (greatest start ≤ tick), clamped to
 * the first/last measure for out-of-range ticks. Returns -1 only for an
 * empty measure list.
 */
export const measureIndexAtTick = (measures: readonly ScoreMeasure[], tick: number): number => {
    if (measures.length === 0) {
        return -1;
    }
    let lo = 0;
    let hi = measures.length - 1;
    if (tick <= (measures[0]?.tick ?? 0)) {
        return 0;
    }
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((measures[mid]?.tick ?? 0) <= tick) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
};

/** Fraction (0–1) of the way through a measure at `tick`. */
export const fractionWithinMeasure = (measure: ScoreMeasure, tick: number): number => {
    if (measure.dTicks <= 0) {
        return 0;
    }
    return Math.min(1, Math.max(0, (tick - measure.tick) / measure.dTicks));
};

/**
 * Horizontal playhead position within a measure, riding the engraved chord
 * columns when the analysis provides them (measure.sl): the line sits exactly
 * on each chord as it sounds and moves proportionally between columns — slow
 * through long values, quick through runs — instead of pretending time is
 * spaced evenly across the bar. Falls back to linear interpolation.
 */
export const xAtTickInMeasure = (measure: ScoreMeasure, tick: number): number => {
    const slots = measure.sl;
    if (!slots || slots.length === 0) {
        return measure.x0 + fractionWithinMeasure(measure, tick) * (measure.x1 - measure.x0);
    }
    const rel = Math.min(measure.dTicks, Math.max(0, tick - measure.tick));
    const first = slots[0];
    if (!first || rel <= first.t) {
        // The pre-slot zone is the measure header (clef/key/time) — no music
        // time lives there, so the line waits on the first chord column.
        return first ? first.x : measure.x0;
    }
    for (let i = 0; i + 1 < slots.length; i++) {
        const a = slots[i];
        const b = slots[i + 1];
        if (a && b && rel < b.t) {
            return a.x + ((rel - a.t) / (b.t - a.t)) * (b.x - a.x);
        }
    }
    const last = slots[slots.length - 1];
    if (!last) {
        return measure.x0;
    }
    const span = measure.dTicks - last.t;
    if (span <= 0) {
        return last.x;
    }
    return last.x + Math.min(1, (rel - last.t) / span) * (measure.x1 - last.x);
};

/**
 * Inverse of {@link xAtTickInMeasure}: tick within a measure at a normalized
 * page x. Used by the fingering OMR populator to turn a marquee into a tick
 * range. Clamps x to the measure span; pre-slot (header) x maps to the first
 * chord column's tick.
 */
export const tickAtXInMeasure = (measure: ScoreMeasure, nx: number): number => {
    const x = Math.min(measure.x1, Math.max(measure.x0, nx));
    const slots = measure.sl;
    if (!slots || slots.length === 0) {
        const width = measure.x1 - measure.x0;
        const frac = width <= 0 ? 0 : (x - measure.x0) / width;
        return measure.tick + Math.round(frac * measure.dTicks);
    }
    const first = slots[0];
    if (!first) {
        return measure.tick;
    }
    if (x <= first.x) {
        return measure.tick + first.t;
    }
    for (let i = 0; i + 1 < slots.length; i++) {
        const a = slots[i];
        const b = slots[i + 1];
        if (a && b && x < b.x) {
            const span = b.x - a.x;
            const frac = span <= 0 ? 0 : (x - a.x) / span;
            return measure.tick + Math.round(a.t + frac * (b.t - a.t));
        }
    }
    const last = slots[slots.length - 1];
    if (!last) {
        return measure.tick;
    }
    const tail = measure.x1 - last.x;
    if (tail <= 0) {
        return measure.tick + last.t;
    }
    const frac = Math.min(1, (x - last.x) / tail);
    return measure.tick + Math.round(last.t + frac * (measure.dTicks - last.t));
};

/**
 * Prev/next-measure stepping, with the standard transport nuance: stepping
 * back from >20% into a measure returns to that measure's own start first.
 * Returns the target start tick.
 */
export const stepMeasure = (measures: readonly ScoreMeasure[], tick: number, delta: -1 | 1): number => {
    const index = measureIndexAtTick(measures, tick);
    if (index < 0) {
        return 0;
    }
    const current = measures[index];
    if (!current) {
        return 0;
    }
    if (delta === 1) {
        const next = measures[index + 1];
        return next ? next.tick : current.tick;
    }
    if (tick - current.tick > current.dTicks * 0.2) {
        return current.tick;
    }
    const prev = measures[index - 1];
    return prev ? prev.tick : current.tick;
};

/** Lower bound: index of the first note starting at or after `tick`. */
export const firstNoteIndexAtOrAfter = (notes: readonly ScoreNote[], tick: number): number => {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((notes[mid]?.t ?? 0) < tick) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
};

/** Safety cap: no sane measure has more beats than this (guards corrupt data). */
const MAX_BEATS_PER_MEASURE = 64;

/**
 * The FELT pulse of a signature: compound meters (6/8, 9/8, 12/8) click in
 * dotted-quarter beats, not a hail of eighths.
 */
export const clickBeatTicks = (sig: ScoreTimeSig): number => {
    const base = ticksPerBeat(sig.den);
    return sig.den >= 8 && sig.num >= 6 && sig.num % 3 === 0 ? base * 3 : base;
};

/** Full notated bar length of a signature, in ticks. */
export const barTicks = (sig: ScoreTimeSig): number => sig.num * ticksPerBeat(sig.den);

/** Velocity added on a full bar's downbeat — shared by note shaping, not the click. */
export const DOWNBEAT_ACCENT = 0.025;
/** Velocity added on the secondary strong beat of an even meter. */
export const SECONDARY_ACCENT = 0.012;

/**
 * How much a beat contributes to a note's velocity. The metronome still uses
 * {@link beatsForMeasure}'s boolean accent (downbeat only); this is the extra
 * hierarchy a player puts on the page — downbeat, the half-bar in even meters
 * of four or more beats (and in 6/8, the second dotted beat), nothing on a
 * pickup. Two-beat simple meters (2/4, 2/2) have no secondary: beat two of a
 * march is weak. Triple meters (3/4, 3/8, 9/8) have none either.
 *
 * Compound signatures are counted in the dotted beats {@link clickBeatTicks}
 * already returns, so 6/8's secondary is the second dotted quarter (index 1)
 * and 12/8's is index 2.
 */
export const beatWeight = (sig: ScoreTimeSig, beatIndex: number, isFullBar: boolean): number => {
    if (!isFullBar) {
        return 0;
    }
    if (beatIndex === 0) {
        return DOWNBEAT_ACCENT;
    }
    const nBeats = barTicks(sig) / clickBeatTicks(sig);
    // 2/4 and 2/2 click in two simple beats; 6/8 clicks in two dotted beats
    // and keeps the secondary. clickBeatTicks equals the denominator-beat
    // only in the simple case.
    const simpleDuple = nBeats === 2 && clickBeatTicks(sig) === ticksPerBeat(sig.den);
    if (nBeats % 2 === 0 && beatIndex === nBeats / 2 && !simpleDuple) {
        return SECONDARY_ACCENT;
    }
    return 0;
};

export interface BeatTick {
    tick: number;
    /** True on real downbeats — never on pickups or truncated bars. */
    accent: boolean;
}

/**
 * Metronome beats within a measure, anchored to its barline. Pickups and
 * short/irregular bars get beats but no downbeat accent (a pickup is not
 * beat one).
 */
export const beatsForMeasure = (measure: ScoreMeasure, timeSignatures: readonly ScoreTimeSig[]): BeatTick[] => {
    const sig = timeSigAt(timeSignatures, measure.tick);
    const beat = clickBeatTicks(sig);
    const isFullBar = measure.dTicks >= barTicks(sig);
    const beats: BeatTick[] = [];
    for (let k = 0; k < MAX_BEATS_PER_MEASURE; k++) {
        const tick = measure.tick + k * beat;
        if (tick >= measure.tick + measure.dTicks) {
            break;
        }
        beats.push({ tick, accent: k === 0 && isFullBar });
    }
    return beats;
};

export interface CountInClick {
    /** Ticks BEFORE the start position (clicks are scheduled at start − offset). */
    offsetTicks: number;
    accent: boolean;
}

/**
 * Count-in clicks for entering at `startTick`: one full bar, plus the beats
 * of the entry bar that precede the entry point. Starting on a downbeat
 * gives the classic single bar; starting on a pickup (which occupies the END
 * of its notated bar) counts "ONE two three four, ONE two three…" so the
 * player comes in on the right beat.
 */
export const countInClicks = (score: ScoreData, startTick: number): CountInClick[] => {
    const sig = timeSigAt(score.timeSignatures, startTick);
    const beat = clickBeatTicks(sig);
    const fullBar = barTicks(sig);

    let posInBar = 0;
    const measure = score.measures[measureIndexAtTick(score.measures, startTick)];
    if (measure) {
        const shortfall = Math.max(0, fullBar - measure.dTicks);
        posInBar = Math.max(0, Math.min(fullBar - 1, shortfall + (startTick - measure.tick)));
    }
    // Snap odd entry points down onto the beat grid.
    posInBar = Math.floor(posInBar / beat) * beat;

    const entryBarStart = posInBar;
    const preBarStart = posInBar + fullBar;
    const clicks: CountInClick[] = [];
    for (let offset = preBarStart; offset > 0; offset -= beat) {
        clicks.push({ offsetTicks: offset, accent: offset === preBarStart || offset === entryBarStart });
    }
    return clicks;
};

/** Start tick of a measure by index, clamped to the score. */
export const measureStartTick = (measures: readonly ScoreMeasure[], index: number): number => {
    const clamped = measures[Math.min(measures.length - 1, Math.max(0, index))];
    return clamped ? clamped.tick : 0;
};

/** End tick (exclusive) of a measure by index. */
export const measureEndTick = (measures: readonly ScoreMeasure[], index: number): number => {
    const measure = measures[Math.min(measures.length - 1, Math.max(0, index))];
    return measure ? measure.tick + measure.dTicks : 0;
};

/**
 * Measure under a normalized point on a page (tap-to-seek). Matches the
 * system whose y-band contains the point, then the measure whose x-range
 * contains it. Returns the measure index, or -1.
 */
export const measureIndexAtPagePoint = (
    score: ScoreData,
    pageIndex: number,
    nx: number,
    ny: number,
    /**
     * Where playback currently is. A printed bar inside a repeat is performed
     * more than once, and tapping it should seek to the pass being played, not
     * always back to the first. Omit for the plain first-match behaviour.
     */
    nearTick?: number,
): number => {
    let best = -1;
    for (let sysIndex = 0; sysIndex < score.systems.length; sysIndex++) {
        const system = score.systems[sysIndex];
        if (!system || system.page !== pageIndex || ny < system.y0 || ny > system.y1) {
            continue;
        }
        for (let i = 0; i < score.measures.length; i++) {
            const measure = score.measures[i];
            if (!measure || measure.sys !== sysIndex || nx < measure.x0 || nx > measure.x1) {
                continue;
            }
            if (nearTick === undefined) {
                return i;
            }
            const bestMeasure = best >= 0 ? score.measures[best] : undefined;
            if (!bestMeasure || Math.abs(measure.tick - nearTick) < Math.abs(bestMeasure.tick - nearTick)) {
                best = i;
            }
        }
    }
    return best;
};

/**
 * Tick↔seconds conversion under a tempo map.
 *
 * Segment `i` runs from `ticks[i]` to `ticks[i+1]` at `spt[i]` seconds per tick.
 * `at[i]` is the wall time of ARRIVING at `ticks[i]`, and `hold[i]` is the pause
 * taken on arrival there before moving on — a fermata stops the clock rather
 * than bending the tempo, so tick space stays untouched and the metronome does
 * not generate beats inside the pause.
 *
 * Everything is a prefix sum, so it is exactly invertible: no closed-form
 * integral, and gradual tempo changes are already discretized by the writer.
 */
export interface TempoMap {
    ticks: number[];
    spt: number[];
    at: number[];
    hold: number[];
}

/** How far an unmarked close slows — reached on the last beat of the final bar. */
export const FINAL_RIT_FACTOR = 0.85;

/**
 * Movement ends: the score's close, plus every barline where numbering restarts
 * AND the engraved-bar identity advances. Repeats and D.C. jumps also reset
 * `n`, but their `srcIndex` goes down, so they are not a new movement.
 */
const movementEnds = (score: ScoreData): number[] => {
    const ends = new Set<number>([score.totalTicks]);
    const measures = score.measures;
    for (let i = 1; i < measures.length; i++) {
        const curr = measures[i];
        const prev = measures[i - 1];
        if (!curr || !prev) {
            continue;
        }
        const currSrc = curr.srcIndex ?? i;
        const prevSrc = prev.srcIndex ?? i - 1;
        if (curr.n <= 1 && prev.n > 1 && currSrc > prevSrc) {
            ends.add(curr.tick);
        }
    }
    return [...ends].sort((a, b) => a - b);
};

/**
 * One tempo point per beat of the last full bar before each movement end,
 * easing linearly from the tempo in force at the barline down to
 * {@link FINAL_RIT_FACTOR} of it on the last beat. A printed rit. (`src: 'ramp'`
 * in the last two bars) or a fermata in the last bar already does this job, so
 * those ends are left alone. Pickup-length last bars are skipped: there is no
 * full bar to stretch.
 *
 * Points are in the score's own BPM, before any practice-tempo scale — the
 * caller folds them in as if they had been printed.
 */
export const finalRitardandoPoints = (score: ScoreData, fallbackBpm: number): Array<{ tick: number; bpm: number }> => {
    const tempos = score.tempos ?? [];
    const holds = score.holds ?? [];
    const points: Array<{ tick: number; bpm: number }> = [];

    const tempoInForce = (tick: number): number => {
        let bpm = fallbackBpm;
        for (const tempo of tempos) {
            if (tempo.tick > tick) {
                break;
            }
            bpm = tempo.bpm;
        }
        return bpm;
    };

    for (const end of movementEnds(score)) {
        const prior: ScoreMeasure[] = [];
        for (const measure of score.measures) {
            if (measure.tick >= end) {
                break;
            }
            prior.push(measure);
        }
        const last = prior[prior.length - 1];
        if (!last) {
            continue;
        }
        const sig = timeSigAt(score.timeSignatures, last.tick);
        if (last.dTicks < barTicks(sig)) {
            continue;
        }
        const windowStart = prior[Math.max(0, prior.length - 2)]?.tick ?? last.tick;
        const rampInWindow = tempos.some(
            (tempo) => tempo.src === 'ramp' && tempo.tick >= windowStart && tempo.tick < end,
        );
        if (rampInWindow) {
            continue;
        }
        const holdInLast = holds.some(
            (hold) => hold.tick >= last.tick && hold.tick < end && hold.tick < last.tick + last.dTicks,
        );
        if (holdInLast) {
            continue;
        }

        const beat = clickBeatTicks(sig);
        const from = tempoInForce(last.tick);
        const target = from * FINAL_RIT_FACTOR;
        const beats: number[] = [];
        for (let k = 0; k < MAX_BEATS_PER_MEASURE; k++) {
            const tick = last.tick + k * beat;
            if (tick >= last.tick + last.dTicks) {
                break;
            }
            beats.push(tick);
        }
        if (beats.length === 0) {
            continue;
        }
        const denom = Math.max(1, beats.length - 1);
        for (let i = 0; i < beats.length; i++) {
            const tick = beats[i];
            if (tick === undefined) {
                continue;
            }
            const progress = beats.length === 1 ? 1 : i / denom;
            points.push({ tick, bpm: from + (target - from) * progress });
        }
    }
    return points;
};

/** Practice-tempo scaling is a single multiplier over the whole map. */
export const buildTempoMap = (score: ScoreData, scale: number, fallbackBpm: number): TempoMap => {
    const safeScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
    const tempos = score.tempos ?? [];
    const holds = score.holds ?? [];
    // Fold the unmarked close in before scaling, the same way a printed rit. is.
    const rit = finalRitardandoPoints(score, score.defaultBpm ?? fallbackBpm);
    const points = [...tempos.map((tempo) => ({ tick: tempo.tick, bpm: tempo.bpm })), ...rit].sort(
        (a, b) => a.tick - b.tick,
    );

    const boundaries = new Set<number>([0]);
    for (const point of points) {
        boundaries.add(point.tick);
    }
    for (const hold of holds) {
        boundaries.add(hold.tick);
    }
    const ticks = [...boundaries].sort((a, b) => a - b);

    const bpmAt = (tick: number): number => {
        let bpm = score.defaultBpm ?? fallbackBpm;
        for (const point of points) {
            if (point.tick > tick) {
                break;
            }
            bpm = point.bpm;
        }
        return bpm;
    };
    const holdBeatsAt = (tick: number): number => {
        let beats = 0;
        for (const hold of holds) {
            if (hold.tick === tick) {
                beats = Math.max(beats, hold.beats);
            }
        }
        return beats;
    };

    const spt: number[] = [];
    const hold: number[] = [];
    const at: number[] = [];
    for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i] ?? 0;
        const bpm = Math.max(1, bpmAt(tick) * safeScale);
        spt.push(secondsPerTick(bpm));
        // A hold is measured in beats, so it stretches with the practice tempo.
        hold.push((holdBeatsAt(tick) * 60) / bpm);
        if (i === 0) {
            at.push(0);
        } else {
            const prev = i - 1;
            at.push((at[prev] ?? 0) + (hold[prev] ?? 0) + (tick - (ticks[prev] ?? 0)) * (spt[prev] ?? 0));
        }
    }
    return { ticks, spt, at, hold };
};

/** Index of the segment containing `tick` (0 for anything before the start). */
const segmentAt = (map: TempoMap, tick: number): number => {
    let lo = 0;
    let hi = map.ticks.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((map.ticks[mid] ?? 0) <= tick) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
};

/**
 * Wall seconds at a tick. A hold sitting exactly on `tick` is NOT counted: the
 * note there still starts on time, and only what comes after it is delayed —
 * which is precisely what makes a fermata ring rather than arrive late.
 * Extrapolates before tick 0, which the count-in needs.
 */
export const secondsAtTick = (map: TempoMap, tick: number): number => {
    const first = map.ticks[0] ?? 0;
    if (tick <= first) {
        return (map.at[0] ?? 0) + (tick - first) * (map.spt[0] ?? 0);
    }
    const i = segmentAt(map, tick);
    const base = map.at[i] ?? 0;
    if (tick === (map.ticks[i] ?? 0)) {
        return base;
    }
    return base + (map.hold[i] ?? 0) + (tick - (map.ticks[i] ?? 0)) * (map.spt[i] ?? 0);
};

/** Inverse of {@link secondsAtTick}; parks on a hold's tick for its duration. */
export const tickAtSeconds = (map: TempoMap, seconds: number): number => {
    const firstAt = map.at[0] ?? 0;
    if (seconds <= firstAt) {
        return (map.ticks[0] ?? 0) + (seconds - firstAt) / (map.spt[0] ?? 1);
    }
    let lo = 0;
    let hi = map.at.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((map.at[mid] ?? 0) <= seconds) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    const start = map.ticks[lo] ?? 0;
    const elapsed = seconds - (map.at[lo] ?? 0) - (map.hold[lo] ?? 0);
    if (elapsed <= 0) {
        return start; // still inside the fermata — the playhead waits here
    }
    const tick = start + elapsed / (map.spt[lo] ?? 1);
    const next = map.ticks[lo + 1];
    return next !== undefined ? Math.min(tick, next) : tick;
};

/** Seconds per tick in force at a tick — for showing the tempo actually playing. */
export const sptAtTick = (map: TempoMap, tick: number): number =>
    map.spt[segmentAt(map, tick)] ?? map.spt[0] ?? secondsPerTick(DEFAULT_MAP_BPM);

const DEFAULT_MAP_BPM = 100;

/** Quarter-BPM in force at a tick, as the map is actually playing it. */
export const bpmAtTick = (map: TempoMap, tick: number): number => 60 / (sptAtTick(map, tick) * TICKS_PER_QUARTER);
