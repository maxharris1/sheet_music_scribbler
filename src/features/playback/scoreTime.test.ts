import { describe, expect, it } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import {
    beatsForMeasure,
    beatWeight,
    bpmAtTick,
    buildTempoMap,
    clickBeatTicks,
    secondsAtTick,
    tickAtSeconds,
    countInClicks,
    DOWNBEAT_ACCENT,
    FINAL_RIT_FACTOR,
    finalRitardandoPoints,
    firstNoteIndexAtOrAfter,
    fractionWithinMeasure,
    measureEndTick,
    measureIndexAtPagePoint,
    measureIndexAtTick,
    measureStartTick,
    SECONDARY_ACCENT,
    secondsPerTick,
    stepMeasure,
    tickAtXInMeasure,
    ticksPerBeat,
    timeSigAt,
    xAtTickInMeasure,
} from '@/features/playback/scoreTime';
import { parseScoreData, type ScoreData, type ScoreMeasure, type ScoreTimeSig } from '@/types/scoreData';

const { measures, notes, timeSignatures } = tinyScore;

describe('tinyScore fixture', () => {
    it('round-trips through parseScoreData', () => {
        expect(parseScoreData(JSON.parse(JSON.stringify(tinyScore)))).toEqual(tinyScore);
    });

    it('is rejected when malformed or future-versioned', () => {
        expect(parseScoreData({ nope: true })).toBeNull();
        expect(parseScoreData({ ...tinyScore, version: 99 })).toBeNull();
    });
});

describe('secondsPerTick / ticksPerBeat', () => {
    it('maps 120 bpm to 480 ticks per half second', () => {
        expect(secondsPerTick(120) * 480).toBeCloseTo(0.5);
    });

    it('derives beat lengths from the denominator', () => {
        expect(ticksPerBeat(4)).toBe(480);
        expect(ticksPerBeat(8)).toBe(240);
        expect(ticksPerBeat(2)).toBe(960);
    });
});

describe('timeSigAt', () => {
    it('returns the signature in effect at a tick', () => {
        expect(timeSigAt(timeSignatures, 0).num).toBe(4);
        expect(timeSigAt(timeSignatures, 8159).num).toBe(4);
        expect(timeSigAt(timeSignatures, 8160).num).toBe(6);
        expect(timeSigAt(timeSignatures, 99999).den).toBe(8);
    });

    it('falls back to 4/4 for an empty list', () => {
        expect(timeSigAt([], 100)).toEqual({ tick: 0, num: 4, den: 4 });
    });
});

describe('measureIndexAtTick', () => {
    it('finds the containing measure at starts, interiors, and boundaries', () => {
        expect(measureIndexAtTick(measures, 0)).toBe(0);
        expect(measureIndexAtTick(measures, 479)).toBe(0);
        expect(measureIndexAtTick(measures, 480)).toBe(1); // barline belongs to the next measure
        expect(measureIndexAtTick(measures, 5000)).toBe(3);
        expect(measureIndexAtTick(measures, 12480)).toBe(8);
    });

    it('clamps out-of-range ticks', () => {
        expect(measureIndexAtTick(measures, -50)).toBe(0);
        expect(measureIndexAtTick(measures, 999999)).toBe(8);
    });

    it('returns -1 for an empty score', () => {
        expect(measureIndexAtTick([], 100)).toBe(-1);
    });
});

describe('fractionWithinMeasure', () => {
    it('interpolates and clamps', () => {
        const m1 = measures[1];
        if (!m1) {
            throw new Error('fixture missing measure');
        }
        expect(fractionWithinMeasure(m1, 480)).toBe(0);
        expect(fractionWithinMeasure(m1, 480 + 960)).toBeCloseTo(0.5);
        expect(fractionWithinMeasure(m1, 99999)).toBe(1);
        expect(fractionWithinMeasure(m1, 0)).toBe(0);
    });
});

