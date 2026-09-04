import { capHolds, capPedals, capTempoEvents } from './caps.js';
import { ERROR_CODES, JobError } from './errors.js';
import type { MusicalScore } from './musicxml.js';
import type { OmrGeometry } from './omrGeometry.js';
import { planRepeats, resolveJump, unrollRepeats } from './repeats.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER, scoreDataSchema } from './scoreData.js';
import type { ScoreData, ScoreMeasure, ScoreNote, ScoreSystem } from './scoreData.js';

/**
 * Disclosures about structure, decided here and nowhere else. The parser records
 * what is engraved; only at this point are the marks paired with real measures
 * and a plan either resolved or refused, so anything a caller arrived with is
 * discarded rather than trusted.
 */
const STRUCTURE_WARNINGS = ['repeats_unrolled', 'repeats_ignored', 'jumps_performed', 'jumps_ignored'];

const SWING_SHIFT = 80;
const EIGHTH_MIN = 200;
const EIGHTH_MAX = 240;

/**
 * Long–short eighths, as a heading of "swing" asks for. Off-beat eighths
 * delay by a 16th-note's worth of ticks; the on-beat eighth in the same hand
 * grows to meet them. Sixteenths, triplets and anything longer stay even.
 */
const applySwing = (notes: ScoreNote[]): ScoreNote[] => {
    const out = notes.map((n) => ({ ...n }));
    const grown = new Set<number>();
    for (let i = 0; i < out.length; i++) {
        const n = out[i];
        if (!n || n.t % TICKS_PER_QUARTER !== 240 || n.d < EIGHTH_MIN || n.d > EIGHTH_MAX) {
            continue;
        }
        const origT = n.t;
        n.t += SWING_SHIFT;
        n.d -= SWING_SHIFT;
        const onBeatT = origT - 240;
        // Notes are sorted by tick, so the partner sits just behind this off-beat.
        for (let j = i - 1; j >= 0; j--) {
            const on = out[j];
            if (!on || on.t < onBeatT) {
                break;
            }
            if (grown.has(j) || on.h !== n.h || on.t !== onBeatT || on.d < EIGHTH_MIN || on.d > EIGHTH_MAX) {
                continue;
            }
            on.d += SWING_SHIFT;
            grown.add(j);
            break;
        }
    }
    return out;
};

/**
 * Zip musical content (MusicXML) with measure geometry (.omr) into the final
 * ScoreData. Both come from the same Audiveris engine model, so geometric
 * measure stacks in reading order should match exported measures 1:1; when
 * they don't, the tail degrades to geometry-less measures (audio still plays,
 * the playhead hides there) rather than risking wrong positions.
 */
