import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ACCOMP_DIP,
    buildNoteShapes,
    clampVelocity,
    MELODY_LIFT,
    noteJitter,
    PEDAL_RELEASE_TAU_S,
    releaseTauFor,
    RESONANCE_RAMP_S,
    RESONANCE_WET,
    velocityToGain,
} from '@/features/playback/expression';
import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { PlaybackEngine, schedulePianoVoice } from '@/features/playback/PlaybackEngine';
import type { AudioContextLike, AudioParamLike } from '@/features/playback/PlaybackEngine';
import {
    LAYER_LOUD_VELOCITY,
    LAYER_MID_VELOCITY,
    LAYER_SOFT_VELOCITY,
    nearestAnchor,
    PIANO_ANCHORS,
} from '@/features/playback/pianoSampler';
import type { PianoBuffers } from '@/features/playback/pianoSampler';
import { buildTempoMap, FINAL_RIT_FACTOR, secondsAtTick } from '@/features/playback/scoreTime';
import type { PlaybackStatus } from '@/state/store';
import { DEFAULT_VELOCITY } from '@/types/scoreData';
import type { ScoreData, ScoreNote, ScorePedal } from '@/types/scoreData';

class MockParam implements AudioParamLike {
    value = 0;
    /** `tau` is present only on setTargetAtTime entries — it is the curve. */
    readonly targets: Array<{ target: number; time: number; tau?: number }> = [];
    setValueAtTime(value: number, time: number): void {
        this.targets.push({ target: value, time });
    }
    setTargetAtTime(target: number, time: number, tau: number): void {
        this.targets.push({ target, time, tau });
    }
    /**
     * Web Audio evaluates automation in time order, so cancelling drops every
     * event scheduled at or after the cancel time — that is the whole point of
     * calling it before a ramp, and a no-op stub here would hide the bug.
     * `tau` is the timeConstant on setTargetAtTime entries — it is the curve.
     */
    cancelScheduledValues(time: number): void {
        for (let i = this.targets.length - 1; i >= 0; i--) {
            if ((this.targets[i]?.time ?? 0) >= time) {
                this.targets.splice(i, 1);
            }
        }
    }
}

/** Every mock node records what it was wired to, so tests can walk the graph. */
class MockNode {
    readonly connections: unknown[] = [];
    connect(target: unknown): void {
        this.connections.push(target);
    }
    disconnect(): void {}
}

class MockGain extends MockNode {
    gain = new MockParam();
}

class MockFilter extends MockNode {
    type = '';
    frequency = new MockParam();
    Q = new MockParam();
}

class MockPanner extends MockNode {
    pan = new MockParam();
}

class MockCompressor extends MockNode {
    threshold = new MockParam();
    knee = new MockParam();
    ratio = new MockParam();
    attack = new MockParam();
    release = new MockParam();
}

class MockConvolver extends MockNode {
    buffer: AudioBuffer | null = null;
}

class MockShaper extends MockNode {
    curve: Float32Array | null = null;
    oversample = 'none';
}

class MockSource extends MockNode {
    buffer: AudioBuffer | null = null;
    playbackRate = new MockParam();
    startedAt: number | null = null;
    stoppedAt: number | null = null;
    onended: (() => void) | null = null;
    start(when = 0): void {
        this.startedAt = when;
    }
    stop(when = 0): void {
        this.stoppedAt = when;
    }
}

class MockOscillator {
    frequency = new MockParam();
    startedAt: number | null = null;
    connect(): void {}
    start(when = 0): void {
        this.startedAt = when;
    }
    stop(): void {}
}

class MockAudioBuffer {
    private readonly channels: Float32Array[];
    constructor(
        readonly numberOfChannels: number,
        readonly length: number,
        readonly sampleRate: number,
    ) {
        this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    }
    get duration(): number {
        return this.length / this.sampleRate;
    }
    getChannelData(channel: number): Float32Array {
        return this.channels[channel] ?? new Float32Array(this.length);
    }
}

class MockContext implements AudioContextLike {
    currentTime = 0;
    state = 'running';
    destination = {};
    sampleRate = 44100;
    readonly gains: MockGain[] = [];
    readonly sources: MockSource[] = [];
    readonly oscillators: MockOscillator[] = [];
    readonly filters: MockFilter[] = [];
    readonly panners: MockPanner[] = [];
    readonly compressors: MockCompressor[] = [];
    readonly convolvers: MockConvolver[] = [];
    readonly shapers: MockShaper[] = [];
    onstatechange: (() => void) | null = null;
    createGain(): MockGain {
        const gain = new MockGain();
        this.gains.push(gain);
        return gain;
    }
    createBufferSource(): MockSource {
        const source = new MockSource();
        this.sources.push(source);
        return source;
    }
    createOscillator(): MockOscillator {
        const osc = new MockOscillator();
        this.oscillators.push(osc);
        return osc;
    }
    createBiquadFilter(): MockFilter {
        const filter = new MockFilter();
        this.filters.push(filter);
        return filter;
    }
    createStereoPanner(): MockPanner {
        const panner = new MockPanner();
        this.panners.push(panner);
        return panner;
    }
    createDynamicsCompressor(): MockCompressor {
        const compressor = new MockCompressor();
        this.compressors.push(compressor);
        return compressor;
    }
    createConvolver(): MockConvolver {
        const convolver = new MockConvolver();
        this.convolvers.push(convolver);
        return convolver;
    }
    createWaveShaper(): MockShaper {
        const shaper = new MockShaper();
        this.shapers.push(shaper);
        return shaper;
    }
    createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
        return new MockAudioBuffer(numberOfChannels, length, sampleRate) as unknown as AudioBuffer;
    }
    async decodeAudioData(): Promise<AudioBuffer> {
        return {} as AudioBuffer;
    }
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
}

const fakeBuffers = (attackLagSec = 0): PianoBuffers =>
    new Map(
        PIANO_ANCHORS.map((midi) => [
            midi,
            [{ buffer: {} as AudioBuffer, onsetSec: 0, attackLagSec, velocity: LAYER_MID_VELOCITY }],
        ]),
    );

const fakeLayeredBuffers = (attackLagSec = 0): PianoBuffers =>
    new Map(
        PIANO_ANCHORS.map((midi) => [
            midi,
            [
                { buffer: {} as AudioBuffer, onsetSec: 0, attackLagSec, velocity: LAYER_SOFT_VELOCITY },
                { buffer: {} as AudioBuffer, onsetSec: 0, attackLagSec, velocity: LAYER_MID_VELOCITY },
                { buffer: {} as AudioBuffer, onsetSec: 0, attackLagSec, velocity: LAYER_LOUD_VELOCITY },
            ],
        ]),
    );

