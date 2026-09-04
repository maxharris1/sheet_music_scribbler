import { readFileSync } from 'node:fs';

import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';

import { buildScoreData } from './buildScoreData.js';
import { mergeScoreDataParts } from './mergeScoreData.js';
import { parseMusicXmlString, parseMxlFiles, expressionSeedAt } from './musicxml.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER, scoreDataSchema } from './scoreData.js';

const wrap = (measures: string, extraParts = ''): string => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"/><score-part id="P2"/></part-list>
  <part id="P1">${measures}</part>${extraParts}
</score-partwise>`;

const ATTRS_44 = `<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;

const note = (step: string, octave: number, duration: number, extra = ''): string =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>1</voice>${extra}</note>`;

/**
 * Sounding duration of an unarticulated note: real playing leaves a little air
 * between notes that are not slurred, so `d` is 90% of the notated value unless
 * a marking says otherwise. Expectations below use this rather than bare
 * constants, so the intent stays legible.
 */
const plain = (notated: number): number => Math.round(notated * 0.9);

describe('parseMusicXmlString', () => {
    it('reads tempo from <sound tempo>', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<direction><sound tempo="72.4"/></direction>${note('C', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.defaultBpm).toBe(72);
    });

    it('reads tempo from <per-minute> when <sound> is absent', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>132</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
        );
        expect(parseMusicXmlString(xml).defaultBpm).toBe(132);
    });

    it('converts non-quarter <beat-unit> metronome marks to quarter-note BPM', () => {
        const half = wrap(
            `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>half</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
        );
        expect(parseMusicXmlString(half).defaultBpm).toBe(120);

        const dotted = wrap(
            `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>half</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
        );
        expect(parseMusicXmlString(dotted).defaultBpm).toBe(180);
    });

    it('pads underfull non-pickup measures to the active time signature', () => {
        // One quarter in 4/4 → pad to 1920 ticks so later bars stay on the grid.
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 4)}</measure><measure number="2">${note('E', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.measures.map((m) => m.dTicks)).toEqual([1920, 1920]);
        expect(score.measures[1]?.tick).toBe(1920);
        expect(score.warnings).toContain('measure_underfull');
    });

    it('extends open ties across underfull padding', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                ${note('C', 4, 4, '<tie type="start"/>')}
                ${note('D', 4, 4)}
                ${note('E', 4, 4)}
            </measure>
            <measure number="2">${note('C', 4, 4, '<tie type="stop"/>')}${note('G', 4, 12)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        // Content was 3 quarters; pad adds 480. Open C4 tie absorbs the pad, then
        // the stop adds one more quarter → 480+480+480 = 1440 notated. A tie chain
        // is gated once, when it closes.
        expect(score.notes.find((n) => n.p === 60)).toMatchObject({ t: 0, d: plain(1440) });
        expect(score.measures[1]?.tick).toBe(1920);
    });

    it('extends secondary-part open ties when the lead timeline is padded', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 5, 4)}${note('D', 5, 4)}${note('E', 5, 4)}</measure>
             <measure number="2">${note('G', 5, 16)}</measure>`,
            `<part id="P2"><measure number="1">${ATTRS_44}${note('C', 3, 8, '<tie type="start"/>')}</measure>
             <measure number="2">${note('C', 3, 4, '<tie type="stop"/>')}${note('G', 2, 12)}</measure></part>`,
        );
        const score = parseMusicXmlString(xml);
        // Lead m1 underfull (1440→1920). LH half (960) pads by 960 to the
        // timeline, then the stop adds one quarter → 960+960+480 = 2400.
        expect(score.notes.find((n) => n.p === 48 && n.h === 1)).toMatchObject({ t: 0, d: plain(2400) });
        expect(score.measures[0]?.dTicks).toBe(1920);
    });

    it('keeps pickup (measure 0 / implicit) content length', () => {
        const xml = wrap(
            `<measure number="0" implicit="yes">${ATTRS_44}${note('C', 4, 4)}</measure><measure number="1">${note('E', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.measures[0]).toMatchObject({ n: 0, dTicks: 480 });
        expect(score.measures[1]?.tick).toBe(480);
        expect(score.warnings).not.toContain('measure_underfull');
    });

    it('converts dotted-quarter and eighth beat units too', () => {
        const mark = (unit: string, dots: number, perMinute: number) =>
            wrap(
                `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>${unit}</beat-unit>${'<beat-unit-dot/>'.repeat(dots)}<per-minute>${perMinute}</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
            );
        expect(parseMusicXmlString(mark('quarter', 1, 60)).defaultBpm).toBe(90); // dotted-quarter = 60 (6/8 feel)
        expect(parseMusicXmlString(mark('eighth', 0, 120)).defaultBpm).toBe(60); // eighth = 120
    });

    it('maps a second single-staff part to the left hand', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 5, 16)}</measure>`,
            `<part id="P2"><measure number="1">${ATTRS_44}${note('C', 2, 16)}</measure></part>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([
            { t: 0, d: plain(1920), p: 72, h: 0 },
            { t: 0, d: plain(1920), p: 36, h: 1 },
        ]);
        expect(score.warnings).not.toContain('single_staff_all_rh');
    });

    it('prefers a later Piano grand staff over sparse Voice dummy parts', () => {
        // Audiveris often emits Voice/Voice before Piano; document order must not win.
        const voiceMeasure = (id: string, step: string, octave: number) =>
            `<part id="${id}"><measure number="1">${ATTRS_44}${note(step, octave, 16)}</measure>
             <measure number="2">${ATTRS_44}<note><rest/><duration>16</duration><voice>1</voice></note></measure></part>`;
        const pianoAttrs = `<attributes><divisions>4</divisions><staves>2</staves><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;
        const xml = `<?xml version="1.0"?>
          <score-partwise version="4.0">
            <part-list>
              <score-part id="P1"><part-name>Voice</part-name></score-part>
              <score-part id="P2"><part-name>Voice</part-name></score-part>
              <score-part id="P3"><part-name>Piano</part-name></score-part>
            </part-list>
            ${voiceMeasure('P1', 'G', 4)}
            ${voiceMeasure('P2', 'E', 4)}
            <part id="P3">
              <measure number="1">${pianoAttrs}
                ${note('C', 5, 8, '<staff>1</staff>')}
                ${note('E', 5, 8, '<staff>1</staff>')}
                ${note('C', 3, 16, '<staff>2</staff>')}
              </measure>
              <measure number="2">${pianoAttrs}
                ${note('D', 5, 16, '<staff>1</staff>')}
                ${note('G', 2, 16, '<staff>2</staff>')}
              </measure>
            </part>
          </score-partwise>`;
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('multi_part_collapsed');
        expect(score.notes.map((n) => n.p).sort((a, b) => a - b)).toEqual([43, 48, 72, 74, 76]);
        expect(score.notes.some((n) => n.h === 1)).toBe(true);
        // Voice pitches (G4=67, E4=64) must not appear.
        expect(score.notes.every((n) => n.p !== 67 && n.p !== 64)).toBe(true);
        expect(score.measures).toHaveLength(2);
    });

    it('keeps Piano alone when a denser vocal line is listed first (art song)', () => {
        const xml = `<?xml version="1.0"?>
          <score-partwise version="4.0">
            <part-list>
              <score-part id="P1"><part-name>Voice</part-name></score-part>
              <score-part id="P2"><part-name>Piano</part-name></score-part>
            </part-list>
            <part id="P1"><measure number="1">${ATTRS_44}
              ${note('A', 4, 4)}${note('B', 4, 4)}${note('C', 5, 4)}${note('D', 5, 4)}
            </measure></part>
            <part id="P2"><measure number="1">
              <attributes><divisions>4</divisions><staves>2</staves>
                <time><beats>4</beats><beat-type>4</beat-type></time>
              </attributes>
              ${note('C', 4, 16, '<staff>1</staff>')}
              <backup><duration>16</duration></backup>
              ${note('C', 3, 16, '<staff>2</staff>')}
            </measure></part>
          </score-partwise>`;
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('multi_part_collapsed');
        expect(score.notes).toEqual([
            { t: 0, d: plain(1920), p: 60, h: 0 },
            { t: 0, d: plain(1920), p: 48, h: 1 },
        ]);
    });

    it('flags a lone single-staff part as all right hand', () => {
        const xml = `<?xml version="1.0"?><score-partwise>
            <part-list><score-part id="P1"/></part-list>
            <part id="P1"><measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure></part>
        </score-partwise>`;
        expect(parseMusicXmlString(xml).warnings).toContain('single_staff_all_rh');
    });

    it('applies alter to pitches', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><pitch><step>F</step><octave>4</octave><alter>1</alter></pitch><duration>16</duration><voice>1</voice></note>
            </measure>`,
        );
        expect(parseMusicXmlString(xml).notes).toEqual([{ t: 0, d: plain(1920), p: 66, h: 0 }]);
    });

    it('plays grace notes as crushed attacks stealing time before their principal', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><rest/><duration>4</duration><voice>1</voice></note>
                <note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>
                <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
                <note><rest/><duration>8</duration><voice>1</voice></note>
            </measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([
            { t: 419, d: 61, p: 62, h: 0, v: 0.6 }, // acciaccatura — never gated; 96 bpm → 61 ticks
            { t: 480, d: plain(480), p: 64, h: 0 },
        ]);
        expect(score.warnings).not.toContain('grace_notes_skipped');
    });

    it('shapes velocities from printed dynamics', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <direction><direction-type><dynamics><p/></dynamics></direction-type></direction>
                ${note('C', 4, 4)}
                <direction><direction-type><dynamics><f/></dynamics></direction-type></direction>
                ${note('D', 4, 4)}
                <note><rest/><duration>8</duration><voice>1</voice></note>
            </measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([
            { t: 0, d: plain(480), p: 60, h: 0, v: 0.46 },
            { t: 480, d: plain(480), p: 62, h: 0, v: 0.82 },
        ]);
    });

    it('sforzando punches a single attack — shared by its whole chord', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <direction><direction-type><dynamics><mf/></dynamics></direction-type></direction>
                ${note('C', 4, 4)}
                <direction><direction-type><dynamics><sfz/></dynamics></direction-type></direction>
                <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
                <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
                ${note('F', 4, 8)}
            </measure>`,
        );
        const velocities = parseMusicXmlString(xml).notes.map((n) => n.v);
        expect(velocities).toEqual([0.7, 0.9, 0.9, 0.7]); // mf, sfz chord (both), back to mf
    });

    it('merges a tie whose stop was renumbered into another voice (system break)', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><tie type="start"/></note>
            </measure>
            <measure number="2">
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>3</voice><tie type="stop"/></note>
            </measure>`,
        );
        expect(parseMusicXmlString(xml).notes).toEqual([{ t: 0, d: plain(3840), p: 72, h: 0 }]);
    });

    it('refuses to merge a "tie" whose halves are not rhythmically adjacent', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><tie type="start"/></note>
                <note><rest/><duration>8</duration><voice>1</voice></note>
            </measure>
            <measure number="2">
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>2</voice><tie type="stop"/></note>
                <note><rest/><duration>8</duration><voice>2</voice></note>
            </measure>`,
        );
        // The open half ends at 960 but the "stop" starts at 1920 — two notes.
        expect(parseMusicXmlString(xml).notes).toEqual([
            { t: 0, d: plain(960), p: 72, h: 0 },
            { t: 1920, d: plain(960), p: 72, h: 0 },
        ]);
    });

    it('records repeat barlines on a linear timeline, and judges nothing', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 16)}<barline location="right"><repeat direction="backward"/></barline></measure>
             <measure number="2">${note('D', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        // Whether a repeat was performed, ignored, or never needed saying is
        // buildScoreData's call — the parser only reports what is engraved.
        expect(score.warnings).not.toContain('repeats_ignored');
        expect(score.repeats[0]).toMatchObject({ repeatBackward: true });
        expect(score.measures.map((m) => m.tick)).toEqual([0, 1920]);
    });

    it('gives an empty measure a full bar of the active signature', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure><measure number="2"></measure><measure number="3">${note('E', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.measures.map((m) => m.tick)).toEqual([0, 1920, 3840]);
    });

    it('offsets everything by tickOffset (movement concatenation)', () => {
        const xml = wrap(`<measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure>`);
        const score = parseMusicXmlString(xml, 10000);
        expect(score.notes[0]?.t).toBe(10000);
        expect(score.measures[0]?.tick).toBe(10000);
        expect(score.totalTicks).toBe(11920);
    });

    it('numbers unnumbered measures sequentially', () => {
        const xml = wrap(`<measure>${ATTRS_44}${note('C', 4, 16)}</measure><measure>${note('D', 4, 16)}</measure>`);
        expect(parseMusicXmlString(xml).measures.map((m) => m.n)).toEqual([1, 2]);
    });
});

/**
 * Dynamics. `divisions=4`, so a duration unit is a 16th (120 ticks) and a bar
 * of 4/4 is 1920. Staff 1 is the right hand (h=0), staff 2 the left (h=1).
 */
describe('dynamics resolution', () => {
    const GRAND = `<attributes><divisions>4</divisions><staves>2</staves><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;

    const dyn = (mark: string, staff?: number): string =>
        `<direction><direction-type><dynamics><${mark}/></dynamics></direction-type>${staff ? `<staff>${staff}</staff>` : ''}</direction>`;

    const sn = (step: string, octave: number, duration: number, staff: number, extra = ''): string =>
        `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${staff}</voice><staff>${staff}</staff>${extra}</note>`;

    /** Four quarters in the right hand, then a whole note in the left. */
    const twoHandBar = (lead = '', afterBackup = ''): string =>
        `<measure>${lead}${sn('C', 5, 4, 1)}${sn('D', 5, 4, 1)}${sn('E', 5, 4, 1)}${sn('F', 5, 4, 1)}` +
        `<backup><duration>16</duration></backup>${afterBackup}${sn('C', 3, 16, 2)}</measure>`;

    const at = (score: ReturnType<typeof parseMusicXmlString>, hand: 0 | 1, tick: number) =>
        score.notes.filter((n) => n.h === hand && n.t >= tick && n.t < tick + 1920).map((n) => n.v);

    it('does not let the lower staff dynamic govern the next bar of the upper staff', () => {
        // The headline regression: MusicXML writes [staff 1] <backup> [staff 2],
        // so the left hand's mark used to be the last one seen in the bar and
        // silently became the right hand's dynamic from the next bar onward.
        const xml = wrap(twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar() + twoHandBar());
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 0)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 0)).toEqual([0.46]);
        // Bars 2 and 3 carry no marks at all — both hands must hold their own.
        expect(at(score, 0, 1920)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 1920)).toEqual([0.46]);
        expect(at(score, 0, 3840)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 3840)).toEqual([0.46]);
    });

    it('applies an unattributed dynamic to both hands', () => {
        const xml = wrap(twoHandBar(`${GRAND}${dyn('ff')}`) + twoHandBar());
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 1920)).toEqual([0.92, 0.92, 0.92, 0.92]);
        expect(at(score, 1, 1920)).toEqual([0.92]);
    });

    it('still reaches the left hand when the writer only ever marks staff 1', () => {
        // Audiveris often attributes every dynamic to the upper staff. That is
        // indistinguishable from a score with one dynamic line, so broadcast —
        // scoping strictly per staff would leave the left hand with nothing.
        const xml = wrap(
            twoHandBar(`${GRAND}${dyn('pp', 1)}`) +
                twoHandBar(dyn('f', 1)) +
                twoHandBar(dyn('p', 1)) +
                twoHandBar(dyn('ff', 1)),
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 1, 0)).toEqual([0.34]);
        expect(at(score, 1, 1920)).toEqual([0.82]);
        expect(at(score, 1, 5760)).toEqual([0.92]);
        expect(score.warnings).toContain('dynamics_not_staff_split');
    });

    it('does not warn about staff splitting when the writer does distinguish hands', () => {
        const xml = wrap(twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar());
        expect(parseMusicXmlString(xml).warnings).not.toContain('dynamics_not_staff_split');
    });

    it('keeps an established left-hand dynamic when a later mark names only staff 1', () => {
        // Independence is sticky: a lone staff-1 ff in bar 3 must not silently
        // overwrite the p the left hand was given in bar 1.
        const xml = wrap(twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar() + twoHandBar(dyn('ff', 1)));
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 3840)).toEqual([0.92, 0.92, 0.92, 0.92]);
        expect(at(score, 1, 3840)).toEqual([0.46]);
    });

    it('re-unifies both hands on an unattributed dynamic after a split', () => {
        // In a file that attributes when it means to, a mark with no staff is a
        // whole-texture marking and overrides the separation.
        const xml = wrap(twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar(dyn('pp')) + twoHandBar());
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 3840)).toEqual([0.34, 0.34, 0.34, 0.34]);
        expect(at(score, 1, 3840)).toEqual([0.34]);
    });

    it('treats cross-staff marks a sixteenth apart as one gesture', () => {
        // The staff-2 mark sits after a backup of 15 units, i.e. 120 ticks into
        // the bar — engraved on the same beat, quantized apart.
        const xml = wrap(
            `<measure>${GRAND}${dyn('f', 1)}${sn('C', 5, 4, 1)}${sn('D', 5, 4, 1)}${sn('E', 5, 4, 1)}${sn('F', 5, 4, 1)}` +
                `<backup><duration>15</duration></backup>${dyn('p', 2)}${sn('C', 3, 12, 2)}</measure>` +
                twoHandBar(),
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 1920)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 1920)).toEqual([0.46]);
    });

    it('lands an sf-family accent on the staff it names, not the next note in document order', () => {
        // The sfz is attributed to staff 1 but written after the backup, so in
        // document order the next note is a LEFT-hand one. It belongs to the
        // right hand's whole note, which is engraved under it.
        const xml = wrap(
            `<measure>${GRAND}${dyn('p', 1)}${sn('C', 5, 16, 1)}` +
                `<backup><duration>16</duration></backup>${dyn('p', 2)}${dyn('sfz', 1)}` +
                `${sn('C', 3, 4, 2)}${sn('D', 3, 4, 2)}${sn('E', 3, 4, 2)}${sn('F', 3, 4, 2)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 0)).toEqual([0.66]);
        expect(at(score, 1, 0)).toEqual([0.46, 0.46, 0.46, 0.46]);
    });

    it('punches every note of a chord an sfz falls on', () => {
        const xml = wrap(
            `<measure>${GRAND}${dyn('p', 1)}${dyn('sfz', 1)}${sn('C', 5, 8, 1)}` +
                `<note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><staff>1</staff></note>` +
                `<note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><staff>1</staff></note>` +
                `${sn('A', 5, 8, 1)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 0)).toEqual([0.66, 0.66, 0.66, 0.46]);
    });

    it('leaves velocity unset when the score prints no dynamics at all', () => {
        const score = parseMusicXmlString(wrap(twoHandBar(GRAND)));
        expect(score.notes.every((n) => n.v === undefined)).toBe(true);
    });

    describe('hairpins', () => {
        const wedge = (type: string, staff?: number, num = 1): string =>
            `<direction><direction-type><wedge type="${type}" number="${num}"/></direction-type>${staff ? `<staff>${staff}</staff>` : ''}</direction>`;

        const words = (text: string, staff?: number): string =>
            `<direction><direction-type><words>${text}</words></direction-type>${staff ? `<staff>${staff}</staff>` : ''}</direction>`;

        /** One 4/4 bar of four right-hand quarters, with hooks before/after. */
        const rhBar = (lead = '', tail = ''): string =>
            `<measure>${lead}${sn('C', 5, 4, 1)}${sn('D', 5, 4, 1)}${sn('E', 5, 4, 1)}${sn('F', 5, 4, 1)}${tail}</measure>`;

        const rh = (score: ReturnType<typeof parseMusicXmlString>) =>
            score.notes.filter((n) => n.h === 0).map((n) => n.v);

        it('interpolates between the dynamic before and the one after', () => {
            const xml = wrap(rhBar(`${GRAND}${dyn('p')}${wedge('crescendo')}`, wedge('stop')) + rhBar(dyn('f')));
            const got = rh(parseMusicXmlString(xml));
            expect(got[0]).toBe(0.46); // p, at the wedge start
            expect(got[4]).toBe(0.82); // f, at the wedge end
            // Everything between rises, strictly.
            const middle = got.slice(0, 5) as number[];
            for (let i = 1; i < middle.length; i++) {
                expect(middle[i]!).toBeGreaterThan(middle[i - 1]!);
            }
        });

        it('reads a textual cresc. as a hairpin', () => {
            const xml = wrap(rhBar(`${GRAND}${dyn('p')}${words('cresc.')}`) + rhBar(dyn('f')));
            const got = rh(parseMusicXmlString(xml)) as number[];
            expect(got[0]).toBe(0.46);
            expect(got[1]!).toBeGreaterThan(0.46);
            expect(got[1]!).toBeLessThan(0.82);
        });

        it('reads dim. and decresc. as diminuendos', () => {
            for (const text of ['dim.', 'decresc.', 'morendo']) {
                const xml = wrap(rhBar(`${GRAND}${dyn('f')}${words(text)}`) + rhBar(dyn('pp')));
                const got = rh(parseMusicXmlString(xml)) as number[];
                expect(got[1]!).toBeLessThan(0.82);
            }
        });

        it('is not fooled by ordinary words that merely start similarly', () => {
            const xml = wrap(rhBar(`${GRAND}${dyn('p')}${words('dolce')}`) + rhBar());
            expect(rh(parseMusicXmlString(xml)).every((v) => v === 0.46)).toBe(true);
        });

        it('holds its arrival when no dynamic is printed after the hairpin', () => {
            // Without materialising the target, the note after the wedge would
            // snap back to where the crescendo started.
            const xml = wrap(rhBar(`${GRAND}${dyn('p')}${wedge('crescendo')}`, wedge('stop')) + rhBar());
            const got = rh(parseMusicXmlString(xml)) as number[];
            const arrival = got[4]!;
            expect(arrival).toBeGreaterThan(0.46);
            expect(got.slice(4).every((v) => v === arrival)).toBe(true);
        });

        it('treats a dynamic inside a hairpin as a waypoint', () => {
            const xml = wrap(
                rhBar(`${GRAND}${dyn('p')}${wedge('crescendo')}`) + rhBar(dyn('mf'), wedge('stop')) + rhBar(dyn('f')),
            );
            const got = rh(parseMusicXmlString(xml)) as number[];
            expect(got[0]).toBe(0.46);
            expect(got[4]).toBe(0.7); // mf lands exactly, mid-hairpin
            expect(got[8]).toBe(0.82); // f at the end
            expect(got[2]!).toBeGreaterThan(0.46);
            expect(got[2]!).toBeLessThan(0.7);
        });

        it('does not let a diminuendo fade below ppp', () => {
            const xml = wrap(rhBar(`${GRAND}${dyn('pp')}${wedge('diminuendo')}`, wedge('stop')) + rhBar());
            const got = rh(parseMusicXmlString(xml)) as number[];
            expect(Math.min(...got)).toBeGreaterThanOrEqual(0.26);
        });

        it('gives an unclosed hairpin a musical length rather than the whole piece', () => {
            const bars = Array.from({ length: 20 }, (_, i) =>
                rhBar(i === 0 ? `${GRAND}${dyn('p')}${wedge('crescendo')}` : ''),
            ).join('');
            const got = rh(parseMusicXmlString(wrap(bars))) as number[];
            // Eight bars of four quarters = 32 notes; past that it must be level.
            const tail = got.slice(34);
            expect(new Set(tail).size).toBe(1);
        });

        it('keeps hairpins on the hand they were printed under', () => {
            const xml = wrap(
                twoHandBar(`${GRAND}${dyn('p', 1)}${wedge('crescendo', 1)}`, dyn('p', 2)) +
                    twoHandBar(dyn('f', 1), '') +
                    twoHandBar(),
            );
            const score = parseMusicXmlString(xml);
            // Right hand swells into the f; left hand stays put at p throughout.
            expect(at(score, 0, 1920)).toEqual([0.82, 0.82, 0.82, 0.82]);
            expect(at(score, 1, 0)).toEqual([0.46]);
            expect(at(score, 1, 1920)).toEqual([0.46]);
        });
    });
});

