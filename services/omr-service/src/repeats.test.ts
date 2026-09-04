import { describe, expect, it } from 'vitest';

import { planRepeats, summarizeStructure, unrollRepeats } from './repeats.js';
import type { MeasureRepeatMarks } from './musicxml.js';

const LIMITS = { maxMeasures: 2000 };

const bar = (over: Partial<MeasureRepeatMarks> = {}): MeasureRepeatMarks => ({
    repeatForward: false,
    repeatBackward: false,
    repeatTimes: 2,
    endingStart: null,
    endingStop: false,
    ...over,
});

const dc = (al: 'fine' | 'coda' | null = null) => ({ kind: 'dc' as const, al });
const ds = (al: 'fine' | 'coda' | null = null) => ({ kind: 'ds' as const, al });

const plan = (marks: MeasureRepeatMarks[], limits = LIMITS, isPickup?: (i: number) => boolean) =>
    planRepeats(marks, limits, isPickup);

describe('planRepeats', () => {
    it('leaves a score with no repeat marks alone', () => {
        const result = plan([bar(), bar(), bar()]);
        expect(result).toEqual({ order: [0, 1, 2], degraded: false, performsRepeats: false, performsJumps: false });
    });

    it('plays |: A B :| as A B A B', () => {
        const result = plan([bar({ repeatForward: true }), bar({ repeatBackward: true })]);
        expect(result.order).toEqual([0, 1, 0, 1]);
        expect(result.degraded).toBe(false);
    });

    it('takes first and second endings in turn', () => {
        // |: A |1. B :|2. C |
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1], endingStop: true, repeatBackward: true }),
            bar({ endingStart: [2], endingStop: true }),
        ]);
        expect(result.order).toEqual([0, 1, 0, 2]);
        expect(result.degraded).toBe(false);
    });

    it('returns to the top when a backward repeat has no forward partner', () => {
        const result = plan([bar(), bar(), bar({ repeatBackward: true })]);
        expect(result.order).toEqual([0, 1, 2, 0, 1, 2]);
    });

    it('does not replay a pickup on the way round', () => {
        // Bar 0 is a pickup: played once on the way in, never again.
        const result = plan([bar(), bar(), bar({ repeatBackward: true })], LIMITS, (i) => i === 0);
        expect(result.order).toEqual([0, 1, 2, 1, 2]);
    });

    it('honours an explicit repeat count', () => {
        const result = plan([bar({ repeatForward: true }), bar({ repeatBackward: true, repeatTimes: 3 })]);
        expect(result.order).toEqual([0, 1, 0, 1, 0, 1]);
    });

    it('lets a second forward repeat take over as the return point', () => {
        // |: A |: B :|  — the nearer forward wins, which is the reading engravers mean.
        const result = plan([
            bar({ repeatForward: true }),
            bar({ repeatForward: true }),
            bar({ repeatBackward: true }),
        ]);
        expect(result.order).toEqual([0, 1, 2, 1, 2]);
    });

    it('skips a volta whose pass does not match', () => {
        // |: A |1. B :| |3. C |  — pass 2 matches neither bracket.
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1], endingStop: true, repeatBackward: true }),
            bar({ endingStart: [3], endingStop: true }),
        ]);
        // Bar 2 is never reached, so the structure was not fully understood.
        expect(result.order).toEqual([0, 1, 0]);
        expect(result.degraded).toBe(true);
    });

    it('reads a multi-pass volta bracket', () => {
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1, 2], endingStop: true, repeatBackward: true, repeatTimes: 3 }),
            bar({ endingStart: [3], endingStop: true }),
        ]);
        expect(result.order).toEqual([0, 1, 0, 1, 0, 2]);
        expect(result.degraded).toBe(false);
    });

    it('degrades to linear rather than exceeding the measure cap', () => {
        // 40 passes of a 10-bar section would blow a 100-measure ceiling.
        const marks = [bar({ repeatForward: true }), ...Array.from({ length: 8 }, () => bar())];
        marks.push(bar({ repeatBackward: true, repeatTimes: 16 }));
        const result = plan(marks, { maxMeasures: 100 });
        expect(result.degraded).toBe(true);
        expect(result.order).toEqual(marks.map((_, i) => i));
    });

    it('degrades to linear on a structure it cannot resolve', () => {
        // A backward repeat inside a volta that never matches: no progress.
        const marks = Array.from({ length: 6 }, () =>
            bar({ repeatForward: true, repeatBackward: true, repeatTimes: 16 }),
        );
        const result = plan(marks, { maxMeasures: 20 });
        expect(result.degraded).toBe(true);
        expect(result.order).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('always terminates, whatever the marks say', () => {
        // Every combination of repeat flags on three bars, crossed with every
        // placement of a jump instruction and of the signs it reads, must
        // return rather than hang — the marks come from OCR, so no combination
        // is too silly to arrive.
        const instructions = [dc(null), dc('fine'), dc('coda'), ds(null), ds('fine'), ds('coda')];
        const signs: Array<Partial<MeasureRepeatMarks>> = [
            { segno: true },
            { fine: true },
            { toCoda: true },
            { codaTarget: true },
            { codaGlyph: true },
        ];
        const empty = (): Array<Partial<MeasureRepeatMarks>> => [{}, {}, {}];

        const jumpRows = [empty()];
        for (let at = 0; at < 3; at++) {
            for (const jump of instructions) {
                const row = empty();
                row[at] = { jump };
                jumpRows.push(row);
            }
        }
        // The lone extra row is the bare-glyph pair the planner disambiguates.
        const signRows = [empty(), [{ codaGlyph: true }, {}, { codaGlyph: true }]];
        for (let at = 0; at < 3; at++) {
            for (const sign of signs) {
                const row = empty();
                row[at] = sign;
                signRows.push(row);
            }
        }
        const structural = jumpRows.flatMap((jumps) =>
            signRows.map((signRow) => [0, 1, 2].map((k) => ({ ...jumps[k], ...signRow[k] }))),
        );

        const flags = [false, true];
        for (const f0 of flags)
            for (const b0 of flags)
                for (const f1 of flags)
                    for (const b1 of flags)
                        for (const e of [null, [1], [2], [1, 2]])
                            for (const extra of structural) {
                                const marks = [
                                    bar({ repeatForward: f0, repeatBackward: b0, ...extra[0] }),
                                    bar({
                                        repeatForward: f1,
                                        repeatBackward: b1,
                                        endingStart: e,
                                        endingStop: !!e,
                                        ...extra[1],
                                    }),
                                    bar({ ...extra[2] }),
                                ];
                                const result = plan(marks, { maxMeasures: 50 });
                                expect(result.order.length).toBeGreaterThan(0);
                                expect(result.order.length).toBeLessThanOrEqual(50);
                                expect(result.order.every((index) => index >= 0 && index < 3)).toBe(true);
                            }
    });
});