// Graph construction order in buildGraph(): master, RH bus, LH bus, reverb
// send, click bus. A score with pedal edges inserts a resonance send before
// the click bus. Every gain after that belongs to a voice or a click.
const BUS_RH = 1;
const BUS_LH = 2;
const REVERB_SEND = 3;
const CLICK_BUS = 4;
const FIRST_VOICE_GAIN = 5;

const makeEngine = (overrides?: {
    bpm?: number;
    score?: typeof tinyScore;
    attackLagSec?: number;
    allLayers?: boolean;
}) => {
    const ctx = new MockContext();
    const statuses: PlaybackStatus[] = [];
    const warnings: string[] = [];
    // One buffer map per engine, so a sample's identity names its anchor and
    // tests can pick a specific note out of the source list.
    const buffers = overrides?.allLayers
        ? fakeLayeredBuffers(overrides.attackLagSec)
        : fakeBuffers(overrides?.attackLagSec);
    const engine = new PlaybackEngine({
        score: overrides?.score ?? tinyScore,
        bpm: overrides?.bpm ?? 120,
        onStatus: (status) => statuses.push(status),
        onWarning: (code) => warnings.push(code),
        createContext: () => ctx,
        loadBuffers: async () => buffers,
    });
    return { ctx, engine, statuses, buffers, warnings };
};

/** Walk source → filter → gain, the chain schedulePianoVoice builds. */
const voiceGainNodeOf = (source: MockSource | undefined): MockGain | undefined => {
    const filter = source?.connections[0] as MockFilter | undefined;
    return filter?.connections[0] as MockGain | undefined;
};

const voiceGainOf = (source: MockSource | undefined): number => voiceGainNodeOf(source)?.gain.value ?? -1;

/** Seconds between a voice's attack and the point its source is torn down. */
const lifespanOf = (source: MockSource | undefined): number => (source?.stoppedAt ?? 0) - (source?.startedAt ?? 0);

const sampleOf = (buffers: PianoBuffers, midi: number): AudioBuffer | undefined =>
    buffers.get(nearestAnchor(midi))?.[0]?.buffer;

const expectConnections = (node: MockNode | undefined, ...targets: unknown[]): void => {
    expect(node?.connections).toHaveLength(targets.length);
    targets.forEach((target, i) => expect(node?.connections[i]).toBe(target));
};

/** Advance wall clock and audio clock together (the engine assumes they agree). */
const advance = async (ctx: MockContext, seconds: number) => {
    const steps = Math.ceil(seconds / 0.025);
    for (let i = 0; i < steps; i++) {
        ctx.currentTime += seconds / steps;
        await vi.advanceTimersByTimeAsync(25);
    }
};

// At 120 bpm a quarter (480 ticks) lasts 0.5 s, so tinyScore's 13920 ticks
// run for 14.5 s.
const SPT_120 = 60 / (120 * 480);

