import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildScoreData } from '../src/buildScoreData.js';
import { parseMxlFiles } from '../src/musicxml.js';
import { parseOmrGeometry } from '../src/omrGeometry.js';

/** Sounding duration of an unarticulated note: 90% of the notated value. */
const plain = (notated: number): number => Math.round(notated * 0.9);

/**
 * End-to-end parser test against REAL Audiveris 5.6.1 artifacts, generated
 * from test/fixtures/tiny.musicxml (rendered by verovio → PDF → Audiveris;
 * see the service README to regenerate). Values below were verified by eye
 * against the engraving. Notable genuine-OMR quirk baked into the fixture:
 * Audiveris reads the metronome mark's quarter glyph as a real G5 note in
 * the pickup, so m. 0 is 960 ticks with 2 notes — the pipeline must stay
 * self-consistent (audio and geometry share the same measure timeline),
 * which is exactly what these assertions check.
 */

const mxl = readFileSync(new URL('./fixtures/tiny.mxl', import.meta.url));
const omr = readFileSync(new URL('./fixtures/tiny.omr', import.meta.url));

describe('fixture pipeline (mxl + omr → ScoreData)', () => {
    const musical = parseMxlFiles([mxl]);
    const geometry = parseOmrGeometry(omr);
    const score = buildScoreData(musical, geometry);

    it('extracts the measure timeline (incl. the pickup and the 3/4 change)', () => {
        expect(score.measures).toHaveLength(15);
        expect(score.measures[0]).toMatchObject({ n: 0, tick: 0, dTicks: 960, page: 0, sys: 0 });
        expect(score.measures[4]).toMatchObject({ n: 4, tick: 6720, dTicks: 1440, page: 0, sys: 1 });
        expect(score.measures[8]).toMatchObject({ n: 8, tick: 12480, page: 1, sys: 2 });
        expect(score.measures[14]).toMatchObject({ n: 14, tick: 21120, dTicks: 1440, page: 1, sys: 3 });
        expect(score.totalTicks).toBe(22560);
        expect(score.timeSignatures).toEqual([
            { tick: 0, num: 4, den: 4 },
            { tick: 6720, num: 3, den: 4 },
        ]);
    });

    it('zips every measure to geometry in reading order, skipping the cautionary stack', () => {
        // 15 stacks ↔ 15 measures, so nothing geometric to report. The single
        // warning is about tempo: Audiveris never recognized the ♩=n text.
        expect(score.warnings).toEqual(['tempo_defaulted']);
        for (const [index, measure] of score.measures.entries()) {
            expect(measure.sys, `measure ${index} has geometry`).toBeGreaterThanOrEqual(0);
            expect(measure.x1).toBeGreaterThan(measure.x0);
        }
        // Measures within one system tile left→right without overlap.
        for (let i = 1; i < score.measures.length; i++) {
            const prev = score.measures[i - 1];
            const cur = score.measures[i];
            if (prev && cur && prev.sys === cur.sys) {
                expect(cur.x0).toBeCloseTo(prev.x1, 5);
            }
        }
    });

    it('produces four systems across two pages with sane y-bands', () => {
        expect(score.systems).toHaveLength(4);
        expect(score.systems.map((s) => s.page)).toEqual([0, 0, 1, 1]);
        for (const system of score.systems) {
            expect(system.y1).toBeGreaterThan(system.y0);
            expect(system.y0).toBeGreaterThanOrEqual(0);
            expect(system.y1).toBeLessThanOrEqual(1);
        }
    });

    it('splits hands by staff and merges the tie across the barline', () => {
        expect(score.notes).toHaveLength(54);
        expect(score.notes.filter((n) => n.h === 0)).toHaveLength(32);
        expect(score.notes.filter((n) => n.h === 1)).toHaveLength(22);
        // A5 whole tied to A5 whole = one 3840-tick note, gated once at its close.
        expect(score.notes.filter((n) => n.d > 1920)).toEqual([{ t: 2880, d: plain(3840), p: 81, h: 0 }]);
        // The E5+G5 chord shares one onset.
        const chord = score.notes.filter((n) => n.t === 960 && n.h === 0);
        expect(chord.map((n) => n.p).sort((a, b) => a - b)).toEqual([76, 79]);
    });

    it('found no tempo mark (metronome text needs OCR) → tempo taken from the meter', () => {
        // No tempo evidence of any kind survived the OMR, so the meter decides:
        // 4/4 reads as a moderate 96, erring slow, and says so rather than
        // leaving the reader to wonder where the number came from.
        expect(score.defaultBpm).toBe(96);
        expect(score.warnings).toContain('tempo_defaulted');
    });

    it('carries the engraved chord columns for a note-accurate playhead', () => {
        // Every fixture measure has slot data (1–4 chord columns).
        expect(score.measures.every((m) => (m.sl?.length ?? 0) >= 1)).toBe(true);
        // m1: two half-note columns at ticks 0 and 960.
        expect(score.measures[1]?.sl?.map((s) => s.t)).toEqual([0, 960]);
        // m5 (the eighth-note run): quarter, two eighths, quarter → 0, 480, 720, 960 —
        // with the UNEVEN engraved x spacing a linear playhead would get wrong.
        expect(score.measures[5]?.sl?.map((s) => s.t)).toEqual([0, 480, 720, 960]);
        for (const measure of score.measures) {
            for (const slot of measure.sl ?? []) {
                expect(slot.x).toBeGreaterThanOrEqual(measure.x0);
                expect(slot.x).toBeLessThanOrEqual(measure.x1);
                expect(slot.t).toBeLessThan(measure.dTicks);
            }
        }
    });
});