describe('planRepeats jumps', () => {
    it('plays a D.C. al Fine from the head and stops at the Fine', () => {
        const result = plan([bar(), bar({ fine: true }), bar({ jump: dc('fine') })]);
        expect(result.order).toEqual([0, 1, 2, 0, 1]);
        expect(result.degraded).toBe(false);
        expect(result.performsJumps).toBe(true);
    });

    it('reads a bare D.C. over a printed Fine as D.C. al Fine', () => {
        const result = plan([bar(), bar({ fine: true }), bar({ jump: dc() })]);
        expect(result.order).toEqual([0, 1, 2, 0, 1]);
        expect(result.degraded).toBe(false);
    });

    it('plays a bare D.C. with no Fine right through to the final barline', () => {
        const result = plan([bar(), bar(), bar({ jump: dc() })]);
        expect(result.order).toEqual([0, 1, 2, 0, 1, 2]);
        expect(result.degraded).toBe(false);
    });

    it('replays segno to To Coda, then appends the coda', () => {
        // A 𝄋 B (To Coda) C D.S. al Coda | 𝄌 E F
        const result = plan([
            bar(),
            bar({ segno: true }),
            bar({ toCoda: true }),
            bar({ jump: ds('coda') }),
            bar({ codaTarget: true }),
            bar(),
        ]);
        expect(result.order).toEqual([0, 1, 2, 3, 1, 2, 4, 5]);
        expect(result.degraded).toBe(false);
        expect(result.performsJumps).toBe(true);
    });

    it('does not retake a repeat on the way back through', () => {
        const result = plan([bar({ repeatForward: true }), bar({ repeatBackward: true }), bar({ jump: dc() })]);
        expect(result.order).toEqual([0, 1, 0, 1, 2, 0, 1, 2]);
        expect(result.degraded).toBe(false);
        expect(result.performsRepeats).toBe(true);
        expect(result.performsJumps).toBe(true);
    });

    it('takes the last volta on the way back through, not the first', () => {
        // |: A |1. B :| |2. C D.C. |
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1], endingStop: true, repeatBackward: true }),
            bar({ endingStart: [2], endingStop: true, jump: dc() }),
        ]);
        expect(result.order).toEqual([0, 1, 0, 2, 0, 2]);
        expect(result.degraded).toBe(false);
    });

    it('reads a three-pass volta as the third bracket after the jump', () => {
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1, 2], endingStop: true, repeatBackward: true, repeatTimes: 3 }),
            bar({ endingStart: [3], endingStop: true, jump: dc() }),
        ]);
        expect(result.order).toEqual([0, 1, 0, 1, 0, 2, 0, 2]);
        expect(result.degraded).toBe(false);
    });

    it('degrades when no volta bracket belongs to the final pass', () => {
        // |1. and |4. over a two-pass repeat: the way back has nowhere to land.
        const marks = [
            bar({ repeatForward: true }),
            bar({ endingStart: [1], endingStop: true, repeatBackward: true }),
            bar({ endingStart: [4], endingStop: true }),
            bar({ jump: dc() }),
        ];
        const result = plan(marks);
        expect(result.degraded).toBe(true);
        expect(result.order).toEqual([0, 1, 2, 3]);
    });

    it('takes the pickup on a D.C. though a bare backward repeat skips it', () => {
        // Bar 0 is a pickup. `:|` returns to bar 1; "da capo" means bar 0.
        const result = plan([bar(), bar(), bar({ repeatBackward: true }), bar({ jump: dc() })], LIMITS, (i) => i === 0);
        expect(result.order).toEqual([0, 1, 2, 1, 2, 3, 0, 1, 2, 3]);
        expect(result.degraded).toBe(false);
    });

    it('disambiguates two bare coda glyphs by engraving order', () => {
        const result = plan([
            bar({ segno: true }),
            bar({ codaGlyph: true }),
            bar({ jump: ds('coda') }),
            bar({ codaGlyph: true }),
            bar(),
        ]);
        expect(result.order).toEqual([0, 1, 2, 0, 1, 3, 4]);
        expect(result.degraded).toBe(false);
    });

    it('reads a bare D.S. over a To Coda / coda pair as D.S. al Coda', () => {
        // <sound dalsegno>/<sound tocoda>/<sound coda>: MusicXML has no attribute
        // for the words, so the pair itself is the second half of the phrase.
        const result = plan([
            bar({ segno: true }),
            bar({ toCoda: true }),
            bar({ jump: ds() }),
            bar({ codaTarget: true }),
            bar(),
        ]);
        expect(result.order).toEqual([0, 1, 2, 0, 1, 3, 4]);
        expect(result.degraded).toBe(false);
        expect(result.performsJumps).toBe(true);
    });

    it('reads a bare D.C. over two bare coda glyphs as D.C. al Coda', () => {
        // "D.C. al 𝄌", where the sign stands in for words no OCR pass can read.
        const result = plan([bar(), bar({ codaGlyph: true }), bar({ jump: dc() }), bar({ codaGlyph: true }), bar()]);
        expect(result.order).toEqual([0, 1, 2, 0, 1, 3, 4]);
        expect(result.degraded).toBe(false);
    });

    it('lets a printed Fine outrank a coda pair under a bare jump', () => {
        // Neither half of the phrase is written, and a bare "D.C." over both
        // signs is "D.C. al Fine" far more often than it is "al Coda". Reading
        // it that way strands the coda section, so the contradiction costs the
        // score its structure — which is the right price for a guess this thin.
        const result = plan([
            bar(),
            bar({ toCoda: true }),
            bar({ fine: true }),
            bar({ jump: dc() }),
            bar({ codaTarget: true }),
        ]);
        // A degraded plan's order is never performed — buildScoreData checks
        // the flag before it looks — so the al-Fine shape here is fine to pin:
        // what matters is that degraded is true and the score plays linear.
        expect(result.order).toEqual([0, 1, 2, 3, 0, 1, 2]);
        expect(result.degraded).toBe(true);
    });

    it('falls back to a plain jump when an inferred coda pair sits wrong', () => {
        // A stray 𝄌 sighting beside a bare D.C. must not cost the score a jump
        // it performs correctly today; only printed "al Coda" words degrade it.
        const result = plan([bar(), bar(), bar({ jump: dc() }), bar({ toCoda: true }), bar({ codaTarget: true })]);
        expect(result.order).toEqual([0, 1, 2, 0, 1, 2, 3, 4]);
        expect(result.degraded).toBe(false);
        expect(result.performsJumps).toBe(true);
    });

    it('stops at a Fine printed on the segno bar itself', () => {
        // The post-jump pass plays that bar before it reads the Fine, so a Fine
        // exactly ON the target is reachable — unlike one above it.
        const result = plan([bar(), bar({ segno: true, fine: true }), bar(), bar({ jump: ds('fine') })]);
        expect(result.order).toEqual([0, 1, 2, 3, 1]);
        expect(result.degraded).toBe(false);
    });

    it('ignores a segno, Fine or coda sign that no jump refers to', () => {
        // A misread "Fine" must not cost the score its repeats.
        const result = plan([
            bar({ repeatForward: true, segno: true }),
            bar({ repeatBackward: true, fine: true, codaGlyph: true }),
        ]);
        expect(result.order).toEqual([0, 1, 0, 1]);
        expect(result.degraded).toBe(false);
        expect(result.performsRepeats).toBe(true);
        expect(result.performsJumps).toBe(false);
    });
});