/** Articulation. `divisions=4`, so a quarter is 4 units = 480 ticks. */
describe('articulation', () => {
    const arts = (...marks: string[]): string =>
        `<notations><articulations>${marks.map((m) => `<${m}/>`).join('')}</articulations></notations>`;

    const slur = (type: string): string => `<notations><slur type="${type}" number="1"/></notations>`;

    const oneBar = (notes: string): string => wrap(`<measure number="1">${ATTRS_44}${notes}</measure>`);

    const durs = (xml: string) => parseMusicXmlString(xml).notes.map((n) => n.d);
    const vels = (xml: string) => parseMusicXmlString(xml).notes.map((n) => n.v);

    it('shortens a staccato note without moving anything', () => {
        const score = parseMusicXmlString(
            oneBar(`${note('C', 4, 4, arts('staccato'))}${note('D', 4, 4)}${note('E', 4, 8)}`),
        );
        expect(score.notes.map((n) => n.d)).toEqual([240, plain(480), plain(960)]);
        // The onsets are untouched — gating changes length, never placement.
        expect(score.notes.map((n) => n.t)).toEqual([0, 480, 960]);
    });

    it('applies one gate per marking, never a product', () => {
        const xml = oneBar(
            `${note('C', 4, 4, arts('staccatissimo'))}` +
                `${note('D', 4, 4, arts('staccato'))}` +
                `${note('E', 4, 4, arts('tenuto'))}` +
                `${note('F', 4, 4)}`,
        );
        expect(durs(xml)).toEqual([120, 240, 480, 432]);
    });

    it('treats dots under a slur as portato, not staccato', () => {
        // staccato x slur would be 0.5 x 1.0 or 0.5 — both wrong. Portato is its own row.
        const xml = oneBar(
            `<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>` +
                `<notations><articulations><staccato/></articulations><slur type="start" number="1"/></notations></note>` +
                `<note><pitch><step>D</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice>` +
                `<notations><slur type="stop" number="1"/></notations></note>`,
        );
        expect(durs(xml)[0]).toBe(336); // 480 * 0.7
    });

    it('does not shorten notes under a slur, but releases the one that ends it', () => {
        const xml = oneBar(
            `${note('C', 4, 4, slur('start'))}${note('D', 4, 4)}${note('E', 4, 4, slur('stop'))}${note('F', 4, 4)}`,
        );
        expect(durs(xml)).toEqual([480, 480, plain(480), plain(480)]);
    });

    it('carries a slur across a barline', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 8, slur('start'))}${note('D', 4, 8)}</measure>` +
                `<measure number="2">${note('E', 4, 8)}${note('F', 4, 8, slur('stop'))}</measure>`,
        );
        expect(durs(xml)).toEqual([960, 960, 960, plain(960)]);
    });

    it('raises velocity for accents without shortening them', () => {
        const xml = oneBar(
            `<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>` +
                `${note('C', 4, 4, arts('accent'))}${note('D', 4, 4, arts('strong-accent'))}${note('E', 4, 8)}`,
        );
        expect(vels(xml)).toEqual([0.61, 0.71, 0.46]);
        expect(durs(xml)).toEqual([plain(480), plain(480), plain(960)]);
    });

    it('takes the larger of a printed accent and an sf direction, not the sum', () => {
        // p + sfz(0.2) and p + accent(0.15) stacked would reach 0.81, well past f.
        const xml = oneBar(
            `<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>` +
                `<direction><direction-type><dynamics><sfz/></dynamics></direction-type></direction>` +
                `${note('C', 4, 4, arts('accent'))}${note('D', 4, 12)}`,
        );
        expect(vels(xml)).toEqual([0.66, 0.46]);
    });

    it('keeps a staccato note audible however short the value', () => {
        const xml = oneBar(`${note('C', 4, 1, arts('staccatissimo'))}${note('D', 4, 15)}`);
        expect(durs(xml)[0]).toBeGreaterThanOrEqual(60);
    });

    it('gives chord members the marking of the note they hang off', () => {
        const xml = oneBar(
            `${note('C', 4, 4, arts('staccato'))}` +
                `<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>` +
                `<note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>` +
                `${note('B', 4, 12)}`,
        );
        expect(durs(xml)).toEqual([240, 240, 240, plain(1440)]);
    });

    it('gates a tie chain once, from the marking that closes it', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 8, '<tie type="start"/>')}${note('D', 4, 8)}</measure>` +
                `<measure number="2">${note('C', 4, 8, `<tie type="stop"/>${arts('staccato')}`)}${note('E', 4, 8)}</measure>`,
        );
        const held = parseMusicXmlString(xml).notes.find((n) => n.t === 0 && n.p === 60);
        expect(held?.d).toBe(960); // 1920 notated, halved once at the close
    });

    it('ignores a staccato on the first link of a tie chain', () => {
        // Audiveris routinely copies the first note's marking forward; a tie is
        // one sounding event and its release is whatever closes it.
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 8, `<tie type="start"/>${arts('staccato')}`)}${note('D', 4, 8)}</measure>` +
                `<measure number="2">${note('C', 4, 8, '<tie type="stop"/>')}${note('E', 4, 8)}</measure>`,
        );
        const held = parseMusicXmlString(xml).notes.find((n) => n.t === 0 && n.p === 60);
        expect(held?.d).toBe(plain(1920));
    });

    it('never gates a grace note', () => {
        const xml = oneBar(
            `<note><rest/><duration>4</duration><voice>1</voice></note>` +
                `<note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>` +
                `${note('E', 4, 4, arts('staccato'))}${note('F', 4, 8)}`,
        );
        expect(durs(xml)[0]).toBe(61);
    });
});

/**
 * Meter reconciliation. Ticks: 480/quarter, so 6/8 = 1440 and 9/8 = 2160.
 * `divisions=4` means a duration unit is a 16th, i.e. 120 ticks.
 */
describe('meter reconciliation', () => {
    const ATTRS = (num: number, den: number) =>
        `<attributes><divisions>4</divisions><time><beats>${num}</beats><beat-type>${den}</beat-type></time></attributes>`;

    /** One bar holding `units` sixteenths, as a single chain of quarter-ish notes. */
    const bar = (units: number, first = ''): string =>
        `<measure>${first}<note><pitch><step>C</step><octave>4</octave></pitch><duration>${units}</duration><voice>1</voice></note></measure>`;

    const spanOf = (declaredNum: number, declaredDen: number, lengths: number[]): string =>
        wrap(lengths.map((u, i) => bar(u, i === 0 ? ATTRS(declaredNum, declaredDen) : '')).join(''));

    it('corrects a signature the over-length bars outvote, and re-signs the timeline', () => {
        // 12 bars of true 9/8 (18 sixteenths = 2160 ticks) declared as 6/8.
        const score = parseMusicXmlString(
            spanOf(
                6,
                8,
                Array.from({ length: 12 }, () => 18),
            ),
        );
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 9, den: 8 }]);
        expect(score.measures.every((m) => m.dTicks === 2160)).toBe(true);
        expect(score.warnings).toContain('meter_corrected');
        // Corrected bars are exactly full, so they are neither over nor under.
        expect(score.warnings).not.toContain('measure_overfull');
        expect(score.warnings).not.toContain('measure_underfull');
    });

    it('corrects on the real-world mix, where the MODE is the wrong length', () => {
        // Schubert D.780 No. 2 measured: of 94 bars, 49 exceed the declared 1440,
        // 35 sit exactly on it and only 18 reach the true 2160. A modal test would
        // pick 1440 and leave the movement broken; the over-length population is
        // what carries the signal.
        const lengths = [
            ...Array.from({ length: 18 }, () => 18), // 2160 — true 9/8
            ...Array.from({ length: 14 }, () => 14), // 1680 — over, scattered
            ...Array.from({ length: 10 }, () => 16), // 1920 — over, scattered
            ...Array.from({ length: 7 }, () => 17), // 2040 — over, scattered
            ...Array.from({ length: 35 }, () => 12), // 1440 — exactly the declared bar
            ...Array.from({ length: 9 }, () => 10), // 1200 — under-read
        ];
        const score = parseMusicXmlString(spanOf(6, 8, lengths));
        expect(score.warnings).toContain('meter_corrected');
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 9, den: 8 }]);
    });

    it('leaves a genuine signature alone when its bars agree', () => {
        const score = parseMusicXmlString(
            spanOf(
                6,
                8,
                Array.from({ length: 12 }, () => 12),
            ),
        );
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
        expect(score.warnings).not.toContain('meter_suspect');
    });

    it('is not fooled by a handful of overfull misreads', () => {
        const lengths = [...Array.from({ length: 30 }, () => 12), ...Array.from({ length: 4 }, () => 18)];
        const score = parseMusicXmlString(spanOf(6, 8, lengths));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('warns but does not act when the disagreement is not a simple misread', () => {
        // 1800 vs 1440 is 5:4 — not a ratio a signature misread produces.
        const score = parseMusicXmlString(
            spanOf(
                6,
                8,
                Array.from({ length: 12 }, () => 15),
            ),
        );
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).toContain('meter_suspect');
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('warns but does not act when the over-length bars do not cluster', () => {
        const score = parseMusicXmlString(spanOf(6, 8, [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]));
        expect(score.warnings).toContain('meter_suspect');
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('does not correct a span too short to judge', () => {
        const score = parseMusicXmlString(spanOf(6, 8, [18, 18, 18, 18, 18]));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('reads 4/4 misdeclared as 2/4', () => {
        const score = parseMusicXmlString(
            spanOf(
                2,
                4,
                Array.from({ length: 12 }, () => 16),
            ),
        );
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 4, den: 4 }]);
        expect(score.warnings).toContain('meter_corrected');
    });

    it('judges each meter span separately', () => {
        // 10 genuine 3/4 bars, then a change to 6/8 whose bars are really 9/8.
        const first = Array.from({ length: 10 }, (_, i) => bar(12, i === 0 ? ATTRS(3, 4) : '')).join('');
        const second = Array.from({ length: 12 }, (_, i) => bar(18, i === 0 ? ATTRS(6, 8) : '')).join('');
        const score = parseMusicXmlString(wrap(first + second));
        expect(score.timeSignatures).toEqual([
            { tick: 0, num: 3, den: 4 },
            { tick: 14400, num: 9, den: 8 },
        ]);
        expect(score.measures.slice(0, 10).every((m) => m.dTicks === 1440)).toBe(true);
        expect(score.measures.slice(10).every((m) => m.dTicks === 2160)).toBe(true);
    });

    it('excludes pickups and the final bar from the vote', () => {
        // 12 full 6/8 bars, a short pickup at the front and a short final bar.
        // Neither should drag the span toward a correction.
        const lengths = Array.from({ length: 12 }, () => 12);
        const inner = lengths.map((u, i) => bar(u, i === 0 ? ATTRS(6, 8) : '')).join('');
        const xml = wrap(
            `<measure number="0" implicit="yes">${ATTRS(6, 8)}<note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure>` +
                inner +
                bar(4),
        );
        const score = parseMusicXmlString(xml);
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
        expect(score.measures[0]?.dTicks).toBe(480); // pickup keeps its real length
    });
});

/** Tempo map. `divisions=4`; a 4/4 bar is 1920 ticks. */
describe('tempo', () => {
    const words = (text: string): string =>
        `<direction><direction-type><words>${text}</words></direction-type></direction>`;

    const soundTempo = (bpm: number): string =>
        `<direction><direction-type><words>x</words></direction-type><sound tempo="${bpm}"/></direction>`;

    const bar = (lead = ''): string => `<measure>${lead}${note('C', 4, 16)}</measure>`;

    it('collects every tempo mark, not just the first', () => {
        const score = parseMusicXmlString(wrap(bar(`${ATTRS_44}${soundTempo(120)}`) + bar(soundTempo(60)) + bar()));
        expect(score.tempos).toEqual([
            { tick: 0, bpm: 120, src: 'sound' },
            { tick: 1920, bpm: 60, src: 'sound' },
        ]);
        expect(score.defaultBpm).toBe(120);
    });

    it('infers a tempo from an Italian heading when no number is printed', () => {
        const score = parseMusicXmlString(wrap(bar(`${ATTRS_44}${words('Andantino.')}`) + bar()));
        expect(score.tempos).toEqual([{ tick: 0, bpm: 94, src: 'word' }]);
        expect(score.defaultBpm).toBe(94);
        expect(score.warnings).toContain('tempo_inferred');
    });

    it('averages the terms of a compound heading', () => {
        const score = parseMusicXmlString(wrap(bar(`${ATTRS_44}${words('Allegro moderato')}`) + bar()));
        expect(score.tempos[0]?.bpm).toBe(120); // (132 + 108) / 2
    });

    it('lets a printed number anywhere beat a word everywhere', () => {
        const score = parseMusicXmlString(wrap(bar(`${ATTRS_44}${words('Adagio')}`) + bar(soundTempo(144)) + bar()));
        expect(score.tempos).toEqual([{ tick: 1920, bpm: 144, src: 'sound' }]);
        expect(score.warnings).not.toContain('tempo_inferred');
    });

    it('does not mistake expression marks for tempo marks', () => {
        for (const text of ['dolce', 'espressivo', 'cantabile', 'con moto', 'Trio', 'Fine', 'sempre legato']) {
            const score = parseMusicXmlString(wrap(bar(`${ATTRS_44}${words(text)}`) + bar()));
            expect(score.tempos).toEqual([]);
        }
    });

    it('bends the pulse through a rit. and restores it at a tempo', () => {
        const score = parseMusicXmlString(
            wrap(bar(`${ATTRS_44}${soundTempo(120)}`) + bar(words('rit.')) + bar(words('a tempo')) + bar()),
        );
        const bpms = score.tempos.map((t) => t.bpm);
        expect(bpms[0]).toBe(120);
        // Descends across the rit., then snaps back to the printed tempo.
        expect(Math.min(...bpms)).toBe(90); // 120 * 0.75
        expect(score.tempos[score.tempos.length - 1]).toMatchObject({ tick: 3840, bpm: 120 });
        for (let i = 1; i < bpms.length - 1; i++) {
            expect(bpms[i]!).toBeLessThanOrEqual(bpms[i - 1]!);
        }
    });

    it('ignores a rit. that has no tempo to bend', () => {
        const score = parseMusicXmlString(wrap(bar(`${ATTRS_44}${words('rit.')}`) + bar()));
        expect(score.tempos).toEqual([]);
    });

    it('bends a seeded rit. and restores a tempo when the shard printed no heading', () => {
        const xml = wrap(bar(`${ATTRS_44}${words('rit.')}`) + bar(words('a tempo')) + bar());
        const seed = { tempoBpm: 132, steadyBpm: 132, velocityByStaff: {} };
        const seeded = parseMusicXmlString(xml, 0, seed);
        const bpms = seeded.tempos.map((t) => t.bpm);
        expect(Math.min(...bpms)).toBe(99); // 132 * 0.75
        expect(seeded.tempos[seeded.tempos.length - 1]).toMatchObject({ tick: 1920, bpm: 132 });
        for (let i = 1; i < bpms.length - 1; i++) {
            expect(bpms[i]!).toBeLessThanOrEqual(bpms[i - 1]!);
        }
        expect(parseMusicXmlString(xml).tempos).toEqual([]);
    });

    it('applies a seeded staff velocity until a printed dynamic takes over', () => {
        const dyn = (mark: string): string =>
            `<direction><direction-type><dynamics><${mark}/></dynamics></direction-type></direction>`;
        const xml = wrap(
            `<measure>${ATTRS_44}${note('C', 4, 16)}</measure>` + `<measure>${dyn('f')}${note('D', 4, 16)}</measure>`,
        );
        const seeded = parseMusicXmlString(xml, 0, {
            tempoBpm: null,
            steadyBpm: null,
            velocityByStaff: { 1: 0.34 },
        });
        expect(seeded.notes.find((n) => n.t === 0)?.v).toBe(0.34);
        expect(seeded.notes.find((n) => n.t === 1920)?.v).toBe(0.82);
    });

    it('reports current, steady and velocity at a tick, including mid-ramp', () => {
        const dyn = (mark: string): string =>
            `<direction><direction-type><dynamics><${mark}/></dynamics></direction-type></direction>`;
        const score = parseMusicXmlString(
            wrap(bar(`${ATTRS_44}${soundTempo(132)}${dyn('pp')}`) + bar(words('rit.')) + bar(dyn('f')) + bar()),
        );
        const ramp = score.tempos.find((t) => t.src === 'ramp');
        expect(ramp).toBeDefined();
        const mid = expressionSeedAt(score, ramp!.tick);
        expect(mid.steadyBpm).toBe(132);
        expect(mid.tempoBpm).toBe(ramp!.bpm);
        expect(mid.tempoBpm!).toBeLessThan(132);
        expect(mid.tempoBpm!).toBeGreaterThan(99);
        expect(mid.velocityByStaff[1]).toBe(0.34);

        const afterForte = expressionSeedAt(score, 3840);
        expect(afterForte.velocityByStaff[1]).toBe(0.82);
        expect(afterForte.steadyBpm).toBe(132);
    });

    it('shades poco and molto rit., and treats meno mosso / ritenuto as steps', () => {
        const poco = parseMusicXmlString(
            wrap(bar(`${ATTRS_44}${soundTempo(120)}`) + bar(words('poco rit.')) + bar(words('a tempo')) + bar()),
        );
        expect(Math.min(...poco.tempos.map((t) => t.bpm))).toBe(102); // 120 * 0.85

        const molto = parseMusicXmlString(
            wrap(bar(`${ATTRS_44}${soundTempo(120)}`) + bar(words('molto rit.')) + bar(words('a tempo')) + bar()),
        );
        expect(Math.min(...molto.tempos.map((t) => t.bpm))).toBe(78); // 120 * 0.65

        const meno = parseMusicXmlString(
            wrap(bar(`${ATTRS_44}${soundTempo(120)}`) + bar(words('meno mosso')) + bar(words('a tempo')) + bar()),
        );
        expect(meno.tempos.find((t) => t.tick === 1920)).toEqual({ tick: 1920, bpm: 96 });
        // a tempo restates 96, which is already in force, so no extra point —
        // and it must not climb back to the original 120.
        expect(meno.tempos.some((t) => t.tick > 0 && t.bpm === 120)).toBe(false);

        const ritenuto = parseMusicXmlString(
            wrap(bar(`${ATTRS_44}${soundTempo(120)}`) + bar(words('ritenuto')) + bar(words('a tempo')) + bar()),
        );
        expect(ritenuto.tempos).toEqual([
            { tick: 0, bpm: 120, src: 'sound' },
            { tick: 1920, bpm: 96, src: 'ramp' },
            { tick: 3840, bpm: 120, src: 'ramp' },
        ]);
    });

    it('emits a fermata as a hold at the note it sits over, leaving the note alone', () => {
        const score = parseMusicXmlString(
            wrap(
                `<measure>${ATTRS_44}${note('C', 4, 8)}${note('E', 4, 8, '<notations><fermata/></notations>')}</measure>`,
            ),
        );
        expect(score.holds).toEqual([{ tick: 960, beats: 2 }]);
        expect(score.notes.map((n) => n.d)).toEqual([plain(960), plain(960)]);
    });

    it('counts a fermata over a chord once', () => {
        const score = parseMusicXmlString(
            wrap(
                `<measure>${ATTRS_44}${note('C', 4, 16, '<notations><fermata/></notations>')}` +
                    `<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><notations><fermata/></notations></note></measure>`,
            ),
        );
        expect(score.holds).toHaveLength(1);
    });

    const bpmOf = (text: string): number | undefined =>
        parseMusicXmlString(wrap(bar(`${ATTRS_44}${words(text)}`) + bar())).tempos[0]?.bpm;

    it('knows vivacissimo, which used to be recognized and then yield nothing', () => {
        expect(bpmOf('Vivacissimo')).toBe(168);
    });

    it('reads German and French headings, diacritics and all', () => {
        expect(bpmOf('Langsam')).toBe(54);
        expect(bpmOf('Lebhaft')).toBe(132);
        expect(bpmOf('Mässig')).toBe(96);
        // The spelling German editions actually print; ß survives NFD intact.
        expect(bpmOf('Mäßig')).toBe(96);
        expect(bpmOf('Modéré')).toBe(108);
        expect(bpmOf('Animé')).toBe(120);
    });

    it('shades a term by the character word printed beside it', () => {
        expect(bpmOf('Molto Adagio')!).toBeLessThan(66);
        expect(bpmOf('Molto Allegro')!).toBeGreaterThan(132);
        expect(bpmOf('Sehr langsam')!).toBeLessThan(54);
        // A qualifier pulls toward the middle and must never shoot past it.
        expect(bpmOf('Allegro non troppo')!).toBeLessThan(132);
        expect(bpmOf('Allegro non troppo')!).toBeGreaterThan(108);
    });

    describe('meter-aware default', () => {
        /** One exactly-full bar of num/den; `divisions=4`, so a unit is a 16th. */
        const meterBar = (num: number, den: number, first: boolean): string =>
            `<measure>` +
            (first
                ? `<attributes><divisions>4</divisions><time><beats>${num}</beats><beat-type>${den}</beat-type></time></attributes>`
                : '') +
            `<note><pitch><step>C</step><octave>4</octave></pitch><duration>${(num * 16) / den}</duration><voice>1</voice></note></measure>`;

        const unmarked = (num: number, den: number) =>
            parseMusicXmlString(wrap(meterBar(num, den, true) + meterBar(num, den, false)));

        it('guesses an opening pulse from the meter when nothing prints a tempo', () => {
            expect(unmarked(6, 8).defaultBpm).toBe(84);
            expect(unmarked(9, 8).defaultBpm).toBe(84);
            expect(unmarked(12, 8).defaultBpm).toBe(84);
            expect(unmarked(3, 8).defaultBpm).toBe(96);
            expect(unmarked(2, 2).defaultBpm).toBe(112);
            expect(unmarked(3, 4).defaultBpm).toBe(108);
            expect(unmarked(2, 4).defaultBpm).toBe(100);
            expect(unmarked(4, 4).defaultBpm).toBe(96);
        });

        it('discloses the guess without inventing a tempo entry for it', () => {
            const score = unmarked(4, 4);
            expect(score.warnings).toContain('tempo_defaulted');
            // A new tempos[].src value would be rejected wholesale by the strict
            // enum in every deployed client, so the guess travels as defaultBpm.
            expect(score.tempos).toEqual([]);
        });

        it('does not guess when the score prints a tempo of any kind', () => {
            const printed = parseMusicXmlString(wrap(bar(`${ATTRS_44}${soundTempo(60)}`) + bar()));
            expect(printed.warnings).not.toContain('tempo_defaulted');
            expect(printed.defaultBpm).toBe(60);

            const worded = parseMusicXmlString(wrap(bar(`${ATTRS_44}${words('Adagio')}`) + bar()));
            expect(worded.warnings).not.toContain('tempo_defaulted');
            expect(worded.defaultBpm).toBe(66);
        });
    });
});

describe('parseMxlFiles warning aggregation', () => {
    /** Audiveris writes one .mxl per movement; no container.xml in these. */
    const mxl = (xml: string): Buffer => {
        const zip = new AdmZip();
        zip.addFile('score.xml', Buffer.from(xml, 'utf8'));
        return zip.toBuffer();
    };
    const soundTempo = (bpm: number): string =>
        `<direction><direction-type><words>x</words></direction-type><sound tempo="${bpm}"/></direction>`;
    const words = (text: string): string =>
        `<direction><direction-type><words>${text}</words></direction-type></direction>`;
    const bar = (lead = ''): string => `<measure>${lead}${note('C', 4, 16)}</measure>`;

    const marked = mxl(wrap(bar(`${ATTRS_44}${soundTempo(132)}`) + bar()));
    const unmarked = mxl(wrap(bar(ATTRS_44) + bar()));

    it('does not report a defaulted tempo for a later movement whose guess is discarded', () => {
        // Only the first movement's guess can survive as defaultBpm, so only the
        // first movement's disclosure describes anything the reader will hear.
        const score = parseMxlFiles([marked, unmarked]);
        expect(score.defaultBpm).toBe(132);
        expect(score.warnings).not.toContain('tempo_defaulted');
        expect(score.warnings).toContain('multiple_movements_concatenated');
    });

    it('keeps the disclosure when the opening movement is the one that guessed', () => {
        const score = parseMxlFiles([unmarked, marked]);
        expect(score.defaultBpm).toBe(96);
        expect(score.warnings).toContain('tempo_defaulted');
        // The second movement's printed 132 still travels, at its own offset.
        expect(score.tempos.map((t) => t.bpm)).toEqual([132]);
    });

    it('still unions every other warning a later movement raises', () => {
        const short = mxl(wrap(`<measure>${ATTRS_44}${note('C', 4, 4)}</measure>` + bar()));
        const score = parseMxlFiles([marked, short]);
        expect(score.warnings).toContain('measure_underfull');
        expect(score.warnings).not.toContain('tempo_defaulted');
    });

    it('gives a heading-less later movement its own meter default, not the previous rit. floor', () => {
        const withContainer = (xml: string): Buffer => {
            const zip = new AdmZip();
            zip.addFile('score.xml', Buffer.from(xml, 'utf8'));
            zip.addFile(
                'META-INF/container.xml',
                Buffer.from(
                    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>',
                    'utf8',
                ),
            );
            return zip.toBuffer();
        };
        const movement1 = withContainer(wrap(bar(`${ATTRS_44}${words('Presto')}`) + bar(words('rit.'))));
        const movement2 = withContainer(wrap(bar(ATTRS_44) + bar()));
        const score = parseMxlFiles([movement1, movement2]);
        const opening = score.tempos.find((t) => t.tick === 3840);
        expect(opening).toEqual({ tick: 3840, bpm: 96 });
        expect(opening?.src).toBeUndefined();
        // Presto (172) ramped, but movement 2 must not sit at that floor.
        expect(Math.min(...score.tempos.filter((t) => t.tick < 3840).map((t) => t.bpm))).toBe(129);
    });
});

describe('shard seam seed', () => {
    const words = (text: string): string =>
        `<direction><direction-type><words>${text}</words></direction-type></direction>`;
    const bar = (lead = ''): string => `<measure>${lead}${note('C', 4, 16)}</measure>`;

    it('restores Allegro at a tempo on shard B when A ended in a rit.', () => {
        const musicalA = parseMusicXmlString(
            wrap(bar(`${ATTRS_44}${words('Allegro')}`) + bar() + bar() + bar(words('rit.'))),
        );
        const scoreA = buildScoreData(musicalA, null);
        const aOverlapStartTick = musicalA.totalTicks;
        const seed = expressionSeedAt(musicalA, aOverlapStartTick);
        expect(seed.steadyBpm).toBe(132);
        expect(seed.tempoBpm).toBe(99);

        const musicalB = parseMusicXmlString(wrap(bar(`${ATTRS_44}${words('a tempo')}`) + bar() + bar()), 0, seed);
        const scoreB = buildScoreData(musicalB, null);
        const merged = mergeScoreDataParts([
            { score: scoreA, sheets: { from: 1, to: 2 } },
            { score: scoreB, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.tempos?.at(-1)?.bpm).toBe(132);
    });
});

describe('repeat structure', () => {
    const bl = (inner: string, loc = 'right') => `<barline location="${loc}">${inner}</barline>`;

    it('records forward and backward repeats with their pass count', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${bl('<repeat direction="forward"/>', 'left')}${note('C', 4, 16)}</measure>` +
                `<measure number="2">${note('D', 4, 16)}${bl('<repeat direction="backward" times="3"/>')}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.repeats[0]).toMatchObject({ repeatForward: true, repeatBackward: false });
        expect(score.repeats[1]).toMatchObject({ repeatBackward: true, repeatTimes: 3 });
    });

    it('reads volta brackets, including a comma-separated pass list', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure>` +
                `<measure number="2">${bl('<ending number="1, 3" type="start"/>', 'left')}${note('D', 4, 16)}${bl('<ending number="1, 3" type="stop"/>')}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.repeats[1]).toMatchObject({ endingStart: [1, 3], endingStop: true });
    });

    it('treats a discontinued bracket as a stop', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 16)}${bl('<ending number="2" type="discontinue"/>')}</measure>`,
        );
        expect(parseMusicXmlString(xml).repeats[0]).toMatchObject({ endingStop: true });
    });
});

