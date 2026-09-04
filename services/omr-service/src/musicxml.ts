import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';

import { DEFAULT_VELOCITY, TICKS_PER_QUARTER } from './scoreData.js';
import type {
    ScoreClef,
    ScoreHold,
    ScoreKeySig,
    ScoreNote,
    ScorePedal,
    ScoreTempo,
    ScoreTimeSig,
} from './scoreData.js';
import { ERROR_CODES, JobError } from './errors.js';
import {
    appoggiaturaSteal,
    arpeggiateChord,
    graceTicks,
    realizeOrnament,
    type AccidentalMark,
    type OrnamentKind,
} from './ornaments.js';

/** Musical content extracted from MusicXML — geometry-free (that comes from the .omr). */
export interface MusicalScore {
    notes: ScoreNote[];
    /** In score order; geometry is zipped on later. */
    measures: Array<{ n: number; tick: number; dTicks: number }>;
    timeSignatures: ScoreTimeSig[];
    keySignatures: ScoreKeySig[];
    clefs: ScoreClef[];
    tempos: ScoreTempo[];
    holds: ScoreHold[];
    /**
     * Sustain-pedal edges. Optional because every other producer of a
     * MusicalScore predates v4, and "no pedal engraved" is exactly what their
     * silence means; this parser always emits the array.
     */
    pedals?: ScorePedal[];
    /** Repeat structure per measure, aligned with `measures`. Never enters ScoreData. */
    repeats: MeasureRepeatMarks[];
    defaultBpm: number | null;
    totalTicks: number;
    warnings: string[];
    /** Unresolved tie-starts still open at end of the lead part (shard seam risk). */
    openTiesAtEnd: number;
    /**
     * Raw tempo marks resolveTempos consumed, absolute ticks. Service-side only —
     * never copied into ScoreData.
     */
    tempoMarks?: TempoMark[];
    /**
     * Per-staff dynamic curves after hairpin interpolation. Service-side only.
     */
    dynamicCurves?: Array<{ staff: number } & DynamicCurve>;
    /** Meter-based opening pulse, whether or not anything printed a tempo. */
    meterDefaultBpm?: number;
    /**
     * A heading or <sound><swing/> asked for swung eighths. Service-side only —
     * buildScoreData bakes the long–short into the note list.
     */
    swing?: boolean;
}

/**
 * Expression state a later parse can resume from — the second shard of a
 * split score, which never sees the heading and dynamics printed on page 1.
 */
export interface ParseSeed {
    tempoBpm: number | null;
    steadyBpm: number | null;
    velocityByStaff: Record<number, number>;
}

const EMPTY_SEED: ParseSeed = { tempoBpm: null, steadyBpm: null, velocityByStaff: {} };

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Sustained dynamic marks → velocity levels (perceptual spread pp…fff). */
const DYNAMIC_LEVELS: Record<string, number> = {
    pppp: 0.2,
    ppp: 0.26,
    pp: 0.34,
    p: 0.46,
    mp: 0.58,
    mf: 0.7,
    f: 0.82,
    ff: 0.92,
    fff: 1,
    ffff: 1,
};

/** One-note accents: sforzando family punches the next attack only. */
const ACCENT_DYNAMICS = new Set(['sf', 'sfz', 'sffz', 'fz', 'rf', 'rfz', 'fp', 'sfp']);

/**
 * Hairpins are printed as often in words as in wedges — this Schubert edition
 * uses both — so the text forms have to be read to get any dynamic shape at all.
 * Anchored at the start of the string so "poco a poco cresc." is the only kind
 * of miss, and a stray "dimenticato" is not a diminuendo.
 */
const TEXT_HAIRPIN_RE = /^\s*(decresc|decr|dim(?:in)?|calando|smorz|morendo|perdendosi|cresc)/i;

/** Where a wedge with no printed target lands, as a factor on where it started. */
const HAIRPIN_GROWTH = 1.35;
const HAIRPIN_DECAY = 0.72;
/** A morendo should fade, not vanish. */
const HAIRPIN_FLOOR = 0.26;
/** A hairpin whose end was never engraved cannot run forever. */
const UNCLOSED_HAIRPIN_BARS = 8;

/**
 * Italian tempo terms, as quarter-BPM.
 *
 * Most published editions mark tempo with a WORD and no metronome number —
 * every one of the six Schubert Moments musicaux does — so without this the
 * whole set plays at one fallback speed and Allegro vivace is indistinguishable
 * from Andantino. A defensible estimate beats that, provided it is disclosed.
 *
 * Read as quarter-BPM directly, with no compound-meter multiplier: "in 9/8 the
 * word describes the dotted beat" is right for fast compound meters and badly
 * wrong for slow ones, and erring slow is the safe direction for practice.
 */
const TEMPO_TERMS: Record<string, number> = {
    larghissimo: 24,
    grave: 40,
    largo: 50,
    lento: 54,
    larghetto: 63,
    adagio: 66,
    adagietto: 72,
    andante: 84,
    andantino: 94,
    moderato: 108,
    allegretto: 116,
    allegro: 132,
    vivace: 152,
    vivo: 152,
    vivacissimo: 168,
    presto: 172,
    prestissimo: 190,

    // German and French headings, for the editions that print no Italian at all
    // (Schumann and Debussy mark in their own languages throughout). Kept
    // deliberately short and blunt: only terms that name a speed rather than a
    // mood, and the ones that do both — ruhig, bewegt — sit near the middle
    // where being wrong costs least.
    langsam: 54,
    ruhig: 66,
    massig: 96,
    maessig: 96,
    bewegt: 116,
    munter: 120,
    lebhaft: 132,
    rasch: 140,
    schnell: 144,
    lent: 54,
    modere: 108,
    anime: 120,
    vif: 152,
    vite: 160,
};

const TEMPO_TERM_SOURCE =
    'larghissimo|grave|larghetto|largo|lento|lent|adagietto|adagio|andantino|andante|moderato|modere|allegretto|allegro|vivacissimo|vivace|vivo|prestissimo|presto|langsam|ruhig|maessig|massig|bewegt|munter|lebhaft|rasch|schnell|anime|vif|vite';
/** Anchored: a heading starts with its tempo term. "dolce" is not a tempo. */
const TEMPO_HEADING_RE = new RegExp(
    `^\\s*(?:molto\\s+|assai\\s+|poco\\s+|un\\s+poco\\s+|non\\s+troppo\\s+|sehr\\s+|tres\\s+|assez\\s+)?(?:${TEMPO_TERM_SOURCE})\\b`,
    'i',
);
const TEMPO_TERM_RE = new RegExp(`\\b(${TEMPO_TERM_SOURCE})\\b`, 'gi');

/**
 * Character words, which shade a term without naming a different one.
 * `non troppo` is tested first: "Allegro molto, ma non troppo" is a limit on the
 * molto, not two independent pushes.
 */
const TEMPO_MOD_STRONG_RE = /\b(?:molto|assai|sehr|tres)\b/i;
const TEMPO_MOD_SLIGHT_RE = /\b(?:un\s+poco|poco|assez)\b/i;
const TEMPO_MOD_NON_TROPPO_RE = /\bnon\s+troppo\b/i;

/** The pulse a qualifier pulls toward: neither fast nor slow. */
const TEMPO_NEUTRAL = 108;
const TEMPO_MIN = 24;
const TEMPO_MAX = 200;

/**
 * Fold diacritics before matching, so the ASCII patterns above meet the page as
 * it is actually printed — "Modéré", "mässig" — and as OCR reproduces it. ß is
 * spelled out on its own, since it has no decomposition for NFD to strip and
 * "Mäßig" is what a German edition actually prints.
 */
const foldDiacritics = (text: string): string =>
    text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u00df/g, 'ss');

/**
 * Shade a term average by the character words around it.
 *
 * The two directions are deliberately not symmetric. "Away" scales the tempo
 * itself, because there is no bounded distance to spend and a molto Presto
 * should keep gaining; "toward" instead spends a fraction of what remains to the
 * neutral pulse, so a qualifier can never overshoot the middle it is pulling to
 * and turn Allegro non troppo into an Andante.
 */
const shadeTempo = (bpm: number, text: string): number => {
    if (TEMPO_MOD_NON_TROPPO_RE.test(text)) {
        return bpm + (TEMPO_NEUTRAL - bpm) * 0.15;
    }
    if (TEMPO_MOD_STRONG_RE.test(text)) {
        return bpm === TEMPO_NEUTRAL ? bpm : bpm * (bpm > TEMPO_NEUTRAL ? 1.1 : 0.9);
    }
    if (TEMPO_MOD_SLIGHT_RE.test(text)) {
        return bpm + (TEMPO_NEUTRAL - bpm) * 0.1;
    }
    return bpm;
};

/** Gradual tempo changes, which arrive as words and never as numbers. */
const GRADUAL_QUALIFIER = '(?:(?:un\\s+poco|poco|molto|assai)\\s+)?';
const RITARDANDO_RE = new RegExp(
    `^\\s*${GRADUAL_QUALIFIER}(?:rit\\b|rit\\.|ritard|rall|allarg|slentando|calando\\s+e)`,
    'i',
);
const ACCELERANDO_RE = new RegExp(`^\\s*${GRADUAL_QUALIFIER}(?:accel|stringendo|affrett)`, 'i');
const A_TEMPO_RE = /^\s*(a\s*tempo|tempo\s+prim|tempo\s+i\b)/i;
const ISTESSO_TEMPO_RE = /^\s*(?:l['\u2018\u2019]istesso\s+tempo|lo\s+stesso\s+tempo)/i;
const MENO_MOSSO_RE = /^\s*meno\s+mosso/i;
const PIU_MOSSO_RE = /^\s*piu\s+mosso/i;
const RITENUTO_RE = /^\s*(?:ritenuto|riten\.)/i;
const DOPPIO_MOVIMENTO_RE = /^\s*doppio\s+movimento/i;

/** How far a rit./accel. bends the pulse, and how long it runs unbounded. */
const RITARDANDO_FACTOR = 0.75;
const ACCELERANDO_FACTOR = 1.25;
const GRADUAL_TEMPO_BARS = 4;

/**
 * Multiplicative target for a rit./accel. The page shades these: poco is a
 * smaller bend, molto/stringendo a larger one, and a bare rit. stays at the
 * historical 0.75 / 1.25 so unmarked scores do not change.
 */
const gradualTargetFactor = (text: string, kind: 'rit' | 'accel'): number => {
    const folded = foldDiacritics(text);
    if (/\b(?:un\s+poco|poco)\b/i.test(folded)) {
        return kind === 'rit' ? 0.85 : 1.15;
    }
    if (/\b(?:molto|assai)\b/i.test(folded) || (kind === 'accel' && /\bstringendo\b/i.test(folded))) {
        return kind === 'rit' ? 0.65 : 1.3;
    }
    return kind === 'rit' ? RITARDANDO_FACTOR : ACCELERANDO_FACTOR;
};

/**
 * Quarter-BPM for a tempo heading, or null. A compound heading averages its two
 * terms — "Allegro moderato" reads as neither Allegro nor Moderato — and the
 * character words around them then shade the average.
 */
const tempoFromWords = (raw: string): number | null => {
    const text = foldDiacritics(raw);
    if (!TEMPO_HEADING_RE.test(text)) {
        return null;
    }
    const found: number[] = [];
    for (const match of text.matchAll(TEMPO_TERM_RE)) {
        const bpm = TEMPO_TERMS[(match[1] ?? '').toLowerCase()];
        if (bpm !== undefined) {
            found.push(bpm);
        }
        if (found.length === 2) {
            break;
        }
    }
    if (found.length === 0) {
        return null;
    }
    const average = found.reduce((sum, bpm) => sum + bpm, 0) / found.length;
    return Math.round(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, shadeTempo(average, text))));
};

/**
 * Opening pulse for a score that prints no tempo anywhere — a lead sheet, or an
 * OMR pass whose heading never survived. The meter is the only evidence left:
 * compound bars are counted in dotted beats and want a slower quarter, a cut-time
 * bar a faster one. Every branch sits under its idiomatic tempo, because a
 * practice tempo that is too slow is a nuisance and one that is too fast is
 * useless.
 */
const meterDefaultBpm = (sig: { num: number; den: number }): number => {
    if (sig.den === 8) {
        return sig.num === 6 || sig.num === 9 || sig.num === 12 ? 84 : 96;
    }
    if (sig.den === 2) {
        return 112;
    }
    if (sig.den === 4 && sig.num === 3) {
        return 108;
    }
    if (sig.den === 4 && sig.num === 2) {
        return 100;
    }
    return 96;
};