describe('planRepeats jump validation', () => {
    /** Four bars whose repeat unrolls to six, so a wholesale degrade shows. */
    const withRepeat = (...over: Array<Partial<MeasureRepeatMarks>>) => [
        bar({ repeatForward: true, ...over[0] }),
        bar({ repeatBackward: true, ...over[1] }),
        bar({ ...over[2] }),
        bar({ ...over[3] }),
    ];

    const cases: Array<[string, MeasureRepeatMarks[]]> = [
        ['two jump instructions', withRepeat({}, {}, { jump: dc() }, { jump: dc() })],
        ['a D.S. with no segno', withRepeat({}, {}, {}, { jump: ds() })],
        ['a segno at the jump itself', withRepeat({}, {}, {}, { segno: true, jump: ds() })],
        ['a segno below the jump', withRepeat({}, {}, { jump: ds() }, { segno: true })],
        ['two segni', withRepeat({ segno: true }, { segno: true }, {}, { jump: ds() })],
        ['a D.C. on the head measure', withRepeat({ jump: dc() })],
        ['al Fine with no Fine', withRepeat({}, {}, {}, { jump: dc('fine') })],
        ['a Fine below the jump', withRepeat({}, {}, { jump: dc('fine') }, { fine: true })],
        // Not `withRepeat`: the Fine has to sit on bar 0, above the segno.
        ['a Fine above the segno', [bar({ fine: true }), bar({ segno: true }), bar(), bar({ jump: ds('fine') })]],
        ['two Fines', withRepeat({ fine: true }, { fine: true }, {}, { jump: dc('fine') })],
        ['al Coda with no coda at all', withRepeat({}, {}, {}, { jump: dc('coda') })],
        ['al Coda with no To Coda', withRepeat({}, {}, { jump: dc('coda') }, { codaTarget: true })],
        ['a coda section above the jump', withRepeat({}, { toCoda: true }, { codaTarget: true }, { jump: dc('coda') })],
        ['a To Coda below the jump', withRepeat({}, {}, { jump: dc('coda') }, { toCoda: true, codaTarget: true })],
        ['a single unresolvable coda glyph', withRepeat({}, { codaGlyph: true }, {}, { jump: dc('coda') })],
        [
            'three coda glyphs',
            withRepeat({ codaGlyph: true }, { codaGlyph: true }, { codaGlyph: true }, { jump: dc('coda') }),
        ],
    ];

    for (const [what, marks] of cases) {
        it(`degrades the whole plan on ${what}`, () => {
            const result = plan(marks);
            // Wholesale: the repeat the score DID say is dropped along with it.
            expect(result).toEqual({
                order: [0, 1, 2, 3],
                degraded: true,
                performsRepeats: false,
                performsJumps: false,
            });
        });
    }
});