/** Where a note is actually struck: its grid time plus its roll and jitter. */
const onsetOf = (score: typeof tinyScore, index: number, gridSeconds: number): number => {
    const note = score.notes[index];
    if (!note) {
        return gridSeconds;
    }
    return gridSeconds + (buildNoteShapes(score)[index]?.roll ?? 0) + noteJitter(note.t, note.p, note.h).dt;
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('PlaybackEngine', () => {
    it('schedules every note exactly once at its tick time', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 16);
        expect(ctx.sources).toHaveLength(tinyScore.notes.length);
        // The pickup carries no dynamic of its own: the score default, nudged
        // by this note's jitter, through the dB velocity curve.
        expect(ctx.gains[FIRST_VOICE_GAIN]?.gain.value).toBeCloseTo(
            velocityToGain(DEFAULT_VELOCITY + noteJitter(0, 72, 0).dv + MELODY_LIFT),
            10,
        );
        // Note k starts at anchor(0.08) + map(t), shaped by its chord and jitter.
        const map = buildTempoMap(tinyScore, 120 / (tinyScore.defaultBpm ?? 120), 120);
        const expected = tinyScore.notes.map((n, i) => onsetOf(tinyScore, i, 0.08 + secondsAtTick(map, n.t)));
        const actual = ctx.sources.map((s) => s.startedAt ?? -1).sort((a, b) => a - b);
        expected.sort((a, b) => a - b);
        for (const [i, time] of expected.entries()) {
            expect(actual[i]).toBeCloseTo(time, 9);
        }
        expect(engine.getStatus()).toBe('ended');
    });

    it('count-in covers a full bar plus the pickup lead-in, with two downbeat accents', async () => {
        const { ctx, engine, statuses } = makeEngine();
        await engine.play({ countIn: true });
        expect(engine.getStatus()).toBe('counting');
        await advance(ctx, 4.5);
        // tinyScore opens with a 1-beat pickup in 4/4: "ONE two three four,
        // ONE two three" = 7 clicks spanning 3360 ticks (3.5 s at 120 bpm).
        expect(ctx.oscillators).toHaveLength(7);
        expect(ctx.oscillators[0]?.startedAt).toBeCloseTo(0.08, 3);
        expect(ctx.oscillators[6]?.startedAt).toBeCloseTo(0.08 + 6 * 0.5, 3);
        expect(ctx.oscillators.filter((o) => o.frequency.value === 1800)).toHaveLength(2);
        // The pickup note enters exactly where beat 4 of the second bar falls.
        const firstNote = Math.min(...ctx.sources.map((s) => s.startedAt ?? Infinity));
        expect(firstNote).toBeCloseTo(onsetOf(tinyScore, 0, 0.08 + 7 * 0.5), 9);
        expect(statuses).toContain('playing');
        expect(engine.getPositionTicks()).toBeGreaterThan(0);
    });

    it('keeps the musical position continuous across a bpm change', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 2);
        const before = engine.getPositionTicks();
        engine.setBpm(60);
        expect(engine.getPositionTicks()).toBeCloseTo(before, 0);
        await advance(ctx, 1);
        // 60 bpm → 480 ticks/second.
        expect(engine.getPositionTicks()).toBeCloseTo(before + 480, -1);
    });

    it('seek cancels ringing notes and replays from the target', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 2);
        const sourcesBefore = ctx.sources.length;
        expect(sourcesBefore).toBeGreaterThan(3);
        engine.seek(0);
        await advance(ctx, 0.5);
        // The pickup note (t=0) has now been scheduled a second time.
        const pickupStarts = ctx.sources.filter((s) => s.buffer && s.startedAt !== null).length;
        expect(pickupStarts).toBeGreaterThan(sourcesBefore);
        expect(engine.getPositionTicks()).toBeLessThan(1500);
    });

    it('drops a voice’s own release before the pause declick, so nothing snaps back', async () => {
        const { ctx, engine, buffers } = makeEngine();
        await engine.play();
        await advance(ctx, 0.3); // mid-pickup: its key release is still ahead
        const held = voiceGainNodeOf(ctx.sources.find((s) => s.buffer === sampleOf(buffers, 72)));
        const cancelAt = ctx.currentTime;
        expect(held?.gain.targets.some((t) => t.time > cancelAt)).toBe(true);

        engine.pause();
        // The 20 ms ramp to silence must be the only automation left ahead of
        // the pause: the note's own release, still scheduled inside the ramp,
        // would otherwise restore full gain and the source would be cut there.
        const ahead = held?.gain.targets.filter((t) => t.time >= cancelAt) ?? [];
        expect(ahead).toHaveLength(1);
        expect(ahead[0]?.target).toBe(0);
        expect(ahead[0]?.time).toBe(cancelAt);
        expect(ahead[0]?.tau).toBe(0.02);
    });

    it('mute and volume route to the correct hand bus while scheduling continues', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 0.5);
        engine.setHandMuted(1, true);
        engine.setHandVolume(0, 0.4);
        const lhTargets = ctx.gains[BUS_LH]?.gain.targets ?? [];
        const rhTargets = ctx.gains[BUS_RH]?.gain.targets ?? [];
        expect(lhTargets[lhTargets.length - 1]?.target).toBe(0);
        expect(rhTargets[rhTargets.length - 1]?.target).toBe(0.4);
        const before = ctx.sources.length;
        await advance(ctx, 1);
        expect(ctx.sources.length).toBeGreaterThan(before); // muted hand still schedules → instant unmute
    });

    it('wraps an A-B loop seamlessly and stays inside it', async () => {
        const { ctx, engine, buffers } = makeEngine();
        // Loop m.0–m.1 (ticks 0–2400): 2400 ticks at 120 bpm = 2.5 s per pass.
        engine.setLoop({ startTick: 0, endTick: 2400 });
        await engine.play();
        await advance(ctx, 8.2);
        expect(engine.getPositionTicks()).toBeLessThan(2400);
        // The pickup C5 (t=0) recurs on every pass: ≥3 passes in 8.2 s. Its
        // anchor sample appears nowhere else inside the loop.
        const pickup = sampleOf(buffers, 72);
        expect(ctx.sources.filter((s) => s.buffer === pickup).length).toBeGreaterThanOrEqual(3);
        expect(engine.getStatus()).toBe('playing'); // loops never end
    });

    it('reports ended after the final barline and can replay from the top', async () => {
        const { ctx, engine, statuses } = makeEngine({ bpm: 240 });
        await engine.play();
        await advance(ctx, 8.5); // 13920 ticks at 240 bpm ≈ 7.25 s
        expect(engine.getStatus()).toBe('ended');
        await engine.play();
        expect(statuses.filter((s) => s === 'playing').length).toBeGreaterThanOrEqual(2);
        expect(engine.getPositionTicks()).toBeLessThan(500);
    });

    it('metronome accents real downbeats — never the pickup', async () => {
        const { ctx, engine } = makeEngine();
        engine.setMetronome(true);
        await engine.play();
        await advance(ctx, 2.6);
        // m0 (pickup) clicks unaccented; m1's barline is the first accent.
        expect(ctx.oscillators.length).toBeGreaterThanOrEqual(6);
        expect(ctx.oscillators[0]?.frequency.value).toBe(1300);
        expect(ctx.oscillators[1]?.frequency.value).toBe(1800);
        expect(ctx.oscillators.some((o) => o.frequency.value === 1800)).toBe(true);
    });

    it('starts each note early by its attack lag so it is heard on the click', async () => {
        const lag = 0.02;
        const { ctx, engine, buffers } = makeEngine({ attackLagSec: lag });
        engine.setMetronome(true);
        await engine.play();
        await advance(ctx, 2.6);

        // Beat 1 of m.1 (tick 480) — click and note share the musical instant.
        const beatAt = 0.08 + 480 * SPT_120;
        const click = ctx.oscillators.find((o) => Math.abs((o.startedAt ?? -1) - beatAt) < 0.001);
        expect(click).toBeDefined(); // the click stays on the grid…
        // …and the left hand's C3 there leads it by its rise time. That note is
        // alone in its hand at that tick, so it takes no chord roll.
        const note = ctx.sources.find((s) => s.buffer === sampleOf(buffers, 48));
        expect(note?.startedAt).toBeCloseTo(beatAt - lag + noteJitter(480, 48, 1).dt, 9);
        expect(ctx.sources.some((s) => Math.abs((s.startedAt ?? -1) - beatAt) < 0.001)).toBe(false);
    });

    it('never schedules a lag-compensated note into the past', async () => {
        const { ctx, engine } = makeEngine({ attackLagSec: 0.02 });
        await engine.play(); // first note sits 0.08 s out, well inside the lag
        ctx.currentTime = 0.075;
        await advance(ctx, 0.05);
        for (const source of ctx.sources) {
            expect(source.startedAt).toBeGreaterThanOrEqual(0);
        }
    });

    it('pauses cleanly when the context is suspended (iOS interruption)', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 1);
        ctx.state = 'suspended';
        ctx.onstatechange?.();
        expect(engine.getStatus()).toBe('paused');
    });
});