/**
 * Jump structure: D.C., D.S., segno, coda, Fine. Three encodings reach the
 * parser and all three have to work, because which one a file uses says more
 * about the exporter than about the music.
 */
describe('jump structure', () => {
    const words = (text: string): string =>
        `<direction><direction-type><words>${text}</words></direction-type></direction>`;

    const bar = (lead = '', tail = ''): string => `<measure>${lead}${note('C', 4, 16)}${tail}</measure>`;

    const marksOf = (measures: string) => parseMusicXmlString(wrap(measures)).repeats;

    it('reads the whole vocabulary from <sound> attributes on a direction', () => {
        const marks = marksOf(
            bar(`${ATTRS_44}<direction><sound segno="A"/></direction>`) +
                bar('<direction><sound tocoda="C"/></direction>') +
                bar('<direction><sound dalsegno="A"/></direction>') +
                bar('<direction><sound coda="C"/></direction>') +
                bar('<direction><sound fine="yes"/></direction>') +
                bar('<direction><sound dacapo="yes"/></direction>'),
        );
        expect(marks[0]).toMatchObject({ segno: true });
        expect(marks[1]).toMatchObject({ toCoda: true });
        expect(marks[2]?.jump).toEqual({ kind: 'ds', al: null });
        expect(marks[3]).toMatchObject({ codaTarget: true });
        expect(marks[4]).toMatchObject({ fine: true });
        expect(marks[5]?.jump).toEqual({ kind: 'dc', al: null });
    });

    it('reads <sound> attributes hung on a barline', () => {
        const marks = marksOf(
            bar(ATTRS_44) +
                `<measure>${note('D', 4, 16)}<barline location="right"><sound tocoda="C"/></barline></measure>`,
        );
        expect(marks[1]).toMatchObject({ toCoda: true });
    });

    it('reads a <sound> hung straight on the measure — tempo and all', () => {
        const score = parseMusicXmlString(
            wrap(bar(ATTRS_44) + `<measure><sound tempo="88" dalsegno="A"/>${note('D', 4, 16)}</measure>`),
        );
        expect(score.tempos).toEqual([{ tick: 1920, bpm: 88, src: 'sound' }]);
        expect(score.repeats[1]?.jump).toEqual({ kind: 'ds', al: null });
    });

    it('reads a segno glyph, and records a bare coda glyph as no more than a sighting', () => {
        const marks = marksOf(
            bar(`${ATTRS_44}<direction><direction-type><segno/></direction-type></direction>`) +
                bar('<direction><direction-type><coda/></direction-type></direction>'),
        );
        expect(marks[0]).toMatchObject({ segno: true });
        expect(marks[1]?.codaGlyph).toBe(true);
        // The same sign is engraved at "To Coda" and over the coda itself; only
        // position separates them, and that is the planner's call to make.
        expect(marks[1]?.toCoda).toBeUndefined();
        expect(marks[1]?.codaTarget).toBeUndefined();
    });

    it('reads jumps printed as words, with the target they name', () => {
        const cases: Array<[string, { kind: string; al: string | null }]> = [
            ['D.C. al Fine', { kind: 'dc', al: 'fine' }],
            ['D.C.', { kind: 'dc', al: null }],
            ['DC al Coda', { kind: 'dc', al: 'coda' }],
            ['Da Capo al Fine', { kind: 'dc', al: 'fine' }],
            ['D.S. al Coda', { kind: 'ds', al: 'coda' }],
            ['D. S. alla Coda', { kind: 'ds', al: 'coda' }],
            ['Dal Segno al Fine', { kind: 'ds', al: 'fine' }],
        ];
        for (const [text, expected] of cases) {
            expect(marksOf(bar(`${ATTRS_44}${words(text)}`))[0]?.jump).toEqual(expected);
        }
    });

    it('reads "To Coda", a bare "Fine" and a spelled-out "Coda"', () => {
        expect(marksOf(bar(`${ATTRS_44}${words('To Coda')}`))[0]).toMatchObject({ toCoda: true });
        expect(marksOf(bar(`${ATTRS_44}${words('Fine.')}`))[0]).toMatchObject({ fine: true });
        expect(marksOf(bar(`${ATTRS_44}${words('Coda')}`))[0]).toMatchObject({ codaTarget: true });
    });

    it('does not let the "al Fine" inside a jump become a Fine of its own', () => {
        // Tested in the wrong order this bar would end the piece instead of
        // sending the player back to the top.
        const marks = marksOf(bar(`${ATTRS_44}${words('D.C. al Fine')}`));
        expect(marks[0]?.jump).toEqual({ kind: 'dc', al: 'fine' });
        expect(marks[0]?.fine).toBeUndefined();
    });

    it('ignores prose that merely contains the structural words', () => {
        for (const text of [
            'Finegan',
            'sempre alla fine',
            'con fine espressione',
            'dolce',
            'diminuendo',
            'Coda che segue',
        ]) {
            const mark = marksOf(bar(`${ATTRS_44}${words(text)}`))[0];
            expect(mark?.jump ?? null).toBeNull();
            expect(mark?.fine).toBeUndefined();
            expect(mark?.toCoda).toBeUndefined();
            expect(mark?.codaTarget).toBeUndefined();
        }
    });

    it('scans every <words> in a direction, not just the first', () => {
        const score = parseMusicXmlString(
            wrap(
                bar(
                    `${ATTRS_44}<direction><direction-type><words>Andante</words></direction-type>` +
                        `<direction-type><words>D.C. al Fine</words></direction-type></direction>`,
                ),
            ),
        );
        expect(score.tempos[0]).toMatchObject({ bpm: 84, src: 'word' });
        expect(score.repeats[0]?.jump).toEqual({ kind: 'dc', al: 'fine' });
    });

    it('combines a jump encoded twice: <sound> for the kind, words for the target', () => {
        const marks = marksOf(
            bar(
                `${ATTRS_44}<direction><direction-type><words>D.S. al Coda</words></direction-type>` +
                    `<sound dalsegno="A"/></direction>`,
            ),
        );
        expect(marks[0]?.jump).toEqual({ kind: 'ds', al: 'coda' });
    });
});

