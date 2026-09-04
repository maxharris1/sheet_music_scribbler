import { describe, expect, it } from 'vitest';

import { DEFAULT_VELOCITY } from './scoreData.js';
import type { ScoreNote } from './scoreData.js';
import { arpeggiateChord, realizeOrnament } from './ornaments.js';

const C4: ScoreNote = { t: 0, d: 480, p: 60, h: 0, v: 0.8 };
const E4: ScoreNote = { t: 0, d: 480, p: 64, h: 0, v: 0.8 };

const pitches = (notes: ScoreNote[]): number[] => notes.map((n) => n.p);
const durs = (notes: ScoreNote[]): number[] => notes.map((n) => n.d);
const onsets = (notes: ScoreNote[]): number[] => notes.map((n) => n.t);
const span = (notes: ScoreNote[]): number => notes.reduce((sum, n) => sum + n.d, 0);

describe('realizeOrnament', () => {
    it('trills a C-major quarter as 32nds, ending on the principal', () => {
        const out = realizeOrnament(C4, 'trill', { fifths: 0, bpm: 120 });
        // 8 units even → drop the last upper; remainder lands on the final C.
        expect(pitches(out)).toEqual([60, 62, 60, 62, 60, 62, 60]);
        expect(durs(out)).toEqual([60, 60, 60, 60, 60, 60, 120]);
        expect(onsets(out)).toEqual([0, 60, 120, 180, 240, 300, 360]);
        expect(span(out)).toBe(480);
        expect(out.every((n) => n.h === 0)).toBe(true);
        expect(out.filter((n) => n.p === 60).every((n) => n.v === 0.8)).toBe(true);
        expect(out.filter((n) => n.p === 62).every((n) => n.v === 0.75)).toBe(true);
    });

    it('trills E in F major onto F, a semitone above', () => {
        const out = realizeOrnament(E4, 'trill', { fifths: -1, bpm: 120 });
        expect(pitches(out).slice(0, 2)).toEqual([64, 65]);
        expect(span(out)).toBe(480);
    });

    it('plays a mordent as principal–lower–principal', () => {
        const out = realizeOrnament(C4, 'mordent', { fifths: 0, bpm: 120 });
        expect(pitches(out)).toEqual([60, 59, 60]);
        expect(durs(out)).toEqual([60, 60, 360]);
        expect(span(out)).toBe(480);
        expect(out.every((n) => n.v === 0.8)).toBe(true);
    });

    it('plays an inverted mordent with the upper neighbour', () => {
        const out = realizeOrnament(C4, 'inverted-mordent', { fifths: 0, bpm: 120 });
        expect(pitches(out)).toEqual([60, 62, 60]);
        expect(durs(out)).toEqual([60, 60, 360]);
    });

    it('plays a turn as four 32nds at the start, then the remainder', () => {
        const out = realizeOrnament(C4, 'turn', { fifths: 0, bpm: 120 });
        expect(pitches(out)).toEqual([62, 60, 59, 60, 60]);
        expect(durs(out)).toEqual([60, 60, 60, 60, 240]);
        expect(span(out)).toBe(480);
    });

    it('plays an inverted turn starting on the lower neighbour', () => {
        const out = realizeOrnament(C4, 'inverted-turn', { fifths: 0, bpm: 120 });
        expect(pitches(out)).toEqual([59, 60, 62, 60, 60]);
        expect(durs(out)).toEqual([60, 60, 60, 60, 240]);
        expect(span(out)).toBe(480);
    });

    it('lets accidental-mark flatten a whole-step upper neighbour to a semitone', () => {
        const out = realizeOrnament(C4, 'inverted-mordent', { fifths: 0, bpm: 120, accidentalMark: 'flat' });
        expect(pitches(out)).toEqual([60, 61, 60]);
    });

    it('lets accidental-mark sharpen a semitone upper neighbour', () => {
        const out = realizeOrnament(E4, 'inverted-mordent', { fifths: 0, bpm: 120, accidentalMark: 'sharp' });
        expect(pitches(out)).toEqual([64, 66, 64]);
    });

    it('leaves accidental-mark natural as the computed neighbour', () => {
        const out = realizeOrnament(C4, 'inverted-mordent', { fifths: 0, bpm: 120, accidentalMark: 'natural' });
        expect(pitches(out)).toEqual([60, 62, 60]);
    });

    it('leaves a short note unchanged', () => {
        const short = { ...C4, d: 119 };
        expect(realizeOrnament(short, 'trill', { fifths: 0, bpm: 120 })).toEqual([short]);
        expect(realizeOrnament({ ...C4, d: 179 }, 'mordent', { fifths: 0, bpm: 120 })).toEqual([{ ...C4, d: 179 }]);
        expect(realizeOrnament({ ...C4, d: 179 }, 'inverted-mordent', { fifths: 0, bpm: 120 })).toEqual([
            { ...C4, d: 179 },
        ]);
        expect(realizeOrnament({ ...C4, d: 299 }, 'turn', { fifths: 0, bpm: 120 })).toEqual([{ ...C4, d: 299 }]);
        expect(realizeOrnament({ ...C4, d: 299 }, 'inverted-turn', { fifths: 0, bpm: 120 })).toEqual([
            { ...C4, d: 299 },
        ]);
    });

    it('trills a half note in 32nds at 120 bpm and 64ths below 90 bpm', () => {
        const half = { ...C4, d: 960 };
        const allegro = realizeOrnament(half, 'trill', { fifths: 0, bpm: 120 });
        const adagio = realizeOrnament(half, 'trill', { fifths: 0, bpm: 60 });
        expect(allegro.slice(0, -1).every((n) => n.d === 60)).toBe(true);
        expect(adagio.slice(0, -1).every((n) => n.d === 30)).toBe(true);
        expect(allegro.length).toBe(15);
        expect(adagio.length).toBe(31);
        expect(allegro.length).not.toBe(adagio.length);
        expect(span(allegro)).toBe(960);
        expect(span(adagio)).toBe(960);
        expect(allegro[allegro.length - 1]?.p).toBe(60);
        expect(adagio[adagio.length - 1]?.p).toBe(60);
    });

    it('caps a trill at 64 units', () => {
        const long = { ...C4, d: 64 * 60 + 480 };
        const out = realizeOrnament(long, 'trill', { fifths: 0, bpm: 120 });
        expect(out.length).toBeLessThanOrEqual(64);
        expect(span(out)).toBe(long.d);
        expect(out[out.length - 1]?.p).toBe(60);
    });

    it('always spends exactly the principal duration', () => {
        for (const kind of ['trill', 'mordent', 'inverted-mordent', 'turn', 'inverted-turn'] as const) {
            for (const d of [120, 180, 300, 432, 480, 960]) {
                const note = { ...C4, d };
                expect(span(realizeOrnament(note, kind, { fifths: 0, bpm: 96 }))).toBe(d);
            }
        }
    });

    it('keeps an unset velocity off the principal copies and still shades the trill', () => {
        const plain: ScoreNote = { t: 0, d: 480, p: 60, h: 1 };
        const out = realizeOrnament(plain, 'trill', { fifths: 0, bpm: 120 });
        expect(out.filter((n) => n.p === 60).every((n) => n.v === undefined)).toBe(true);
        expect(out.filter((n) => n.p === 62).every((n) => n.v === DEFAULT_VELOCITY - 0.05)).toBe(true);
    });
});

