import { barTicks, beatWeight, beatsForMeasure, timeSigAt } from '@/features/playback/scoreTime';
import { DEFAULT_VELOCITY, HAND_LH, HAND_RH } from '@/types/scoreData';
import type { ScoreData, ScoreNote, ScorePedal } from '@/types/scoreData';

export { DOWNBEAT_ACCENT } from '@/features/playback/scoreTime';

/**
 * The pure half of expressive playback: every curve that turns a velocity, a
 * pitch, or a note's place in a chord into something the audio graph can apply.
 * DOM-free and side-effect free (scoreTime.ts discipline), so the engine and the
 * one-shot audition share one definition of "how loud is mezzo-forte" and so
 * each curve can be pinned to exact numbers in tests without an AudioContext.
 */

/** Span from the quietest playable velocity to the loudest, in decibels. */
export const DYN_RANGE_DB = 36;
/** Linear gain a note carrying the score's default velocity plays at. */
export const DYN_REF_GAIN = 0.5;

/** Fraction of each hand bus fed to the reverb; the dry path is untouched. */
export const REVERB_WET = 0.22;
/** T60 of the synthesized impulse: a small hall, not a cathedral. */
export const REVERB_SECONDS = 1.8;
/** Shorter T60 on machines that cannot afford the full tail. */
export const REVERB_SECONDS_LOW_POWER = 1.2;
/** Silence before the tail begins — the ear reads this as room size. */
export const REVERB_PREDELAY_MS = 15;
/** Fixed seed so every engine instance renders the same room. */
export const REVERB_SEED = 0x52455642;

/**
 * Sympathetic string bloom while the dampers are up. A real piano does not
 * only lengthen notes under the pedal — the undamped strings speak with
 * whatever was just struck, a short bright halo rather than another room.
 */
export const RESONANCE_WET = 0.16;
/** T60 of the bloom — strings, not a hall. */
export const RESONANCE_SECONDS = 0.6;
/** Almost no predelay: the undamped strings speak with the hammer, not after it. */
export const RESONANCE_PREDELAY_MS = 4;
/** Fixed seed so every engine instance blooms the same. */
export const RESONANCE_SEED = 0x52534e43;
/** Time constant for the send to open and close — a foot, not a switch. */
export const RESONANCE_RAMP_S = 0.03;
/** How far the bloom's one-pole floor is raised toward remaining open. */
const RESONANCE_BRIGHTNESS = 0.55;

/**
 * Humanization amounts. The timing figure is deliberately far below the 25 ms
 * attack-lag ceiling the sampler corrects for: this is a practice app, and a
 * player following the metronome must never be able to hear the engine drift.
 */
export const JITTER_TIME_S = 0.005;
export const JITTER_VEL = 0.03;

/** Per-note delay inside a chord, lowest sounding note first. */
export const CHORD_ROLL_S = 0.004;
/** Ceiling on a roll — a ten-note chord must still land as one event. */
export const CHORD_ROLL_MAX_S = 0.012;
/** Velocity added to the highest sounding note when that note attacks, so the tune sings. */
export const MELODY_LIFT = 0.06;
/** Velocity taken off the other hand when it sounds under that melody note. */
export const ACCOMP_DIP = 0.02;
/** Velocity taken off a note whose onset sits between beats of a full bar. */
export const OFFBEAT_DIP = 0.01;

/** Floor for a humanized velocity: below this a note is inaudible, not quiet. */
export const MIN_VELOCITY = 0.05;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Keep a velocity that jitter and accents have moved inside the playable range. */
export const clampVelocity = (velocity: number): number => clamp(velocity, MIN_VELOCITY, 1);

/**
 * Velocity → linear gain across a fixed dB range, pinned so a note carrying the
 * score's default velocity plays at DYN_REF_GAIN.
 *
 * Working in decibels rather than in a power curve is what makes dynamics read
 * as dynamics: hairpins are interpolated linearly in velocity, so linear-in-dB
 * is a perceptually even crescendo, and pp lands ~15 dB under mf instead of the
 * ~5 dB a `v^1.6` curve gave it. ff and fff exceed unity gain on purpose — the
 * limiter at the end of the chain is what makes that safe, and clipping the
 * curve here instead would just flatten the top of the range again.
 */