/**
 * The jump vocabulary as OCR delivers it. Audiveris reads "D.C. al Fine" as
 * <words>; the <sound> attributes a native export would carry are the lucky
 * case, so text is the path that has to work.
 *
 * Two orderings matter. Jumps are tested before Fine and Coda, or "D.C. al Fine"
 * would be consumed as a Fine and the piece would stop where it should turn
 * back. And Fine and Coda match the WHOLE string only: "fine" is an ordinary
 * Italian word, and a substring match would end the movement inside a phrase.
 */
const JUMP_DC_RE = /^\s*(?:d\.?\s?c\.?|da\s+capo)\b/i;
const JUMP_DS_RE = /^\s*(?:d\.?\s?s\.?|dal\s+segno)\b/i;
const AL_FINE_RE = /\bal\s+fine\b/i;
const AL_CODA_RE = /\bal(?:la)?\s+coda\b/i;
const FINE_RE = /^\s*fine\s*[.!]?\s*$/i;
const TO_CODA_RE = /^\s*to\s+coda\b/i;
const CODA_WORD_RE = /^\s*coda\s*$/i;

/** Where a jump ends, when the words say so at all. */
const jumpTargetOf = (text: string): 'fine' | 'coda' | null =>
    AL_FINE_RE.test(text) ? 'fine' : AL_CODA_RE.test(text) ? 'coda' : null;

/**
 * Record a jump without discarding what another encoding already said about it:
 * a <sound dacapo> carries the kind and the <words> beside it carry "al Fine",
 * and the two are one printed instruction.
 */
const noteJump = (repeat: MeasureRepeatMarks, kind: 'dc' | 'ds', al: 'fine' | 'coda' | null): void => {
    repeat.jump = { kind, al: al ?? repeat.jump?.al ?? null };
};

/**
 * Structure carried by <sound> attributes. `dacapo` and `fine` are yes/no, while
 * `segno`, `dalsegno`, `coda` and `tocoda` carry a label naming which sign is
 * meant — so for those the presence of the attribute IS the instruction.
 */
const applySoundStructure = (sound: Elem, repeat: MeasureRepeatMarks): void => {
    const isYes = (name: string): boolean => (sound.getAttribute(name) ?? '').trim().toLowerCase() === 'yes';
    const isNamed = (name: string): boolean => (sound.getAttribute(name) ?? '').trim() !== '';
    if (isYes('dacapo')) {
        noteJump(repeat, 'dc', null);
    }
    if (isNamed('dalsegno')) {
        noteJump(repeat, 'ds', null);
    }
    if (isNamed('tocoda')) {
        repeat.toCoda = true;
    }
    if (isNamed('coda')) {
        repeat.codaTarget = true;
    }
    if (isNamed('segno')) {
        repeat.segno = true;
    }
    if (isYes('fine')) {
        repeat.fine = true;
    }
};

/**
 * Engraved signs. A segno says exactly one thing, but a coda glyph is printed
 * both at "To Coda" and over the coda section itself, so a bare sighting is
 * recorded as nothing more than a sighting — the planner tells the two apart by
 * position, which is the only thing that distinguishes them.
 */
const applyGlyphStructure = (host: Elem, repeat: MeasureRepeatMarks): void => {
    if (host.getElementsByTagName('segno').length > 0) {
        repeat.segno = true;
    }
    if (host.getElementsByTagName('coda').length > 0) {
        repeat.codaGlyph = true;
    }
};

/** Structure printed as plain text, the path OMR actually produces. */
const applyWordStructure = (text: string, repeat: MeasureRepeatMarks): void => {
    if (JUMP_DC_RE.test(text)) {
        noteJump(repeat, 'dc', jumpTargetOf(text));
    } else if (JUMP_DS_RE.test(text)) {
        noteJump(repeat, 'ds', jumpTargetOf(text));
    } else if (TO_CODA_RE.test(text)) {
        repeat.toCoda = true;
    } else if (FINE_RE.test(text)) {
        repeat.fine = true;
    } else if (CODA_WORD_RE.test(text)) {
        // Spelled out, "Coda" labels the section — it is the bare GLYPH that is
        // ambiguous, never the word.
        repeat.codaTarget = true;
    }
};

/**
 * How much of its written value a note actually sounds. Nothing was ever
 * shortened before, and the engine adds a release tail on top, so consecutive
 * notes overlapped and every texture came out legato — a staccato Alberti bass
 * and a slurred nocturne had identical touch.
 *
 * A single winner applies, never a product: `staccato x slur` is not 0.5, it is
 * portato, which is its own row.
 */
const GATE_STACCATISSIMO = 0.25;
const GATE_STACCATO = 0.5;
const GATE_PORTATO = 0.7;
const GATE_DEFAULT = 0.9;
const GATE_LEGATO = 1;
/** Below this a gated note stops reading as a pitch at all. */
const MIN_SOUNDING_TICKS = 60;

/** Articulation, reduced to the two things playback can act on. */
interface ArtSet {
    gate: number;
    boost: number;
}

const PLAIN_ART: ArtSet = { gate: GATE_DEFAULT, boost: 0 };

const markNames = (noteEl: Elem, container: string): Set<string> => {
    const names = new Set<string>();
    const groups = noteEl.getElementsByTagName(container);
    for (let i = 0; i < groups.length; i++) {
        const group = groups.item(i) as Elem | null;
        if (!group) {
            continue;
        }
        for (const mark of childElements(group)) {
            names.add(mark.nodeName);
        }
    }
    return names;
};

const slurTypesOf = (noteEl: Elem): string[] => {
    const out: string[] = [];
    const slurs = noteEl.getElementsByTagName('slur');
    for (let i = 0; i < slurs.length; i++) {
        const type = (slurs.item(i) as Elem | null)?.getAttribute('type');
        if (type) {
            out.push(type);
        }
    }
    return out;
};

/** Accents shape velocity only — a `>` on a staccato note stays short. */
const articulationOf = (arts: Set<string>, underSlur: boolean): ArtSet => {
    const short = arts.has('staccatissimo') || arts.has('spiccato');
    const gate = short
        ? GATE_STACCATISSIMO
        : arts.has('staccato')
          ? underSlur
              ? GATE_PORTATO // portato: dots under a slur are lifted, not clipped
              : GATE_STACCATO
          : arts.has('detached-legato')
            ? GATE_PORTATO
            : arts.has('tenuto') || underSlur
              ? GATE_LEGATO
              : GATE_DEFAULT;
    const boost = arts.has('strong-accent')
        ? 0.25
        : arts.has('accent')
          ? 0.15
          : short
            ? 0.05
            : arts.has('tenuto')
              ? 0.03
              : 0;
    return { gate, boost };
};

const gateDuration = (dur: number, gate: number): number =>
    Math.max(MIN_SOUNDING_TICKS, Math.min(dur, Math.round(dur * gate)));

const clampVelocity = (v: number): number => Math.min(1, Math.max(0.1, v));
const roundVelocity = (v: number): number => Math.round(v * 100) / 100;

const ORNAMENT_TAGS: Record<string, OrnamentKind> = {
    'trill-mark': 'trill',
    mordent: 'mordent',
    'inverted-mordent': 'inverted-mordent',
    turn: 'turn',
    'inverted-turn': 'inverted-turn',
};

const accidentalMarkOf = (text: string): AccidentalMark | undefined => {
    const folded = text.trim().toLowerCase();
    if (folded === 'sharp' || folded === 'sharp-sharp' || folded === 's') {
        return 'sharp';
    }
    if (folded === 'flat' || folded === 'flat-flat' || folded === 'f') {
        return 'flat';
    }
    if (folded === 'natural' || folded === 'n') {
        return 'natural';
    }
    return undefined;
};

const ornamentOf = (noteEl: Elem): { kind: OrnamentKind; accidentalMark?: AccidentalMark } | undefined => {
    const groups = noteEl.getElementsByTagName('ornaments');
    for (let g = 0; g < groups.length; g++) {
        const group = groups.item(g) as Elem | null;
        if (!group) {
            continue;
        }
        let kind: OrnamentKind | undefined;
        let accidentalMark: AccidentalMark | undefined;
        for (const mark of childElements(group)) {
            const mapped = ORNAMENT_TAGS[mark.nodeName];
            if (mapped && kind === undefined) {
                kind = mapped;
            }
            if (mark.nodeName === 'accidental-mark') {
                accidentalMark = accidentalMarkOf(mark.textContent ?? '') ?? accidentalMark;
            }
        }
        if (kind) {
            return accidentalMark ? { kind, accidentalMark } : { kind };
        }
    }
    return undefined;
};

const arpeggiateOf = (noteEl: Elem): 'up' | 'down' | undefined => {
    const el = noteEl.getElementsByTagName('arpeggiate').item(0) as Elem | null;
    if (!el) {
        return undefined;
    }
    return (el.getAttribute('direction') ?? '').toLowerCase() === 'down' ? 'down' : 'up';
};

/** slash default true = acciaccatura; steal-time-following without slash → appoggiatura. */
const graceFigureOf = (graceEl: Elem): { slash: boolean; stealPrevious: boolean; stealFollowing: boolean } => {
    const slashAttr = graceEl.getAttribute('slash');
    const stealPrevious = (graceEl.getAttribute('steal-time-previous') ?? '') !== '';
    const stealFollowing = (graceEl.getAttribute('steal-time-following') ?? '') !== '';
    let slash = true;
    if (slashAttr === 'no') {
        slash = false;
    } else if (slashAttr === 'yes') {
        slash = true;
    } else if (stealFollowing) {
        slash = false;
    }
    return { slash, stealPrevious, stealFollowing };
};

type Elem = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

const childElements = (parent: Elem, name?: string): Elem[] => {
    const out: Elem[] = [];
    for (let i = 0; i < parent.childNodes.length; i++) {
        const node = parent.childNodes[i];
        if (node && node.nodeType === 1 && (!name || node.nodeName === name)) {
            out.push(node as Elem);
        }
    }
    return out;
};

const firstChild = (parent: Elem, name: string): Elem | null => childElements(parent, name)[0] ?? null;

const childText = (parent: Elem, name: string): string | null => {
    const el = firstChild(parent, name);
    return el ? (el.textContent ?? '').trim() : null;
};

const childInt = (parent: Elem, name: string): number | null => {
    const text = childText(parent, name);
    if (text === null || text === '') {
        return null;
    }
    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) ? value : null;
};

/** MIDI pitch from a <pitch> element (null for unpitched). */
const midiFromPitch = (pitch: Elem): number | null => {
    const step = childText(pitch, 'step');
    const octave = childInt(pitch, 'octave');
    if (!step || octave === null) {
        return null;
    }
    const semitone = STEP_SEMITONES[step.toUpperCase()];
    if (semitone === undefined) {
        return null;
    }
    const alterText = childText(pitch, 'alter');
    const alter = alterText ? Math.round(Number.parseFloat(alterText)) : 0;
    const midi = (octave + 1) * 12 + semitone + alter;
    return midi >= 0 && midi <= 127 ? midi : null;
};

/** Extract the (first) score XML from a compressed .mxl container. */
const MAX_MXL_ENTRY_BYTES = 8 * 1024 * 1024;

export const extractMxl = (mxlBytes: Buffer): string => {
    if (mxlBytes.byteLength > MAX_MXL_ENTRY_BYTES * 2) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML archive too large');
    }
    const zip = new AdmZip(mxlBytes);
    const container = zip.getEntry('META-INF/container.xml');
    if (container) {
        if (container.header.size > MAX_MXL_ENTRY_BYTES) {
            throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML entry too large');
        }
        const doc = new DOMParser().parseFromString(container.getData().toString('utf8'), 'text/xml');
        const rootfiles = doc.getElementsByTagName('rootfile');
        const first = rootfiles.item(0);
        const path = first?.getAttribute('full-path');
        if (path) {
            const entry = zip.getEntry(path);
            if (entry) {
                if (entry.header.size > MAX_MXL_ENTRY_BYTES) {
                    throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML entry too large');
                }
                return entry.getData().toString('utf8');
            }
        }
    }
    const fallback = zip
        .getEntries()
        .find((entry) => entry.entryName.toLowerCase().endsWith('.xml') && !entry.entryName.startsWith('META-INF'));
    if (!fallback) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No score XML inside .mxl');
    }
    if (fallback.header.size > MAX_MXL_ENTRY_BYTES) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML entry too large');
    }
    return fallback.getData().toString('utf8');
};

interface PartParseTarget {
    part: Elem;
    /** Hand for single-staff parts (multi-staff parts derive hand from <staff>). */
    fallbackHand: 0 | 1;
}

