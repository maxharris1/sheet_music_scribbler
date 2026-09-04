import { DEFAULT_VELOCITY } from './scoreData.js';
import type { ScoreNote } from './scoreData.js';

/** A 32nd note at 480 ticks per quarter. */
export const THIRTY_SECOND = 60;

export type OrnamentKind = 'trill' | 'mordent' | 'inverted-mordent' | 'turn' | 'inverted-turn';

export type AccidentalMark = 'sharp' | 'flat' | 'natural';

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

/** Pitch classes of the major scale whose key signature is `fifths`. */
const scalePitchClasses = (fifths: number): Set<number> => {
    const tonic = (((fifths * 7) % 12) + 12) % 12;
    return new Set(MAJOR_STEPS.map((step) => (tonic + step) % 12));
};

const nearestScaleTone = (midi: number, scale: Set<number>, dir: 1 | -1): number => {
    const pc = ((midi % 12) + 12) % 12;
    for (let delta = 1; delta <= 12; delta++) {
        const candidate = (pc + dir * delta + 12) % 12;
        if (scale.has(candidate)) {
            return midi + dir * delta;
        }
    }
    return midi + dir;
};

/**
 * Accidental-mark on an ornament overrides the UPPER neighbour only:
 * `sharp` raises a 1-semitone neighbour to 2; `flat` lowers a 2-semitone
 * neighbour to 1; `natural` (and anything else) leaves the computed tone.
 */
const applyAccidentalMark = (principal: number, upper: number, mark: AccidentalMark | undefined): number => {
    const interval = upper - principal;
    if (mark === 'sharp' && interval === 1) {
        return upper + 1;
    }
    if (mark === 'flat' && interval === 2) {
        return upper - 1;
    }
    return upper;
};

const clampMidi = (midi: number): number => Math.max(0, Math.min(127, midi));

const neighbours = (
    midi: number,
    fifths: number,
    accidentalMark?: AccidentalMark,
): { upper: number; lower: number } => {
    const scale = scalePitchClasses(fifths);
    const upper = applyAccidentalMark(midi, nearestScaleTone(midi, scale, 1), accidentalMark);
    const lower = nearestScaleTone(midi, scale, -1);
    return { upper: clampMidi(upper), lower: clampMidi(lower) };
};

const clone = (note: ScoreNote, over: Partial<ScoreNote>): ScoreNote => ({
    t: over.t ?? note.t,
    d: over.d ?? note.d,
    p: over.p ?? note.p,
    h: over.h ?? note.h,
    ...(over.v !== undefined ? { v: over.v } : note.v !== undefined ? { v: note.v } : {}),
});

const trillVelocity = (principal: ScoreNote): number =>
    Math.max(0.1, Math.round(((principal.v ?? DEFAULT_VELOCITY) - 0.05) * 100) / 100);

/**
 * Spell an engraved ornament as ordinary notes occupying the principal's
 * sounding span. Total ticks always equal `principal.d`. Short notes — too
 * brief to host the figure — come back unchanged.
 */
export const realizeOrnament = (
    principal: ScoreNote,
    kind: OrnamentKind,
    opts: { fifths: number; bpm: number; accidentalMark?: AccidentalMark },
): ScoreNote[] => {
    const { upper, lower } = neighbours(principal.p, opts.fifths, opts.accidentalMark);
    if (kind === 'trill') {
        return realizeTrill(principal, upper, opts.bpm);
    }
    if (kind === 'mordent') {
        return realizeMordent(principal, lower);
    }
    if (kind === 'inverted-mordent') {
        return realizeMordent(principal, upper);
    }
    if (kind === 'turn') {
        return realizeTurn(principal, upper, lower);
    }
    return realizeTurn(principal, lower, upper);
};

