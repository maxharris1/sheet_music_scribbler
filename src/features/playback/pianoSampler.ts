/**
 * Bundled piano voice: 29 Salamander Grand anchors (every minor third,
 * C1–C8) at three velocity layers, served from /audio/piano and pitch-shifted
 * at most ±1.5 semitones via playbackRate. Regenerate the files with
 * scripts/fetch-piano-samples.mjs (keep ANCHOR list and that script in sync).
 *
 * Sample credit: Salamander Grand Piano by Alexander Holm, CC BY 3.0.
 */

const NOTE_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'] as const;

const FIRST_ANCHOR_MIDI = 24; // C1
const LAST_ANCHOR_MIDI = 108; // C8
const ANCHOR_STEP = 3;

/** MIDI numbers of the bundled anchor samples, ascending. */
export const PIANO_ANCHORS: readonly number[] = Array.from(
    { length: (LAST_ANCHOR_MIDI - FIRST_ANCHOR_MIDI) / ANCHOR_STEP + 1 },
    (_, i) => FIRST_ANCHOR_MIDI + i * ANCHOR_STEP,
);

/** Soft layer (Salamander v4) — fallback if layers.json is not fetched. */
export const LAYER_SOFT_VELOCITY = 0.22;
/** Mid layer (Salamander v9) — the filename with no suffix, loaded first. */
export const LAYER_MID_VELOCITY = 0.54;
/** Loud layer (Salamander v14). */
export const LAYER_LOUD_VELOCITY = 0.85;