/** Cleffy is piano-first — boost keyboard names, penalize vocal/OCR ghosts. */
const PIANO_NAME_RE = /\b(piano|pianoforte|pno\.?|kbd|keyboard|clavier)\b/i;
const NOISE_NAME_RE = /\b(voice|vocal|soprano|alto|tenor|bass|choir|chorus|lyrics?)\b/i;
/** Parts below this fraction of the densest part's pitched notes are treated as noise. */
const NOISE_PITCHED_FRACTION = 0.1;

interface PartCandidate {
    part: Elem;
    index: number;
    name: string;
    staves: number;
    pitchedNotes: number;
    nameScore: number;
}

/**
 * Parse one exported MusicXML document (score-partwise) into musical content.
 * Time base: everything is normalized to 480 ticks/quarter regardless of the
 * file's <divisions>. Ties are merged and grace notes crushed in ahead of their
 * principal. Repeat and jump structure is RECORDED per measure and never acted
 * on here: the timeline this returns is always linear, and buildScoreData is
 * what decides whether the structure can be performed or must be disclosed.
 *
 * Part selection is piano-primary: prefer a grand-staff / Piano-named part over
 * document order so Audiveris "Voice" dummy parts (and art-song vocal lines)
 * do not become the play-along timeline.
 */
export const parseMusicXmlString = (xml: string, tickOffset = 0, seed: ParseSeed = EMPTY_SEED): MusicalScore => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'score-partwise') {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, `Unsupported root <${root?.nodeName ?? 'none'}>`);
    }

    const warnings = new Set<string>();
    const parts = childElements(root, 'part');
    if (parts.length === 0) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No <part> elements');
    }

    const targets = selectPartTargets(root, parts, warnings);
    const lead = targets[0]?.part;
    if (!lead) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No lead part');
    }
    const leadStaves = countDeclaredStaves(lead);

    // The lead part is the timeline authority: its measures define barlines.
    const leadResult = parsePart(lead, { fallbackHand: 0, timeline: null, tickOffset, warnings, seed });
    const notes = [...leadResult.notes];
    let swing = leadResult.swing;
    for (const target of targets.slice(1)) {
        const secondary = parsePart(target.part, {
            fallbackHand: target.fallbackHand,
            timeline: leadResult.measures,
            tickOffset,
            warnings,
            seed,
        });
        notes.push(...secondary.notes);
        swing = swing || secondary.swing;
    }

    if (leadStaves < 2 && targets.length === 1) {
        warnings.add('single_staff_all_rh');
    }

    notes.sort((a, b) => a.t - b.t || a.h - b.h || a.p - b.p);
    const lastMeasure = leadResult.measures[leadResult.measures.length - 1];
    // The lead part's final barline is the end of the timeline, but a secondary
    // part can run past it — playback stops at totalTicks, so anything beyond
    // would silently never sound.
    let totalTicks = lastMeasure ? lastMeasure.tick + lastMeasure.dTicks : tickOffset;
    for (const note of notes) {
        totalTicks = Math.max(totalTicks, note.t + note.d);
    }
    return {
        notes,
        measures: leadResult.measures,
        timeSignatures: leadResult.timeSignatures,
        keySignatures: leadResult.keySignatures,
        clefs: leadResult.clefs,
        tempos: leadResult.tempos,
        holds: leadResult.holds,
        pedals: leadResult.pedals,
        repeats: leadResult.repeats,
        defaultBpm: leadResult.defaultBpm,
        totalTicks,
        warnings: [...warnings],
        openTiesAtEnd: leadResult.openTiesAtEnd,
        tempoMarks: leadResult.tempoMarks,
        dynamicCurves: leadResult.dynamicCurves,
        meterDefaultBpm: leadResult.meterDefaultBpm,
        swing,
    };
};

/**
 * Choose which MusicXML parts feed playback/fingering.
 *
 * 1. Grand staff (staves ≥ 2) or strongly Piano-named → richest such part alone.
 * 2. Else densest non-noise single-staff parts, pairing a second as LH when present.
 * 3. Noise = sparse pitched content (< 10% of max) and/or vocal-ish names when a
 *    denser part exists — never merge those notes into the piano timeline.
 */
const selectPartTargets = (root: Elem, parts: Elem[], warnings: Set<string>): PartParseTarget[] => {
    const names = partNameById(root);
    const candidates: PartCandidate[] = parts.map((part, index) => {
        const id = part.getAttribute('id') ?? '';
        const name = names.get(id) ?? '';
        const staves = countDeclaredStaves(part);
        const pitchedNotes = countPitchedNotes(part);
        let nameScore = 0;
        if (PIANO_NAME_RE.test(name)) {
            nameScore += 2;
        }
        if (NOISE_NAME_RE.test(name)) {
            nameScore -= 2;
        }
        return { part, index, name, staves, pitchedNotes, nameScore };
    });

    const maxPitched = Math.max(0, ...candidates.map((c) => c.pitchedNotes));
    const isNoise = (c: PartCandidate): boolean =>
        maxPitched > 0 && c.pitchedNotes < maxPitched * NOISE_PITCHED_FRACTION;

    const rank = (a: PartCandidate, b: PartCandidate): number =>
        b.pitchedNotes - a.pitchedNotes || b.nameScore - a.nameScore || b.staves - a.staves || a.index - b.index;

    const grands = candidates.filter((c) => c.staves >= 2 || (c.nameScore > 0 && !isNoise(c))).sort(rank);

    let selected: PartCandidate[];
    if (grands[0]) {
        // Piano product rule: one grand/piano timeline — do not pair leftover Voices.
        selected = [grands[0]];
    } else {
        const usable = candidates.filter((c) => !isNoise(c));
        const pool = (usable.length > 0 ? usable : candidates).slice().sort(rank);
        const lead = pool[0];
        if (!lead) {
            selected = candidates.slice(0, 1);
        } else if (lead.staves < 2) {
            const secondary = pool.find((c) => c.part !== lead.part && c.staves < 2);
            selected = secondary ? [lead, secondary] : [lead];
        } else {
            selected = [lead];
        }
    }

    if (parts.length > selected.length) {
        warnings.add('multi_part_collapsed');
    }

    return selected.map((c, i) => ({
        part: c.part,
        fallbackHand: (i === 0 ? 0 : 1) as 0 | 1,
    }));
};

/** Map score-part id → printed part-name (empty when absent). */
const partNameById = (root: Elem): Map<string, string> => {
    const map = new Map<string, string>();
    const partList = firstChild(root, 'part-list');
    if (!partList) {
        return map;
    }
    for (const scorePart of childElements(partList, 'score-part')) {
        const id = scorePart.getAttribute('id');
        if (!id) {
            continue;
        }
        map.set(id, (childText(scorePart, 'part-name') ?? '').trim());
    }
    return map;
};

const countDeclaredStaves = (part: Elem): number => {
    let staves = 1;
    for (const measure of childElements(part, 'measure')) {
        for (const attributes of childElements(measure, 'attributes')) {
            const declared = childInt(attributes, 'staves');
            if (declared !== null) {
                staves = Math.max(staves, declared);
            }
        }
    }
    return staves;
};

/** Pitched (non-rest) note elements — used only for part ranking, not playback. */
const countPitchedNotes = (part: Elem): number => {
    let count = 0;
    for (const measure of childElements(part, 'measure')) {
        for (const noteEl of childElements(measure, 'note')) {
            if (firstChild(noteEl, 'rest') || firstChild(noteEl, 'grace')) {
                continue;
            }
            if (firstChild(noteEl, 'pitch')) {
                count += 1;
            }
        }
    }
    return count;
};

interface PartContext {
    fallbackHand: 0 | 1;
    /** Barline authority from the lead part (secondary parts snap to it). */
    timeline: Array<{ n: number; tick: number; dTicks: number }> | null;
    tickOffset: number;
    warnings: Set<string>;
    seed: ParseSeed;
}

interface PartResult {
    notes: ScoreNote[];
    measures: Array<{ n: number; tick: number; dTicks: number }>;
    timeSignatures: ScoreTimeSig[];
    keySignatures: ScoreKeySig[];
    clefs: ScoreClef[];
    tempos: ScoreTempo[];
    holds: ScoreHold[];
    pedals: ScorePedal[];
    repeats: MeasureRepeatMarks[];
    defaultBpm: number | null;
    openTiesAtEnd: number;
    tempoMarks: TempoMark[];
    dynamicCurves: Array<{ staff: number } & DynamicCurve>;
    meterDefaultBpm: number;
    swing: boolean;
}

/**
 * A mark's staff, when the writer said which: `null` means unattributed.
 * Deliberately NOT collapsed to staff 1 — that default is what destroys the
 * only signal distinguishing "this writer separates the hands" from "this
 * writer doesn't".
 */
type EventStaff = number | null;

/**
 * One thing that happens inside a measure, positioned at `rel` ticks from the
 * barline. Directions sit at the cursor where they were met, so a dynamic
 * written after a <backup> lands near the start of the bar rather than after
 * the whole upper staff.
 */
type RawEvent =
    | {
          k: 'note';
          rel: number;
          dur: number;
          midi: number;
          staff: number;
          voice: string;
          chord: boolean;
          tieStart: boolean;
          tieStop: boolean;
          arts: ArtSet;
          fermata: boolean;
          ornament?: { kind: OrnamentKind; accidentalMark?: AccidentalMark };
          arpeggiate?: 'up' | 'down';
      }
    | {
          k: 'grace';
          rel: number;
          midi: number;
          staff: number;
          slash: boolean;
          stealPrevious: boolean;
          stealFollowing: boolean;
      }
    | { k: 'dyn'; rel: number; staff: EventStaff; v: number }
    | { k: 'accentDyn'; rel: number; staff: EventStaff; toPiano: boolean }
    | { k: 'wedge'; rel: number; staff: EventStaff; dir: 'crescendo' | 'diminuendo' | 'stop'; num: number }
    | { k: 'tempo'; rel: number; qbpm: number; src: 'sound' | 'metronome' | 'word' }
    | { k: 'gradual'; rel: number; kind: 'rit' | 'accel'; amount: number }
    | { k: 'gradual'; rel: number; kind: 'atempo' }
    | { k: 'gradual'; rel: number; kind: 'step'; amount: number; becomesSteady: boolean }
    | { k: 'pedal'; rel: number; kind: 'down' | 'up' | 'change' }
    | { k: 'time'; rel: number; num: number; den: number }
    | { k: 'key'; rel: number; fifths: number }
    | { k: 'clef'; rel: number; staff: 0 | 1; sign: 'G' | 'F' | 'C'; line: number }
    | { k: 'swing' };

/**
 * Repeat structure engraved on a measure's barlines. Service-side only — this
 * never reaches ScoreData, which stores the performance, not the notation.
 *
 * Position is part of the vocabulary, and the two halves differ: `segno` and
 * `codaTarget` name a place a jump ARRIVES at, so they bind to the measure's
 * START, while `toCoda`, `fine` and `jump` are instructions obeyed once the bar
 * has been played, so they take effect at its END.
 */
export interface MeasureRepeatMarks {
    /** `|:` — where a backward repeat returns to. */
    repeatForward: boolean;
    /** `:|` */
    repeatBackward: boolean;
    /** <repeat times>, i.e. total passes; 2 unless stated. */
    repeatTimes: number;
    /** Volta passes this bar belongs to, e.g. [1] or [1,3]; null when not in one. */
    endingStart: number[] | null;
    /** A volta bracket closes here. */
    endingStop: boolean;
    /** 𝄋 — a D.S. jump lands at this measure's START. */
    segno?: boolean;
    /** 𝄌 section begins at this measure's START. */
    codaTarget?: boolean;
    /** "To Coda" — divert to the coda at this measure's END, post-jump pass only. */
    toCoda?: boolean;
    /**
     * A bare 𝄌 glyph with nothing saying which role it plays. The same sign is
     * engraved both at "To Coda" and at the coda itself, so the parser records
     * the sighting and the planner disambiguates by position.
     */
    codaGlyph?: boolean;
    /** "Fine" — stop at this measure's END, post-jump pass only. */
    fine?: boolean;
    /** D.C./D.S. instruction taking effect at this measure's END. */
    jump?: { kind: 'dc' | 'ds'; al: 'fine' | 'coda' | null } | null;
}

const NO_REPEAT_MARKS: MeasureRepeatMarks = {
    repeatForward: false,
    repeatBackward: false,
    repeatTimes: 2,
    endingStart: null,
    endingStop: false,
};

/** Pass-1 output for one <measure>. Nothing here is padded or velocity-resolved. */
interface RawMeasure {
    /** Position in the part's <measure> list — how secondary parts index the timeline. */
    index: number;
    /** Display number as printed (pickups are 0). */
    n: number;
    isPickup: boolean;
    /** Real content length, BEFORE any padding — the meter check's evidence. */
    contentTicks: number;
    /** Signature in force after this measure's own <attributes>. */
    sig: { num: number; den: number };
    /** Document order, preserved: resolution may reorder, scanning must not. */
    events: RawEvent[];
    repeat: MeasureRepeatMarks;
}