const realizeTrill = (principal: ScoreNote, upper: number, bpm: number): ScoreNote[] => {
    if (principal.d < 120) {
        return [principal];
    }
    // Below 90, a 32nd is a slow wobble (125 ms at 60 bpm); a 64th keeps the
    // figure sounding like a trill. Mordents and turns stay on 32nds.
    const unit = bpm < 90 ? 30 : THIRTY_SECOND;
    const altV = trillVelocity(principal);
    let units = Math.min(64, Math.floor(principal.d / unit));
    if (units < 2) {
        return [principal];
    }
    // Alternate principal / upper, starting on the principal. An even count
    // would end on the upper; drop that last upper so the final unit is the
    // principal, and give it any remainder of the sounding duration.
    if (units % 2 === 0) {
        units -= 1;
    }
    const out: ScoreNote[] = [];
    let t = principal.t;
    for (let i = 0; i < units; i++) {
        const isPrincipal = i % 2 === 0;
        const isLast = i === units - 1;
        const d = isLast ? principal.t + principal.d - t : unit;
        out.push(
            clone(principal, {
                t,
                d,
                p: isPrincipal ? principal.p : upper,
                ...(isPrincipal ? {} : { v: altV }),
            }),
        );
        t += d;
    }
    return out;
};

const realizeMordent = (principal: ScoreNote, neighbour: number): ScoreNote[] => {
    if (principal.d < 180) {
        return [principal];
    }
    return [
        clone(principal, { d: THIRTY_SECOND }),
        clone(principal, { t: principal.t + THIRTY_SECOND, d: THIRTY_SECOND, p: neighbour }),
        clone(principal, { t: principal.t + 2 * THIRTY_SECOND, d: principal.d - 2 * THIRTY_SECOND }),
    ];
};

const realizeTurn = (principal: ScoreNote, first: number, third: number): ScoreNote[] => {
    if (principal.d < 300) {
        return [principal];
    }
    const span = 4 * THIRTY_SECOND;
    const pitches = [first, principal.p, third, principal.p];
    const out = pitches.map((p, i) => clone(principal, { t: principal.t + i * THIRTY_SECOND, d: THIRTY_SECOND, p }));
    const rest = principal.d - span;
    if (rest > 0) {
        out.push(clone(principal, { t: principal.t + span, d: rest }));
    }
    return out;
};

/**
 * Spread a simultaneous chord in pitch order, one 32nd apart, each note still
 * ending where it originally ended. Too-short chords (or a lone note) stay put.
 */
export const arpeggiateChord = (notes: ScoreNote[], direction: 'up' | 'down'): ScoreNote[] => {
    if (notes.length < 2) {
        return notes;
    }
    const t0 = notes[0]?.t;
    if (t0 === undefined || notes.some((n) => n.t !== t0)) {
        return notes;
    }
    const count = notes.length;
    if (notes.some((n) => n.d <= THIRTY_SECOND * count)) {
        return notes;
    }
    const ordered = [...notes].sort((a, b) => (direction === 'up' ? a.p - b.p : b.p - a.p));
    return ordered.map((note, i) => {
        const t = t0 + i * THIRTY_SECOND;
        return clone(note, { t, d: note.t + note.d - t });
    });
};

/**
 * Crushed acciaccatura length, ≈80 ms at the sounding tempo.
 *
 * 80 ms in ticks is `80 * bpm * 480 / 60_000 = 0.64 * bpm`. The design note
 * wrote `bpm * 6.4`; at 120 that is 768, which the ceiling would clamp to 110,
 * but the required lengths are 77 ticks at 120 bpm and 38 at 60 bpm — so
 * the factor is 0.64, and 110 remains only the ceiling.
 */
export const graceTicks = (bpm: number, principalDur: number): number => {
    const hi = Math.max(30, Math.min(110, Math.floor(principalDur / 4)));
    const raw = Math.round(bpm * 0.64);
    return Math.max(30, Math.min(hi, raw));
};

/**
 * How much of a principal an appoggiatura steals. Dotted values are 3× a
 * binary duration in 60-tick units (a quarter is 8 such units, so it stays at
 * half even though 480 is divisible by 3 in raw ticks); those take two-thirds.
 */
export const appoggiaturaSteal = (notated: number): number => {
    const units = notated / THIRTY_SECOND;
    const dotted = Number.isInteger(units) && units % 3 === 0;
    const steal = dotted ? Math.round((notated * 2) / 3) : Math.round(notated / 2);
    return Math.max(1, Math.min(notated - 1, steal));
};