describe('expression through the engine', () => {
    it('routes the limiter, the soft clip, the reverb send, and the dry click bus', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 0.1);
        const master = ctx.gains[0];
        const limiter = ctx.compressors[0];
        const softClip = ctx.shapers[0];
        const convolver = ctx.convolvers[0];
        const send = ctx.gains[REVERB_SEND];

        // Nothing reaches the speakers except through limiter then soft clip —
        // the compressor's attack passes transients, the memoryless clip cannot.
        expectConnections(master, limiter);
        expectConnections(limiter, softClip);
        expectConnections(softClip, ctx.destination);
        expect(softClip?.oversample).toBe('2x');
        expect(softClip?.curve?.length).toBeGreaterThan(0);
        // The send is the only thing feeding the reverb, and both hands use it.
        expectConnections(send, convolver);
        expectConnections(convolver, master);
        expectConnections(ctx.gains[BUS_RH], master, send);
        expectConnections(ctx.gains[BUS_LH], master, send);
        // The metronome stays dry: a click smeared by a room is no reference.
        expectConnections(ctx.gains[CLICK_BUS], master);
        expect(convolver?.buffer?.numberOfChannels).toBe(2);
        expect(limiter?.threshold.value).toBe(-12);
    });

    it('gives every voice a filter and a panner between the source and its bus', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 0.1);
        const source = ctx.sources[0];
        const filter = source?.connections[0] as MockFilter | undefined;
        const gain = filter?.connections[0] as MockGain | undefined;
        const panner = gain?.connections[0] as MockPanner | undefined;
        expect(filter?.type).toBe('lowpass');
        expect(panner).toBeInstanceOf(MockPanner);
        expectConnections(panner, ctx.gains[BUS_RH]);
        // The pickup C5 sits a fifth above middle C, so it leans slightly right.
        expect(panner?.pan.value).toBeCloseTo(0.4, 10);
    });

    it('gives a note the same jitter on every loop pass, so the seam never flams', async () => {
        const { ctx, engine, buffers } = makeEngine();
        const loopSeconds = 2400 * SPT_120;
        engine.setLoop({ startTick: 0, endTick: 2400 });
        await engine.play();
        await advance(ctx, 8.2);

        // The left hand's C3 at t=480 is the only note in the region on its
        // anchor, so its sample identifies every pass of that one note.
        const passes = ctx.sources
            .filter((s) => s.buffer === sampleOf(buffers, 48))
            .map((s) => ({ startedAt: s.startedAt ?? -1, gain: voiceGainOf(s) }))
            .sort((a, b) => a.startedAt - b.startedAt);
        expect(passes.length).toBeGreaterThanOrEqual(3);
        const first = passes[0];
        for (const [i, pass] of passes.entries()) {
            expect(pass.startedAt - (first?.startedAt ?? 0)).toBeCloseTo(i * loopSeconds, 9);
            expect(pass.gain).toBe(first?.gain);
        }
    });

    it('resumes a note seeked into mid-ring at the loudness its attack had', async () => {
        const { ctx, engine, buffers } = makeEngine();
        await engine.play();
        await advance(ctx, 1); // inside the left hand's C3, which rings to 2400
        const attacks = ctx.sources.filter((s) => s.buffer === sampleOf(buffers, 48));
        expect(attacks).toHaveLength(1);

        engine.seek(1200);
        await advance(ctx, 0.1);
        const all = ctx.sources.filter((s) => s.buffer === sampleOf(buffers, 48));
        expect(all.length).toBeGreaterThan(1);
        expect(voiceGainOf(all[0])).toBeGreaterThan(0);
        // Same loudness, but the tail starts where the transport landed rather
        // than being nudged by the timing jitter a second time.
        expect(voiceGainOf(all[all.length - 1])).toBe(voiceGainOf(all[0]));
        expect(all[all.length - 1]?.startedAt).toBeCloseTo(1.05, 9);
    });

    it('voices the top of a right-hand chord above the note under it', async () => {
        const { ctx, engine, buffers } = makeEngine();
        await engine.play();
        await advance(ctx, 0.7);
        // m.1's chord: E5 (index 1) under G5 (index 2), the melody note.
        const under = ctx.sources.find((s) => s.buffer === sampleOf(buffers, 76));
        const top = ctx.sources.find((s) => s.buffer === sampleOf(buffers, 79));
        expect(voiceGainOf(top)).toBeGreaterThan(voiceGainOf(under));
        // …and it arrives after it: the chord rolls from the bottom up.
        expect((top?.startedAt ?? 0) - (under?.startedAt ?? 0)).toBeGreaterThan(0);
    });

    it('keeps a rolled chord on the last beat of a loop from attacking after B', async () => {
        // Four notes on the last beat of a one-bar loop, close enough to B that
        // a 12 ms roll would otherwise land the top notes after the wrap.
        const B = 1920;
        const lastBeat = B - 8;
        const chord: ScoreNote[] = [60, 64, 67, 72].map((p) => ({ t: lastBeat, d: 8, p, h: 0 as const }));
        const score: ScoreData = {
            ...tinyScore,
            notes: chord,
            totalTicks: B,
            measures: [{ n: 1, tick: 0, dTicks: B, page: 0, sys: 0, x0: 0.08, x1: 0.92 }],
        };
        const { ctx, engine } = makeEngine({ score });
        engine.setLoop({ startTick: 0, endTick: B });
        await engine.play();
        await advance(ctx, 2.6);
        const map = buildTempoMap(score, 120 / (score.defaultBpm ?? 120), 120);
        const bTime = 0.08 + secondsAtTick(map, B);
        const firstPass = ctx.sources.filter((s) => (s.startedAt ?? Infinity) < bTime + 0.05);
        expect(firstPass).toHaveLength(4);
        for (const source of firstPass) {
            expect(source.startedAt ?? Infinity).toBeLessThan(bTime);
        }
    });

    it('keeps the lifted G when the left hand doubles it on the same tick', async () => {
        const notes: ScoreNote[] = [
            { t: 0, d: 480, p: 60, h: 0 },
            { t: 0, d: 480, p: 64, h: 0 },
            { t: 0, d: 480, p: 67, h: 0 },
            { t: 0, d: 480, p: 67, h: 1 },
        ];
        const score: ScoreData = { ...tinyScore, notes };
        const { ctx, engine, buffers } = makeEngine({ score });
        await engine.play();
        await advance(ctx, 0.5);
        const gSources = ctx.sources.filter((s) => s.buffer === sampleOf(buffers, 67));
        expect(gSources).toHaveLength(1);
        const lifted = clampVelocity(DEFAULT_VELOCITY + noteJitter(0, 67, 0).dv + MELODY_LIFT);
        expect(voiceGainOf(gSources[0])).toBeCloseTo(velocityToGain(lifted), 10);
    });

    it('schedules a left-hand accompaniment note a dip quieter than the formula without it', async () => {
        // Beat 2 of a 4/4 bar: no downbeat, no secondary, on the beat so no
        // offbeat dip — the only shaping on the LH is ACCOMP_DIP.
        const score: ScoreData = {
            ...tinyScore,
            timeSignatures: [{ tick: 0, num: 4, den: 4 }],
            notes: [
                { t: 480, d: 480, p: 72, h: 0 },
                { t: 480, d: 480, p: 48, h: 1 },
            ],
            measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0.08, x1: 0.92 }],
            totalTicks: 1920,
        };
        const { ctx, engine, buffers } = makeEngine({ score });
        await engine.play();
        await advance(ctx, 0.8);
        const lh = ctx.sources.find((s) => s.buffer === sampleOf(buffers, 48));
        const expected = velocityToGain(clampVelocity(DEFAULT_VELOCITY + noteJitter(480, 48, 1).dv - ACCOMP_DIP));
        expect(voiceGainOf(lh)).toBeCloseTo(expected, 10);
    });

    it('builds the same room for every engine of the same score', async () => {
        const a = makeEngine();
        await a.engine.play();
        const b = makeEngine();
        await b.engine.play();
        const bufA = a.ctx.convolvers[0]?.buffer;
        const bufB = b.ctx.convolvers[0]?.buffer;
        expect(bufA).toBeDefined();
        expect(bufB).toBeDefined();
        expect(bufA?.length).toBe(bufB?.length);
        expect(Array.from(bufA!.getChannelData(0))).toEqual(Array.from(bufB!.getChannelData(0)));
        expect(Array.from(bufA!.getChannelData(1))).toEqual(Array.from(bufB!.getChannelData(1)));
    });
});

