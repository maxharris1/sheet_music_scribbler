import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    LAYER_LOUD_VELOCITY,
    LAYER_MID_VELOCITY,
    LAYER_SOFT_VELOCITY,
    MAX_ATTACK_LAG_S,
    PIANO_ANCHORS,
    anchorFileName,
    anchorUrl,
    detectAttackLagSec,
    detectOnsetSec,
    layersBracketing,
    loadPianoBuffers,
    nearestAnchor,
    playbackRateFor,
    resetPianoBufferCache,
} from '@/features/playback/pianoSampler';
import type { PianoLayer } from '@/features/playback/pianoSampler';

const stubBuffer = (leadingSilenceSamples: number, sampleRate = 22050): AudioBuffer => {
    const data = new Float32Array(leadingSilenceSamples + 1000);
    for (let i = leadingSilenceSamples; i < data.length; i++) {
        data[i] = 0.5;
    }
    return { sampleRate, length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
};

/** Leading silence, then a linear ramp to full over `riseSamples`, then steady. */
const rampBuffer = (leadingSilenceSamples: number, riseSamples: number, sampleRate = 22050): AudioBuffer => {
    const data = new Float32Array(leadingSilenceSamples + riseSamples + 4000);
    for (let i = 0; i < riseSamples; i++) {
        data[leadingSilenceSamples + i] = 0.8 * (i / riseSamples);
    }
    for (let i = leadingSilenceSamples + riseSamples; i < data.length; i++) {
        data[i] = 0.8;
    }
    return { sampleRate, length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
};

afterEach(() => {
    resetPianoBufferCache();
    vi.restoreAllMocks();
});

describe('anchor map', () => {
    it('covers C1–C8 every minor third with correct file names', () => {
        expect(PIANO_ANCHORS).toHaveLength(29);
        expect(anchorFileName(24)).toBe('C1.mp3');
        expect(anchorFileName(27)).toBe('Ds1.mp3');
        expect(anchorFileName(108)).toBe('C8.mp3');
    });

    it('nearestAnchor keeps pitch shifts within ±1.5 semitones and clamps extremes', () => {
        expect(nearestAnchor(60)).toBe(60);
        expect(nearestAnchor(61)).toBe(60);
        expect(nearestAnchor(62)).toBe(63);
        expect(nearestAnchor(21)).toBe(24); // A0 → C1 (lowest bundled anchor)
        expect(nearestAnchor(115)).toBe(108);
        for (let midi = 21; midi <= 108; midi++) {
            expect(Math.abs(midi - nearestAnchor(midi))).toBeLessThanOrEqual(3);
        }
    });

    it('playbackRateFor is an equal-temperament ratio', () => {
        expect(playbackRateFor(60, 60)).toBe(1);
        expect(playbackRateFor(61, 60)).toBeCloseTo(Math.pow(2, 1 / 12), 6);
        expect(playbackRateFor(59, 60)).toBeCloseTo(Math.pow(2, -1 / 12), 6);
    });
});

describe('detectOnsetSec', () => {
    it('finds the attack past codec padding, keeping ~2ms pre-roll', () => {
        // 2205 samples of silence at 22050 Hz = 100 ms of padding.
        expect(detectOnsetSec(stubBuffer(2205))).toBeCloseTo(0.098, 3);
    });

    it('returns 0 for an immediate attack and for silence', () => {
        expect(detectOnsetSec(stubBuffer(0))).toBe(0);
        const silent = { sampleRate: 22050, length: 100, getChannelData: () => new Float32Array(100) };
        expect(detectOnsetSec(silent as unknown as AudioBuffer)).toBe(0);
    });
});

describe('detectAttackLagSec', () => {
    /**
     * The engine plays buffer position `onsetSec` at `beat − attackLagSec`, so
     * the audible attack lands `attackLagSec − (trueAttack − onsetSec)` off the
     * beat. Zero means the note is heard exactly on the click.
     */
    const alignmentErrorSec = (buffer: AudioBuffer, trueAttackSec: number): number => {
        const onsetSec = detectOnsetSec(buffer);
        return detectAttackLagSec(buffer, onsetSec) - (trueAttackSec - onsetSec);
    };

    it('cancels the onset pre-roll for a step attack', () => {
        const buffer = stubBuffer(2205); // silence, then full amplitude at 100 ms
        expect(detectAttackLagSec(buffer, detectOnsetSec(buffer))).toBeCloseTo(0.002, 3);
        expect(Math.abs(alignmentErrorSec(buffer, 0.1))).toBeLessThan(0.001);
    });

    it('measures how long a slow attack takes to speak', () => {
        // 220 samples ≈ 10 ms of rise: half energy lands around 5–7 ms in.
        const buffer = rampBuffer(2205, 220);
        const lag = detectAttackLagSec(buffer, detectOnsetSec(buffer));
        expect(lag).toBeGreaterThan(0.003);
        expect(lag).toBeLessThan(0.014);
    });

    it('lands a slow attack far closer to the beat than playing it raw', () => {
        // A 15 ms rise: uncompensated, this note is heard ~9 ms behind the click.
        const buffer = rampBuffer(2205, 330);
        const halfWay = 2205 / 22050 + 330 / 2 / 22050;
        expect(Math.abs(alignmentErrorSec(buffer, halfWay))).toBeLessThan(0.003);
    });

    it('never exceeds the cap, so a bad measurement cannot smear the beat', () => {
        const buffer = rampBuffer(2205, 22050); // absurd 1-second rise
        expect(detectAttackLagSec(buffer, detectOnsetSec(buffer))).toBe(MAX_ATTACK_LAG_S);
    });

    it('is zero for silence', () => {
        const silent = { sampleRate: 22050, length: 1000, getChannelData: () => new Float32Array(1000) };
        expect(detectAttackLagSec(silent as unknown as AudioBuffer, 0)).toBe(0);
    });
});

const layer = (velocity: number, id?: string): PianoLayer => ({
    buffer: { id } as unknown as AudioBuffer,
    onsetSec: 0,
    attackLagSec: 0,
    velocity,
});

const threeLayers = (): PianoLayer[] => [
    layer(LAYER_SOFT_VELOCITY, 'soft'),
    layer(LAYER_MID_VELOCITY, 'mid'),
    layer(LAYER_LOUD_VELOCITY, 'loud'),
];

describe('anchorUrl', () => {
    it('names the mid file with no suffix and the extra layers with -soft/-loud', () => {
        expect(anchorUrl(60)).toBe('/audio/piano/C4.mp3');
        expect(anchorUrl(60, '-soft')).toBe('/audio/piano/C4-soft.mp3');
        expect(anchorUrl(60, '-loud')).toBe('/audio/piano/C4-loud.mp3');
    });
});

describe('layersBracketing', () => {
    const layers = threeLayers();
    const soft = layers[0]!;
    const mid = layers[1]!;
    const loud = layers[2]!;

    it('clamps below the softest layer to that layer alone', () => {
        expect(layersBracketing(layers, 0.1)).toEqual({ low: soft, high: soft, mix: 0 });
    });

    it('sits on the soft layer at its own velocity', () => {
        expect(layersBracketing(layers, LAYER_SOFT_VELOCITY)).toEqual({ low: soft, high: soft, mix: 0 });
    });

    it('crossfades soft and mid with mix 0.5 at their midpoint', () => {
        const { low, high, mix } = layersBracketing(layers, 0.38);
        expect(low).toBe(soft);
        expect(high).toBe(mid);
        expect(mix).toBeCloseTo(0.5, 10);
    });

    it('sits on the mid layer at its own velocity', () => {
        expect(layersBracketing(layers, LAYER_MID_VELOCITY)).toEqual({ low: mid, high: mid, mix: 0 });
    });

    it('crossfades mid and loud above the mid layer', () => {
        const { low, high, mix } = layersBracketing(layers, 0.7);
        expect(low).toBe(mid);
        expect(high).toBe(loud);
        expect(mix).toBeCloseTo((0.7 - LAYER_MID_VELOCITY) / (LAYER_LOUD_VELOCITY - LAYER_MID_VELOCITY), 10);
    });

    it('clamps above the loudest layer to that layer alone', () => {
        expect(layersBracketing(layers, 0.9)).toEqual({ low: loud, high: loud, mix: 1 });
    });

    it('always returns the mid layer when that is the only one loaded', () => {
        const onlyMid = [mid];
        expect(layersBracketing(onlyMid, 0.1)).toEqual({ low: mid, high: mid, mix: 0 });
        expect(layersBracketing(onlyMid, 0.54)).toEqual({ low: mid, high: mid, mix: 0 });
        expect(layersBracketing(onlyMid, 0.9)).toEqual({ low: mid, high: mid, mix: 0 });
    });
});

describe('loadPianoBuffers', () => {
    it('decodes every mid-layer anchor with its onset and caches the result', async () => {
        const fetchImpl = vi.fn(async (_url: string) => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        }));
        const decoder = { decodeAudioData: vi.fn(async () => stubBuffer(1102)) };
        const voices = await loadPianoBuffers(decoder, fetchImpl as unknown as typeof fetch);
        expect(voices.size).toBe(PIANO_ANCHORS.length);
        expect(voices.get(60)?.[0]?.onsetSec).toBeCloseTo(0.048, 3); // ~50ms padding skipped
        expect(voices.get(60)?.[0]?.velocity).toBe(LAYER_MID_VELOCITY);
        const midCalls = () =>
            fetchImpl.mock.calls.filter(
                ([url]) => typeof url === 'string' && !url.includes('-soft') && !url.includes('-loud'),
            ).length;
        expect(midCalls()).toBe(PIANO_ANCHORS.length);
        await loadPianoBuffers(decoder, fetchImpl as unknown as typeof fetch);
        expect(midCalls()).toBe(PIANO_ANCHORS.length); // second call served from cache
    });

    it('clears the cache on failure so a retry can succeed', async () => {
        const failing = vi.fn(async () => ({
            ok: false,
            status: 503,
            arrayBuffer: async () => new ArrayBuffer(0),
        })) as unknown as typeof fetch;
        const decoder = { decodeAudioData: vi.fn(async () => stubBuffer(0)) };
        await expect(loadPianoBuffers(decoder, failing)).rejects.toThrow('HTTP 503');
        const working = vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })) as unknown as typeof fetch;
        await expect(loadPianoBuffers(decoder, working)).resolves.toBeDefined();
    });

    it('resolves after the mid layer and appends soft/loud as those fetches land', async () => {
        const pending = new Map<string, (value: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void>();
        const fetchImpl = vi.fn((url: string) => {
            return new Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>((resolve) => {
                pending.set(url, resolve);
            });
        }) as unknown as typeof fetch;
        const decoder = { decodeAudioData: vi.fn(async () => stubBuffer(0)) };

        const loading = loadPianoBuffers(decoder, fetchImpl);
        await vi.waitFor(() => expect(pending.size).toBe(PIANO_ANCHORS.length));
        for (const midi of PIANO_ANCHORS) {
            pending.get(anchorUrl(midi))?.({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
        }
        const buffers = await loading;
        expect(buffers.get(60)).toHaveLength(1);
        expect(buffers.get(60)?.[0]?.velocity).toBe(LAYER_MID_VELOCITY);

        await vi.waitFor(() => expect(pending.has(anchorUrl(60, '-soft'))).toBe(true));
        expect(pending.has(anchorUrl(60, '-loud'))).toBe(true);
        expect(buffers.get(60)).toHaveLength(1);

        for (const midi of PIANO_ANCHORS) {
            pending.get(anchorUrl(midi, '-soft'))?.({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
            pending.get(anchorUrl(midi, '-loud'))?.({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
        }
        await vi.waitFor(() => expect(buffers.get(60)).toHaveLength(3));
        const velocities = (buffers.get(60) ?? []).map((entry) => entry.velocity);
        expect(velocities).toEqual([LAYER_SOFT_VELOCITY, LAYER_MID_VELOCITY, LAYER_LOUD_VELOCITY]);
    });
});
