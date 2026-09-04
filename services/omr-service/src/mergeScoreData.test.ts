import { describe, expect, it } from 'vitest';

import { MAX_HOLDS, MAX_TEMPO_EVENTS, capHolds, capPedals, capTempoEvents } from './caps.js';
import {
    mergeScoreDataParts,
    seamIsUnsafe,
    splitSheetRanges,
    splitSheetRangesOverlapping,
} from './mergeScoreData.js';
import type { StructureSummary } from './repeats.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER } from './scoreData.js';
import type { ScoreData, ScoreHold, ScorePedal, ScoreTempo } from './scoreData.js';

const basePart = (overrides: Partial<ScoreData>): ScoreData => ({
    version: SCORE_DATA_VERSION,
    ticksPerQuarter: TICKS_PER_QUARTER,
    defaultBpm: 120,
    timeSignatures: [{ tick: 0, num: 4, den: 4 }],
    totalTicks: 1920,
    notes: [{ t: 0, d: 480, p: 60, h: 0 }],
    measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 }],
    systems: [{ page: 0, y0: 0.1, y1: 0.4 }],
    warnings: [],
    ...overrides,
});

describe('splitSheetRanges', () => {
    it('splits evenly across N shards', () => {
        expect(splitSheetRanges(4, 2)).toEqual([
            { from: 1, to: 2 },
            { from: 3, to: 4 },
        ]);
        expect(splitSheetRanges(5, 2)).toEqual([
            { from: 1, to: 3 },
            { from: 4, to: 5 },
        ]);
    });
});

describe('splitSheetRangesOverlapping', () => {
    it('shares one page at the cut for n=2', () => {
        expect(splitSheetRangesOverlapping(5, 2, 1)).toEqual([
            { from: 1, to: 3 },
            { from: 3, to: 5 },
        ]);
        expect(splitSheetRangesOverlapping(4, 2, 1)).toEqual([
            { from: 1, to: 2 },
            { from: 2, to: 4 },
        ]);
    });
});