describe('key-signature fixture (G major, real Audiveris 5.6.1 artifact)', () => {
    // Pitch-accuracy proof for the classic OMR trap: notes altered by the key
    // signature carry NO printed accidental. keysig.musicxml (source) engraves
    // G major; Audiveris must emit alter=1 on every F for the sounding pitch.
    const keysig = readFileSync(new URL('./fixtures/keysig.mxl', import.meta.url));
    const musical = parseMxlFiles([keysig]);

    it('applies the key signature (F→F♯), honors accidentals, keeps naturals', () => {
        expect(musical.notes).toEqual([
            { t: 0, d: plain(480), p: 78, h: 0 }, // F♯5 purely from the key signature
            { t: 0, d: plain(960), p: 50, h: 1 }, // D3 stays natural
            { t: 480, d: plain(480), p: 79, h: 0 }, // G5
            { t: 960, d: plain(480), p: 81, h: 0 }, // A5
            { t: 960, d: plain(960), p: 38, h: 1 }, // D2
            { t: 1440, d: plain(480), p: 85, h: 0 }, // C♯6 from an explicit accidental
            { t: 1920, d: plain(1920), p: 74, h: 0 }, // D5 (chord)
            { t: 1920, d: plain(1920), p: 78, h: 0 }, // F♯5 inside the chord — key sig again
            { t: 1920, d: plain(1920), p: 43, h: 1 }, // G2
        ]);
    });

    it('keeps the two-bar timeline intact', () => {
        expect(musical.measures.map((m) => ({ tick: m.tick, dTicks: m.dTicks }))).toEqual([
            { tick: 0, dTicks: 1920 },
            { tick: 1920, dTicks: 1920 },
        ]);
        expect(musical.totalTicks).toBe(3840);
    });

    it('exports the G-major key signature and treble/bass clefs', () => {
        expect(musical.keySignatures).toEqual([{ tick: 0, fifths: 1 }]);
        expect(musical.clefs.some((c) => c.staff === 0 && c.sign === 'G')).toBe(true);
        expect(musical.clefs.some((c) => c.staff === 1 && c.sign === 'F')).toBe(true);
    });
});