export const velocityToGain = (velocity: number): number =>
    DYN_REF_GAIN * Math.pow(10, (DYN_RANGE_DB * (velocity - DEFAULT_VELOCITY)) / 20);

/**
 * Residual brightness correction now that hammer timbre comes from velocity
 * layers. At and above the soft layer (0.22) the samples already carry the
 * right spectrum, so the filter sits fully open at 16 kHz. Below that the
 * quietest layer is still a v4 hammer, and rolling the top off
 * (`800 · 20^(v / 0.22)`) is what keeps a pp from sounding like a muted mf.
 */
export const filterCutoffHz = (velocity: number): number => {
    const v = clamp(velocity, 0, 1);
    if (v >= 0.22) {
        return 16_000;
    }
    return 800 * Math.pow(20, v / 0.22);
};

/**
 * Release time constant after the key lifts. Bass strings carry far more energy
 * and keep ringing under the damper; treble notes stop almost at once. Velocity
 * scales it because a note struck hard has more left to shed.
 */
export const releaseTauFor = (midi: number, velocity: number): number =>
    (0.045 + 0.1 * clamp((60 - midi) / 36, 0, 1)) * (0.8 + 0.4 * clamp(velocity, 0, 1));

/**
 * Release time constant for a note the pedal is still holding when it ends.
 * Nothing touches the string here, so what is heard is the string's own decay
 * rather than a damper landing on it — far longer than any {@link releaseTauFor}
 * value, and flat across the keyboard because the pedal lifts every damper at
 * once. This is what makes a pedalled phrase pool instead of ending in a row
 * of clipped notes.
 */
export const PEDAL_RELEASE_TAU_S = 0.25;

/**
 * Stereo position from the keyboard's own geometry, heard from the bench:
 * bass to the left, treble to the right, middle C dead centre. Held to half
 * width because the samples are mono — panning them is a placement cue, and
 * pushing it further starts to sound like two pianos.
 */
export const panForMidi = (midi: number): number => clamp((midi - 60) / 30, -0.5, 0.5);

const splitmix32 = (seed: number): number => {
    let z = (seed + 0x9e3779b9) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
};

/** Hash word → [0, 1). */
const unitFrom = (hash: number): number => hash / 0x1_0000_0000;

/**
 * Deterministic [0, 1) stream from a seed, built on the same splitmix32 that
 * {@link noteJitter} uses. The reverb IR is the caller that needs this: a
 * fresh Math.random on every engine would make two plays of the same score
 * different rooms.
 */
export const seededUnitRng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = splitmix32(state);
        return unitFrom(state);
    };
};

export interface NoteJitter {
    /** Seconds to shift the attack by, within ±JITTER_TIME_S. */
    dt: number;
    /** Velocity offset, within ±JITTER_VEL. */
    dv: number;
}

/**
 * Per-note timing and loudness jitter, derived only from the note's identity.
 *
 * Purity here is a correctness requirement, not a style preference: the
 * scheduler re-walks the score from wherever the transport lands — a seek, a
 * resumed sustain, every loop wrap — and a note that jittered differently on
 * the second pass would flam against its own still-ringing tail and make the
 * loop seam audible. A random source, however well seeded, cannot survive that.
 */
export const noteJitter = (tick: number, pitch: number, hand: number): NoteJitter => {
    const seed =
        (Math.imul(tick | 0, 0x9e3779b1) ^ Math.imul(pitch | 0, 0x85ebca6b) ^ Math.imul((hand | 0) + 1, 0xc2b2ae35)) >>>
        0;
    const first = splitmix32(seed);
    const second = splitmix32(first);
    return {
        dt: (unitFrom(first) * 2 - 1) * JITTER_TIME_S,
        dv: (unitFrom(second) * 2 - 1) * JITTER_VEL,
    };
};

/** Minimal slice of AudioContext {@link buildReverbImpulse} needs (mockable). */
export interface ImpulseFactory {
    readonly sampleRate: number;
    createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
}

export interface ReverbOptions {
    /** T60 — seconds to decay by 60 dB. */
    seconds?: number;
    predelayMs?: number;
    /** Injectable noise source; tests need a reproducible tail. */
    rng?: () => number;
    /**
     * 0..1. Raises the one-pole lowpass floor so the tail keeps more high end.
     * 0 (default) eases the coefficient from 0.6 to 0.15 — the original room,
     * byte-identical. 1 leaves it at 0.6, so the tail never darkens. Linear
     * in between.
     */
    brightness?: number;
}