describe('arpeggiateChord', () => {
    const chord = (pitches: number[], d = 480): ScoreNote[] =>
        pitches.map((p) => ({ t: 0, d, p, h: 0 as const, v: 0.7 }));

    it('rolls up from the bottom, shortening so every note still ends together', () => {
        const out = arpeggiateChord(chord([64, 60, 67]), 'up');
        expect(pitches(out)).toEqual([60, 64, 67]);
        expect(onsets(out)).toEqual([0, 60, 120]);
        expect(durs(out)).toEqual([480, 420, 360]);
        expect(out.every((n) => n.t + n.d === 480)).toBe(true);
    });

    it('rolls down from the top', () => {
        const out = arpeggiateChord(chord([60, 67, 64]), 'down');
        expect(pitches(out)).toEqual([67, 64, 60]);
        expect(onsets(out)).toEqual([0, 60, 120]);
        expect(durs(out)).toEqual([480, 420, 360]);
    });

    it('leaves a too-short chord, or a lone note, unchanged', () => {
        const pair = chord([60, 64], 120);
        expect(arpeggiateChord(pair, 'up')).toEqual(pair);
        const one = chord([60]);
        expect(arpeggiateChord(one, 'up')).toEqual(one);
        expect(arpeggiateChord([], 'up')).toEqual([]);
    });
});