describe('mergeScoreDataParts', () => {
    it('offsets ticks and remaps pages across sheet ranges', () => {
        const a = basePart({});
        const b = basePart({
            notes: [{ t: 0, d: 480, p: 62, h: 0 }],
            measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 }],
            systems: [{ page: 0, y0: 0.2, y1: 0.5 }],
            timeSignatures: [],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.totalTicks).toBe(3840);
        expect(merged.notes.map((n) => n.t)).toEqual([0, 1920]);
        expect(merged.measures.map((m) => m.n)).toEqual([1, 2]);
        expect(merged.measures.map((m) => m.page)).toEqual([0, 2]);
        expect(merged.systems.map((s) => s.page)).toEqual([0, 2]);
        expect(merged.timeSignatures[0]).toEqual({ tick: 0, num: 4, den: 4 });
        expect(merged.warnings).toContain('merged_inherited_time_signature');
    });

    it('drops overlap page from the later part and inherits meter', () => {
        const a = basePart({
            timeSignatures: [{ tick: 0, num: 3, den: 4 }],
            totalTicks: 3840,
            notes: [
                { t: 0, d: 480, p: 60, h: 0 },
                { t: 1920, d: 480, p: 61, h: 0 },
            ],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1920, dTicks: 1920, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            systems: [
                { page: 0, y0: 0.1, y1: 0.3 },
                { page: 1, y0: 0.1, y1: 0.3 },
            ],
        });
        const b = basePart({
            timeSignatures: [],
            totalTicks: 3840,
            notes: [
                { t: 0, d: 480, p: 61, h: 0 },
                { t: 1920, d: 480, p: 62, h: 0 },
            ],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1920, dTicks: 1920, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            systems: [
                { page: 0, y0: 0.2, y1: 0.4 },
                { page: 1, y0: 0.2, y1: 0.4 },
            ],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 2, to: 3 } },
        ]);
        expect(merged.warnings).toContain('merged_dropped_overlap_page');
        expect(merged.warnings).toContain('merged_inherited_time_signature');
        // Page 0+1 from A, page 2 from B (B's page 1 after drop/rebase)
        expect(merged.measures.map((m) => m.page).sort()).toEqual([0, 1, 2]);
        expect(merged.notes).toHaveLength(3);
        expect(merged.timeSignatures.some((s) => s.num === 3 && s.den === 4)).toBe(true);
    });

    it('leaves no silence at the seam where the overlap page was dropped', () => {
        /** `pages` engraved pages of four 4/4 bars each, one system per page. */
        const shard = (pages: number, pitch: number, overrides: Partial<ScoreData> = {}): ScoreData => {
            const measures: ScoreData['measures'] = [];
            const notes: ScoreData['notes'] = [];
            const systems: ScoreData['systems'] = [];
            let tick = 0;
            for (let page = 0; page < pages; page++) {
                systems.push({ page, y0: 0.1, y1: 0.9 });
                for (let bar = 0; bar < 4; bar++) {
                    measures.push({
                        n: measures.length + 1,
                        tick,
                        dTicks: 1920,
                        page,
                        sys: page,
                        x0: 0,
                        x1: 1,
                    });
                    notes.push({ t: tick, d: 480, p: pitch, h: 0 });
                    tick += 1920;
                }
            }
            return basePart({ totalTicks: tick, measures, notes, systems, ...overrides });
        };
        // The production split of a 5-page score: sheets 1-3 and 3-5, sharing
        // page 3, which B drops.
        const merged = mergeScoreDataParts([
            { score: shard(3, 60), sheets: { from: 1, to: 3 } },
            { score: shard(3, 62, { timeSignatures: [] }), sheets: { from: 3, to: 5 } },
        ]);
        expect(merged.warnings).toContain('merged_dropped_overlap_page');
        expect(merged.measures).toHaveLength(20);
        // Every bar abuts the one before it: a shard whose first page was cut
        // away must be pulled back to zero before the merge offsets it, or the
        // score plays a whole page of nothing at the seam.
        for (const [i, measure] of merged.measures.entries()) {
            const prev = merged.measures[i - 1];
            expect(measure.tick).toBe(prev ? prev.tick + prev.dTicks : 0);
        }
        expect(merged.totalTicks).toBe(merged.measures.reduce((sum, m) => sum + m.dTicks, 0));
        expect(merged.notes.map((n) => n.t)).toEqual(merged.measures.map((m) => m.tick));
    });
});