describe('planRepeats flags', () => {
    it('reports a plain score as performing neither', () => {
        const result = plan([bar(), bar()]);
        expect({ r: result.performsRepeats, j: result.performsJumps }).toEqual({ r: false, j: false });
    });

    it('reports a printed but never retaken repeat as performing neither', () => {
        // A lone `|:` with no partner: printed structure, no performance effect.
        const result = plan([bar({ repeatForward: true }), bar()]);
        expect(result.order).toEqual([0, 1]);
        expect({ r: result.performsRepeats, j: result.performsJumps }).toEqual({ r: false, j: false });
    });

    it('reports repeats and jumps independently', () => {
        const repeatOnly = plan([bar({ repeatForward: true }), bar({ repeatBackward: true })]);
        expect({ r: repeatOnly.performsRepeats, j: repeatOnly.performsJumps }).toEqual({ r: true, j: false });

        const jumpOnly = plan([bar(), bar({ jump: dc() })]);
        expect({ r: jumpOnly.performsRepeats, j: jumpOnly.performsJumps }).toEqual({ r: false, j: true });

        const both = plan([bar({ repeatForward: true }), bar({ repeatBackward: true }), bar({ jump: dc() })]);
        expect({ r: both.performsRepeats, j: both.performsJumps }).toEqual({ r: true, j: true });
    });

    it('reports neither once a plan has degraded to linear', () => {
        const marks = [bar({ repeatForward: true }), ...Array.from({ length: 8 }, () => bar())];
        marks.push(bar({ repeatBackward: true, repeatTimes: 16 }));
        const result = plan(marks, { maxMeasures: 100 });
        expect({ r: result.performsRepeats, j: result.performsJumps }).toEqual({ r: false, j: false });
    });
});