describe('tempo map', () => {
    // tinyScore's bars are 1920 ticks. Halve the tempo from bar 3 (tick 5760):
    // bars 1-3 run at 120, everything after at 60.
    const paced: typeof tinyScore = {
        ...tinyScore,
        defaultBpm: 120,
        tempos: [
            { tick: 0, bpm: 120 },
            { tick: 5760, bpm: 60 },
        ],
    };

    /** Grid seconds of a note under `paced`, before roll and jitter. */
    const gridSeconds = (tick: number): number => secondsAtTick(buildTempoMap(paced, 1, 120), tick);

    it('hears a mid-score tempo change at the right moment', async () => {
        const { ctx, engine } = makeEngine({ score: paced, bpm: 120 });
        await engine.play();
        await advance(ctx, 30);
        const started = ctx.sources.map((s) => s.startedAt ?? -1).sort((a, b) => a - b);
        const expected = paced.notes.map((n, i) => onsetOf(paced, i, 0.08 + gridSeconds(n.t))).sort((a, b) => a - b);
        expect(started).toHaveLength(expected.length);
        started.forEach((at, i) => expect(at).toBeCloseTo(expected[i] ?? -1, 9));
    });

    it('rings a note through a fermata rather than cutting it at the hold', async () => {
        const held: typeof tinyScore = { ...tinyScore, defaultBpm: 120, holds: [{ tick: 2400, beats: 2 }] };
        const plain = makeEngine({ score: { ...tinyScore, defaultBpm: 120 }, bpm: 120 });
        await plain.engine.play();
        await advance(plain.ctx, 20);
        const before = plain.ctx.sources.map((s) => (s.stoppedAt ?? 0) - (s.startedAt ?? 0));

        const withHold = makeEngine({ score: held, bpm: 120 });
        await withHold.engine.play();
        await advance(withHold.ctx, 24);
        const after = withHold.ctx.sources.map((s) => (s.stoppedAt ?? 0) - (s.startedAt ?? 0));

        // Something now sounds a full second longer — the hold at 2400 stretched
        // whatever was ringing across it.
        expect(Math.max(...after)).toBeGreaterThan(Math.max(...before) + 0.9);
    });

    it('wraps an A-B loop across a tempo change without a gap', async () => {
        // The loop spans the change at 5760, so the wrap has to re-base onto the
        // map rather than assume one seconds-per-tick throughout.
        const { ctx, engine } = makeEngine({ score: paced, bpm: 120 });
        engine.setLoop({ startTick: 3840, endTick: 7680 });
        await engine.play();
        await advance(ctx, 24);

        const loopSeconds = gridSeconds(7680) - gridSeconds(3840); // 2 s at 120, then 4 s at 60
        const onsets = ctx.sources.map((s) => s.startedAt ?? -1).sort((a, b) => a - b);
        expect(onsets.length).toBeGreaterThan(0);

        // Every onset lands on the loop's grid: k full laps plus a real note offset.
        const inLoop = paced.notes
            .map((n, i) => (n.t >= 3840 && n.t < 7680 ? onsetOf(paced, i, gridSeconds(n.t) - gridSeconds(3840)) : null))
            .filter((offset): offset is number => offset !== null);
        for (const onset of onsets) {
            const sinceStart = onset - 0.08;
            const lap = Math.floor(sinceStart / loopSeconds + 1e-6);
            const offset = sinceStart - lap * loopSeconds;
            expect(inLoop.some((o) => Math.abs(o - offset) < 1e-6)).toBe(true);
        }
        // It really did wrap more than once.
        expect(Math.max(...onsets)).toBeGreaterThan(0.08 + loopSeconds);
    });

    it('does not jump the position when the practice tempo changes mid-play', async () => {
        const { ctx, engine } = makeEngine({ score: paced, bpm: 120 });
        await engine.play();
        await advance(ctx, 3);
        const before = engine.getPositionTicks();
        engine.setBpm(60);
        expect(engine.getPositionTicks()).toBeCloseTo(before, 0);
    });

    it('reports the tempo actually sounding, which the field alone does not', () => {
        const { engine } = makeEngine({ score: paced, bpm: 120 });
        expect(engine.getBpmAt(0)).toBe(120);
        expect(engine.getBpmAt(6000)).toBe(60);
        engine.setBpm(60); // practise the whole thing at half speed
        expect(engine.getBpmAt(0)).toBe(60);
        expect(engine.getBpmAt(6000)).toBe(30);
    });

    it('reports the unmarked final ritardando near the end', () => {
        const closing: ScoreData = {
            ...tinyScore,
            defaultBpm: 120,
            totalTicks: 7680,
            timeSignatures: [{ tick: 0, num: 4, den: 4 }],
            tempos: [{ tick: 0, bpm: 120 }],
            measures: [0, 1, 2, 3].map((i) => ({
                n: i + 1,
                tick: i * 1920,
                dTicks: 1920,
                page: 0,
                sys: 0,
                x0: 0.08,
                x1: 0.92,
                srcIndex: i,
            })),
            notes: [],
        };
        const { engine } = makeEngine({ score: closing, bpm: 120 });
        expect(engine.getBpmAt(0)).toBe(120);
        expect(engine.getBpmAt(7200)).toBe(Math.round(120 * FINAL_RIT_FACTOR));
        engine.setBpm(60);
        expect(engine.getBpmAt(0)).toBe(60);
        expect(engine.getBpmAt(7200)).toBe(Math.round(60 * FINAL_RIT_FACTOR));
    });
});