/** The optional <staff> child of a <direction>; null when unattributed. */
const directionStaff = (direction: Elem): EventStaff => childInt(direction, 'staff');

/**
 * Pass 1 — the only place that knows about document order. Emits measure-RELATIVE
 * onsets: absolute ticks depend on padding, padding depends on the signature, and
 * the signature is exactly what meter reconciliation wants to change.
 */
const scanPart = (part: Elem): RawMeasure[] => {
    const raws: RawMeasure[] = [];
    let divisions = 1;
    let currentSig = { num: 4, den: 4 };
    let runningNumber: number | null = null;
    /** Open slurs per staff — phrasing runs across barlines. */
    const slurDepth = new Map<number, number>();
    /** Last non-chord articulation per staff, for chord members to inherit. */
    const lastArts = new Map<number, ArtSet>();
    /** Last non-chord arpeggio sign per staff — members of the chord share it. */
    const lastArp = new Map<number, 'up' | 'down' | undefined>();

    const measureElems = childElements(part, 'measure');
    for (let index = 0; index < measureElems.length; index++) {
        const measure = measureElems[index];
        if (!measure) {
            continue;
        }
        const events: RawEvent[] = [];
        const repeat: MeasureRepeatMarks = { ...NO_REPEAT_MARKS };
        let cursor = 0;
        let maxCursor = 0;
        let lastNoteStart = 0;

        for (const child of childElements(measure)) {
            switch (child.nodeName) {
                case 'attributes': {
                    const declaredDivisions = childInt(child, 'divisions');
                    if (declaredDivisions && declaredDivisions > 0) {
                        divisions = declaredDivisions;
                    }
                    const time = firstChild(child, 'time');
                    if (time) {
                        const num = childInt(time, 'beats');
                        const den = childInt(time, 'beat-type');
                        if (num && den) {
                            currentSig = { num, den };
                            events.push({ k: 'time', rel: cursor, num, den });
                        }
                    }
                    const key = firstChild(child, 'key');
                    if (key) {
                        const fifths = childInt(key, 'fifths');
                        if (fifths !== null && fifths >= -7 && fifths <= 7) {
                            events.push({ k: 'key', rel: cursor, fifths });
                        }
                    }
                    for (const clefEl of childElements(child, 'clef')) {
                        const signRaw = (childText(clefEl, 'sign') ?? '').toUpperCase();
                        if (signRaw !== 'G' && signRaw !== 'F' && signRaw !== 'C') {
                            continue;
                        }
                        const numberAttr = clefEl.getAttribute('number');
                        const staffNum = numberAttr ? Number.parseInt(numberAttr, 10) : 1;
                        const staff: 0 | 1 = staffNum >= 2 ? 1 : 0;
                        const line = childInt(clefEl, 'line') ?? (signRaw === 'F' ? 4 : signRaw === 'C' ? 3 : 2);
                        events.push({ k: 'clef', rel: cursor, staff, sign: signRaw, line });
                    }
                    break;
                }
                case 'direction': {
                    const sound = firstChild(child, 'sound');
                    // <sound tempo> is quarter-BPM by definition — prefer it; a printed
                    // metronome mark is per BEAT UNIT and converts.
                    let qbpm: number | null = null;
                    let tempoSrc: 'sound' | 'metronome' = 'sound';
                    const tempoAttr = sound?.getAttribute('tempo');
                    if (tempoAttr) {
                        const parsed = Number.parseFloat(tempoAttr);
                        if (Number.isFinite(parsed) && parsed > 0) {
                            qbpm = Math.round(parsed);
                        }
                    }
                    if (qbpm === null) {
                        const metronome = child.getElementsByTagName('metronome').item(0) as Elem | null;
                        const perMinute = metronome ? childText(metronome, 'per-minute') : null;
                        const parsed = perMinute ? Number.parseFloat(perMinute) : NaN;
                        if (Number.isFinite(parsed) && parsed > 0) {
                            qbpm = Math.round(parsed * beatUnitToQuarters(metronome));
                            tempoSrc = 'metronome';
                        }
                    }
                    if (qbpm !== null) {
                        events.push({ k: 'tempo', rel: cursor, qbpm, src: tempoSrc });
                    }

                    if (sound) {
                        applySoundStructure(sound, repeat);
                    }
                    applyGlyphStructure(child, repeat);
                    // Structure is read from EVERY <words> in the direction, not
                    // just the first: Audiveris splits one printed line into
                    // several text items, and "D.C. al Fine" routinely arrives
                    // behind a heading that got there first.
                    const allWords = child.getElementsByTagName('words');
                    for (let w = 0; w < allWords.length; w++) {
                        const text = (allWords.item(w) as Elem | null)?.textContent ?? '';
                        if (text) {
                            applyWordStructure(text, repeat);
                            if (/\bswing\b/i.test(foldDiacritics(text))) {
                                events.push({ k: 'swing' });
                            }
                        }
                    }
                    if (child.getElementsByTagName('swing').length > 0) {
                        events.push({ k: 'swing' });
                    }

                    const pedalEl = child.getElementsByTagName('pedal').item(0) as Elem | null;
                    if (pedalEl) {
                        const type = (pedalEl.getAttribute('type') ?? '').toLowerCase();
                        if (type === 'start' || type === 'stop' || type === 'change') {
                            events.push({
                                k: 'pedal',
                                rel: cursor,
                                kind: type === 'start' ? 'down' : type === 'stop' ? 'up' : 'change',
                            });
                        }
                    }

                    const wordsForTempo = child.getElementsByTagName('words').item(0) as Elem | null;
                    const wordText = wordsForTempo ? (wordsForTempo.textContent ?? '') : '';
                    if (wordText) {
                        const foldedWords = foldDiacritics(wordText);
                        if (ISTESSO_TEMPO_RE.test(foldedWords)) {
                            // Same pulse, new note values — not a heading and not a bend.
                        } else if (MENO_MOSSO_RE.test(foldedWords)) {
                            events.push({ k: 'gradual', rel: cursor, kind: 'step', amount: 0.8, becomesSteady: true });
                        } else if (PIU_MOSSO_RE.test(foldedWords)) {
                            events.push({ k: 'gradual', rel: cursor, kind: 'step', amount: 1.2, becomesSteady: true });
                        } else if (RITENUTO_RE.test(foldedWords)) {
                            events.push({
                                k: 'gradual',
                                rel: cursor,
                                kind: 'step',
                                amount: 0.8,
                                becomesSteady: false,
                            });
                        } else if (DOPPIO_MOVIMENTO_RE.test(foldedWords)) {
                            events.push({ k: 'gradual', rel: cursor, kind: 'step', amount: 2, becomesSteady: true });
                        } else if (RITARDANDO_RE.test(foldedWords)) {
                            events.push({
                                k: 'gradual',
                                rel: cursor,
                                kind: 'rit',
                                amount: gradualTargetFactor(foldedWords, 'rit'),
                            });
                        } else if (ACCELERANDO_RE.test(foldedWords)) {
                            events.push({
                                k: 'gradual',
                                rel: cursor,
                                kind: 'accel',
                                amount: gradualTargetFactor(foldedWords, 'accel'),
                            });
                        } else if (A_TEMPO_RE.test(foldedWords)) {
                            events.push({ k: 'gradual', rel: cursor, kind: 'atempo' });
                        } else if (qbpm === null) {
                            const worded = tempoFromWords(wordText);
                            if (worded !== null) {
                                events.push({ k: 'tempo', rel: cursor, qbpm: worded, src: 'word' });
                            }
                        }
                    }

                    const staff = directionStaff(child);
                    const wedgeEl = child.getElementsByTagName('wedge').item(0) as Elem | null;
                    if (wedgeEl) {
                        const type = (wedgeEl.getAttribute('type') ?? '').toLowerCase();
                        const numAttr = Number.parseInt(wedgeEl.getAttribute('number') ?? '1', 10);
                        const num = Number.isFinite(numAttr) ? numAttr : 1;
                        if (type === 'crescendo' || type === 'diminuendo' || type === 'stop') {
                            events.push({ k: 'wedge', rel: cursor, staff, dir: type, num });
                        }
                    } else {
                        const wordsEl = child.getElementsByTagName('words').item(0) as Elem | null;
                        const text = wordsEl ? (wordsEl.textContent ?? '') : '';
                        const hairpin = TEXT_HAIRPIN_RE.exec(text);
                        if (hairpin) {
                            events.push({
                                k: 'wedge',
                                rel: cursor,
                                staff,
                                dir: /^cresc/i.test(hairpin[1] ?? '') ? 'crescendo' : 'diminuendo',
                                num: 1,
                            });
                        }
                    }

                    const dynamics = child.getElementsByTagName('dynamics').item(0) as Elem | null;
                    if (dynamics) {
                        for (const mark of childElements(dynamics)) {
                            const level = DYNAMIC_LEVELS[mark.nodeName];
                            if (level !== undefined) {
                                events.push({ k: 'dyn', rel: cursor, staff, v: level });
                                break;
                            }
                            if (ACCENT_DYNAMICS.has(mark.nodeName)) {
                                events.push({
                                    k: 'accentDyn',
                                    rel: cursor,
                                    staff,
                                    toPiano: mark.nodeName === 'fp' || mark.nodeName === 'sfp',
                                });
                                break;
                            }
                        }
                    } else {
                        // <sound dynamics> is a percentage of a standard forte.
                        const soundDynamics = sound?.getAttribute('dynamics');
                        const pct = soundDynamics ? Number.parseFloat(soundDynamics) : NaN;
                        if (Number.isFinite(pct) && pct > 0) {
                            events.push({
                                k: 'dyn',
                                rel: cursor,
                                staff,
                                v: roundVelocity(clampVelocity((pct / 100) * 0.82)),
                            });
                        }
                    }
                    break;
                }
                case 'sound': {
                    // A <sound> hung straight on the measure rather than inside a
                    // <direction> — where an exporter puts a jump's own
                    // instruction, and, until now, the one tempo mark nothing in
                    // this parser ever looked at.
                    const tempoAttr = child.getAttribute('tempo');
                    const parsed = tempoAttr ? Number.parseFloat(tempoAttr) : NaN;
                    if (Number.isFinite(parsed) && parsed > 0) {
                        events.push({ k: 'tempo', rel: cursor, qbpm: Math.round(parsed), src: 'sound' });
                    }
                    applySoundStructure(child, repeat);
                    if (child.getElementsByTagName('swing').length > 0) {
                        events.push({ k: 'swing' });
                    }
                    break;
                }
                case 'backup': {
                    const dur = childInt(child, 'duration') ?? 0;
                    cursor = Math.max(0, cursor - ticksOf(dur, divisions));
                    break;
                }
                case 'forward': {
                    const dur = childInt(child, 'duration') ?? 0;
                    cursor += ticksOf(dur, divisions);
                    maxCursor = Math.max(maxCursor, cursor);
                    break;
                }
                case 'barline': {
                    const barlineSound = firstChild(child, 'sound');
                    if (barlineSound) {
                        applySoundStructure(barlineSound, repeat);
                    }
                    const repeatEl = firstChild(child, 'repeat');
                    if (repeatEl) {
                        const direction = (repeatEl.getAttribute('direction') ?? '').toLowerCase();
                        if (direction === 'forward') {
                            repeat.repeatForward = true;
                        } else if (direction === 'backward') {
                            repeat.repeatBackward = true;
                            const times = Number.parseInt(repeatEl.getAttribute('times') ?? '', 10);
                            if (Number.isFinite(times) && times >= 2 && times <= 16) {
                                repeat.repeatTimes = times;
                            }
                        }
                    }
                    const endingEl = firstChild(child, 'ending');
                    if (endingEl) {
                        const type = (endingEl.getAttribute('type') ?? '').toLowerCase();
                        if (type === 'start') {
                            // "1, 2" or "1,3" — the passes this bracket covers.
                            const passes = (endingEl.getAttribute('number') ?? '')
                                .split(',')
                                .map((part) => Number.parseInt(part.trim(), 10))
                                .filter((n) => Number.isFinite(n) && n > 0);
                            repeat.endingStart = passes.length > 0 ? passes : [1];
                        } else if (type === 'stop' || type === 'discontinue') {
                            // "discontinue" is an open-ended bracket; for playback
                            // purposes it ends here just the same.
                            repeat.endingStop = true;
                        }
                    }
                    break;
                }
                case 'note': {
                    const graceEl = firstChild(child, 'grace');
                    if (graceEl) {
                        const gracePitch = firstChild(child, 'pitch');
                        const graceMidi = gracePitch ? midiFromPitch(gracePitch) : null;
                        if (graceMidi !== null) {
                            const figure = graceFigureOf(graceEl);
                            events.push({
                                k: 'grace',
                                rel: cursor,
                                midi: graceMidi,
                                staff: childInt(child, 'staff') ?? 1,
                                slash: figure.slash,
                                stealPrevious: figure.stealPrevious,
                                stealFollowing: figure.stealFollowing,
                            });
                        }
                        break;
                    }
                    const isChord = firstChild(child, 'chord') !== null;
                    const durTicks = ticksOf(childInt(child, 'duration') ?? 0, divisions);
                    const start = isChord ? lastNoteStart : cursor;
                    const isRest = firstChild(child, 'rest') !== null;

                    const noteStaff = childInt(child, 'staff') ?? 1;
                    let arts = lastArts.get(noteStaff) ?? PLAIN_ART;
                    let arp = lastArp.get(noteStaff);
                    if (!isChord) {
                        // A slur's LAST note is its release, so it is not "under"
                        // the slur for gating — that is what lets a phrase end.
                        const slurs = slurTypesOf(child);
                        const starts = slurs.filter((t) => t === 'start').length;
                        const stops = slurs.filter((t) => t === 'stop').length;
                        const depth = slurDepth.get(noteStaff) ?? 0;
                        const underSlur = (depth > 0 || starts > 0) && stops === 0;
                        slurDepth.set(noteStaff, Math.max(0, depth + starts - stops));
                        arts = articulationOf(markNames(child, 'articulations'), underSlur);
                        arp = arpeggiateOf(child);
                        // Chord members carry the marking of the note they hang off.
                        lastArts.set(noteStaff, arts);
                        lastArp.set(noteStaff, arp);
                    }

                    if (!isRest && durTicks > 0) {
                        const pitch = firstChild(child, 'pitch');
                        const midi = pitch ? midiFromPitch(pitch) : null;
                        if (midi !== null) {
                            const tieTypes = childElements(child, 'tie').map((tie) => tie.getAttribute('type'));
                            const ornament = ornamentOf(child);
                            events.push({
                                k: 'note',
                                rel: start,
                                dur: durTicks,
                                midi,
                                staff: noteStaff,
                                voice: childText(child, 'voice') ?? '1',
                                chord: isChord,
                                tieStart: tieTypes.includes('start'),
                                tieStop: tieTypes.includes('stop'),
                                arts,
                                fermata: child.getElementsByTagName('fermata').length > 0,
                                ...(ornament ? { ornament } : {}),
                                ...(arp ? { arpeggiate: arp } : {}),
                            });
                        }
                    }
                    if (!isChord) {
                        lastNoteStart = start;
                        cursor += durTicks;
                        maxCursor = Math.max(maxCursor, cursor);
                    }
                    break;
                }
                default:
                    break;
            }
        }

        const numberAttr = measure.getAttribute('number');
        const parsedNumber = numberAttr ? Number.parseInt(numberAttr, 10) : NaN;
        const displayNumber: number = Number.isFinite(parsedNumber) ? parsedNumber : (runningNumber ?? 0) + 1;
        runningNumber = displayNumber;

        raws.push({
            index,
            n: displayNumber,
            isPickup: measure.getAttribute('implicit') === 'yes' || displayNumber === 0,
            contentTicks: maxCursor,
            sig: { ...currentSig },
            events,
            repeat,
        });
    }

    return raws;
};

