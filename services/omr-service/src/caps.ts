import type { ScoreHold, ScorePedal, ScoreTempo } from './scoreData.js';

/**
 * Ceilings the ScoreData schema enforces on the expressive event arrays. A
 * single engraved page never approaches them; unrolled repeats (which clone
 * every event they sweep) and shard concatenation both can, and a score that
 * breaches one fails its own self-check and is thrown away entirely. Thinning
 * costs a little nuance, so it is always the better trade.
 */
export const MAX_TEMPO_EVENTS = 512;
export const MAX_HOLDS = 128;
export const MAX_PEDAL_EDGES = 256;

/**
 * Where a ramp arrives rather than where it passes through: the last point
 * before a printed mark, and every point at which the curve turns — the floor a
 * rit. bends down to, and the ceiling an accel. climbs to. Everything between
 * two points on the same slope is the discretization proper.
 */
const isRampLanding = (events: readonly ScoreTempo[], i: number): boolean => {
    const here = events[i];
    const next = events[i + 1];
    const prev = events[i - 1];
    if (!here || !next || next.src !== 'ramp') {
        return true;
    }
    if (!prev) {
        return false;
    }
    return Math.sign(here.bpm - prev.bpm) !== Math.sign(next.bpm - here.bpm);
};

/**
 * Bring a tempo map under the schema ceiling, spending the cheapest events first.
 *
 * `src: 'ramp'` points are a per-beat discretization of a rit./accel., not
 * tempos anyone wrote down: halving the density of the points along one slope
 * leaves the curve landing within one beat of where it did, which is inaudible.
 * Two kinds of ramp point are not along a slope, and are kept. A landing (see
 * `isRampLanding`) is where a curve arrives or turns. A restoration is the
 * "a tempo" that restates the last printed pulse — resolveTempos stamps it
 * 'ramp' too, and it is the only event that ever does the restating, so
 * thinning it leaves the score at the ritardando floor; it cannot be told from
 * its shape (an accel. into a rit. passes straight through it, same slope
 * sign on both sides), only from its bpm being the printed one. Printed marks
 * themselves — 'sound', 'metronome', 'word' — are irreplaceable and only ever
 * dropped by the truncation of last resort, which needs more than `max`
 * printed tempos in one score to trigger at all.
 */
export const capTempoEvents = (
    tempos: readonly ScoreTempo[],
    max = MAX_TEMPO_EVENTS,
): ScoreTempo[] => {
    let kept: ScoreTempo[] = [...tempos];
    while (kept.length > max) {
        let seen = 0;
        let printedBpm: number | null = null;
        const thinned = kept.filter((tempo, i) => {
            if (tempo.src !== 'ramp') {
                printedBpm = tempo.bpm;
                return true;
            }
            if (tempo.bpm === printedBpm || isRampLanding(kept, i)) {
                return true;
            }
            return seen++ % 2 === 0;
        });
        // A map whose ramps are all landings (or a single surviving point, or
        // none) cannot be halved again; without this the loop would spin on an
        // array it can no longer shrink, and the truncation below takes over.
        if (thinned.length === kept.length) {
            break;
        }
        kept = thinned;
    }
    return kept.length > max ? kept.slice(0, max) : kept;
};

/**
 * Bring fermatas under the schema ceiling by keeping the earliest.
 *
 * There is no musically cheaper hold to drop — every one of them is a printed
 * pause — so the rule is chosen for being deterministic and for keeping the
 * opening pages, which a practising reader plays far more often than the tail,
 * exactly as engraved.
 */
export const capHolds = (holds: readonly ScoreHold[], max = MAX_HOLDS): ScoreHold[] => {
    if (holds.length <= max) {
        return [...holds];
    }
    return [...holds].sort((a, b) => a.tick - b.tick).slice(0, max);
};

/**
 * Bring pedal edges under the ceiling, keeping the earliest for the same reason
 * fermatas do — plus one thing they do not need. A cut that lands on a `down`
 * leaves the pedal depressed for every bar after it, washing the tail of the
 * score into one chord, so an orphaned last depression goes with the cut.
 */
export const capPedals = (pedals: readonly ScorePedal[], max = MAX_PEDAL_EDGES): ScorePedal[] => {
    if (pedals.length <= max) {
        return [...pedals];
    }
    const kept = pedals.slice(0, max);
    if (kept[kept.length - 1]?.k === 'down') {
        kept.pop();
    }
    return kept;
};