describe('sustain pedal', () => {
    const pedalled = (pedals: ScorePedal[], notes: readonly ScoreNote[] = tinyScore.notes): ScoreData => ({
        ...tinyScore,
        notes: [...notes],
        pedals,
    });

    /** Seconds a voice's source outlives its key release, under the pedal. */
    const PEDAL_TAIL_S = 5 * PEDAL_RELEASE_TAU_S;

    it('rings a note past its written end until the foot comes up', async () => {
        // The pickup C5 is written for one beat and pedalled for five.
        const { ctx, engine, buffers } = makeEngine({
            score: pedalled([
                { tick: 0, k: 'down' },
                { tick: 2400, k: 'up' },
            ]),
        });
        await engine.play();
        await advance(ctx, 3);
        const held = ctx.sources.find((s) => s.buffer === sampleOf(buffers, 72));
        expect(lifespanOf(held)).toBeCloseTo(2400 * SPT_120 + PEDAL_TAIL_S, 9);

        // Same note, same score, no pedal: one beat and a damped tail.
        const dry = makeEngine();
        await dry.engine.play();
        await advance(dry.ctx, 3);
        const damped = dry.ctx.sources.find((s) => s.buffer === sampleOf(dry.buffers, 72));
        expect(lifespanOf(damped)).toBeCloseTo(480 * SPT_120 + 0.3, 9);
    });

    it('releases a pedalled note as a free string, not as a damped one', async () => {
        const { ctx, engine, buffers } = makeEngine({
            score: pedalled([
                { tick: 0, k: 'down' },
                { tick: 2400, k: 'up' },
            ]),
        });
        await engine.play();
        await advance(ctx, 3);
        const held = voiceGainNodeOf(ctx.sources.find((s) => s.buffer === sampleOf(buffers, 72)));
        const release = held?.gain.targets.at(-1);
        expect(release?.target).toBe(0);
        expect(release?.tau).toBe(PEDAL_RELEASE_TAU_S);
        // The lift at 2400 is where the damper finally lands.
        expect(release?.time).toBeCloseTo(0.08 + 2400 * SPT_120 + noteJitter(0, 72, 0).dt, 9);
    });

    it('clears at a re-catch and holds only what is struck on it', async () => {
        // Foot down at 0, changed at 2400, up at 5760. The first note is caught
        // by the opening take and let go by the clearing half of the change; the
        // second is struck on the change and rides the re-take to the lift.
        const { ctx, engine } = makeEngine({
            score: pedalled(
                [
                    { tick: 0, k: 'down' },
                    { tick: 2400, k: 'up' },
                    { tick: 2400, k: 'down' },
                    { tick: 5760, k: 'up' },
                ],
                [
                    { t: 0, d: 480, p: 72, h: 0 },
                    { t: 2400, d: 480, p: 60, h: 0 },
                ],
            ),
        });
        await engine.play();
        await advance(ctx, 3);
        expect(ctx.sources).toHaveLength(2);
        expect(lifespanOf(ctx.sources[0])).toBeCloseTo(2400 * SPT_120 + PEDAL_TAIL_S, 9);
        expect(lifespanOf(ctx.sources[1])).toBeCloseTo(3360 * SPT_120 + PEDAL_TAIL_S, 9);
        expect(ctx.sources[1]?.startedAt).toBeCloseTo(0.08 + 2400 * SPT_120 + noteJitter(2400, 60, 0).dt, 9);
    });

    it('cuts a pedalled note at the loop end, the way a written one is cut', async () => {
        // Pedalled to 5760, but the B point is 2400 — carrying the harmony over
        // the wrap would smear every pass into the next. The clamp is a damper,
        // not a lift, so the tail is the damped one.
        const { ctx, engine } = makeEngine({
            score: pedalled(
                [
                    { tick: 0, k: 'down' },
                    { tick: 5760, k: 'up' },
                ],
                [{ t: 0, d: 480, p: 72, h: 0 }],
            ),
        });
        engine.setLoop({ startTick: 0, endTick: 2400 });
        await engine.play();
        await advance(ctx, 1);
        expect(ctx.sources).toHaveLength(1);
        const vel = clampVelocity(DEFAULT_VELOCITY + noteJitter(0, 72, 0).dv + MELODY_LIFT);
        const dampedTail = Math.max(0.3, 5 * releaseTauFor(72, vel));
        expect(lifespanOf(ctx.sources[0])).toBeCloseTo(2400 * SPT_120 + dampedTail, 9);
    });

    it('damps a loop-clamped pedalled note instead of letting the pedal tail ring into the wrap', async () => {
        const { ctx, engine, buffers } = makeEngine({
            score: pedalled(
                [
                    { tick: 0, k: 'down' },
                    { tick: 5760, k: 'up' },
                ],
                [{ t: 0, d: 480, p: 72, h: 0 }],
            ),
        });
        engine.setLoop({ startTick: 0, endTick: 2400 });
        await engine.play();
        await advance(ctx, 1);
        const held = ctx.sources.find((s) => s.buffer === sampleOf(buffers, 72));
        const bTime = 0.08 + 2400 * SPT_120;
        const vel = clampVelocity(DEFAULT_VELOCITY + noteJitter(0, 72, 0).dv + MELODY_LIFT);
        const damped = Math.max(0.3, 5 * releaseTauFor(72, vel));
        expect(held?.stoppedAt ?? Infinity).toBeLessThanOrEqual(bTime + damped + 0.006);
        expect(held?.stoppedAt ?? Infinity).toBeLessThan(bTime + 1.25);
    });

    it('revives only the key still down when a seek lands inside a held pedal', async () => {
        // A bar of eighths under one unbroken take. At the landing tick every
        // one of them is still ringing on the damper, but only the last has a
        // key down: the rest are decaying strings, and re-striking them would
        // be a chord the pianist never played.
        const eighths = Array.from({ length: 8 }, (_, i): ScoreNote => ({ t: i * 240, d: 240, p: 48 + i * 6, h: 0 }));
        const { ctx, engine, buffers } = makeEngine({
            score: pedalled(
                [
                    { tick: 0, k: 'down' },
                    { tick: 2880, k: 'up' },
                ],
                eighths,
            ),
        });
        await engine.play();
        await advance(ctx, 1.9);
        expect(ctx.sources).toHaveLength(8);

        engine.seek(1900); // inside the last eighth, written 1680–1920
        await advance(ctx, 0.05);
        expect(ctx.sources).toHaveLength(9);
        const revived = ctx.sources[8];
        expect(revived?.buffer).toBe(sampleOf(buffers, 90));
        expect(revived?.startedAt).toBeCloseTo(1.95, 9);
        // Its ring still runs to the lift at 2880 — the pedal decides how long
        // the resumed voice holds, it just no longer decides what is resumed.
        expect(lifespanOf(revived)).toBeCloseTo(980 * SPT_120 + PEDAL_TAIL_S, 9);
    });

    it('silences a ringing note when its own key is struck again', async () => {
        const { ctx, engine } = makeEngine({
            score: pedalled(
                [],
                [
                    { t: 0, d: 1920, p: 60, h: 0 },
                    { t: 480, d: 1920, p: 60, h: 0 },
                ],
            ),
        });
        await engine.play();
        await advance(ctx, 1);
        expect(ctx.sources).toHaveLength(2);
        const [first, second] = ctx.sources;
        const restrike = second?.startedAt ?? 0;

        // Left alone the first voice would have run four beats plus its tail.
        expect(first?.stoppedAt ?? 0).toBeGreaterThan(restrike);
        expect(first?.stoppedAt ?? 0).toBeLessThan(restrike + 0.1);
        const damping = voiceGainNodeOf(first)?.gain.targets.at(-1);
        expect(damping?.target).toBe(0);
        expect(damping?.time).toBeCloseTo(restrike, 9);
        expect(damping?.tau ?? 1).toBeLessThan(releaseTauFor(60, DEFAULT_VELOCITY));
        // The note that did the striking is untouched.
        expect(lifespanOf(second)).toBeCloseTo(1920 * SPT_120 + 0.3, 9);
    });

    it('carries the polyphony a held pedal needs before it gives up', async () => {
        // Eighty voices at once is far past any notated piano texture, but the
        // pedal makes it reachable — and it must not warn or drop notes.
        const cluster = Array.from({ length: 80 }, (_, i): ScoreNote => ({ t: 0, d: 480, p: 21 + i, h: 0 }));
        const { ctx, engine, warnings } = makeEngine({ score: pedalled([], cluster) });
        await engine.play();
        await advance(ctx, 0.5);
        expect(ctx.sources).toHaveLength(80);
        expect(warnings).toEqual([]);
    });

    it('steals the soonest-ending voice once the cap is hit, rather than dropping the incoming note', async () => {
        const cluster = Array.from({ length: 97 }, (_, i): ScoreNote => ({ t: 0, d: 480, p: 21 + i, h: 0 }));
        const { ctx, engine, warnings } = makeEngine({ score: pedalled([], cluster) });
        await engine.play();
        await advance(ctx, 0.5);
        expect(ctx.sources).toHaveLength(97);
        expect(warnings).toEqual(['too_many_voices']);
        const stolen = ctx.sources.filter((source) => {
            const ramp = voiceGainNodeOf(source)?.gain.targets.find((t) => t.target === 0 && t.tau === 0.01);
            return ramp !== undefined;
        });
        expect(stolen).toHaveLength(1);
        const incoming = ctx.sources[96];
        expect(voiceGainOf(incoming)).toBeGreaterThan(0);
        expect(incoming?.startedAt).not.toBeNull();
        expect(voiceGainNodeOf(incoming)?.gain.targets.some((t) => t.tau === 0.01)).toBe(false);
    });
});