describe('summarizeStructure', () => {
    it('says nothing about a score with no structure', () => {
        expect(summarizeStructure([bar(), bar()])).toEqual({
            openForwardAtEnd: false,
            bareBackwardAtStart: false,
            openVoltaAtEnd: false,
            hasJumpMarks: false,
        });
    });

    it('sees a forward repeat whose partner is past the end', () => {
        const summary = summarizeStructure([
            bar({ repeatForward: true }),
            bar({ repeatBackward: true }),
            bar({ repeatForward: true }),
        ]);
        expect(summary.openForwardAtEnd).toBe(true);
        expect(summary.bareBackwardAtStart).toBe(false);
    });

    it('counts an unclosed volta at the end as an open forward', () => {
        const summary = summarizeStructure([
            bar({ repeatForward: true }),
            bar({ endingStart: [1], endingStop: true, repeatBackward: true }),
            bar({ endingStart: [2] }),
        ]);
        expect(summary.openForwardAtEnd).toBe(true);
        expect(summary.openVoltaAtEnd).toBe(true);
    });

    it('closes a volta that ends on the bar it opened', () => {
        const summary = summarizeStructure([bar({ endingStart: [1], endingStop: true }), bar()]);
        expect(summary.openVoltaAtEnd).toBe(false);
        expect(summary.openForwardAtEnd).toBe(false);
    });

    it('sees a backward repeat whose top is above the range', () => {
        const summary = summarizeStructure([bar(), bar({ repeatBackward: true }), bar({ repeatForward: true })]);
        expect(summary.bareBackwardAtStart).toBe(true);
        expect(summary.openForwardAtEnd).toBe(true);
    });

    it('does not call a normal repeat pair a bare backward', () => {
        const summary = summarizeStructure([bar({ repeatForward: true }), bar({ repeatBackward: true })]);
        expect(summary.bareBackwardAtStart).toBe(false);
        expect(summary.openForwardAtEnd).toBe(false);
    });

    it('reports every kind of jump mark, resolvable or not', () => {
        const each: Array<Partial<MeasureRepeatMarks>> = [
            { segno: true },
            { codaTarget: true },
            { toCoda: true },
            { codaGlyph: true },
            { fine: true },
            { jump: dc('fine') },
        ];
        for (const over of each) {
            expect(summarizeStructure([bar(), bar(over)]).hasJumpMarks).toBe(true);
        }
        expect(summarizeStructure([bar(), bar({ jump: null })]).hasJumpMarks).toBe(false);
    });
});