/** Notated bar length of a signature, in ticks. */
const barTicksOf = (sig: { num: number; den: number }): number =>
    Math.max(1, Math.round(sig.num * ((TICKS_PER_QUARTER * 4) / sig.den)));

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Ratios a time-signature misread actually produces (9/8 read as 6/8, 4/4 as
 * 2/4, …). A disagreement that is not one of these is far likelier to be
 * damaged bars than a wrong signature, so we refuse to act on it.
 */
const METER_RATIOS: ReadonlyArray<readonly [number, number]> = [
    [3, 2],
    [2, 3],
    [2, 1],
    [1, 2],
    [4, 3],
    [3, 4],
];

const MAX_METER_NUM = 32;
const VALID_DENOMINATORS = new Set([1, 2, 4, 8, 16]);

/** Apply a ratio to a signature, preferring to move the numerator. */
const resignature = (
    sig: { num: number; den: number },
    rn: number,
    rd: number,
): { num: number; den: number } | null => {
    if ((sig.num * rn) % rd === 0) {
        const num = (sig.num * rn) / rd;
        if (num > 0 && num <= MAX_METER_NUM) {
            return { num, den: sig.den };
        }
    }
    if ((sig.den * rd) % rn === 0) {
        const den = (sig.den * rd) / rn;
        if (VALID_DENOMINATORS.has(den)) {
            return { num: sig.num, den };
        }
    }
    return null;
};

/** Effective signature for a contiguous run of measures sharing one declared one. */
interface MeterVerdict {
    /** Inclusive positions into the RawMeasure array. */
    from: number;
    to: number;
    sig: { num: number; den: number };
    corrected: boolean;
}

const MIN_METER_VOTES = 8;
/** A correct signature is rarely exceeded by a quarter of its own bars. */
const MIN_OVER_SHARE = 0.25;
/** The over-length bars must cluster, not scatter. */
const MIN_OVER_MODAL_COUNT = 6;

/**
 * Decide what signature a span of measures is really in.
 *
 * The discriminator is deliberately NOT "the modal bar length disagrees with the
 * signature". Measured on Schubert D. 780 No. 2 — printed 9/8, read by Audiveris
 * as 6/8 — the span's 94 bars split 49 longer than the declared 1440 ticks, 35
 * at exactly 1440, 9 shorter, with only 18 at the true 2160. The mode is
 * therefore the WRONG length, because OMR under-reads far more bars than it
 * over-reads; a modal test would leave that movement broken.
 *
 * What is distinctive is the over-length population. Dropping notes shortens a
 * bar, so a genuinely correct signature is seldom exceeded; a wrong one is
 * exceeded constantly, and those excesses cluster at the true bar length.
 */
const judgeSpan = (raws: readonly RawMeasure[], from: number, to: number, warnings: Set<string>): MeterVerdict => {
    const declared = raws[from]?.sig ?? { num: 4, den: 4 };
    const fallback: MeterVerdict = { from, to, sig: declared, corrected: false };
    const expected = barTicksOf(declared);

    // Pickups are legitimately short, and so is the final bar of a part.
    const votes: number[] = [];
    for (let i = from; i <= to; i++) {
        const raw = raws[i];
        if (!raw || raw.isPickup || raw.contentTicks <= 0 || i === raws.length - 1) {
            continue;
        }
        votes.push(raw.contentTicks);
    }
    const n = votes.length;
    if (n < MIN_METER_VOTES) {
        return fallback;
    }

    const over = votes.filter((v) => v > expected);
    const exact = votes.filter((v) => v === expected).length;
    if (over.length / n < MIN_OVER_SHARE || over.length <= exact) {
        return fallback;
    }

    // Modal length among the over-length bars — the candidate true bar length.
    const counts = new Map<number, number>();
    for (const v of over) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let modal = 0;
    let modalCount = 0;
    for (const [len, count] of counts) {
        if (count > modalCount || (count === modalCount && len < modal)) {
            modalCount = count;
            modal = len;
        }
    }

    const g = gcd(modal, expected);
    const rn = modal / g;
    const rd = expected / g;
    const known = METER_RATIOS.some(([a, b]) => a === rn && b === rd);
    const corrected = modalCount >= MIN_OVER_MODAL_COUNT && known ? resignature(declared, rn, rd) : null;

    if (!corrected) {
        // Noticed and did not act — worth far more to the reader than silence.
        warnings.add('meter_suspect');
        return fallback;
    }
    warnings.add('meter_corrected');
    return { from, to, sig: corrected, corrected: true };
};

/**
 * Split a part into contiguous runs sharing a declared signature and judge each.
 * Correction only ever changes a bar's LENGTH, never the bar count — that is
 * what keeps buildScoreData's positional measure↔geometry zip valid.
 */
const reconcileMeter = (raws: readonly RawMeasure[], warnings: Set<string>): MeterVerdict[] => {
    const verdicts: MeterVerdict[] = [];
    if (raws.length === 0) {
        return verdicts;
    }
    let from = 0;
    for (let i = 1; i <= raws.length; i++) {
        const prev = raws[i - 1]?.sig;
        const cur = raws[i]?.sig;
        if (prev && cur && cur.num === prev.num && cur.den === prev.den) {
            continue;
        }
        verdicts.push(judgeSpan(raws, from, i - 1, warnings));
        from = i;
    }
    return verdicts;
};

/** Per-measure effective signature, expanded from the span verdicts. */
const effectiveSigs = (raws: readonly RawMeasure[], verdicts: readonly MeterVerdict[]) => {
    const sigs = raws.map((raw) => raw.sig);
    for (const verdict of verdicts) {
        for (let i = verdict.from; i <= verdict.to; i++) {
            sigs[i] = verdict.sig;
        }
    }
    return sigs;
};

export type TempoMark =
    | { tick: number; kind: 'abs'; bpm: number; src: 'sound' | 'metronome' | 'word' }
    | { tick: number; kind: 'rit' | 'accel'; amount: number }
    | { tick: number; kind: 'atempo' }
    | { tick: number; kind: 'step'; amount: number; becomesSteady: boolean };

/**
 * Turn tempo marks into a stepwise map.
 *
 * Gradual changes are pre-discretized here, one point per beat, rather than
 * represented as ramps in the schema. That keeps the reader's tick-to-seconds
 * conversion a plain prefix sum — exactly invertible, with no closed-form
 * integral to get wrong — and puts the only awkward arithmetic somewhere it can
 * be tested in isolation. At one point per beat the steps are inaudible.
 */
const resolveTempos = (
    marks: readonly TempoMark[],
    endTick: number,
    barTicksAt: (tick: number) => number,
    beatTicksAt: (tick: number) => number,
    warnings: Set<string>,
    seed: ParseSeed,
): ScoreTempo[] => {
    // A printed number anywhere in the movement beats a word everywhere in it.
    const hasPrinted = marks.some((m) => m.kind === 'abs' && m.src !== 'word');
    const usable = marks
        .filter((m) => !(m.kind === 'abs' && m.src === 'word' && hasPrinted))
        .slice()
        .sort((a, b) => a.tick - b.tick);
    if (usable.length === 0) {
        return [];
    }
    if (usable.some((m) => m.kind === 'abs' && m.src === 'word')) {
        warnings.add('tempo_inferred');
    }

    const out: ScoreTempo[] = [];
    const push = (tick: number, bpm: number, src?: ScoreTempo['src']): void => {
        const rounded = Math.round(Math.min(400, Math.max(10, bpm)));
        const last = out[out.length - 1];
        if (last && last.tick === tick) {
            last.bpm = rounded;
            return;
        }
        if (last && last.bpm === rounded) {
            return;
        }
        out.push({ tick, bpm: rounded, ...(src ? { src } : {}) });
    };

    let current: number | null = seed.tempoBpm;
    /** The last tempo that was actually printed — what "a tempo" returns to. */
    let steady: number | null = seed.steadyBpm;

    for (let i = 0; i < usable.length; i++) {
        const mark = usable[i];
        if (!mark) {
            continue;
        }
        if (mark.kind === 'abs') {
            push(mark.tick, mark.bpm, mark.src);
            current = mark.bpm;
            steady = mark.bpm;
            continue;
        }
        if (mark.kind === 'atempo') {
            if (steady !== null) {
                push(mark.tick, steady, 'ramp');
                current = steady;
            }
            continue;
        }
        if (current === null) {
            // A rit. before any tempo is known has nothing to bend.
            continue;
        }
        if (mark.kind === 'step') {
            const next = current * mark.amount;
            // A new steady is a printed-equivalent pulse (no src); a ritenuto is
            // a temporary step that `a tempo` cancels, so it wears 'ramp'.
            push(mark.tick, next, mark.becomesSteady ? undefined : 'ramp');
            current = next;
            if (mark.becomesSteady) {
                steady = next;
            }
            continue;
        }
        const next = usable[i + 1];
        const limit = mark.tick + GRADUAL_TEMPO_BARS * barTicksAt(mark.tick);
        const spanEnd = Math.min(endTick, limit, next ? next.tick : Number.POSITIVE_INFINITY);
        const step = Math.max(1, beatTicksAt(mark.tick));
        const from: number = current;
        const target: number = from * mark.amount;
        // Reach the target on the LAST beat inside the span, not at its edge:
        // a rit. is at its slowest just before the a tempo, and a point sitting
        // exactly on the next mark would be overwritten by it anyway.
        const reachBy = Math.max(step, spanEnd - mark.tick - step);
        for (let tick = mark.tick + step; tick < spanEnd; tick += step) {
            const progress = Math.min(1, (tick - mark.tick) / reachBy);
            push(tick, from + (target - from) * progress, 'ramp');
        }
        current = target;
    }
    return out;
};