describe('sustain pedal', () => {
    const pedal = (type: string): string =>
        `<direction><direction-type><pedal type="${type}" line="yes"/></direction-type></direction>`;

    it('reads pedal marks as edges, a change being a re-catch on one tick', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${pedal('start')}${note('C', 4, 8)}${pedal('change')}${note('E', 4, 8)}</measure>` +
                `<measure number="2">${note('G', 4, 16)}${pedal('stop')}</measure>`,
        );
        expect(parseMusicXmlString(xml).pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 960, k: 'up' },
            { tick: 960, k: 'down' },
            // Engraved after bar 2's last note, so it lands on the bar line and
            // is pulled one tick back inside the bar it was written in.
            { tick: 3839, k: 'up' },
        ]);
    });

    it('keeps a release at the closing bar line inside the repeat it damps', () => {
        // The pedal is taken on the downbeat and lifted at the double bar. Each
        // pass has to get its own down and up: a release that drifted onto the
        // next bar's tick belongs to whatever follows the repeat, and the two
        // passes would ring together as one undamped wash.
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<barline location="left"><repeat direction="forward"/></barline>` +
                `${pedal('start')}${note('C', 4, 16)}</measure>` +
                `<measure number="2">${note('E', 4, 16)}${pedal('stop')}` +
                `<barline location="right"><repeat direction="backward"/></barline></measure>` +
                `<measure number="3">${note('G', 4, 16)}</measure>`,
        );
        const score = buildScoreData(parseMusicXmlString(xml), null);
        expect(score.warnings).toContain('repeats_unrolled');
        expect(score.pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 3839, k: 'up' },
            { tick: 3840, k: 'down' },
            { tick: 7679, k: 'up' },
        ]);
    });

    it('keeps a bar-line re-catch and depression on the beat they name', () => {
        // Only the release is pulled inside its bar. A change or a fresh start
        // written at the bar line lands on the downbeat it belongs to: the
        // engine reads a damper drop on the exact tick a note ends as the
        // pedal falling with the key, and an edge one tick early would catch
        // the very note the change exists to clear.
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${pedal('start')}${note('C', 4, 16)}${pedal('change')}</measure>` +
                `<measure number="2">${note('E', 4, 16)}${pedal('stop')}</measure>`,
        );
        expect(parseMusicXmlString(xml).pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 1920, k: 'up' },
            { tick: 1920, k: 'down' },
            { tick: 3839, k: 'up' },
        ]);
    });

    it('ignores pedal types there is nothing to do about', () => {
        const xml = wrap(`<measure number="1">${ATTRS_44}${pedal('continue')}${note('C', 4, 16)}</measure>`);
        expect(parseMusicXmlString(xml).pedals).toEqual([]);
    });

    it('offsets pedal edges along with the rest of a concatenated movement', () => {
        const xml = wrap(`<measure number="1">${ATTRS_44}${pedal('start')}${note('C', 4, 16)}</measure>`);
        expect(parseMusicXmlString(xml, 10000).pedals).toEqual([{ tick: 10000, k: 'down' }]);
    });
});

/** Ornaments, grace figures, and swing — baked into the note list at parse/build. */
describe('ornaments, graces and swing', () => {
    const orns = (tag: string, accidental = ''): string =>
        `<notations><ornaments><${tag}/>${accidental}</ornaments><articulations><tenuto/></articulations></notations>`;

    const soundTempo = (bpm: number): string =>
        `<direction><direction-type><words>x</words></direction-type><sound tempo="${bpm}"/></direction>`;

    const words = (text: string): string =>
        `<direction><direction-type><words>${text}</words></direction-type></direction>`;

    it('realises a trill-mark on a half note as 32nds ending on the principal', () => {
        const xml = wrap(`<measure number="1">${ATTRS_44}${note('C', 4, 8, orns('trill-mark'))}</measure>`);
        const score = parseMusicXmlString(xml);
        const notes = score.notes;
        expect(notes.length).toBeGreaterThan(1);
        expect(notes[0]?.p).toBe(60);
        expect(notes[1]?.p).toBe(62);
        expect(notes[notes.length - 1]?.p).toBe(60);
        expect(notes.slice(0, -1).every((n) => n.d === 60)).toBe(true);
        expect(notes.reduce((sum, n) => sum + n.d, 0)).toBe(960);
        expect(score.warnings).toContain('ornaments_realized');
    });

    it('realises a mordent as principal–lower–principal', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 4, orns('mordent'))}${note('E', 4, 12)}</measure>`,
        );
        const notes = parseMusicXmlString(xml).notes.filter((n) => n.t < 480);
        expect(notes.map((n) => n.p)).toEqual([60, 59, 60]);
        expect(notes.map((n) => n.d)).toEqual([60, 60, 360]);
    });

    it('rolls an arpeggiated chord from the bottom', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>
                    <notations><arpeggiate direction="up"/><articulations><tenuto/></articulations></notations></note>
                <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>
                    <notations><articulations><tenuto/></articulations></notations></note>
                <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>
                    <notations><articulations><tenuto/></articulations></notations></note>
                ${note('C', 5, 12)}
            </measure>`,
        );
        const chord = parseMusicXmlString(xml).notes.filter((n) => n.t < 480);
        expect(chord.map((n) => n.p)).toEqual([60, 64, 67]);
        expect(chord.map((n) => n.t)).toEqual([0, 60, 120]);
        expect(chord.every((n) => n.t + n.d === 480)).toBe(true);
        expect(parseMusicXmlString(xml).warnings).toContain('ornaments_realized');
    });

    it('gives an appoggiatura half the principal on the beat', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><grace slash="no"/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>
                ${note('E', 4, 4)}
                <note><rest/><duration>12</duration><voice>1</voice></note>
            </measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([
            { t: 0, d: 240, p: 62, h: 0, v: 0.6 },
            { t: 240, d: plain(240), p: 64, h: 0 },
        ]);
    });

    it('sizes an acciaccatura to 77 ticks at 120 bpm and 38 at 60 bpm', () => {
        const at = (bpm: number) =>
            wrap(
                `<measure number="1">${ATTRS_44}${soundTempo(bpm)}
                    <note><rest/><duration>4</duration><voice>1</voice></note>
                    <note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>
                    ${note('E', 4, 4)}
                    <note><rest/><duration>8</duration><voice>1</voice></note>
                </measure>`,
            );
        const fast = parseMusicXmlString(at(120)).notes[0];
        expect(fast).toMatchObject({ t: 403, d: 77, p: 62 });
        const slow = parseMusicXmlString(at(60)).notes[0];
        expect(slow).toMatchObject({ t: 442, d: 38, p: 62 });
    });

    it('swings a pair of eighths from a heading and warns', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${words('Swing')}${note('C', 4, 2)}${note('D', 4, 2)}${note('E', 4, 12)}</measure>`,
        );
        const parsed = parseMusicXmlString(xml);
        expect(parsed.swing).toBe(true);
        const score = buildScoreData(parsed, null);
        expect(score.warnings).toContain('swing_applied');
        const pair = score.notes.filter((n) => n.p === 60 || n.p === 62);
        expect(pair.find((n) => n.p === 60)).toMatchObject({ t: 0, d: plain(240) + 80 });
        expect(pair.find((n) => n.p === 62)).toMatchObject({ t: 320, d: plain(240) - 80 });
    });
});