/**
 * A stereo impulse response synthesized at runtime: decaying noise, lowpassed
 * with a filter that closes as the tail develops, because air absorbs the high
 * end of a room's reflections faster than the low. Independent noise per
 * channel is what gives the result width from mono sources.
 *
 * Synthesizing beats shipping an IR file — no asset, no cache-busting, no
 * download on a connection that already paid for 0.85 MB of piano samples —
 * and the shape only has to be plausible, not any particular real hall.
 */
export const buildReverbImpulse = (ctx: ImpulseFactory, options: ReverbOptions = {}): AudioBuffer => {
    const seconds = options.seconds ?? REVERB_SECONDS;
    const predelayMs = options.predelayMs ?? REVERB_PREDELAY_MS;
    const rng = options.rng ?? Math.random;
    const brightness = options.brightness ?? 0;
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.round(seconds * rate));
    const predelay = Math.min(length, Math.max(0, Math.round((predelayMs / 1000) * rate)));
    const buffer = ctx.createBuffer(2, length, rate);
    const span = Math.max(1, length - predelay);
    // One-pole coefficient eases from open (0.6) toward a floor that brightness
    // raises: 0 keeps the original 0.15 close, 1 never closes at all.
    const open = 0.6;
    const closed = 0.15 + (0.6 - 0.15) * brightness;

    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        let lowpassed = 0;
        for (let i = predelay; i < length; i++) {
            const progress = (i - predelay) / span;
            const elapsed = (i - predelay) / rate;
            const white = rng() * 2 - 1;
            lowpassed += (open + (closed - open) * progress) * (white - lowpassed);
            data[i] = lowpassed * Math.pow(10, (-3 * elapsed) / seconds);
        }
    }
    return buffer;
};

/**
 * The pedal's own impulse: the room IR with a shorter T60, a shorter predelay,
 * and a brighter tail. Same factory so the two convolvers stay one shape of
 * decaying noise, just tuned for strings rather than air.
 */
export const buildResonanceImpulse = (ctx: ImpulseFactory, options: Pick<ReverbOptions, 'rng'> = {}): AudioBuffer =>
    buildReverbImpulse(ctx, {
        seconds: RESONANCE_SECONDS,
        predelayMs: RESONANCE_PREDELAY_MS,
        rng: options.rng,
        brightness: RESONANCE_BRIGHTNESS,
    });

/**
 * Whether the sustain pedal is holding at `tick`. Edges at the tick count —
 * a re-catch is an `up` then a `down` on one tick, in array order, so the
 * later `down` wins and the state is down. No edges, or none yet, is up.
 */
export const pedalStateAt = (pedals: readonly ScorePedal[] | undefined, tick: number): boolean => {
    if (!pedals || pedals.length === 0) {
        return false;
    }
    let down = false;
    for (const edge of pedals) {
        if (edge.tick > tick) {
            break;
        }
        down = edge.k === 'down';
    }
    return down;
};

/** Below this the soft clip is a straight wire; above it the knee bends. */
export const SOFTCLIP_KNEE = 0.8;
/** Hard ceiling after the knee — just under full scale so oversampling
 * interpolation cannot overshoot into the DAC's clamp. */
export const SOFTCLIP_CEILING = 0.995;

/**
 * Transfer curve for the output soft clip: identity up to the knee, then a
 * tanh that saturates below the ceiling. The limiter ahead of it is a
 * compressor whose 3 ms attack lets a piano's transient through untouched —
 * measured at 1.39× full scale for a ten-voice ff chord — so the true
 * ceiling has to be held by a memoryless stage that cannot be outrun.
 * Below the knee the curve is exactly linear (times the ceiling), so normal
 * material passes uncoloured.
 */
export const buildSoftClipCurve = (samples = 4096): Float32Array => {
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        const x = (i / (samples - 1)) * 2 - 1;
        const a = Math.abs(x);
        const shaped =
            a <= SOFTCLIP_KNEE
                ? a
                : SOFTCLIP_KNEE + (1 - SOFTCLIP_KNEE) * Math.tanh((a - SOFTCLIP_KNEE) / (1 - SOFTCLIP_KNEE));
        curve[i] = Math.sign(x) * shaped * SOFTCLIP_CEILING;
    }
    return curve;
};