/** Where a measure sits once padding is settled. */
interface MeasurePlacement {
    tick: number;
    dTicks: number;
    /** Ticks inserted after the real content — open ties stretch across it. */
    pad: number;
}

/**
 * Pad and lay out measures. Pure with respect to notes, so absolute ticks are
 * known before velocities are resolved — which is what lets dynamics be looked
 * up by musical position instead of by document order.
 */
const placeMeasures = (
    raws: readonly RawMeasure[],
    sigs: ReadonlyArray<{ num: number; den: number }>,
    ctx: PartContext,
): MeasurePlacement[] => {
    const out: MeasurePlacement[] = [];
    let measureStart = ctx.tickOffset;

    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        if (!raw) {
            continue;
        }
        const sig = sigs[pos] ?? raw.sig;
        if (ctx.timeline) {
            const slot = ctx.timeline[raw.index];
            if (slot) {
                measureStart = slot.tick;
            }
        }
        const expected = barTicksOf(sig);
        // Pickups stay content-length (MusicXML implicit / measure 0); other bars
        // snap underfull content up to the active signature so later ticks don't skew.
        const contentLen = raw.contentTicks;
        let length = contentLen;
        let pad = 0;
        if (ctx.timeline) {
            length = ctx.timeline[raw.index]?.dTicks ?? length;
            // Lead timeline may be longer after underfull padding — extend open
            // ties so secondary-part cross-bar ties still sound past the pad.
            if (length > contentLen) {
                pad = length - contentLen;
            }
        } else if (length <= 0) {
            length = expected;
        } else if (!raw.isPickup && length < expected) {
            pad = expected - length;
            ctx.warnings.add('measure_underfull');
            length = expected;
        } else if (!raw.isPickup && length > expected) {
            ctx.warnings.add('measure_overfull');
            // Keep content length so note onsets stay consistent with the timeline.
        }

        out.push({ tick: measureStart, dTicks: length, pad });
        measureStart += length;
    }
    return out;
};

/**
 * A staff's dynamic shape over time: `points` hold until the next one.
 * (`ramps` are filled in by hairpin interpolation.)
 */
export interface DynamicCurve {
    points: Array<{ tick: number; v: number }>;
    ramps: Array<{ from: number; to: number; vFrom: number; vTo: number }>;
}

const velocityAt = (curve: DynamicCurve | undefined, tick: number): number | undefined => {
    if (!curve) {
        return undefined;
    }
    for (const ramp of curve.ramps) {
        if (tick > ramp.from && tick < ramp.to && ramp.to > ramp.from) {
            const t = (tick - ramp.from) / (ramp.to - ramp.from);
            return roundVelocity(clampVelocity(ramp.vFrom + t * (ramp.vTo - ramp.vFrom)));
        }
    }
    let value: number | undefined;
    for (const point of curve.points) {
        if (point.tick > tick) {
            break;
        }
        value = point.v;
    }
    return value;
};

interface DynamicMark {
    tick: number;
    staff: EventStaff;
    /** Sustained level, or undefined for a bare sf-family accent. */
    v?: number;
    accent: boolean;
    wedge?: { dir: 'crescendo' | 'diminuendo' | 'stop'; num: number };
}

/** Value of the step-wise part of a curve at a tick — ramps not consulted. */
const pointValueAt = (points: ReadonlyArray<{ tick: number; v: number }>, tick: number): number | undefined => {
    let value: number | undefined;
    for (const point of points) {
        if (point.tick > tick) {
            break;
        }
        value = point.v;
    }
    return value;
};

/**
 * Turn one staff's wedge starts/stops into interpolated ramps.
 *
 * Ramps are linear in velocity. The engine already applies a v^1.6 gain curve,
 * so linear-in-v is perceptually convex — slow to bloom, then rushing — which is
 * how a crescendo actually feels. A second curve here would double-count it.
 */
const buildRamps = (
    curve: DynamicCurve,
    wedges: ReadonlyArray<{ tick: number; dir: 'crescendo' | 'diminuendo' | 'stop'; num: number }>,
    endTick: number,
    barTicksAt: (tick: number) => number,
): void => {
    const open = new Map<number, { tick: number; dir: 'crescendo' | 'diminuendo' }>();
    const spans: Array<{ from: number; to: number; dir: 'crescendo' | 'diminuendo' }> = [];

    for (const wedge of wedges) {
        const existing = open.get(wedge.num);
        if (existing && wedge.tick > existing.tick) {
            // A stop closes it; a fresh start on the same number implicitly does too.
            spans.push({ from: existing.tick, to: wedge.tick, dir: existing.dir });
            open.delete(wedge.num);
        }
        if (wedge.dir !== 'stop') {
            open.set(wedge.num, { tick: wedge.tick, dir: wedge.dir });
        }
    }
    for (const [, remaining] of open) {
        // Never engraved an end — a text "cresc." never has one. The next printed
        // dynamic finishes it, which is exactly what "p cresc. ——— f" means; only
        // when nothing follows does it fall back to a plain musical length.
        const arrival = curve.points.find((p) => p.tick > remaining.tick);
        const limit = remaining.tick + UNCLOSED_HAIRPIN_BARS * barTicksAt(remaining.tick);
        const to = Math.min(endTick, limit, arrival?.tick ?? Number.POSITIVE_INFINITY);
        if (to > remaining.tick) {
            spans.push({ from: remaining.tick, to, dir: remaining.dir });
        }
    }
    spans.sort((a, b) => a.from - b.from);

    for (const span of spans) {
        const vFrom = pointValueAt(curve.points, span.from) ?? DEFAULT_VELOCITY;
        const slack = Math.max(1, Math.floor(barTicksAt(span.to) / 2));

        // The classic "p [<<<] f" engraves the f at, or just past, the wedge end.
        const target: { tick: number; v: number } | undefined = curve.points.find(
            (p) => p.tick >= span.to && p.tick <= span.to + slack,
        );
        let rampEnd = span.to;
        let vTo: number;
        if (target) {
            // Run the ramp all the way into the printed dynamic, or the value
            // would snap back to vFrom in the gap between them.
            rampEnd = Math.max(span.to, target.tick);
            vTo = target.v;
        } else {
            const grown = vFrom * (span.dir === 'crescendo' ? HAIRPIN_GROWTH : HAIRPIN_DECAY);
            vTo = roundVelocity(
                span.dir === 'crescendo' ? clampVelocity(grown) : Math.max(HAIRPIN_FLOOR, clampVelocity(grown)),
            );
            // Materialise the arrival, so the very next note holds it instead of
            // snapping back to where the hairpin started.
            curve.points.push({ tick: span.to, v: vTo });
            curve.points.sort((a, b) => a.tick - b.tick);
        }
        if (rampEnd <= span.from) {
            continue;
        }

        // A dynamic printed inside the hairpin is a waypoint: lerp to it, then on.
        const waypoints = curve.points.filter((p) => p.tick > span.from && p.tick < rampEnd);
        let cursorTick = span.from;
        let cursorV = vFrom;
        for (const point of waypoints) {
            curve.ramps.push({ from: cursorTick, to: point.tick, vFrom: cursorV, vTo: point.v });
            cursorTick = point.tick;
            cursorV = point.v;
        }
        curve.ramps.push({ from: cursorTick, to: rampEnd, vFrom: cursorV, vTo });
    }
    curve.ramps.sort((a, b) => a.from - b.from);
};

interface DynamicsResolution {
    curves: Map<number, DynamicCurve>;
    /** `${staff}:${onsetTick}` for attacks a sf-family mark punches. */
    accents: Set<string>;
}

/**
 * The largest gap still unambiguously ONE gesture. Cross-staff marks are
 * engraved on the same beat but land on different voices, so OMR quantization
 * can offset them by a sixteenth. Not a full beat: in 2/4, a right-hand f on
 * beat 1 and a left-hand p on beat 2 is a real two-gesture reading.
 */
const momentWindow = (sig: { num: number; den: number }): number =>
    Math.max(60, Math.min(240, Math.floor(barTicksOf(sig) / 4)));

/**
 * Resolve printed dynamics into a per-staff curve.
 *
 * The hard part is not the lookup, it is deciding whether a mark belongs to one
 * hand or to the texture. Scoping strictly per staff would leave the left hand
 * silent-dynamics whenever Audiveris attributes everything to staff 1 — worse
 * than the bug being fixed. Deciding per event flaps: a bar with two marks goes
 * independent, the next bar's single mark broadcasts and clobbers what was just
 * established.
 *
 * So classify the PART once — a writer either distinguishes the hands or does
 * not — and, when it does, make independence sticky.
 */
const resolveDynamics = (
    raws: readonly RawMeasure[],
    placements: readonly MeasurePlacement[],
    sigs: ReadonlyArray<{ num: number; den: number }>,
    staffCount: number,
    warnings: Set<string>,
    seed: ParseSeed,
    tickOffset: number,
): DynamicsResolution => {
    const staves = Array.from({ length: Math.max(1, staffCount) }, (_, i) => i + 1);
    const curves = new Map<number, DynamicCurve>(staves.map((s) => [s, { points: [], ramps: [] }]));
    const accents = new Set<string>();

    const marks: Array<DynamicMark & { pos: number }> = [];
    const onsets = new Map<number, number[]>();
    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        const place = placements[pos];
        if (!raw || !place) {
            continue;
        }
        for (const ev of raw.events) {
            if (ev.k === 'dyn') {
                marks.push({ tick: place.tick + ev.rel, staff: ev.staff, v: ev.v, accent: false, pos });
            } else if (ev.k === 'accentDyn') {
                marks.push({
                    tick: place.tick + ev.rel,
                    staff: ev.staff,
                    ...(ev.toPiano ? { v: DYNAMIC_LEVELS['p'] } : {}),
                    accent: true,
                    pos,
                });
            } else if (ev.k === 'wedge') {
                marks.push({
                    tick: place.tick + ev.rel,
                    staff: ev.staff,
                    accent: false,
                    wedge: { dir: ev.dir, num: ev.num },
                    pos,
                });
            } else if (ev.k === 'note') {
                const list = onsets.get(ev.staff) ?? [];
                list.push(place.tick + ev.rel);
                onsets.set(ev.staff, list);
            }
        }
    }
    if (marks.length === 0) {
        seedCurveStarts(curves, seed, tickOffset);
        return { curves, accents };
    }
    marks.sort((a, b) => a.tick - b.tick);
    for (const list of onsets.values()) {
        list.sort((a, b) => a - b);
    }

    // Tier 1 — does this writer distinguish the hands at all?
    const attributed = new Set<number>();
    for (const mark of marks) {
        if (mark.staff !== null) {
            attributed.add(mark.staff);
        }
    }
    const perStaff = attributed.size >= 2;
    if (!perStaff && staffCount >= 2 && marks.length >= 4) {
        // "All null" and "all on staff 1" are indistinguishable from a score with
        // one dynamic line, so broadcasting is the only safe reading — but say so.
        warnings.add('dynamics_not_staff_split');
    }

    /** Earliest attack at or just after a mark, so an accent lands on a real chord. */
    const attackAt = (staff: number, tick: number, window: number): number | null => {
        const list = onsets.get(staff);
        if (!list) {
            return null;
        }
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if ((list[mid] ?? 0) < tick) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        const found = list[lo];
        return found !== undefined && found - tick <= window ? found : null;
    };

    const wedges = new Map<number, Array<{ tick: number; dir: 'crescendo' | 'diminuendo' | 'stop'; num: number }>>(
        staves.map((s) => [s, []]),
    );

    const applyTo = (staff: number, mark: DynamicMark, window: number): void => {
        if (mark.v !== undefined) {
            curves.get(staff)?.points.push({ tick: mark.tick, v: mark.v });
        }
        if (mark.accent) {
            const onset = attackAt(staff, mark.tick, window);
            if (onset !== null) {
                accents.add(`${staff}:${onset}`);
            }
        }
        if (mark.wedge) {
            wedges.get(staff)?.push({ tick: mark.tick, dir: mark.wedge.dir, num: mark.wedge.num });
        }
    };

    /** Staves that have been given a dynamic of their own, and keep it. */
    const independent = new Set<number>();

    for (let i = 0; i < marks.length;) {
        const first = marks[i];
        if (!first) {
            break;
        }
        const window = momentWindow(sigs[first.pos] ?? raws[first.pos]?.sig ?? { num: 4, den: 4 });
        let j = i;
        while (j < marks.length && (marks[j]?.tick ?? 0) - first.tick <= window) {
            j += 1;
        }
        const moment = marks.slice(i, j);
        i = j;

        if (!perStaff) {
            for (const mark of moment) {
                for (const staff of staves) {
                    applyTo(staff, mark, window);
                }
            }
            continue;
        }

        const momentStaves = new Set(moment.filter((m) => m.staff !== null).map((m) => m.staff as number));
        const hasUnattributed = moment.some((m) => m.staff === null);

        if (hasUnattributed) {
            // In a file that attributes when it means to, an unattributed mark is
            // a whole-texture marking — it overrides an established separation.
            for (const mark of moment) {
                for (const staff of staves) {
                    applyTo(staff, mark, window);
                }
            }
            independent.clear();
            continue;
        }

        if (momentStaves.size >= 2) {
            for (const mark of moment) {
                applyTo(mark.staff as number, mark, window);
            }
            for (const staff of momentStaves) {
                independent.add(staff);
            }
            continue;
        }

        // One attributed staff. It applies there, and reaches any staff that has
        // not been given a dynamic of its own — so a later lone staff-1 ff does
        // not silently overwrite the left hand's established p.
        for (const mark of moment) {
            const own = mark.staff as number;
            applyTo(own, mark, window);
            for (const staff of staves) {
                if (staff !== own && !independent.has(staff)) {
                    applyTo(staff, mark, window);
                }
            }
        }
    }

    const last = placements[placements.length - 1];
    const endTick = last ? last.tick + last.dTicks : 0;
    const barTicksAt = (tick: number): number => {
        for (let pos = placements.length - 1; pos >= 0; pos--) {
            const place = placements[pos];
            if (place && place.tick <= tick) {
                return barTicksOf(sigs[pos] ?? raws[pos]?.sig ?? { num: 4, den: 4 });
            }
        }
        return barTicksOf(sigs[0] ?? { num: 4, den: 4 });
    };

    for (const curve of curves.values()) {
        curve.points.sort((a, b) => a.tick - b.tick);
    }
    seedCurveStarts(curves, seed, tickOffset);
    for (const [staff, curve] of curves) {
        buildRamps(curve, wedges.get(staff) ?? [], endTick, barTicksAt);
    }
    return { curves, accents };
};