describe('xAtTickInMeasure', () => {
    const withSlots = {
        n: 1,
        tick: 1000,
        dTicks: 1920,
        page: 0,
        sys: 0,
        x0: 0.2,
        x1: 0.4,
        sl: [
            { x: 0.22, t: 0 },
            { x: 0.3, t: 1440 },
        ],
    };

    it('rides the engraved chord columns, not linear time', () => {
        expect(xAtTickInMeasure(withSlots, 1000)).toBe(0.22); // on the first chord
        expect(xAtTickInMeasure(withSlots, 1000 + 720)).toBeCloseTo(0.26, 6); // halfway to the 2nd column
        expect(xAtTickInMeasure(withSlots, 1000 + 1440)).toBe(0.3);
        // Linear interpolation would put tick 720/1920 at x = 0.275 — the dotted
        // rhythm's engraving says 0.26. That difference is the whole point.
        expect(xAtTickInMeasure(withSlots, 1000 + 720)).not.toBeCloseTo(0.275, 3);
    });

    it('sweeps from the last column to the barline', () => {
        expect(xAtTickInMeasure(withSlots, 1000 + 1680)).toBeCloseTo(0.35, 6); // halfway of the tail
        expect(xAtTickInMeasure(withSlots, 1000 + 1920)).toBeCloseTo(0.4, 6);
    });

    it('falls back to linear interpolation without slot data', () => {
        const plain = { ...withSlots, sl: undefined };
        expect(xAtTickInMeasure(plain, 1000 + 960)).toBeCloseTo(0.3, 6);
    });
});

describe('tickAtXInMeasure', () => {
    const withSlots: ScoreMeasure = {
        n: 1,
        tick: 1000,
        dTicks: 1920,
        page: 0,
        sys: 0,
        x0: 0.2,
        x1: 0.4,
        sl: [
            { x: 0.22, t: 0 },
            { x: 0.3, t: 1440 },
        ],
    };

    it('inverts slot-aware xAtTickInMeasure within rounding', () => {
        const midTick = 1000 + 720;
        const x = xAtTickInMeasure(withSlots, midTick);
        expect(tickAtXInMeasure(withSlots, x)).toBe(midTick);
    });

    it('maps pre-slot x to the first column tick', () => {
        expect(tickAtXInMeasure(withSlots, 0.2)).toBe(1000);
        expect(tickAtXInMeasure(withSlots, 0.22)).toBe(1000);
    });

    it('falls back to linear without slots', () => {
        const plain = { ...withSlots, sl: undefined };
        expect(tickAtXInMeasure(plain, 0.3)).toBe(1000 + 960);
    });
});

describe('stepMeasure', () => {
    it('steps forward to the next barline', () => {
        expect(stepMeasure(measures, 0, 1)).toBe(480);
        expect(stepMeasure(measures, 500, 1)).toBe(2400);
    });

    it('stays on the last measure when stepping past the end', () => {
        expect(stepMeasure(measures, 13000, 1)).toBe(12480);
    });

    it('returns to the current start when >20% in, else the previous measure', () => {
        expect(stepMeasure(measures, 480 + 1000, -1)).toBe(480); // deep into m1 → m1 start
        expect(stepMeasure(measures, 480 + 100, -1)).toBe(0); // near m1 start → m0
        expect(stepMeasure(measures, 100, -1)).toBe(0); // m0 has no predecessor
    });

    it('handles empty measures', () => {
        expect(stepMeasure([], 100, 1)).toBe(0);
    });
});

describe('firstNoteIndexAtOrAfter', () => {
    it('is a lower bound over note start ticks', () => {
        expect(firstNoteIndexAtOrAfter(notes, 0)).toBe(0);
        expect(firstNoteIndexAtOrAfter(notes, 1)).toBe(1);
        expect(firstNoteIndexAtOrAfter(notes, 480)).toBe(1);
        expect(firstNoteIndexAtOrAfter(notes, 999999)).toBe(notes.length);
    });
});

describe('beatsForMeasure', () => {
    it('produces 4 quarter beats in a 4/4 measure, downbeat accented', () => {
        const m1 = measures[1];
        if (!m1) {
            throw new Error('fixture missing measure');
        }
        expect(beatsForMeasure(m1, timeSignatures)).toEqual([
            { tick: 480, accent: true },
            { tick: 960, accent: false },
            { tick: 1440, accent: false },
            { tick: 1920, accent: false },
        ]);
    });

    it('feels 6/8 in two dotted-quarter beats, not six eighths', () => {
        const m5 = measures[5];
        if (!m5) {
            throw new Error('fixture missing measure');
        }
        expect(clickBeatTicks({ tick: 0, num: 6, den: 8 })).toBe(720);
        expect(beatsForMeasure(m5, timeSignatures)).toEqual([
            { tick: 8160, accent: true },
            { tick: 8880, accent: false },
        ]);
    });

    it('gives a pickup its beat but never a downbeat accent', () => {
        const pickup = measures[0];
        if (!pickup) {
            throw new Error('fixture missing measure');
        }
        expect(beatsForMeasure(pickup, timeSignatures)).toEqual([{ tick: 0, accent: false }]);
    });
});