describe('pedal resonance', () => {
    const pedalled = (pedals: ScorePedal[], notes: readonly ScoreNote[] = tinyScore.notes): ScoreData => ({
        ...tinyScore,
        notes: [...notes],
        pedals,
    });

    const resonanceSendOf = (ctx: MockContext): MockGain | undefined => {
        const ir = ctx.convolvers[1];
        return ctx.gains.find((g) => g.connections.includes(ir));
    };

    const gridAt = (score: ScoreData, tick: number): number =>
        0.08 + secondsAtTick(buildTempoMap(score, 120 / (score.defaultBpm ?? 120), 120), tick);

    it('builds a second convolver only when the score has pedal edges', async () => {
        const dry = makeEngine();
        await dry.engine.play();
        expect(dry.ctx.convolvers).toHaveLength(1);

        const wet = makeEngine({
            score: pedalled([
                { tick: 0, k: 'down' },
                { tick: 960, k: 'up' },
            ]),
        });
        await wet.engine.play();
        expect(wet.ctx.convolvers).toHaveLength(2);
        expect(wet.ctx.convolvers[1]?.buffer?.numberOfChannels).toBe(2);
        expect(wet.ctx.convolvers[1]?.buffer?.duration).toBeCloseTo(0.6, 5);
    });

    it('opens the send on a down and closes it on the matching up', async () => {
        const score = pedalled(
            [
                { tick: 0, k: 'down' },
                { tick: 960, k: 'up' },
            ],
            [{ t: 0, d: 480, p: 60, h: 0 }],
        );
        const { ctx, engine } = makeEngine({ score });
        await engine.play();
        await advance(ctx, 1.3);
        const send = resonanceSendOf(ctx);
        expect(send).toBeDefined();
        expect(
            send?.gain.targets.some((t) => t.target === RESONANCE_WET && t.time < 0.1 && t.tau === RESONANCE_RAMP_S),
        ).toBe(true);
        const upAt = gridAt(score, 960);
        const close = send?.gain.targets.filter((t) => t.target === 0 && t.tau === RESONANCE_RAMP_S) ?? [];
        expect(close.some((t) => Math.abs(t.time - upAt) < 1e-6)).toBe(true);
    });

    it('opens immediately when seeking into a held pedal, and is closed past the lift', async () => {
        const score = pedalled(
            [
                { tick: 0, k: 'down' },
                { tick: 1920, k: 'up' },
            ],
            [{ t: 0, d: 480, p: 60, h: 0 }],
        );
        const { ctx, engine } = makeEngine({ score });
        await engine.play();
        await advance(ctx, 0.2);

        engine.seek(480);
        const send = resonanceSendOf(ctx);
        const opened = send?.gain.targets.filter((t) => t.time === ctx.currentTime) ?? [];
        expect(opened.at(-1)?.target).toBe(RESONANCE_WET);
        expect(opened.at(-1)?.tau).toBe(RESONANCE_RAMP_S);

        engine.seek(2400);
        const closed = send?.gain.targets.filter((t) => t.time === ctx.currentTime) ?? [];
        expect(closed.at(-1)?.target).toBe(0);
        expect(closed.at(-1)?.tau).toBe(RESONANCE_RAMP_S);
    });

    it('drops the send at a loop B and reopens it on the wrap', async () => {
        const B = 1920;
        const score = pedalled(
            [
                { tick: 0, k: 'down' },
                { tick: 5760, k: 'up' },
            ],
            [{ t: 0, d: 480, p: 60, h: 0 }],
        );
        const { ctx, engine } = makeEngine({ score });
        engine.setLoop({ startTick: 0, endTick: B });
        await engine.play();
        await advance(ctx, 2.5);
        const send = resonanceSendOf(ctx);
        const bTime = gridAt(score, B);
        const atB = send?.gain.targets.filter((t) => Math.abs(t.time - bTime) < 1e-6) ?? [];
        expect(atB.some((t) => t.target === 0 && t.tau === RESONANCE_RAMP_S)).toBe(true);
        expect(atB.some((t) => t.target === RESONANCE_WET && t.tau === RESONANCE_RAMP_S)).toBe(true);
        const lastAtB = atB.at(-1);
        expect(lastAtB?.target).toBe(RESONANCE_WET);
    });

    it('ramps the send to 0 on pause', async () => {
        const { ctx, engine } = makeEngine({
            score: pedalled(
                [
                    { tick: 0, k: 'down' },
                    { tick: 1920, k: 'up' },
                ],
                [{ t: 0, d: 480, p: 60, h: 0 }],
            ),
        });
        await engine.play();
        await advance(ctx, 0.2);
        const send = resonanceSendOf(ctx);
        const now = ctx.currentTime;
        engine.pause();
        const ahead = send?.gain.targets.filter((t) => t.time >= now) ?? [];
        expect(ahead).toHaveLength(1);
        expect(ahead[0]?.target).toBe(0);
        expect(ahead[0]?.time).toBe(now);
        expect(ahead[0]?.tau).toBe(0.02);
    });

    it('leaves the send open after a re-catch pair', async () => {
        const score = pedalled(
            [
                { tick: 0, k: 'down' },
                { tick: 960, k: 'up' },
                { tick: 960, k: 'down' },
            ],
            [{ t: 0, d: 480, p: 60, h: 0 }],
        );
        const { ctx, engine } = makeEngine({ score });
        await engine.play();
        await advance(ctx, 1.3);
        const send = resonanceSendOf(ctx);
        const recatchAt = gridAt(score, 960);
        const atPair = send?.gain.targets.filter((t) => Math.abs(t.time - recatchAt) < 1e-6) ?? [];
        expect(atPair.some((t) => t.target === 0)).toBe(true);
        expect(atPair.at(-1)?.target).toBe(RESONANCE_WET);
        expect(atPair.at(-1)?.tau).toBe(RESONANCE_RAMP_S);
    });

    it('does not feed the click bus into the resonance send', async () => {
        const { ctx, engine } = makeEngine({
            score: pedalled(
                [
                    { tick: 0, k: 'down' },
                    { tick: 960, k: 'up' },
                ],
                [{ t: 0, d: 480, p: 60, h: 0 }],
            ),
        });
        engine.setMetronome(true);
        await engine.play();
        await advance(ctx, 0.3);
        const master = ctx.gains[0];
        const send = resonanceSendOf(ctx);
        const clickBus = ctx.gains.find((g) => g.connections.length === 1 && g.connections[0] === master);
        expect(clickBus).toBeDefined();
        expect(clickBus?.connections).not.toContain(send);
        expect(send?.connections).not.toContain(clickBus);
        expect(ctx.gains[BUS_RH]?.connections).not.toContain(clickBus);
    });

    it('keeps the other hand feeding the bloom when one hand is muted', async () => {
        const { ctx, engine } = makeEngine({
            score: pedalled(
                [
                    { tick: 0, k: 'down' },
                    { tick: 1920, k: 'up' },
                ],
                [
                    { t: 0, d: 480, p: 72, h: 0 },
                    { t: 0, d: 480, p: 48, h: 1 },
                ],
            ),
        });
        await engine.play();
        await advance(ctx, 0.1);
        const send = resonanceSendOf(ctx);
        expect(ctx.gains[BUS_RH]?.connections).toContain(send);
        expect(ctx.gains[BUS_LH]?.connections).toContain(send);
        engine.setHandMuted(1, true);
        expect(ctx.gains[BUS_RH]?.connections).toContain(send);
        expect(ctx.gains[BUS_LH]?.connections).toContain(send);
        expectConnections(send, ctx.convolvers[1]);
        expectConnections(ctx.convolvers[1], ctx.gains[0]);
        const lhTargets = ctx.gains[BUS_LH]?.gain.targets ?? [];
        expect(lhTargets[lhTargets.length - 1]?.target).toBe(0);
    });
});