export const buildScoreData = (musical: MusicalScore, geometry: OmrGeometry | null): ScoreData => {
    if (musical.notes.length === 0 || musical.measures.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'No playable notes recognized');
    }

    const warnings = new Set(musical.warnings);
    const systems: ScoreSystem[] = [];
    const stacks: Array<{ page: number; sys: number; x0: number; x1: number; slots: Array<{ x: number; t: number }> }> =
        [];

    if (geometry) {
        for (const sheet of geometry.sheets) {
            for (const system of sheet.systems) {
                const sysIndex = systems.length;
                systems.push({
                    page: sheet.pageIndex,
                    y0: system.y0,
                    y1: system.y1,
                    ...((system.staves?.length ?? 0) > 0 ? { staves: system.staves } : {}),
                });
                for (const stack of system.stacks) {
                    stacks.push({
                        page: sheet.pageIndex,
                        sys: sysIndex,
                        x0: stack.x0,
                        x1: stack.x1,
                        slots: stack.slots,
                    });
                }
            }
        }
    } else {
        warnings.add('no_geometry');
    }

    if (geometry && stacks.length !== musical.measures.length) {
        warnings.add('measure_geometry_mismatch');
    }

    const measures: ScoreMeasure[] = musical.measures.map((measure, index) => {
        const stack = stacks[index];
        // Chord columns must fit inside the measure's own timeline — an OMR
        // rhythm misread otherwise drags the playhead outside the bar.
        const slots = stack ? stack.slots.filter((slot) => slot.t < measure.dTicks) : [];
        return {
            n: measure.n,
            tick: measure.tick,
            dTicks: measure.dTicks,
            // Identity of the engraved bar. Trivially the index today; once
            // repeats are unrolled, several entries will share one.
            srcIndex: index,
            page: stack ? stack.page : -1,
            sys: stack ? stack.sys : -1,
            x0: stack ? stack.x0 : 0,
            x1: stack ? stack.x1 : 0,
            ...(slots.length > 0 ? { sl: slots } : {}),
        };
    });

    // Unroll AFTER the geometry zip: both the secondary-part timeline and the
    // stacks-to-measures pairing above are positional, so duplicating measures
    // any earlier would break them. Here a repeat is a structural clone that
    // keeps its page position, which is why the playhead sweeps the same
    // printed bar twice for nothing.
    const MAX_MEASURES = 2_000;
    const marks = musical.repeats ?? [];
    // Only act on marks that line up with the measures one-for-one; anything
    // else means a caller built the score without them, and an empty plan must
    // never be mistaken for "perform nothing".
    const plan =
        marks.length === measures.length
            ? planRepeats(marks, { maxMeasures: MAX_MEASURES }, (i) => musical.measures[i]?.n === 0)
            : null;
    // A degraded plan is never performed, so its flags describe a performance
    // that does not happen — they cannot be read without this filter.
    const performing = plan && !plan.degraded ? plan : null;
    const performsRepeats = performing?.performsRepeats ?? false;
    const performsJumps = performing?.performsJumps ?? false;
    const structureLost = performing === null;

    // Each disclosure is keyed to what the reader would MISS, not to what was
    // printed: a `:|` that was never retaken, or a D.C./D.S. that was never
    // taken. A lone forward `|:` is performed identically by a linear read, so
    // it costs the reader nothing and earns no warning — claiming otherwise was
    // the old false positive, and it fired on ordinary unrepeated scores.
    for (const code of STRUCTURE_WARNINGS) {
        warnings.delete(code);
    }
    if (performsRepeats) {
        warnings.add('repeats_unrolled');
    }
    if (performsJumps) {
        warnings.add('jumps_performed');
    }
    if (structureLost && marks.some((mark) => mark.repeatBackward)) {
        warnings.add('repeats_ignored');
    }
    // A segno or Fine with no instruction to send the player back to it is
    // decoration, and `resolveJump` says so by returning null; only a real
    // D.C./D.S. that went unperformed is worth a reader's attention.
    if (!performsJumps && resolveJump(marks) !== null) {
        warnings.add('jumps_ignored');
    }

    const linearScore = {
        timeSignatures: musical.timeSignatures,
        ...((musical.keySignatures?.length ?? 0) > 0 ? { keySignatures: musical.keySignatures } : {}),
        ...((musical.clefs?.length ?? 0) > 0 ? { clefs: musical.clefs } : {}),
        ...((musical.tempos?.length ?? 0) > 0 ? { tempos: musical.tempos } : {}),
        ...((musical.holds?.length ?? 0) > 0 ? { holds: musical.holds } : {}),
        ...((musical.pedals?.length ?? 0) > 0 ? { pedals: musical.pedals } : {}),
        notes: musical.notes,
        measures,
        totalTicks: Math.max(1, musical.totalTicks),
    };
    if (musical.swing) {
        linearScore.notes = applySwing(linearScore.notes);
        warnings.add('swing_applied');
    }
    const performed =
        performing && (performsRepeats || performsJumps) ? unrollRepeats(linearScore, performing.order) : linearScore;

    // Unrolling clones every event it sweeps, so a repeat-heavy score can breach
    // ceilings the printed page came nowhere near — and a breach fails the
    // self-check below, throwing away a score that is otherwise perfectly good.
    const tempos = performed.tempos ? capTempoEvents(performed.tempos) : undefined;
    const holds = performed.holds ? capHolds(performed.holds) : undefined;
    const pedals = performed.pedals ? capPedals(performed.pedals) : undefined;

    const candidate: ScoreData = {
        version: SCORE_DATA_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: musical.defaultBpm,
        timeSignatures: performed.timeSignatures,
        ...(performed.keySignatures ? { keySignatures: performed.keySignatures } : {}),
        ...(performed.clefs ? { clefs: performed.clefs } : {}),
        ...(tempos ? { tempos } : {}),
        ...(holds ? { holds } : {}),
        ...(pedals && pedals.length > 0 ? { pedals } : {}),
        totalTicks: performed.totalTicks,
        notes: performed.notes,
        measures: performed.measures,
        systems,
        warnings: [...warnings],
    };

    const checked = scoreDataSchema.safeParse(candidate);
    if (!checked.success) {
        throw new JobError(ERROR_CODES.internal, `ScoreData failed self-check: ${checked.error.issues[0]?.message}`);
    }
    return checked.data;
};