/** Resume a staff's curve from a prior shard when this parse has no earlier point. */
const seedCurveStarts = (curves: Map<number, DynamicCurve>, seed: ParseSeed, tickOffset: number): void => {
    for (const [staff, curve] of curves) {
        const v = seed.velocityByStaff[staff];
        if (v === undefined) {
            continue;
        }
        if (pointValueAt(curve.points, tickOffset) === undefined) {
            curve.points.push({ tick: tickOffset, v });
            curve.points.sort((a, b) => a.tick - b.tick);
        }
    }
};

/**
 * Tempo and gradual marks sit on the timeline, not on notes, so they can be
 * gathered before anything is emitted — which is what lets a later pass ask
 * "what is the pulse at this tick" while crushing a grace or spelling a trill.
 */
const collectTempoMarks = (raws: readonly RawMeasure[], placements: readonly MeasurePlacement[]): TempoMark[] => {
    const marks: TempoMark[] = [];
    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        const place = placements[pos];
        if (!raw || !place) {
            continue;
        }
        for (const ev of raw.events) {
            if (ev.k === 'tempo') {
                marks.push({ tick: place.tick + ev.rel, kind: 'abs', bpm: ev.qbpm, src: ev.src });
            } else if (ev.k === 'gradual') {
                if (ev.kind === 'rit' || ev.kind === 'accel') {
                    marks.push({ tick: place.tick + ev.rel, kind: ev.kind, amount: ev.amount });
                } else if (ev.kind === 'step') {
                    marks.push({
                        tick: place.tick + ev.rel,
                        kind: 'step',
                        amount: ev.amount,
                        becomesSteady: ev.becomesSteady,
                    });
                } else {
                    marks.push({ tick: place.tick + ev.rel, kind: 'atempo' });
                }
            }
        }
    }
    return marks;
};

/**
 * Pass 2 — assign absolute ticks, merge ties, pad, and resolve velocities.
 * Events are walked in document order, which is what dynamics currently key off;
 * their `rel` positions are carried through so that resolution can move to a
 * (tick, staff) lookup without touching the scanner again.
 */
const placeAndEmit = (raws: readonly RawMeasure[], ctx: PartContext): PartResult => {
    const notes: ScoreNote[] = [];
    const measures: Array<{ n: number; tick: number; dTicks: number }> = [];
    const timeSignatures: ScoreTimeSig[] = [];
    const keySignatures: ScoreKeySig[] = [];
    const clefs: ScoreClef[] = [];
    const holds: ScoreHold[] = [];
    const pedals: ScorePedal[] = [];

    /** Grace notes buffered until their principal note arrives. */
    let pendingGraces: Array<{ midi: number; hand: 0 | 1; slash: boolean }> = [];
    /** Ties still waiting for their stop, keyed by staff:voice:midi. */
    const openTies = new Map<string, ScoreNote>();
    let arpBuffer: ScoreNote[] = [];
    let arpDirection: 'up' | 'down' | null = null;
    let swing = false;

    // Secondary parts take their barlines from the lead, so only the lead's
    // signatures are worth second-guessing.
    const sigs = ctx.timeline ? raws.map((raw) => raw.sig) : effectiveSigs(raws, reconcileMeter(raws, ctx.warnings));
    const placements = placeMeasures(raws, sigs, ctx);

    const lastPlace = placements[placements.length - 1];
    const endTick = lastPlace ? lastPlace.tick + lastPlace.dTicks : ctx.tickOffset;
    const sigAtTick = (tick: number): { num: number; den: number } => {
        for (let pos = placements.length - 1; pos >= 0; pos--) {
            if ((placements[pos]?.tick ?? 0) <= tick) {
                return sigs[pos] ?? { num: 4, den: 4 };
            }
        }
        return sigs[0] ?? { num: 4, den: 4 };
    };
    const tempoMarks = collectTempoMarks(raws, placements);
    const tempos = ctx.timeline
        ? []
        : resolveTempos(
              tempoMarks,
              endTick,
              (tick) => barTicksOf(sigAtTick(tick)),
              (tick) => Math.round((TICKS_PER_QUARTER * 4) / sigAtTick(tick).den),
              ctx.warnings,
              ctx.seed,
          );
    const pulseFallback = meterDefaultBpm(sigs[0] ?? { num: 4, den: 4 });
    const bpmAt = (tick: number): number => {
        let bpm: number | null = null;
        for (const entry of tempos) {
            if (entry.tick > tick) {
                break;
            }
            bpm = entry.bpm;
        }
        return bpm ?? ctx.seed.tempoBpm ?? pulseFallback;
    };

    const keyPoints: Array<{ tick: number; fifths: number }> = [];
    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        const place = placements[pos];
        if (!raw || !place) {
            continue;
        }
        for (const ev of raw.events) {
            if (ev.k === 'key') {
                keyPoints.push({ tick: place.tick, fifths: ev.fifths });
            }
        }
    }
    const fifthsAt = (tick: number): number => {
        let fifths = 0;
        for (const ks of keyPoints) {
            if (ks.tick > tick) {
                break;
            }
            fifths = ks.fifths;
        }
        return fifths;
    };

    const flushArp = (): void => {
        if (arpBuffer.length === 0) {
            return;
        }
        const t0 = arpBuffer[0]?.t;
        const realized = arpeggiateChord(arpBuffer, arpDirection ?? 'up');
        if (t0 !== undefined && realized.some((n) => n.t !== t0)) {
            ctx.warnings.add('ornaments_realized');
        }
        notes.push(...realized);
        arpBuffer = [];
        arpDirection = null;
    };

    let staffCount = 1;
    for (const raw of raws) {
        for (const ev of raw.events) {
            if (ev.k === 'note' && ev.staff > staffCount) {
                staffCount = ev.staff;
            }
        }
    }
    const { curves, accents } = resolveDynamics(
        raws,
        placements,
        sigs,
        staffCount,
        ctx.warnings,
        ctx.seed,
        ctx.tickOffset,
    );
    const curveFor = (staff: number): DynamicCurve | undefined => curves.get(staff) ?? curves.get(1);

    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        const place = placements[pos];
        if (!raw || !place) {
            continue;
        }
        const sig = sigs[pos] ?? raw.sig;
        const measureStart = place.tick;

        for (const ev of raw.events) {
            switch (ev.k) {
                case 'time': {
                    if (!ctx.timeline) {
                        // Publish the RECONCILED signature, never both it and the
                        // declared one — the client clicks its metronome and counts
                        // its count-in off this, and 6/8 against a 9/8 timeline is
                        // worse than either alone.
                        const last = timeSignatures[timeSignatures.length - 1];
                        if (!last || last.num !== sig.num || last.den !== sig.den) {
                            timeSignatures.push({ tick: measureStart, num: sig.num, den: sig.den });
                        }
                    }
                    break;
                }
                case 'key': {
                    if (!ctx.timeline) {
                        const last = keySignatures[keySignatures.length - 1];
                        if (!last || last.fifths !== ev.fifths) {
                            keySignatures.push({ tick: measureStart, fifths: ev.fifths });
                        }
                    }
                    break;
                }
                case 'clef': {
                    if (!ctx.timeline) {
                        const last = [...clefs].reverse().find((c) => c.staff === ev.staff);
                        if (!last || last.sign !== ev.sign || last.line !== ev.line) {
                            clefs.push({ tick: measureStart, staff: ev.staff, sign: ev.sign, line: ev.line });
                        }
                    }
                    break;
                }
                case 'tempo':
                case 'gradual':
                    // Collected in the pre-pass so the map exists before notes emit.
                    break;
                case 'pedal': {
                    // A release written after the bar's last note sits exactly on
                    // the next bar's downbeat, which hands it to whatever follows
                    // — so a performed repeat leaves the pedal down for both
                    // passes. Hold the RELEASE inside the bar it was engraved
                    // in; one tick at 480 per quarter is nothing to the ear.
                    // Only the release: a depression or re-catch taken at the
                    // bar line belongs to the exact beat it names — the engine
                    // reads a damper drop on the very tick a note ends as the
                    // pedal falling with the key, and pulling it a tick early
                    // would catch the note the change exists to clear.
                    const raw = measureStart + ev.rel;
                    const clamped = measureStart + Math.min(ev.rel, Math.max(0, place.dTicks - 1));
                    if (ev.kind === 'change') {
                        // A re-catch: the dampers drop and the pedal is taken
                        // again on the same beat, which is the whole point of the
                        // marking — it is what clears the previous harmony.
                        pedals.push({ tick: raw, k: 'up' }, { tick: raw, k: 'down' });
                    } else {
                        pedals.push({ tick: ev.kind === 'up' ? clamped : raw, k: ev.kind });
                    }
                    break;
                }
                case 'dyn':
                case 'accentDyn':
                    // Already resolved into per-staff curves by musical position.
                    break;
                case 'swing':
                    swing = true;
                    break;
                case 'grace': {
                    // Buffer graces; they crush in just before their principal.
                    if (pendingGraces.length < 8) {
                        pendingGraces.push({
                            midi: ev.midi,
                            hand: ev.staff >= 2 ? 1 : ctx.fallbackHand,
                            slash: ev.slash,
                        });
                    }
                    break;
                }
                case 'note': {
                    const start = measureStart + ev.rel;
                    const hand: 0 | 1 = ev.staff >= 2 ? 1 : ctx.fallbackHand;
                    const tieKey = `${ev.staff}:${ev.voice}:${ev.midi}`;

                    // A tie-stop must continue a note of the same pitch that ends
                    // exactly where this one starts. Match by key first, but fall
                    // back on that musical adjacency — Audiveris renumbers voices
                    // across system breaks, and a missed merge re-attacks a held note.
                    const resolveOpenTie = (): string | null => {
                        if (openTies.has(tieKey)) {
                            return tieKey;
                        }
                        let crossStaff: string | null = null;
                        for (const [key, open] of openTies) {
                            const parts = key.split(':');
                            if (parts[2] !== String(ev.midi) || Math.abs(open.t + open.d - start) > 2) {
                                continue;
                            }
                            if (parts[0] === String(ev.staff)) {
                                return key;
                            }
                            crossStaff = crossStaff ?? key;
                        }
                        return crossStaff;
                    };

                    const openKey = ev.tieStop ? resolveOpenTie() : null;
                    if (openKey) {
                        const open = openTies.get(openKey);
                        if (open) {
                            open.d += ev.dur;
                            openTies.delete(openKey);
                            if (ev.tieStart) {
                                // Chain continues under this note's identity.
                                openTies.set(tieKey, open);
                            } else {
                                // A tie chain is one sounding event: gate it once,
                                // here, from the marking that closes it. Doing it
                                // per link would also corrupt resolveOpenTie above,
                                // which matches on where an open note ENDS.
                                open.d = gateDuration(open.d, ev.arts.gate);
                            }
                        }
                        break;
                    }

                    if (!ev.chord) {
                        flushArp();
                    }

                    const sustained = velocityAt(curveFor(ev.staff), start);
                    let principalStart = start;
                    let principalNotated = ev.dur;
                    if (!ev.chord && pendingGraces.length > 0) {
                        const bpm = bpmAt(start);
                        const graceV = roundVelocity(clampVelocity((sustained ?? DEFAULT_VELOCITY) * 0.8));
                        const accis = pendingGraces.filter((g) => g.slash);
                        const appogs = pendingGraces.filter((g) => !g.slash);
                        if (accis.length > 0) {
                            // Crush acciaccaturas just before this attack, stealing
                            // time from what came before (they may reach back across
                            // the barline — that's correct).
                            const gt = graceTicks(bpm, ev.dur);
                            accis.forEach((grace, i) => {
                                notes.push({
                                    t: Math.max(ctx.tickOffset, start - gt * (accis.length - i)),
                                    d: gt,
                                    p: grace.midi,
                                    h: grace.hand,
                                    v: graceV,
                                });
                            });
                        }
                        if (appogs.length > 0) {
                            const steal = appoggiaturaSteal(ev.dur);
                            let t = start;
                            let remaining = steal;
                            appogs.forEach((grace, i) => {
                                const d =
                                    i === appogs.length - 1 ? remaining : Math.floor(remaining / (appogs.length - i));
                                notes.push({ t, d, p: grace.midi, h: grace.hand, v: graceV });
                                t += d;
                                remaining -= d;
                            });
                            principalStart = start + steal;
                            principalNotated = Math.max(1, ev.dur - steal);
                        }
                        pendingGraces = [];
                    }
                    // Velocity is now a pure function of (staff, tick), so every
                    // member of a chord gets the same value for free. An sf-family
                    // direction and a printed accent on the same attack take the
                    // LARGER boost, never the sum — stacking them overshoots.
                    const boost = Math.max(accents.has(`${ev.staff}:${start}`) ? 0.2 : 0, ev.arts.boost);
                    const velocity =
                        boost > 0 ? roundVelocity(clampVelocity((sustained ?? DEFAULT_VELOCITY) + boost)) : sustained;
                    const note: ScoreNote = {
                        t: principalStart,
                        // Held notes are gated when their chain closes, not here.
                        d: ev.tieStart ? principalNotated : gateDuration(principalNotated, ev.arts.gate),
                        p: ev.midi,
                        h: hand,
                        ...(velocity !== undefined ? { v: velocity } : {}),
                    };
                    // A tie chain is one sounding event: skip ornaments on tied notes
                    // rather than spelling them on a length we do not yet know.
                    let emitted: ScoreNote[] = [note];
                    if (ev.ornament && !ev.tieStart && !ev.tieStop) {
                        emitted = realizeOrnament(note, ev.ornament.kind, {
                            fifths: fifthsAt(principalStart),
                            bpm: bpmAt(principalStart),
                            accidentalMark: ev.ornament.accidentalMark,
                        });
                        if (emitted.length > 1) {
                            ctx.warnings.add('ornaments_realized');
                        }
                    }
                    if (ev.arpeggiate) {
                        arpDirection = arpDirection ?? ev.arpeggiate;
                        arpBuffer.push(...emitted);
                    } else {
                        notes.push(...emitted);
                    }
                    if (ev.fermata) {
                        // Hold on ARRIVING at the onset, so the note itself still
                        // starts on time and everything sounding across it rings on.
                        holds.push({ tick: start, beats: Math.min(4, Math.max(0.5, ev.dur / TICKS_PER_QUARTER)) });
                    }
                    if (ev.tieStart) {
                        openTies.set(tieKey, note);
                    }
                    break;
                }
                default:
                    break;
            }
        }

        flushArp();

        // Extend open ties across inserted padding so a tie-stop in the next bar
        // still lands after the real sounding content, not inside the pad.
        if (place.pad > 0) {
            for (const open of openTies.values()) {
                open.d += place.pad;
            }
        }

        measures.push({ n: raw.n, tick: place.tick, dTicks: place.dTicks });
    }

    // A tie whose stop was never engraved never reached its gating point. Close
    // it out with the plain gate so it does not sound longer than its neighbours.
    for (const open of openTies.values()) {
        open.d = gateDuration(open.d, GATE_DEFAULT);
    }

    if (pendingGraces.length > 0) {
        // Graces with no principal note to attach to (OMR tail damage).
        ctx.warnings.add('grace_notes_skipped');
    }

    if (timeSignatures.length === 0 && !ctx.timeline) {
        const finalSig = sigs[sigs.length - 1] ?? { num: 4, den: 4 };
        timeSignatures.push({ tick: ctx.tickOffset, num: finalSig.num, den: finalSig.den });
    }

    // Nothing printed a number, nothing printed a word: the meter is the last
    // evidence there is. Deliberately NOT a tempos[] entry — deployed clients
    // validate that array against a closed `src` enum and would reject the whole
    // score over a new value, so a guess this weak travels as defaultBpm plus a
    // warning, which every version of the client already tolerates. Concatenated
    // movements re-emit it as a src-less tempos[] point in parseMxlFiles, so a
    // later movement does not inherit the previous one's ritardando floor.
    const meterDefault = meterDefaultBpm(timeSignatures[0] ?? sigs[0] ?? { num: 4, den: 4 });
    let defaultBpm = tempos[0]?.bpm ?? null;
    if (defaultBpm === null && !ctx.timeline) {
        defaultBpm = meterDefault;
        ctx.warnings.add('tempo_defaulted');
    }

    // Dedupe holds: a fermata over a chord is one pause, not one per note.
    const holdByTick = new Map<number, ScoreHold>();
    for (const hold of holds) {
        const existing = holdByTick.get(hold.tick);
        if (!existing || hold.beats > existing.beats) {
            holdByTick.set(hold.tick, hold);
        }
    }

    return {
        notes,
        measures,
        timeSignatures,
        keySignatures,
        clefs,
        tempos,
        holds: [...holdByTick.values()].sort((a, b) => a.tick - b.tick),
        // Pedal, like tempo, is state the lead part owns: a secondary part snaps
        // to the lead's timeline and would only ever restate it.
        pedals: ctx.timeline ? [] : pedals,
        repeats: raws.map((raw) => raw.repeat),
        defaultBpm,
        openTiesAtEnd: openTies.size,
        tempoMarks: ctx.timeline ? [] : tempoMarks,
        dynamicCurves: [...curves.entries()].map(([staff, curve]) => ({ staff, ...curve })),
        meterDefaultBpm: meterDefault,
        swing,
    };
};