describe('beatWeight', () => {
    const sig = (num: number, den: number): ScoreTimeSig => ({ tick: 0, num, den });

    it('is a table of the common meters', () => {
        expect(beatWeight(sig(4, 4), 0, true)).toBe(DOWNBEAT_ACCENT);
        expect(beatWeight(sig(4, 4), 1, true)).toBe(0);
        expect(beatWeight(sig(4, 4), 2, true)).toBe(SECONDARY_ACCENT);
        expect(beatWeight(sig(4, 4), 3, true)).toBe(0);
        expect(beatWeight(sig(2, 2), 1, true)).toBe(0);
        expect(beatWeight(sig(2, 4), 1, true)).toBe(0);
        expect(beatWeight(sig(3, 4), 1, true)).toBe(0);
        expect(beatWeight(sig(3, 4), 2, true)).toBe(0);
        expect(beatWeight(sig(6, 8), 1, true)).toBe(SECONDARY_ACCENT);
        expect(beatWeight(sig(12, 8), 1, true)).toBe(0);
        expect(beatWeight(sig(12, 8), 2, true)).toBe(SECONDARY_ACCENT);
        expect(beatWeight(sig(9, 8), 1, true)).toBe(0);
        expect(beatWeight(sig(3, 8), 1, true)).toBe(0);
        expect(beatWeight(sig(4, 4), 0, false)).toBe(0);
        expect(beatWeight(sig(4, 4), 2, false)).toBe(0);
    });
});

describe('countInClicks', () => {
    it('is one plain bar when entering on a downbeat', () => {
        expect(countInClicks(tinyScore, 480)).toEqual([
            { offsetTicks: 1920, accent: true },
            { offsetTicks: 1440, accent: false },
            { offsetTicks: 960, accent: false },
            { offsetTicks: 480, accent: false },
        ]);
    });

    it('counts a full bar plus the lead-in beats for a pickup entry', () => {
        // 1-beat pickup in 4/4: "ONE two three four, ONE two three" → enter on 4.
        const clicks = countInClicks(tinyScore, 0);
        expect(clicks.map((c) => c.offsetTicks)).toEqual([3360, 2880, 2400, 1920, 1440, 960, 480]);
        expect(clicks.filter((c) => c.accent).map((c) => c.offsetTicks)).toEqual([3360, 1440]);
    });

    it('counts compound meter in dotted-quarter clicks', () => {
        expect(countInClicks(tinyScore, 8160)).toEqual([
            { offsetTicks: 1440, accent: true },
            { offsetTicks: 720, accent: false },
        ]);
    });

    it('leads into a mid-measure entry on the beat grid', () => {
        // Entering on beat 3 of m1: one bar + beats 1-2 of the entry bar.
        const clicks = countInClicks(tinyScore, 480 + 960);
        expect(clicks.map((c) => c.offsetTicks)).toEqual([2880, 2400, 1920, 1440, 960, 480]);
        expect(clicks.filter((c) => c.accent).map((c) => c.offsetTicks)).toEqual([2880, 960]);
    });
});

describe('measureStartTick / measureEndTick', () => {
    it('clamps indices to the score', () => {
        expect(measureStartTick(measures, 1)).toBe(480);
        expect(measureStartTick(measures, -5)).toBe(0);
        expect(measureStartTick(measures, 99)).toBe(12480);
        expect(measureEndTick(measures, 8)).toBe(13920);
        expect(measureEndTick(measures, 99)).toBe(13920);
    });
});