/**
 * The two copies of the ScoreData contract are kept in lockstep by hand, so the
 * only thing that catches drift is a payload walked through both of them.
 */
describe('ScoreData v4 contract', () => {
    const v4 = {
        version: 4,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: 96,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        tempos: [{ tick: 0, bpm: 96, src: 'sound' as const }],
        holds: [],
        pedals: [
            { tick: 0, k: 'down' as const },
            { tick: 960, k: 'up' as const },
            { tick: 960, k: 'down' as const },
        ],
        totalTicks: 1920,
        notes: [{ t: 0, d: 480, p: 60, h: 0 as const }],
        measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1, srcIndex: 0 }],
        systems: [{ page: 0, y0: 0, y1: 1 }],
        warnings: ['tempo_defaulted'],
    };

    it('writes and validates version 4, pedals and all', () => {
        expect(SCORE_DATA_VERSION).toBe(4);
        const checked = scoreDataSchema.safeParse(v4);
        expect(checked.success).toBe(true);
        expect(checked.data?.pedals).toEqual(v4.pedals);
    });

    it('refuses a pedal edge it could not act on', () => {
        expect(scoreDataSchema.safeParse({ ...v4, pedals: [{ tick: 0, k: 'half' }] }).success).toBe(false);
    });

    it('holds the client copy to the same version and the same field', () => {
        // Read as text rather than imported: the app tree sits outside this
        // package's rootDir, and importing it would drag the whole client into
        // the service's typecheck. A string match is enough for what this
        // guards — one copy of the contract moving without the other.
        const client = readFileSync(new URL('../../../src/types/scoreData.ts', import.meta.url), 'utf8');
        expect(client).toContain(`export const SCORE_DATA_VERSION = ${SCORE_DATA_VERSION};`);
        expect(client).toContain('pedals: z.array(scorePedalSchema).max(256).optional(),');
    });
});