export interface NoteShape {
    /** Seconds to delay this note's attack so its chord rolls upward. */
    roll: number;
    /** Velocity added because this note carries the melody. */
    lift: number;
    /**
     * Velocity offset from the note's place in the bar: a downbeat, a weaker
     * half-bar, or a small dip when the onset sits off the beat. May be negative.
     */
    accent: number;
    /** Velocity subtracted because this note is accompaniment under a melody. */
    dip: number;
}

const emptyShape = (): NoteShape => ({ roll: 0, lift: 0, accent: 0, dip: 0 });

interface ActiveNote {
    index: number;
    note: ScoreNote;
}

/** Drop notes whose written end has arrived — they are no longer sounding. */
const evictEnded = (active: ActiveNote[], tick: number): void => {
    let kept = 0;
    for (const entry of active) {
        if (tick < entry.note.t + entry.note.d) {
            active[kept] = entry;
            kept += 1;
        }
    }
    active.length = kept;
};

/**
 * One pass over the score at engine construction, deciding what each note owes
 * to its neighbours: a chord is rolled from the bottom up the way a hand
 * actually lands on it, and voicing looks at everything still sounding — a
 * held melody note stays the tune while the other hand's figure attacks under
 * it, so those attacks are dipped and not lifted. The highest sounding pitch
 * (right hand on a tie) is the melody; it is lifted only when it attacks in
 * this group. Notes take the weight of their beat, or a small dip when they
 * sit off it in a full bar. All of it is a function of the score alone, so —
 * like {@link noteJitter} — it survives seeks and loop wraps unchanged.
 *
 * The result is index-aligned with `score.notes`, which the scheduler already
 * walks by index.
 */
export const buildNoteShapes = (score: ScoreData): readonly NoteShape[] => {
    const notes = score.notes;
    const shapes: NoteShape[] = notes.map(emptyShape);

    // Beat ticks and their metrical weight, from the same beat grid the
    // metronome clicks. The click's boolean accent is unchanged; this map is
    // only how hard a note on that tick is struck.
    const weightAt = new Map<number, number>();
    const fullBars: Array<{ start: number; end: number }> = [];
    for (const measure of score.measures) {
        const sig = timeSigAt(score.timeSignatures, measure.tick);
        const isFullBar = measure.dTicks >= barTicks(sig);
        if (isFullBar) {
            fullBars.push({ start: measure.tick, end: measure.tick + measure.dTicks });
        }
        const beats = beatsForMeasure(measure, score.timeSignatures);
        for (let k = 0; k < beats.length; k++) {
            const beat = beats[k];
            if (beat) {
                weightAt.set(beat.tick, beatWeight(sig, k, isFullBar));
            }
        }
    }
    const inFullBar = (tick: number): boolean => fullBars.some((bar) => tick >= bar.start && tick < bar.end);

    // Sounding notes, not just attacks: a held RH under an Alberti figure is
    // still the tune. Notes are tick-sorted, so one active list per hand and a
    // sweep is enough — no scan of the whole score at each onset.
    const activeRh: ActiveNote[] = [];
    const activeLh: ActiveNote[] = [];

    let start = 0;
    while (start < notes.length) {
        const head = notes[start];
        if (!head) {
            break;
        }
        let end = start;
        while (end < notes.length && notes[end]?.t === head.t) {
            end += 1;
        }
        const tick = head.t;
        const weight = weightAt.get(tick);
        const accent = weight !== undefined ? weight : inFullBar(tick) ? -OFFBEAT_DIP : 0;

        evictEnded(activeRh, tick);
        evictEnded(activeLh, tick);
        for (let i = start; i < end; i++) {
            const note = notes[i];
            if (!note) {
                continue;
            }
            (note.h === HAND_RH ? activeRh : activeLh).push({ index: i, note });
        }

        let topPitch = -Infinity;
        let melodyHand: 0 | 1 = HAND_LH;
        let topIndex = -1;
        for (const { index, note } of [...activeRh, ...activeLh]) {
            if (note.p > topPitch || (note.p === topPitch && note.h === HAND_RH && melodyHand !== HAND_RH)) {
                topPitch = note.p;
                melodyHand = note.h;
                topIndex = index;
            }
        }
        const topAttacking = topIndex >= 0 && notes[topIndex]?.t === tick;
        if (topAttacking) {
            const topShape = shapes[topIndex];
            if (topShape) {
                topShape.lift = MELODY_LIFT;
            }
        }

        const bothHands = activeRh.length > 0 && activeLh.length > 0;
        for (const hand of [HAND_RH, HAND_LH] as const) {
            const group: Array<{ index: number; pitch: number }> = [];
            for (let i = start; i < end; i++) {
                const note = notes[i];
                if (note && note.h === hand) {
                    group.push({ index: i, pitch: note.p });
                }
            }
            group.sort((a, b) => a.pitch - b.pitch);
            group.forEach(({ index }, position) => {
                const shape = shapes[index];
                if (!shape) {
                    return;
                }
                shape.roll = Math.min(CHORD_ROLL_MAX_S, position * CHORD_ROLL_S);
                shape.accent = accent;
                if (bothHands && hand !== melodyHand) {
                    shape.dip = ACCOMP_DIP;
                }
            });
        }
        start = end;
    }
    return shapes;
};