describe('tempo map', () => {
    const scoreWith = (over: Partial<ScoreData>): ScoreData => ({ ...tinyScore, defaultBpm: 120, ...over });

    // At 120 quarter-BPM a tick is 60/(120*480) s, so a 4/4 bar (1920) is 2 s.
    it('is exact across a tempo change', () => {
        const map = buildTempoMap(
            scoreWith({
                tempos: [
                    { tick: 0, bpm: 120 },
                    { tick: 7680, bpm: 60 },
                ],
            }),
            1,
            100,
        );
        expect(secondsAtTick(map, 7680)).toBeCloseTo(8, 6); // 4 bars at 120
        // Past the printed change the unmarked close still stretches the last
        // bar, so 15360 is no longer a flat 16 s at 60. Arriving at m.8 (the
        // last barline before the rit.) is still five seconds of 60.
        expect(secondsAtTick(map, 12480)).toBeCloseTo(18, 6);
    });

    it('inverts exactly', () => {
        const map = buildTempoMap(
            scoreWith({
                tempos: [
                    { tick: 0, bpm: 120 },
                    { tick: 3000, bpm: 72 },
                    { tick: 9000, bpm: 144 },
                ],
                holds: [{ tick: 6000, beats: 2 }],
            }),
            1,
            100,
        );
        for (let tick = 0; tick <= 12000; tick += 61) {
            // Ticks inside a hold's shadow are the one place this is not 1:1 —
            // arrival maps back to the hold tick itself.
            expect(tickAtSeconds(map, secondsAtTick(map, tick))).toBeCloseTo(tick, 3);
        }
    });

    it('does not delay the very tick a fermata sits on', () => {
        // The fermata note must still START on time; only what follows waits.
        const map = buildTempoMap(scoreWith({ holds: [{ tick: 1920, beats: 2 }] }), 1, 100);
        expect(secondsAtTick(map, 1920)).toBeCloseTo(2, 6);
        expect(secondsAtTick(map, 1921)).toBeCloseTo(2 + 1 + 1 / 960, 5);
        // ...and the note rings through the pause rather than being cut at it.
        expect(secondsAtTick(map, 2880) - secondsAtTick(map, 1920)).toBeCloseTo(2, 5);
    });

    it('parks the playhead on a fermata for its duration', () => {
        const map = buildTempoMap(scoreWith({ holds: [{ tick: 1920, beats: 2 }] }), 1, 100);
        expect(tickAtSeconds(map, 2.0)).toBe(1920);
        expect(tickAtSeconds(map, 2.5)).toBe(1920);
        expect(tickAtSeconds(map, 2.99)).toBe(1920);
        expect(tickAtSeconds(map, 3.5)).toBeGreaterThan(1920);
    });

    it('never runs backwards', () => {
        const map = buildTempoMap(
            scoreWith({
                tempos: [
                    { tick: 0, bpm: 60 },
                    { tick: 2000, bpm: 200 },
                ],
                holds: [{ tick: 2000, beats: 3 }],
            }),
            1,
            100,
        );
        let previous = -1;
        for (let s = 0; s < 20; s += 0.05) {
            const tick = tickAtSeconds(map, s);
            expect(tick).toBeGreaterThanOrEqual(previous);
            previous = tick;
        }
    });

    it('extrapolates before the start, which the count-in needs', () => {
        const map = buildTempoMap(scoreWith({ tempos: [{ tick: 0, bpm: 120 }] }), 1, 100);
        expect(secondsAtTick(map, -1920)).toBeCloseTo(-2, 6);
    });

    it('scales every point by the practice tempo', () => {
        const score = scoreWith({
            tempos: [
                { tick: 0, bpm: 120 },
                { tick: 1920, bpm: 60 },
            ],
        });
        const full = buildTempoMap(score, 1, 100);
        const half = buildTempoMap(score, 0.5, 100);
        expect(secondsAtTick(half, 5760)).toBeCloseTo(secondsAtTick(full, 5760) * 2, 6);
    });

    it('reduces to a flat map for a score with no tempo data', () => {
        const map = buildTempoMap({ ...tinyScore, defaultBpm: null }, 1, 100);
        // Falls back to the supplied bpm, exactly as before v3. The unmarked
        // close still bends the last bar; the body of the piece is flat.
        expect(secondsAtTick(map, 480)).toBeCloseTo(60 / 100, 6);
        expect(bpmAtTick(map, 480)).toBeCloseTo(100, 6);
        expect(bpmAtTick(map, 0)).toBeCloseTo(100, 6);
    });
});