describe('unrollRepeats', () => {
    /** Three 480-tick bars, one note each, geometry that must survive cloning. */
    const linear = {
        measures: [
            { tick: 0, dTicks: 480, srcIndex: 0, page: 0, sys: 0, x0: 0.1, x1: 0.3, sl: [{ x: 0.15, t: 0 }] },
            { tick: 480, dTicks: 480, srcIndex: 1, page: 0, sys: 0, x0: 0.3, x1: 0.5, sl: [{ x: 0.35, t: 0 }] },
            { tick: 960, dTicks: 480, srcIndex: 2, page: 0, sys: 0, x0: 0.5, x1: 0.7, sl: [{ x: 0.55, t: 0 }] },
        ],
        notes: [
            { t: 0, d: 480, p: 60, h: 0 as const },
            { t: 480, d: 480, p: 62, h: 0 as const },
            { t: 960, d: 480, p: 64, h: 0 as const },
        ],
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        totalTicks: 1440,
    };

    it('clones a repeated bar with its geometry intact at a new tick', () => {
        const out = unrollRepeats(linear, [0, 1, 0, 1, 2]);
        expect(out.measures.map((m) => m.tick)).toEqual([0, 480, 960, 1440, 1920]);
        expect(out.measures.map((m) => m.srcIndex)).toEqual([0, 1, 0, 1, 2]);
        // The page position is what makes the playhead sweep the same bar twice.
        const [first, , second] = out.measures;
        expect({ page: second!.page, sys: second!.sys, x0: second!.x0, x1: second!.x1, sl: second!.sl }).toEqual({
            page: first!.page,
            sys: first!.sys,
            x0: first!.x0,
            x1: first!.x1,
            sl: first!.sl,
        });
        expect(out.totalTicks).toBe(2400);
    });

    it('re-emits the notes of every pass', () => {
        const out = unrollRepeats(linear, [0, 1, 0, 1, 2]);
        expect(out.notes.map((n) => [n.t, n.p])).toEqual([
            [0, 60],
            [480, 62],
            [960, 60],
            [1440, 62],
            [1920, 64],
        ]);
    });

    it('clips a note held across a jump but not one across a continuous seam', () => {
        const held = {
            ...linear,
            notes: [
                { t: 0, d: 480, p: 60, h: 0 as const },
                // Bar 1's note rings two bars — legitimate inside a run, but it
                // cannot ring past the repeat's backward jump.
                { t: 480, d: 960, p: 62, h: 0 as const },
                { t: 960, d: 480, p: 64, h: 0 as const },
            ],
        };
        const out = unrollRepeats(held, [0, 1, 0, 1, 2]);
        const long = out.notes.filter((n) => n.p === 62);
        // First pass jumps back after bar 1 → clipped to the bar.
        expect(long[0]!.d).toBe(480);
        // Second pass continues into bar 2 → keeps its full length.
        expect(long[1]!.d).toBe(960);
    });

    it('re-emits the state in force at a jump target', () => {
        const withSigs = {
            ...linear,
            timeSignatures: [
                { tick: 0, num: 4, den: 4 },
                { tick: 960, num: 3, den: 4 },
            ],
        };
        // Perform bar 2 (3/4), then jump back to bar 0 (4/4).
        const out = unrollRepeats(withSigs, [2, 0, 1]);
        expect(out.timeSignatures).toEqual([
            { tick: 0, num: 3, den: 4 },
            { tick: 480, num: 4, den: 4 },
        ]);
    });

    it('duplicates a fermata that falls inside a repeated bar', () => {
        const out = unrollRepeats({ ...linear, holds: [{ tick: 480, beats: 2 }] }, [0, 1, 0, 1, 2]);
        expect(out.holds).toEqual([
            { tick: 480, beats: 2 },
            { tick: 1440, beats: 2 },
        ]);
    });

    it('keeps an orphan release at the score head instead of dropping it', () => {
        // OMR losing the start of a pedal line leaves a lone 'up' — here on
        // tick 0, the one tick with no bar before it to claim it. Bar 0 takes
        // it, on each pass, so the down that follows still alternates.
        const out = unrollRepeats(
            { ...linear, pedals: [{ tick: 0, k: 'up' as const }, { tick: 479, k: 'down' as const }] },
            [0, 1, 0, 1, 2],
        );
        expect(out.pedals).toEqual([
            { tick: 0, k: 'up' },
            { tick: 479, k: 'down' },
            { tick: 960, k: 'up' },
            { tick: 1439, k: 'down' },
        ]);
    });

    it('gives every pass its release when the pedal lifts on the repeat bar line', () => {
        const out = unrollRepeats(
            { ...linear, pedals: [{ tick: 0, k: 'down' as const }, { tick: 960, k: 'up' as const }] },
            [0, 1, 0, 1, 2],
        );
        // The 'up' sits on the bar line the repeat jumps from. Each pass must
        // release before the span replays — and the second pass's fresh 'down'
        // lands on the same tick as the first pass's 'up', in re-catch order.
        expect(out.pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 960, k: 'up' },
            { tick: 960, k: 'down' },
            { tick: 1920, k: 'up' },
        ]);
    });

    it('leaves a linear order completely unchanged', () => {
        const out = unrollRepeats(linear, [0, 1, 2]);
        expect(out.measures).toEqual(linear.measures);
        expect(out.notes).toEqual(linear.notes);
        expect(out.totalTicks).toBe(linear.totalTicks);
    });
});