export const anchorFileName = (midi: number, suffix = ''): string => {
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}${suffix}.mp3`;
};

export const anchorUrl = (midi: number, suffix = ''): string => `/audio/piano/${anchorFileName(midi, suffix)}`;

/** Nearest bundled anchor for a pitch (ties resolve downward — stretching up stays brighter). */
export const nearestAnchor = (midi: number): number => {
    if (midi <= FIRST_ANCHOR_MIDI) {
        return FIRST_ANCHOR_MIDI;
    }
    if (midi >= LAST_ANCHOR_MIDI) {
        return LAST_ANCHOR_MIDI;
    }
    const offset = midi - FIRST_ANCHOR_MIDI;
    const below = FIRST_ANCHOR_MIDI + Math.floor(offset / ANCHOR_STEP) * ANCHOR_STEP;
    const above = below + ANCHOR_STEP;
    return midi - below <= above - midi ? below : above;
};

export const playbackRateFor = (midi: number, anchor: number): number => Math.pow(2, (midi - anchor) / 12);

/** Minimal slice of AudioContext the loader needs (mockable in tests). */
export interface SampleDecoder {
    decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

export interface PianoVoice {
    buffer: AudioBuffer;
    /** Seconds into the buffer where the attack actually begins (see below). */
    onsetSec: number;
    /** Seconds from that first movement to the note's perceived beat (see below). */
    attackLagSec: number;
}

export type PianoLayer = PianoVoice & {
    /** Nominal struck velocity this sample was recorded at, in 0..1. */
    velocity: number;
};

/** Per-anchor layers, sorted ascending by velocity. Mid is present first; soft/loud append later. */
export type PianoBuffers = Map<number, PianoLayer[]>;

export const layersFor = (buffers: PianoBuffers, anchor: number): PianoLayer[] => buffers.get(anchor) ?? [];

export interface LayerBracket {
    low: PianoLayer;
    high: PianoLayer;
    /** Weight of `high` in [0, 1]. 0/1 with `low === high` means a single layer. */
    mix: number;
}

/**
 * The two (or one) layers that should speak at `velocity`. Below the softest
 * or above the loudest is a single layer, not an extrapolation; sitting
 * exactly on a layer is that layer alone. Mix is the equal-power weight of
 * `high` when two neighbours bracket the strike.
 */
export const layersBracketing = (layers: readonly PianoLayer[], velocity: number): LayerBracket => {
    const first = layers[0];
    if (!first) {
        throw new Error('layersBracketing: no layers');
    }
    if (layers.length === 1 || velocity <= first.velocity) {
        return { low: first, high: first, mix: 0 };
    }
    const last = layers[layers.length - 1] ?? first;
    if (velocity >= last.velocity) {
        return { low: last, high: last, mix: 1 };
    }
    for (let i = 0; i < layers.length - 1; i++) {
        const low = layers[i];
        const high = layers[i + 1];
        if (!low || !high) {
            continue;
        }
        if (velocity <= low.velocity) {
            return { low, high: low, mix: 0 };
        }
        if (velocity >= high.velocity) {
            continue;
        }
        const span = high.velocity - low.velocity;
        return { low, high, mix: span > 0 ? (velocity - low.velocity) / span : 0 };
    }
    return { low: last, high: last, mix: 1 };
};

/**
 * Where the note's attack truly starts inside a decoded sample. mp3 decoding
 * always prepends codec padding (and our encoder writes no gapless header,
 * so the browser cannot strip it) — playing from 0 would put every piano
 * note tens of milliseconds behind the metronome click and the playhead.
 * The engine passes this as the `offset` argument of source.start().
 */
export const detectOnsetSec = (buffer: AudioBuffer): number => {
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
        const magnitude = Math.abs(data[i] ?? 0);
        if (magnitude > peak) {
            peak = magnitude;
        }
    }
    const threshold = Math.max(0.004, peak * 0.01);
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i] ?? 0) > threshold) {
            // Keep ~2 ms of pre-roll so the transient isn't clipped.
            return Math.max(0, i / buffer.sampleRate - 0.002);
        }
    }
    return 0;
};

/** Window of the envelope scan used to locate the perceived attack. */
const ENVELOPE_WINDOW_S = 0.002;
/** How far past the onset a piano attack can still be building. */
const ATTACK_SEARCH_S = 0.3;
/** Fraction of the attack's peak energy that reads as "the note has spoken". */
const ATTACK_ENERGY_FRACTION = 0.5;
/** Ceiling on the correction — a bad measurement must never smear the beat. */
export const MAX_ATTACK_LAG_S = 0.025;

/**
 * How long after `onsetSec` the note is actually *heard* to land.
 *
 * Physical alignment is not perceptual alignment. A metronome click is a step
 * discontinuity: it reads as an event at its very first sample. A piano note
 * ramps — low strings need 15–25 ms to speak — so starting the sample exactly
 * on the beat leaves the ear hearing the click first and the note trailing it,
 * which is what "the click is rushing" actually is. Measuring the energy rise
 * lets the engine start each note that much early, so its perceived attack —
 * not its first inaudible movement — sits on the beat.
 */
export const detectAttackLagSec = (buffer: AudioBuffer, onsetSec: number): number => {
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    const window = Math.max(1, Math.round(rate * ENVELOPE_WINDOW_S));
    const from = Math.max(0, Math.floor(onsetSec * rate));
    const to = Math.min(data.length, from + Math.ceil(ATTACK_SEARCH_S * rate));

    const energyAt = (start: number): number => {
        let sum = 0;
        const end = Math.min(to, start + window);
        for (let i = start; i < end; i++) {
            const sample = data[i] ?? 0;
            sum += sample * sample;
        }
        return Math.sqrt(sum / window);
    };

    let peak = 0;
    for (let start = from; start < to; start += window) {
        peak = Math.max(peak, energyAt(start));
    }
    if (peak <= 0) {
        return 0;
    }
    const target = peak * ATTACK_ENERGY_FRACTION;
    for (let start = from; start < to; start += window) {
        if (energyAt(start) >= target) {
            return Math.min(MAX_ATTACK_LAG_S, Math.max(0, (start - from) / rate));
        }
    }
    return 0;
};

const voiceFrom = async (decoder: SampleDecoder, data: ArrayBuffer, velocity: number): Promise<PianoLayer> => {
    const buffer = await decoder.decodeAudioData(data);
    const onsetSec = detectOnsetSec(buffer);
    return { buffer, onsetSec, attackLagSec: detectAttackLagSec(buffer, onsetSec), velocity };
};

const loadLayer = async (
    decoder: SampleDecoder,
    fetchImpl: typeof fetch,
    midi: number,
    suffix: string,
    velocity: number,
): Promise<PianoLayer> => {
    const res = await fetchImpl(anchorUrl(midi, suffix));
    if (!res.ok) {
        throw new Error(`Piano sample ${anchorFileName(midi, suffix)}: HTTP ${res.status}`);
    }
    return voiceFrom(decoder, await res.arrayBuffer(), velocity);
};

const EXTRA_LAYERS: ReadonlyArray<{ suffix: string; velocity: number }> = [
    { suffix: '-soft', velocity: LAYER_SOFT_VELOCITY },
    { suffix: '-loud', velocity: LAYER_LOUD_VELOCITY },
];

/** Soft/loud fill the same map the mid layer already resolved; failures stay mid-only. */
const fillExtraLayers = (buffers: PianoBuffers, decoder: SampleDecoder, fetchImpl: typeof fetch): void => {
    void (async () => {
        const extras = await Promise.all(
            PIANO_ANCHORS.flatMap((midi) =>
                EXTRA_LAYERS.map(async ({ suffix, velocity }) => {
                    try {
                        const layer = await loadLayer(decoder, fetchImpl, midi, suffix, velocity);
                        return { midi, layer };
                    } catch {
                        return null;
                    }
                }),
            ),
        );
        for (const extra of extras) {
            if (!extra) {
                continue;
            }
            const layers = buffers.get(extra.midi);
            if (!layers) {
                continue;
            }
            layers.push(extra.layer);
            layers.sort((a, b) => a.velocity - b.velocity);
        }
    })();
};

let cache: Promise<PianoBuffers> | null = null;

/**
 * Fetch + decode the mid layer of every anchor in parallel, once per app
 * lifetime, and resolve as soon as those are in — the same filenames and
 * timing the single-layer loader had. Soft and loud then fill the same map
 * entries in the background, so a voice scheduled before they land simply
 * plays the mid sample.
 *
 * Failure of the mid layer clears the cache so a retry can succeed. Extra
 * layers that 404 are skipped; the mid sample stays.
 */
export const loadPianoBuffers = (decoder: SampleDecoder, fetchImpl: typeof fetch = fetch): Promise<PianoBuffers> => {
    if (!cache) {
        cache = (async () => {
            const entries = await Promise.all(
                PIANO_ANCHORS.map(async (midi): Promise<[number, PianoLayer[]]> => {
                    const layer = await loadLayer(decoder, fetchImpl, midi, '', LAYER_MID_VELOCITY);
                    return [midi, [layer]];
                }),
            );
            const buffers = new Map(entries);
            fillExtraLayers(buffers, decoder, fetchImpl);
            return buffers;
        })().catch((err: unknown) => {
            cache = null;
            throw err;
        });
    }
    return cache;
};

/** Test hook. */
export const resetPianoBufferCache = (): void => {
    cache = null;
};