describe('finalRitardandoPoints', () => {
    const bar = (n: number, tick: number, dTicks: number, srcIndex: number): ScoreMeasure => ({
        n,
        tick,
        dTicks,
        page: 0,
        sys: 0,
        x0: 0,
        x1: 1,
        srcIndex,
    });

    const fourBar44 = (over: Partial<ScoreData> = {}): ScoreData => ({
        ...tinyScore,
        defaultBpm: 120,
        totalTicks: 7680,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        tempos: [{ tick: 0, bpm: 120 }],
        holds: undefined,
        measures: [0, 1, 2, 3].map((i) => bar(i + 1, i * 1920, 1920, i)),
        notes: [],
        ...over,
    });

    it('eases the last full bar of a 4/4 score down to 85% on the last beat', () => {
        const points = finalRitardandoPoints(fourBar44(), 120);
        expect(points).toHaveLength(4);
        for (let k = 0; k < 4; k++) {
            expect(points[k]?.tick).toBe(5760 + 480 * k);
        }
        expect(points[0]?.bpm).toBe(120);
        expect(points[3]?.bpm).toBe(120 * FINAL_RIT_FACTOR);
        expect(points[3]?.bpm).toBe(102);
        expect(points[1]?.bpm).toBeCloseTo(114, 10);
        expect(points[2]?.bpm).toBeCloseTo(108, 10);
    });

    it('is suppressed by a ramp point in the last two bars', () => {
        const withRamp = fourBar44({
            tempos: [
                { tick: 0, bpm: 120 },
                { tick: 4000, bpm: 100, src: 'ramp' },
            ],
        });
        expect(finalRitardandoPoints(withRamp, 120)).toEqual([]);
    });

    it('is suppressed by a hold in the last bar', () => {
        const withHold = fourBar44({ holds: [{ tick: 6000, beats: 2 }] });
        expect(finalRitardandoPoints(withHold, 120)).toEqual([]);
    });

    it('emits points before both ends of a two-movement score', () => {
        const twoMovements = fourBar44({
            measures: [bar(1, 0, 1920, 0), bar(2, 1920, 1920, 1), bar(1, 3840, 1920, 2), bar(2, 5760, 1920, 3)],
        });
        const points = finalRitardandoPoints(twoMovements, 120);
        const ticks = points.map((p) => p.tick);
        expect(ticks).toEqual([1920, 2400, 2880, 3360, 5760, 6240, 6720, 7200]);
        expect(points[3]?.bpm).toBe(102);
        expect(points[7]?.bpm).toBe(102);
    });

    it('ignores a numbering reset whose srcIndex goes down — that is a repeat, not a movement', () => {
        const repeated = fourBar44({
            measures: [bar(1, 0, 1920, 0), bar(2, 1920, 1920, 1), bar(1, 3840, 1920, 0), bar(2, 5760, 1920, 1)],
        });
        const ticks = finalRitardandoPoints(repeated, 120).map((p) => p.tick);
        expect(ticks).toEqual([5760, 6240, 6720, 7200]);
    });

    it('makes the last bar longer than the metronomic duration by the expected amount', () => {
        const score = fourBar44();
        const map = buildTempoMap(score, 1, 120);
        const spt = (bpm: number): number => 60 / (bpm * 480);
        const lastBar = 480 * spt(120) + 480 * spt(114) + 480 * spt(108) + 480 * spt(120 * FINAL_RIT_FACTOR);
        expect(secondsAtTick(map, 5760)).toBeCloseTo(6, 6);
        expect(secondsAtTick(map, 7680)).toBeCloseTo(6 + lastBar, 6);
        expect(secondsAtTick(map, 7680)).toBeGreaterThan(8);
    });
});

describe('measureIndexAtPagePoint with repeats', () => {
    // Measures 0-2 of tinyScore performed a second time at later ticks, with
    // the same geometry — what an unrolled repeat looks like.
    const shift = tinyScore.totalTicks;
    const repeated: ScoreData = {
        ...tinyScore,
        measures: [
            ...tinyScore.measures.map((m, i) => ({ ...m, srcIndex: i })),
            ...tinyScore.measures.slice(0, 3).map((m, i) => ({ ...m, srcIndex: i, tick: m.tick + shift })),
        ].sort((a, b) => a.tick - b.tick),
    };
    const inM1 = tinyScore.measures[1]!;
    const sys0 = tinyScore.systems[inM1.sys]!;
    const nx = (inM1.x0 + inM1.x1) / 2;
    const ny = (sys0.y0 + sys0.y1) / 2;

    it('keeps first-match behaviour when no playhead position is given', () => {
        const i = measureIndexAtPagePoint(repeated, inM1.page, nx, ny);
        expect(repeated.measures[i]?.tick).toBe(inM1.tick);
    });

    it('picks the pass nearest the playhead', () => {
        const second = measureIndexAtPagePoint(repeated, inM1.page, nx, ny, shift + inM1.tick);
        expect(repeated.measures[second]?.tick).toBe(shift + inM1.tick);

        const first = measureIndexAtPagePoint(repeated, inM1.page, nx, ny, inM1.tick);
        expect(repeated.measures[first]?.tick).toBe(inM1.tick);
    });

    it('still misses cleanly off any system', () => {
        expect(measureIndexAtPagePoint(repeated, inM1.page, nx, 0.999, 0)).toBe(-1);
    });
});