const parsePart = (part: Elem, ctx: PartContext): PartResult => placeAndEmit(scanPart(part), ctx);

/**
 * Expression in force at `tick`: last resolved tempo, last non-ramp (steady)
 * tempo, and each staff's curve value. Used to seed the second shard of a
 * split score so rit./a tempo/dynamics survive the page cut.
 */
export const expressionSeedAt = (musical: MusicalScore, tick: number): ParseSeed => {
    let tempoBpm: number | null = null;
    let steadyBpm: number | null = null;
    for (const entry of musical.tempos) {
        if (entry.tick > tick) {
            continue;
        }
        tempoBpm = entry.bpm;
        if (entry.src !== 'ramp') {
            steadyBpm = entry.bpm;
        }
    }
    const velocityByStaff: Record<number, number> = {};
    for (const curve of musical.dynamicCurves ?? []) {
        const v = velocityAt(curve, tick);
        if (v !== undefined) {
            velocityByStaff[curve.staff] = v;
        }
    }
    return { tempoBpm, steadyBpm, velocityByStaff };
};

const ticksOf = (duration: number, divisions: number): number =>
    Math.max(0, Math.round((duration * TICKS_PER_QUARTER) / Math.max(1, divisions)));

/** Quarters spanned by a MusicXML <beat-unit> (+ optional <beat-unit-dot>s). */
const BEAT_UNIT_QUARTERS: Record<string, number> = {
    whole: 4,
    half: 2,
    quarter: 1,
    eighth: 0.5,
    '16th': 0.25,
    '32nd': 0.125,
    '64th': 0.0625,
    '128th': 0.03125,
};

const beatUnitToQuarters = (metronome: Elem | null): number => {
    if (!metronome) {
        return 1;
    }
    const unit = (childText(metronome, 'beat-unit') ?? 'quarter').toLowerCase();
    let factor = BEAT_UNIT_QUARTERS[unit] ?? 1;
    let add = factor / 2;
    for (let i = 0; i < childElements(metronome, 'beat-unit-dot').length; i++) {
        factor += add;
        add /= 2;
    }
    return factor;
};

/**
 * Parse one or more exported .mxl files (Audiveris writes one per detected
 * movement) into a single tick-continuous MusicalScore.
 */
export const parseMxlFiles = (files: Buffer[], seed: ParseSeed = EMPTY_SEED): MusicalScore => {
    if (files.length === 0) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No MusicXML produced');
    }
    const combined: MusicalScore = {
        notes: [],
        measures: [],
        timeSignatures: [],
        keySignatures: [],
        clefs: [],
        tempos: [],
        holds: [],
        pedals: [],
        repeats: [],
        defaultBpm: null,
        totalTicks: 0,
        warnings: [],
        openTiesAtEnd: 0,
        tempoMarks: [],
        dynamicCurves: [],
        swing: false,
    };
    const warnings = new Set<string>();
    // Whether the movement whose `defaultBpm` survives is the one that guessed
    // it from the meter. `tempo_defaulted` describes the opening of the whole
    // score: a second movement that prints no heading of its own has its guess
    // thrown away below, so its disclosure would only contradict the first
    // movement's printed tempo.
    let defaultedAtOpening = false;
    for (const [index, file] of files.entries()) {
        const tickOffset = combined.totalTicks;
        // A later movement is a new piece — never resume the previous movement's
        // ritardando floor. Only the first file of a shard carries the seed.
        const parsed = parseMusicXmlString(extractMxl(file), tickOffset, index === 0 ? seed : EMPTY_SEED);
        combined.notes.push(...parsed.notes);
        combined.measures.push(...parsed.measures);
        combined.timeSignatures.push(...parsed.timeSignatures);
        combined.keySignatures.push(...parsed.keySignatures);
        combined.clefs.push(...parsed.clefs);
        // A heading-less movement has no tempos[] entry at its first tick, so
        // without a point here it would inherit the previous movement's last
        // pulse — including a ritardando floor. Re-emit the meter default the
        // parser already computed, with no `src` (the client enum is closed).
        const startTick = parsed.measures[0]?.tick ?? tickOffset;
        const hasOpeningTempo = parsed.tempos.some((t) => t.tick <= startTick);
        // The opening of the whole score still travels as defaultBpm: a src-less
        // point at tick 0 would look printed to the client and hide the guess.
        if (!hasOpeningTempo && parsed.meterDefaultBpm !== undefined && tickOffset > 0) {
            combined.tempos.push({ tick: startTick, bpm: parsed.meterDefaultBpm });
        }
        combined.tempos.push(...parsed.tempos);
        combined.holds.push(...parsed.holds);
        combined.pedals = [...(combined.pedals ?? []), ...(parsed.pedals ?? [])];
        combined.repeats.push(...parsed.repeats);
        combined.tempoMarks = [...(combined.tempoMarks ?? []), ...(parsed.tempoMarks ?? [])];
        combined.dynamicCurves = [...(combined.dynamicCurves ?? []), ...(parsed.dynamicCurves ?? [])];
        if (combined.defaultBpm === null && parsed.defaultBpm !== null) {
            combined.defaultBpm = parsed.defaultBpm;
            defaultedAtOpening = parsed.warnings.includes('tempo_defaulted');
            combined.meterDefaultBpm = parsed.meterDefaultBpm;
        }
        combined.totalTicks = parsed.totalTicks;
        combined.openTiesAtEnd = parsed.openTiesAtEnd;
        combined.swing = combined.swing || parsed.swing;
        parsed.warnings.forEach((warning) => {
            if (warning !== 'tempo_defaulted') {
                warnings.add(warning);
            }
        });
    }
    if (defaultedAtOpening) {
        warnings.add('tempo_defaulted');
    }
    if (files.length > 1) {
        warnings.add('multiple_movements_concatenated');
    }
    combined.warnings = [...warnings];
    combined.notes.sort((a, b) => a.t - b.t || a.h - b.h || a.p - b.p);
    return combined;
};