/**
 * The tick each note actually stops sounding at, index-aligned with `notes`.
 * `pedals` must be in tick order, as parseScoreData leaves it. `totalTicks` is
 * the score's end, used as an implicit lift for a trailing `down` that never
 * got an `up` — a pedal held to the double bar, or an OMR pass that lost the
 * last lift — so the ending rings instead of damping at the written value.
 *
 * A damper held off the string by the pedal leaves a note ringing past the
 * length it was written at, which is the whole point of the pedal and the one
 * thing a note-plus-duration model cannot say on its own. `pedals` carries
 * edges rather than spans (see ScoreData.pedals), so the state has to be
 * integrated here; a note the pedal is not holding keeps its notated end.
 *
 * Two boundary readings carry the musical meaning, and both fall out of taking
 * only edges STRICTLY around the note's end. An 'up' printed on the very tick a
 * note ends damps it there, so a re-catch — 'up' then 'down' on one tick —
 * clears everything that was sounding and holds only what follows, the same
 * clearing a pianist's foot performs. And a 'down' printed on the tick a note
 * ends does NOT catch it: that is syncopated pedalling, where the foot falls
 * after the hand lifts precisely so the old harmony is let go.
 */
export const buildPedalEnds = (
    notes: readonly ScoreNote[],
    pedals: readonly ScorePedal[] | undefined,
    totalTicks: number,
): readonly number[] => {
    const ends = notes.map((note) => note.t + note.d);
    if (!pedals || pedals.length === 0) {
        return ends;
    }

    // Tick of the first lift at or after each position, so extending a note is a
    // lookup rather than a forward scan of the edges per note.
    const nextLift = new Array<number>(pedals.length + 1).fill(-1);
    for (let i = pedals.length - 1; i >= 0; i--) {
        nextLift[i] = pedals[i]?.k === 'up' ? (pedals[i]?.tick ?? -1) : (nextLift[i + 1] ?? -1);
    }

    // Note starts are sorted but note ends are not — a whole note and an eighth
    // can begin on the same tick — so the walk goes in end order. That keeps one
    // monotone pointer into the edges for the whole score rather than a scan of
    // them per note, which on a pedalled piece is the difference between one
    // pass and fifty thousand.
    const byEnd = ends.map((_, index) => index).sort((a, b) => (ends[a] ?? 0) - (ends[b] ?? 0));
    let cursor = 0;
    let down = false;
    for (const index of byEnd) {
        const end = ends[index] ?? 0;
        while (cursor < pedals.length && (pedals[cursor]?.tick ?? 0) < end) {
            down = pedals[cursor]?.k === 'down';
            cursor += 1;
        }
        if (!down) {
            continue;
        }
        // The next lift is at or after `end` by construction. One landing exactly
        // on it is the damper falling with the key; a trailing `down` with no
        // later `up` is an implicit lift at the score end. In both cases a lift
        // that is not strictly past `end` leaves the written length alone.
        const lift = nextLift[cursor] ?? -1;
        const releaseAt = lift === -1 ? totalTicks : lift;
        if (releaseAt > end) {
            ends[index] = releaseAt;
        }
    }
    return ends;
};