describe('mergeScoreDataParts tempo disclosure', () => {
    it('does not report a defaulted tempo when only the later shard is tempo-less', () => {
        // A heading is printed on page 1 and nowhere else, so the second shard
        // of nearly every score guesses its own opening from the meter. That
        // guess is discarded here; saying it out loud would tell a reader
        // looking at "♩=132" that nothing was printed at all.
        const a = basePart({ defaultBpm: 132, tempos: [{ tick: 0, bpm: 132, src: 'sound' }] });
        const b = basePart({
            timeSignatures: [],
            defaultBpm: 96,
            warnings: ['tempo_defaulted'],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.defaultBpm).toBe(132);
        expect(merged.warnings).not.toContain('tempo_defaulted');
    });

    it('keeps the disclosure when the opening itself was guessed', () => {
        // The mirror case: page 1 prints nothing and the tempo only appears
        // later, so the pulse the reader starts on really is a guess.
        const a = basePart({ defaultBpm: 96, warnings: ['tempo_defaulted'] });
        const b = basePart({
            timeSignatures: [],
            defaultBpm: 132,
            tempos: [{ tick: 0, bpm: 132, src: 'sound' }],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.defaultBpm).toBe(96);
        expect(merged.warnings).toContain('tempo_defaulted');
        expect(merged.tempos).toEqual([{ tick: 1920, bpm: 132, src: 'sound' }]);
    });
});

describe('mergeScoreDataParts tempo map and fermatas', () => {
    it('carries tempos and holds across the seam at the part tick offset', () => {
        const a = basePart({
            tempos: [{ tick: 0, bpm: 100, src: 'metronome' }],
            holds: [{ tick: 960, beats: 2 }],
        });
        const b = basePart({
            timeSignatures: [],
            tempos: [{ tick: 0, bpm: 76, src: 'word' }],
            holds: [{ tick: 480, beats: 1.5 }],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.tempos).toEqual([
            { tick: 0, bpm: 100, src: 'metronome' },
            { tick: 1920, bpm: 76, src: 'word' },
        ]);
        expect(merged.holds).toEqual([
            { tick: 960, beats: 2 },
            { tick: 2400, beats: 1.5 },
        ]);
    });

    it('leaves part A tempo in force over part B rather than restating it', () => {
        const a = basePart({ tempos: [{ tick: 0, bpm: 132, src: 'metronome' }] });
        const b = basePart({ timeSignatures: [] });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.tempos).toEqual([{ tick: 0, bpm: 132, src: 'metronome' }]);
        // The meter, which is not stepwise state the same way, IS restated.
        expect(merged.warnings).toContain('merged_inherited_time_signature');
    });

    it('drops tempos and holds that sat on the dropped overlap page', () => {
        const twoPages = (pitches: [number, number]): Partial<ScoreData> => ({
            totalTicks: 3840,
            notes: [
                { t: 0, d: 480, p: pitches[0], h: 0 },
                { t: 1920, d: 480, p: pitches[1], h: 0 },
            ],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1920, dTicks: 1920, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            systems: [
                { page: 0, y0: 0.1, y1: 0.3 },
                { page: 1, y0: 0.1, y1: 0.3 },
            ],
        });
        const a = basePart({
            ...twoPages([60, 61]),
            tempos: [{ tick: 0, bpm: 100, src: 'metronome' }],
            holds: [{ tick: 3000, beats: 2 }],
        });
        const b = basePart({
            ...twoPages([61, 62]),
            timeSignatures: [],
            // The first entry of each pair sits on B's page 0 — the same
            // engraved page A already contributed — and must not play twice.
            tempos: [
                { tick: 0, bpm: 100, src: 'metronome' },
                { tick: 1920, bpm: 72, src: 'word' },
            ],
            holds: [
                { tick: 1000, beats: 2 },
                { tick: 2400, beats: 1 },
            ],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 2, to: 3 } },
        ]);
        expect(merged.warnings).toContain('merged_dropped_overlap_page');
        // B's surviving events are rebased with the page that was dropped out
        // from under them and then take A's 3840-tick offset, exactly as B's
        // surviving measures and notes do — the word tempo B engraved on its
        // second page lands on the bar that follows A's last, not a page later.
        expect(merged.tempos).toEqual([
            { tick: 0, bpm: 100, src: 'metronome' },
            { tick: 3840, bpm: 72, src: 'word' },
        ]);
        expect(merged.holds).toEqual([
            { tick: 3000, beats: 2 },
            { tick: 4320, beats: 1 },
        ]);
        // B re-read the same metronome mark A already reported; the copy that
        // came in on the dropped page is gone rather than restated at the seam.
        expect((merged.tempos ?? []).filter((t) => t.bpm === 100)).toHaveLength(1);
    });

    it('thins a joined tempo map and fermata list to the schema ceilings', () => {
        const ramps = Array.from({ length: 300 }, (_, i) => ({
            tick: i + 1,
            bpm: 120 - (i % 40),
            src: 'ramp' as const,
        }));
        const manyHolds = Array.from({ length: 80 }, (_, i) => ({ tick: i * 4, beats: 1 }));
        const a = basePart({
            tempos: [{ tick: 0, bpm: 120, src: 'metronome' }, ...ramps],
            holds: manyHolds,
        });
        const b = basePart({
            timeSignatures: [],
            tempos: [{ tick: 0, bpm: 60, src: 'metronome' }, ...ramps],
            holds: manyHolds,
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect((merged.tempos ?? []).length).toBeLessThanOrEqual(MAX_TEMPO_EVENTS);
        expect((merged.holds ?? []).length).toBe(MAX_HOLDS);
        expect((merged.tempos ?? []).filter((t) => t.src !== 'ramp')).toEqual([
            { tick: 0, bpm: 120, src: 'metronome' },
            { tick: 1920, bpm: 60, src: 'metronome' },
        ]);
    });
});

describe('mergeScoreDataParts pedal', () => {
    it('carries pedal edges across the seam at the part tick offset', () => {
        const a = basePart({
            pedals: [
                { tick: 0, k: 'down' },
                { tick: 1900, k: 'up' },
            ],
        });
        const b = basePart({
            timeSignatures: [],
            pedals: [
                { tick: 10, k: 'down' },
                { tick: 900, k: 'up' },
            ],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        // Nothing is inherited at the seam: an unreleased depression in part A
        // is a lost edge in the engraving, not a release the merge can invent.
        expect(merged.pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 1900, k: 'up' },
            { tick: 1930, k: 'down' },
            { tick: 2820, k: 'up' },
        ]);
    });
});

describe('mergeScoreDataParts srcIndex rebase', () => {
    it('rebases engraved-bar identities per part, keeping repeat clones shared', () => {
        // Part A is already unrolled: bars 0-1 play twice, so four entries carry
        // two identities.
        const a = basePart({
            totalTicks: 2400,
            notes: [{ t: 0, d: 480, p: 60, h: 0 }],
            measures: [
                { n: 1, tick: 0, dTicks: 480, srcIndex: 0, page: 0, sys: 0, x0: 0, x1: 0.2 },
                { n: 2, tick: 480, dTicks: 480, srcIndex: 1, page: 0, sys: 0, x0: 0.2, x1: 0.4 },
                { n: 3, tick: 960, dTicks: 480, srcIndex: 0, page: 0, sys: 0, x0: 0, x1: 0.2 },
                { n: 4, tick: 1440, dTicks: 480, srcIndex: 1, page: 0, sys: 0, x0: 0.2, x1: 0.4 },
                { n: 5, tick: 1920, dTicks: 480, srcIndex: 2, page: 0, sys: 0, x0: 0.4, x1: 0.6 },
            ],
            systems: [{ page: 0, y0: 0.1, y1: 0.4 }],
        });
        // Part B carries no srcIndex at all — its position in the part stands in.
        const b = basePart({
            timeSignatures: [],
            totalTicks: 960,
            notes: [{ t: 0, d: 480, p: 64, h: 0 }],
            measures: [
                { n: 1, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 0.5 },
                { n: 2, tick: 480, dTicks: 480, page: 0, sys: 0, x0: 0.5, x1: 1 },
            ],
            systems: [{ page: 0, y0: 0.2, y1: 0.5 }],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.measures.map((m) => m.srcIndex)).toEqual([0, 1, 0, 1, 2, 3, 4]);
    });

    it('keeps identities clear of the earlier part when the overlap page is dropped', () => {
        const a = basePart({
            totalTicks: 3840,
            notes: [{ t: 0, d: 480, p: 60, h: 0 }],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, srcIndex: 0, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1920, dTicks: 1920, srcIndex: 1, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            systems: [
                { page: 0, y0: 0.1, y1: 0.3 },
                { page: 1, y0: 0.1, y1: 0.3 },
            ],
        });
        const b = basePart({
            timeSignatures: [],
            totalTicks: 3840,
            notes: [{ t: 1920, d: 480, p: 62, h: 0 }],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, srcIndex: 0, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1920, dTicks: 1920, srcIndex: 1, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            systems: [
                { page: 0, y0: 0.2, y1: 0.4 },
                { page: 1, y0: 0.2, y1: 0.4 },
            ],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 2, to: 3 } },
        ]);
        const indices = merged.measures.map((m) => m.srcIndex ?? -1);
        expect(indices).toHaveLength(3);
        expect(indices.slice(0, 2)).toEqual([0, 1]);
        expect(indices[2]).toBeGreaterThan(1);
    });
});

describe('capTempoEvents', () => {
    it('leaves a map already under the cap alone', () => {
        const tempos: ScoreTempo[] = [
            { tick: 0, bpm: 100, src: 'metronome' },
            { tick: 480, bpm: 96, src: 'ramp' },
        ];
        expect(capTempoEvents(tempos)).toEqual(tempos);
    });

    it('halves ramp density until it fits, keeping every printed mark', () => {
        const tempos: ScoreTempo[] = [
            { tick: 0, bpm: 120, src: 'metronome' },
            ...Array.from({ length: 2_000 }, (_, i) => ({
                tick: i + 1,
                bpm: 120 - (i % 40),
                src: 'ramp' as const,
            })),
            { tick: 4_000, bpm: 88, src: 'word' },
        ];
        const capped = capTempoEvents(tempos);
        expect(capped.length).toBeLessThanOrEqual(MAX_TEMPO_EVENTS);
        expect(capped.filter((t) => t.src !== 'ramp')).toEqual([
            { tick: 0, bpm: 120, src: 'metronome' },
            { tick: 4_000, bpm: 88, src: 'word' },
        ]);
        // Thinning must not reshuffle the map the reader prefix-sums.
        expect(capped.map((t) => t.tick)).toEqual([...capped.map((t) => t.tick)].sort((x, y) => x - y));
    });

    it('never thins away the "a tempo" that returns a ritardando to the printed pulse', () => {
        // What resolveTempos emits for a rubato-heavy page: one printed mark,
        // then rit. after rit. discretized per beat, each closed by an "a tempo"
        // point back at 120. Those closing points wear 'ramp' like the rest, but
        // nothing else ever restates 120 — drop one and the score stays at the
        // ritardando floor until the next surviving event.
        const tempos: ScoreTempo[] = [{ tick: 0, bpm: 120, src: 'metronome' }];
        for (let block = 0; block < 70; block++) {
            const start = 1 + block * 8;
            for (let step = 0; step < 7; step++) {
                tempos.push({ tick: start + step, bpm: 116 - step * 4, src: 'ramp' });
            }
            tempos.push({ tick: start + 7, bpm: 120, src: 'ramp' });
        }
        expect(tempos.length).toBeGreaterThan(MAX_TEMPO_EVENTS);

        const capped = capTempoEvents(tempos);
        expect(capped.length).toBeLessThanOrEqual(MAX_TEMPO_EVENTS);
        expect(capped.filter((t) => t.src === 'ramp' && t.bpm === 120)).toHaveLength(70);
        // The floor each rit. reaches is kept for the same reason: it is where
        // the curve arrives, not a point it passes through.
        expect(capped.filter((t) => t.src === 'ramp' && t.bpm === 92)).toHaveLength(70);
    });

    it('keeps the "a tempo" an accel. runs straight through on its way to a rit.', () => {
        // Between an accelerando's ceiling and the next ritardando, the
        // "a tempo" is not a turn in the curve — the slope falls on both sides
        // of it — so no shape test can find it. It is the only point restating
        // the printed 120, and it must survive on that ground alone.
        const tempos: ScoreTempo[] = [{ tick: 0, bpm: 120, src: 'metronome' }];
        for (let block = 0; block < 40; block++) {
            const start = 1 + block * 16;
            for (let step = 0; step < 7; step++) {
                tempos.push({ tick: start + step, bpm: 124 + step * 4, src: 'ramp' }); // accel.
            }
            tempos.push({ tick: start + 7, bpm: 120, src: 'ramp' }); // a tempo
            for (let step = 0; step < 7; step++) {
                tempos.push({ tick: start + 8 + step, bpm: 116 - step * 4, src: 'ramp' }); // rit.
            }
            tempos.push({ tick: start + 15, bpm: 120, src: 'ramp' }); // a tempo
        }
        expect(tempos.length).toBeGreaterThan(MAX_TEMPO_EVENTS);

        const capped = capTempoEvents(tempos);
        expect(capped.length).toBeLessThanOrEqual(MAX_TEMPO_EVENTS);
        expect(capped.filter((t) => t.src === 'ramp' && t.bpm === 120)).toHaveLength(80);
    });

    it('truncates as a last resort when nothing is a ramp', () => {
        const tempos: ScoreTempo[] = Array.from({ length: MAX_TEMPO_EVENTS + 8 }, (_, i) => ({
            tick: i,
            bpm: 100,
            src: 'word' as const,
        }));
        expect(capTempoEvents(tempos)).toHaveLength(MAX_TEMPO_EVENTS);
    });

    it('respects an explicit lower cap', () => {
        const tempos: ScoreTempo[] = [
            { tick: 0, bpm: 100, src: 'metronome' },
            ...Array.from({ length: 8 }, (_, i) => ({ tick: i + 1, bpm: 99 - i, src: 'ramp' as const })),
        ];
        expect(capTempoEvents(tempos, 5).length).toBeLessThanOrEqual(5);
    });
});

describe('capHolds', () => {
    it('keeps the earliest holds and drops the tail', () => {
        const holds: ScoreHold[] = Array.from({ length: MAX_HOLDS + 72 }, (_, i) => ({
            tick: i * 480,
            beats: 2,
        }));
        const capped = capHolds(holds);
        expect(capped).toHaveLength(MAX_HOLDS);
        expect(capped[0]).toEqual({ tick: 0, beats: 2 });
        expect(capped[MAX_HOLDS - 1]).toEqual({ tick: (MAX_HOLDS - 1) * 480, beats: 2 });
    });

    it('leaves a list already under the cap alone', () => {
        const holds: ScoreHold[] = [{ tick: 960, beats: 2 }];
        expect(capHolds(holds)).toEqual(holds);
    });
});

describe('capPedals', () => {
    it('leaves a list already under the cap alone', () => {
        const pedals: ScorePedal[] = [
            { tick: 0, k: 'down' },
            { tick: 480, k: 'up' },
        ];
        expect(capPedals(pedals)).toEqual(pedals);
    });

    it('never leaves the pedal down with no release to follow', () => {
        // Cutting mid-span would hold the damper up for every remaining bar and
        // wash the tail of the score into one chord.
        const pedals: ScorePedal[] = Array.from({ length: 8 }, (_, i) => ({
            tick: i * 480,
            k: i % 2 === 0 ? 'down' : 'up',
        }));
        expect(capPedals(pedals, 5)).toEqual(pedals.slice(0, 4));
    });
});

describe('seamIsUnsafe', () => {
    const noStructure: StructureSummary = {
        openForwardAtEnd: false,
        bareBackwardAtStart: false,
        openVoltaAtEnd: false,
        hasJumpMarks: false,
    };
    const seam = (earlier: Partial<StructureSummary>, later: Partial<StructureSummary> = {}) =>
        seamIsUnsafe([
            { score: basePart({}), sheets: { from: 1, to: 2 }, structure: { ...noStructure, ...earlier } },
            { score: basePart({}), sheets: { from: 2, to: 4 }, structure: { ...noStructure, ...later } },
        ]);

    it('merges when every mark stays inside the shard that printed it', () => {
        expect(seam({})).toEqual({ unsafe: false, reasons: [] });
    });

    it('refuses a repeat whose two halves fell in different shards', () => {
        // Each half plans the repeat it can see, and neither is the one
        // engraved: the first never retakes, the second returns to a top it
        // does not contain.
        expect(seam({ openForwardAtEnd: true }).reasons).toEqual(['repeat_seam sheets=1-2']);
        expect(seam({}, { bareBackwardAtStart: true }).reasons).toEqual(['repeat_seam sheets=1-2']);
    });

    it('refuses a volta bracket the earlier shard never closes', () => {
        expect(seam({ openVoltaAtEnd: true }).reasons).toEqual(['repeat_seam sheets=1-2']);
    });

    it('refuses a jump mark wherever it was printed, seam or no seam', () => {
        // The later shard has no seam after it, but the segno its D.S. returns
        // to may well sit in a range this half never saw.
        expect(seam({}, { hasJumpMarks: true }).reasons).toEqual(['structure_jumps sheets=2-4']);
    });

    it('flags open ties on the earlier part', () => {
        const result = seamIsUnsafe([
            { score: basePart({}), sheets: { from: 1, to: 2 }, openTiesAtEnd: 1 },
            { score: basePart({}), sheets: { from: 2, to: 4 }, openTiesAtEnd: 0 },
        ]);
        expect(result.unsafe).toBe(true);
        expect(result.reasons.some((r) => r.startsWith('open_ties'))).toBe(true);
    });

    it('flags explicit meter disagreement at the seam', () => {
        const result = seamIsUnsafe([
            {
                score: basePart({ timeSignatures: [{ tick: 0, num: 3, den: 4 }] }),
                sheets: { from: 1, to: 2 },
            },
            {
                score: basePart({ timeSignatures: [{ tick: 0, num: 4, den: 4 }] }),
                sheets: { from: 2, to: 4 },
            },
        ]);
        expect(result.unsafe).toBe(true);
        expect(result.reasons.some((r) => r.startsWith('meter_seam'))).toBe(true);
    });
});