describe('velocity layers', () => {
    it('creates two equal-power sources at DEFAULT_VELOCITY when every layer is in', () => {
        const ctx = new MockContext();
        const dest = ctx.createGain();
        const voice = schedulePianoVoice({
            ctx,
            buffers: fakeLayeredBuffers(),
            midi: 60,
            velocity: DEFAULT_VELOCITY,
            startAt: 0,
            holdSec: 0.5,
            destination: dest,
        });
        expect(ctx.sources).toHaveLength(2);
        expect(voice?.sources).toHaveLength(2);
        const mixA = ctx.sources[0]?.connections[0] as MockGain | undefined;
        const mixB = ctx.sources[1]?.connections[0] as MockGain | undefined;
        const g1 = mixA?.gain.value ?? 0;
        const g2 = mixB?.gain.value ?? 0;
        expect(g1 * g1 + g2 * g2).toBeCloseTo(1, 10);
        expect(g1).toBeGreaterThan(0);
        expect(g2).toBeGreaterThan(0);
        const filter = mixA?.connections[0] as MockFilter | undefined;
        expect(filter?.type).toBe('lowpass');
        expect(mixB?.connections[0]).toBe(filter);
        const envelope = filter?.connections[0] as MockGain | undefined;
        const panner = envelope?.connections[0] as MockPanner | undefined;
        expect(panner).toBeInstanceOf(MockPanner);
    });

    it('creates one source when the velocity sits on the mid layer', () => {
        const ctx = new MockContext();
        const dest = ctx.createGain();
        schedulePianoVoice({
            ctx,
            buffers: fakeLayeredBuffers(),
            midi: 60,
            velocity: LAYER_MID_VELOCITY,
            startAt: 0,
            holdSec: 0.5,
            destination: dest,
        });
        expect(ctx.sources).toHaveLength(1);
        const filter = ctx.sources[0]?.connections[0] as MockFilter | undefined;
        expect(filter?.type).toBe('lowpass');
    });

    it('stops both sources of a two-source voice on pause', async () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [{ t: 0, d: 480, p: 60, h: 0 }],
            totalTicks: 1920,
            measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0.08, x1: 0.92 }],
        };
        const { ctx, engine } = makeEngine({ score, allLayers: true });
        await engine.play();
        await advance(ctx, 0.2);
        expect(ctx.sources).toHaveLength(2);
        engine.pause();
        expect(ctx.sources[0]?.stoppedAt).not.toBeNull();
        expect(ctx.sources[1]?.stoppedAt).not.toBeNull();
        expect(ctx.sources[0]?.stoppedAt).toBeCloseTo(ctx.sources[1]?.stoppedAt ?? -1, 9);
    });

    it('stops both sources of a two-source voice when a re-strike steals it', async () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 0, d: 1920, p: 60, h: 0 },
                { t: 480, d: 480, p: 60, h: 0 },
            ],
            totalTicks: 1920,
            measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0.08, x1: 0.92 }],
        };
        const { ctx, engine } = makeEngine({ score, allLayers: true });
        await engine.play();
        await advance(ctx, 1);
        expect(ctx.sources).toHaveLength(4);
        const restrike = ctx.sources[2]?.startedAt ?? 0;
        expect(ctx.sources[0]?.stoppedAt ?? 0).toBeLessThan(restrike + 0.1);
        expect(ctx.sources[1]?.stoppedAt ?? 0).toBeLessThan(restrike + 0.1);
        expect(ctx.sources[2]?.stoppedAt ?? 0).toBeGreaterThan(restrike + 0.3);
        expect(ctx.sources[3]?.stoppedAt ?? 0).toBeGreaterThan(restrike + 0.3);
    });
});
