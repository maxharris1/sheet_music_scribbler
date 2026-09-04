import {
    buildNoteShapes,
    buildPedalEnds,
    buildResonanceImpulse,
    buildReverbImpulse,
    buildSoftClipCurve,
    CHORD_ROLL_MAX_S,
    clampVelocity,
    filterCutoffHz,
    JITTER_TIME_S,
    noteJitter,
    panForMidi,
    PEDAL_RELEASE_TAU_S,
    pedalStateAt,
    releaseTauFor,
    RESONANCE_RAMP_S,
    RESONANCE_SEED,
    RESONANCE_WET,
    REVERB_SECONDS,
    REVERB_SECONDS_LOW_POWER,
    REVERB_SEED,
    REVERB_WET,
    seededUnitRng,
    velocityToGain,
} from '@/features/playback/expression';
import type { NoteShape } from '@/features/playback/expression';
import {
    layersBracketing,
    layersFor,
    loadPianoBuffers,
    nearestAnchor,
    playbackRateFor,
} from '@/features/playback/pianoSampler';
import type { PianoBuffers, PianoLayer } from '@/features/playback/pianoSampler';
import {
    beatsForMeasure,
    bpmAtTick,
    buildTempoMap,
    countInClicks,
    firstNoteIndexAtOrAfter,
    measureIndexAtTick,
    secondsAtTick,
    tickAtSeconds,
} from '@/features/playback/scoreTime';
import type { BeatTick, TempoMap } from '@/features/playback/scoreTime';
import { getSharedAudioContext } from '@/features/playback/sharedAudioContext';
import type { PlaybackStatus } from '@/state/store';
import { DEFAULT_VELOCITY, HAND_LH, HAND_RH } from '@/types/scoreData';
import type { ScoreData, ScoreNote } from '@/types/scoreData';

/**
 * Web Audio playback of a ScoreData: classic lookahead scheduler (25 ms tick,
 * 120 ms horizon) feeding sampled piano notes into per-hand gain buses, plus
 * a synthesized click bus for metronome and count-in, and an anchor-swap
 * mechanism that makes BPM changes, seeks, count-in, and seamless A-B loop
 * wraps all the same operation. DOM/React-free; the caller owns AudioContext
 * creation timing (iOS requires it inside the user's tap).
 *
 * Everything that decides how a note should *sound* lives in expression.ts;
 * this file decides only when notes happen and where their audio is routed.
 */

const SCHEDULER_INTERVAL_MS = 25;
const HORIZON_S = 0.12;
const START_DELAY_S = 0.08;
/**
 * Voice ceiling. Held higher than the notated polyphony of any piano writing
 * because the pedal keeps notes alive long past their written ends; the
 * same-pitch stealing below is what stops that from becoming unbounded.
 */
const MAX_ACTIVE_SOURCES = 96;
/** Damping time when a key is struck again — fast, but not a click. */
const STEAL_TAU_S = 0.01;

const MASTER_GAIN = 0.8;
const CLICK_BUS_GAIN = 0.5;
/** Butterworth Q — a lowpass with no resonant bump at the corner. */
const VOICE_FILTER_Q = 0.7071;
/** Shortest envelope a staccato may get, however brief the notated value. */
const MIN_HOLD_S = 0.05;
/** Release tails are cut here: five time constants is −43 dB, inaudible. */
const RELEASE_STOP_TAUS = 5;
const RELEASE_STOP_MIN_S = 0.3;

/** Structural subset of AudioContext used by the engine — mockable in tests. */
export interface AudioContextLike {
    readonly currentTime: number;
    readonly state: string;
    readonly destination: unknown;
    readonly sampleRate: number;
    createGain(): GainNodeLike;
    createBufferSource(): AudioBufferSourceLike;
    createOscillator(): OscillatorLike;
    createBiquadFilter(): BiquadFilterLike;
    createStereoPanner(): StereoPannerLike;
    createDynamicsCompressor(): DynamicsCompressorLike;
    createWaveShaper(): WaveShaperLike;
    createConvolver(): ConvolverLike;
    createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
    decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
    resume(): Promise<void>;
    close(): Promise<void>;
    onstatechange?: (() => void) | null;
}

export interface AudioParamLike {
    value: number;
    setValueAtTime(value: number, time: number): unknown;
    setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
    cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
    connect(target: unknown): unknown;
    disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
    gain: AudioParamLike;
}

export interface BiquadFilterLike extends AudioNodeLike {
    type: string;
    frequency: AudioParamLike;
    Q: AudioParamLike;
}

export interface StereoPannerLike extends AudioNodeLike {
    pan: AudioParamLike;
}

export interface DynamicsCompressorLike extends AudioNodeLike {
    threshold: AudioParamLike;
    knee: AudioParamLike;
    ratio: AudioParamLike;
    attack: AudioParamLike;
    release: AudioParamLike;
}

export interface ConvolverLike extends AudioNodeLike {
    buffer: AudioBuffer | null;
}

export interface WaveShaperLike extends AudioNodeLike {
    curve: Float32Array | null;
    oversample: string;
}

export interface AudioBufferSourceLike extends AudioNodeLike {
    buffer: AudioBuffer | null;
    playbackRate: AudioParamLike;
    start(when?: number, offset?: number): void;
    stop(when?: number): void;
    onended: (() => void) | null;
}

export interface OscillatorLike {
    frequency: AudioParamLike;
    connect(target: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
}

/**
 * Ceiling shared by score playback and the one-shot audition. This is a safety
 * limiter, not a colour: velocityToGain deliberately exceeds unity at ff, and
 * a dense chord stacks dozens of those, so something has to hold the top —
 * and holding it here costs far less than trimming the dynamic range back to
 * whatever always fits.
 */
export const applyLimiterSettings = (compressor: DynamicsCompressorLike): void => {
    compressor.threshold.value = -12;
    compressor.knee.value = 20;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
};

/**
 * The limiter alone does not hold the ceiling: its 3 ms attack passes a
 * piano's transient before any gain reduction lands — an OfflineAudioContext
 * render of a ten-voice ff chord peaked at 1.39× full scale through it. The
 * soft clip after it is memoryless, so it cannot be outrun; below its knee it
 * is a straight wire (see buildSoftClipCurve).
 */
export const applySoftClip = (shaper: WaveShaperLike): void => {
    shaper.curve = buildSoftClipCurve();
    shaper.oversample = '2x';
};

export interface PianoVoiceRequest {
    ctx: AudioContextLike;
    buffers: PianoBuffers;
    midi: number;
    /** Struck velocity, before clamping — expression may have pushed it out of range. */
    velocity: number;
    /** Context time the attack should be *heard* at. */
    startAt: number;
    /** Seconds the key stays down; the release tail rings on past it. */
    holdSec: number;
    /** Where the voice lands: a hand bus, or the audition chain's own input. */
    destination: unknown;
    /**
     * Overrides the pitch-and-velocity release curve. The sustain pedal is the
     * caller that needs it: a note it is still holding decays as a free string,
     * not as one a damper has landed on.
     */
    releaseTauSec?: number;
}

export interface ScheduledVoice {
    source: AudioBufferSourceLike;
    /** Every buffer source in this voice — one layer, or the two-layer crossfade. */
    sources: AudioBufferSourceLike[];
    /** The voice's own level — cancel and ramp this to cut a note short. */
    gain: GainNodeLike;
    /** Pitch, so a re-strike can find the voice it is silencing. */
    midi: number;
    /**
     * Struck velocity, before clamping. A unison keeps the louder of two
     * same-pitch attacks, and that comparison has to see the melody lift
     * (and not the clamped floor).
     */
    velocity: number;
    /** Context time this voice was asked to be heard at (after roll/jitter). */
    startAt: number;
    /** Context time the source stops; nothing of this voice sounds past it. */
    stopsAt: number;
    /** Release the voice's nodes once it has ended. */
    dispose: () => void;
}

/**
 * The one place a sampled piano note is built: source(s) → (equal-power mix)
 * → lowpass → gain → panner → destination. Neighbouring velocity layers
 * crossfade into one filter; a single layer is the same chain as before.
 * Score playback and the fingering audition both go through here, so a chord
 * auditioned in the margin is the same instrument, at the same loudness, as
 * the same chord in the score.
 *
 * Returns null when no anchor sample covers the pitch. The caller owns the
 * lifetime: wire `dispose` into `source.onended` (the dominant source).
 */
export const schedulePianoVoice = (request: PianoVoiceRequest): ScheduledVoice | null => {
    const { ctx, midi, destination } = request;
    const anchor = nearestAnchor(midi);
    const layers = layersFor(request.buffers, anchor);
    if (layers.length === 0) {
        return null;
    }
    const velocity = clampVelocity(request.velocity);
    const { low, high, mix } = layersBracketing(layers, velocity);
    const dominant = mix < 0.5 ? low : high;
    // Start early by the dominant sample's own rise time so the note is *heard*
    // on the beat rather than just beginning there — otherwise every attack
    // trails the click, which reads as the click rushing
    // (pianoSampler: detectAttackLagSec). Never schedule into the past.
    const at = Math.max(ctx.currentTime, request.startAt - dominant.attackLagSec);
    const rate = playbackRateFor(midi, anchor);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterCutoffHz(velocity);
    filter.Q.value = VOICE_FILTER_Q;
    const gain = ctx.createGain();
    const gainValue = velocityToGain(velocity);
    gain.gain.value = gainValue;
    const panner = ctx.createStereoPanner();
    panner.pan.value = panForMidi(midi);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(destination);

    // The whole envelope shifts with the attack, so note lengths stay exact.
    const endAt = at + Math.max(MIN_HOLD_S, request.holdSec);
    const tau = request.releaseTauSec ?? releaseTauFor(midi, velocity);
    gain.gain.setValueAtTime(gainValue, endAt);
    gain.gain.setTargetAtTime(0, endAt, tau);
    const stopsAt = endAt + Math.max(RELEASE_STOP_MIN_S, RELEASE_STOP_TAUS * tau);

    const makeSource = (sample: PianoLayer): AudioBufferSourceLike => {
        const source = ctx.createBufferSource();
        source.buffer = sample.buffer;
        source.playbackRate.value = rate;
        return source;
    };

    const mixGains: GainNodeLike[] = [];
    let sources: AudioBufferSourceLike[];
    let source: AudioBufferSourceLike;

    if (low === high) {
        source = makeSource(low);
        source.connect(filter);
        // Start from the measured onset so no codec padding is heard —
        // decoded mp3s carry ~50 ms of it at the front.
        source.start(at, low.onsetSec);
        source.stop(stopsAt);
        sources = [source];
    } else {
        const sourceLow = makeSource(low);
        const sourceHigh = makeSource(high);
        const mixLow = ctx.createGain();
        const mixHigh = ctx.createGain();
        // Equal-power: cos²(m·π/2) + sin²(m·π/2) = 1, mix is the weight of high.
        mixLow.gain.value = Math.cos((mix * Math.PI) / 2);
        mixHigh.gain.value = Math.sin((mix * Math.PI) / 2);
        sourceLow.connect(mixLow);
        sourceHigh.connect(mixHigh);
        mixLow.connect(filter);
        mixHigh.connect(filter);
        sourceLow.start(at, low.onsetSec);
        sourceHigh.start(at, high.onsetSec);
        sourceLow.stop(stopsAt);
        sourceHigh.stop(stopsAt);
        mixGains.push(mixLow, mixHigh);
        sources = [sourceLow, sourceHigh];
        source = dominant === low ? sourceLow : sourceHigh;
    }

    const dispose = (): void => {
        for (const node of [...sources, ...mixGains, filter, gain, panner]) {
            try {
                node.disconnect();
            } catch {
                // already disconnected
            }
        }
    };
    return { source, sources, gain, midi, velocity: request.velocity, startAt: request.startAt, stopsAt, dispose };
};

/**
 * The release a note gets, given where it really stops. Ringing past its
 * notated end can only mean the pedal is holding it, so it decays as a free
 * string; anything else is a damper landing, which {@link releaseTauFor}
 * already describes better than a single constant could.
 *
 * A pedal-held note cut at a loop's B point is the second case, even though
 * the clamped end is past the written one: the wrap is a damper, not a lift,
 * and using {@link PEDAL_RELEASE_TAU_S} here would carry the previous pass's
 * harmony a beat into the next.
 */
const releaseTauOverrideFor = (note: ScoreNote, endTick: number, cutAtRegion: boolean): number | undefined =>
    !cutAtRegion && endTick > note.t + note.d ? PEDAL_RELEASE_TAU_S : undefined;

export interface LoopRegion {
    startTick: number;
    endTick: number;
}

export interface PlaybackEngineOptions {
    score: ScoreData;
    bpm: number;
    onStatus: (status: PlaybackStatus) => void;
    /** Fired after seeks/stops so the playhead can redraw while paused. */
    onPositionJump?: () => void;
    onWarning?: (code: string) => void;
    /** Test seams. */
    createContext?: () => AudioContextLike;
    loadBuffers?: (ctx: AudioContextLike) => Promise<PianoBuffers>;
}

interface Anchor {
    tick: number;
    ctxTime: number;
    /** Position on the score's own clock, so tempo changes stay continuous. */
    baseSeconds: number;
}

export class PlaybackEngine {
    private readonly score: ScoreData;
    private readonly onStatus: (status: PlaybackStatus) => void;
    private readonly onPositionJump: (() => void) | undefined;
    private readonly onWarning: ((code: string) => void) | undefined;
    private readonly createContext: () => AudioContextLike;
    private readonly loadBuffers: (ctx: AudioContextLike) => Promise<PianoBuffers>;

    private ctx: AudioContextLike | null = null;
    private buffers: PianoBuffers | null = null;
    private limiter: DynamicsCompressorLike | null = null;
    private softClip: WaveShaperLike | null = null;
    private master: GainNodeLike | null = null;
    private handBuses: [GainNodeLike, GainNodeLike] | null = null;
    private reverbSend: GainNodeLike | null = null;
    private convolver: ConvolverLike | null = null;
    private resonanceSend: GainNodeLike | null = null;
    private resonance: ConvolverLike | null = null;
    private clickBus: GainNodeLike | null = null;

    /** Chord/melody/downbeat shaping, index-aligned with `score.notes`. */
    private readonly shapes: readonly NoteShape[];
    /** Pedal-lengthened end ticks, index-aligned with `score.notes`. */
    private readonly pedalEnds: readonly number[];

    private status: PlaybackStatus = 'idle';
    /** The score's tempo map, scaled to the practice tempo. */
    private map: TempoMap;
    private bpmValue: number;
    private anchor: Anchor = { tick: 0, ctxTime: 0, baseSeconds: 0 };
    private pendingAnchor: Anchor | null = null;
    private pausedTick = 0;
    private nextNoteIndex = 0;
    private nextPedalIndex = 0;
    private nextBeat: BeatTick | null = null;
    private loop: LoopRegion | null = null;
    private muted: [boolean, boolean] = [false, false];
    private volumes: [number, number] = [1, 1];
    private metronome = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly active = new Set<ScheduledVoice>();
    private warnedSourceCap = false;
    private destroyed = false;

    constructor(options: PlaybackEngineOptions) {
        this.score = options.score;
        this.bpmValue = options.bpm;
        // One pass over the score, up front: the scheduler re-walks notes from
        // arbitrary positions and must never re-decide their shaping — and the
        // pedal, being state integrated from edges, cannot be resolved for one
        // note in isolation at the moment that note is scheduled.
        this.shapes = buildNoteShapes(options.score);
        this.pedalEnds = buildPedalEnds(options.score.notes, options.score.pedals, options.score.totalTicks);
        this.map = buildTempoMap(options.score, this.scaleFor(options.bpm), options.bpm);
        this.onStatus = options.onStatus;
        this.onPositionJump = options.onPositionJump;
        this.onWarning = options.onWarning;
        this.createContext = options.createContext ?? (() => getSharedAudioContext() as unknown as AudioContextLike);
        this.loadBuffers = options.loadBuffers ?? ((ctx) => loadPianoBuffers(ctx));
    }

    getStatus(): PlaybackStatus {
        return this.status;
    }

    getBpm(): number {
        return this.bpmValue;
    }

    /** Current musical position in ticks (drives the playhead each frame). */
    getPositionTicks(): number {
        if (
            !this.ctx ||
            this.status === 'idle' ||
            this.status === 'paused' ||
            this.status === 'ended' ||
            this.status === 'loading'
        ) {
            return this.pausedTick;
        }
        this.promotePendingAnchor(this.ctx.currentTime);
        const raw = tickAtSeconds(this.map, this.anchor.baseSeconds + (this.ctx.currentTime - this.anchor.ctxTime));
        // Never regress below the anchor (count-in and the 50 ms seek ramp sit
        // "before" it) and never overshoot the final barline.
        return Math.min(this.score.totalTicks, Math.max(this.anchor.tick, raw));
    }

    async play(options?: { countIn?: boolean }): Promise<void> {
        if (this.destroyed || this.status === 'playing' || this.status === 'counting' || this.status === 'loading') {
            return;
        }
        if (!this.ctx) {
            this.ctx = this.createContext();
            this.buildGraph(this.ctx);
            this.watchStateChanges(this.ctx);
        }
        await this.ctx.resume().catch(() => undefined);
        if (!this.buffers) {
            this.setStatus('loading');
            try {
                this.buffers = await this.loadBuffers(this.ctx);
            } catch {
                this.setStatus('idle');
                this.onWarning?.('samples_unavailable');
                return;
            }
            if (this.destroyed) {
                return;
            }
        }

        const startTick = this.status === 'ended' ? (this.loop ? this.loop.startTick : 0) : this.pausedTick;
        const now = this.ctx.currentTime;
        const startAt = now + START_DELAY_S;

        if (options?.countIn) {
            // One full bar plus the entry bar's lead-in beats, so pickups and
            // mid-bar entries land on the right count (see countInClicks).
            const clicks = countInClicks(this.score, startTick);
            const lead = clicks[0]?.offsetTicks ?? 0;
            // Count-in ticks run BEFORE the entry point, so the map extrapolates
            // back past zero; counting into a slow coda then counts slowly.
            const leadSeconds = secondsAtTick(this.map, startTick) - secondsAtTick(this.map, startTick - lead);
            for (const click of clicks) {
                const before = secondsAtTick(this.map, startTick - click.offsetTicks);
                this.scheduleClick(startAt + (before - secondsAtTick(this.map, startTick - lead)), click.accent);
            }
            this.anchor = this.anchorAt(startTick, startAt + leadSeconds);
            this.setStatus(leadSeconds > 0 ? 'counting' : 'playing');
        } else {
            this.anchor = this.anchorAt(startTick, startAt);
            this.setStatus('playing');
        }
        this.pendingAnchor = null;
        this.nextNoteIndex = firstNoteIndexAtOrAfter(this.score.notes, startTick);
        this.nextBeat = null;
        this.syncResonanceFrom(startTick, now, true);
        this.scheduleSustainingNotesAt(startTick);
        this.startScheduler();
    }

    pause(): void {
        if (this.status !== 'playing' && this.status !== 'counting') {
            return;
        }
        this.pausedTick = this.getPositionTicks();
        this.stopScheduler();
        this.cancelActiveNotes();
        this.setStatus('paused');
    }

    /** Stop = rewind to the start (of the loop when one is active) and hold. */
    stop(): void {
        const target = this.loop ? this.loop.startTick : 0;
        this.seek(target);
        if (this.status === 'playing' || this.status === 'counting') {
            this.pause();
            this.pausedTick = target;
        } else {
            this.setStatus(this.status === 'idle' ? 'idle' : 'paused');
        }
        this.onPositionJump?.();
    }

    seek(tick: number): void {
        const clamped = Math.max(0, Math.min(this.score.totalTicks, Math.round(tick)));
        if (this.ctx && (this.status === 'playing' || this.status === 'counting')) {
            this.cancelActiveNotes();
            this.anchor = this.anchorAt(clamped, this.ctx.currentTime + 0.05);
            this.pendingAnchor = null;
            this.nextNoteIndex = firstNoteIndexAtOrAfter(this.score.notes, clamped);
            this.nextBeat = null;
            this.syncResonanceFrom(clamped, this.ctx.currentTime, true);
            this.scheduleSustainingNotesAt(clamped);
            if (this.status === 'counting') {
                this.setStatus('playing');
            }
        } else {
            this.pausedTick = clamped;
            if (this.status === 'ended') {
                this.setStatus('paused');
            }
        }
        this.onPositionJump?.();
    }

    setBpm(bpm: number): void {
        this.bpmValue = bpm;
        const wasPlaying = this.ctx && (this.status === 'playing' || this.status === 'counting');
        if (wasPlaying && this.ctx) {
            // Read the position on the OLD map before rebuilding, then re-anchor
            // on the new one, or the playhead jumps when the tempo changes.
            const positionNow = this.getPositionTicks();
            this.map = buildTempoMap(this.score, this.scaleFor(bpm), bpm);
            this.anchor = this.anchorAt(positionNow, this.ctx.currentTime);
            this.pendingAnchor = null;
            this.nextBeat = null;
        } else {
            this.map = buildTempoMap(this.score, this.scaleFor(bpm), bpm);
        }
    }

    /**
     * Quarter-BPM actually sounding at a tick. The transport field shows the
     * opening tempo; mid-score this can differ, and saying so is the honest
     * alternative to a number that quietly stops being true.
     */
    getBpmAt(tick: number): number {
        return Math.round(bpmAtTick(this.map, tick));
    }

    setHandMuted(hand: 0 | 1, muted: boolean): void {
        this.muted[hand] = muted;
        this.applyBusGain(hand);
    }

    setHandVolume(hand: 0 | 1, volume: number): void {
        this.volumes[hand] = Math.min(1, Math.max(0, volume));
        this.applyBusGain(hand);
    }

    setMetronome(on: boolean): void {
        this.metronome = on;
        this.nextBeat = null;
    }

    setLoop(loop: LoopRegion | null): void {
        this.loop = loop && loop.endTick > loop.startTick ? loop : null;
        this.pendingAnchor = null;
        if (this.loop && this.status !== 'playing' && this.status !== 'counting') {
            // Snap a paused transport into the loop so Play starts inside it.
            if (this.pausedTick < this.loop.startTick || this.pausedTick >= this.loop.endTick) {
                this.seek(this.loop.startTick);
            }
        }
    }

    getLoop(): LoopRegion | null {
        return this.loop;
    }

    destroy(): void {
        this.destroyed = true;
        this.stopScheduler();
        this.cancelActiveNotes();
        this.teardownGraph();
        // Do not close the shared AudioContext — Hear / next PlaybackEngine reuse it.
        this.ctx = null;
        this.setStatus('idle');
    }

    // ----- internals -------------------------------------------------------

    private setStatus(status: PlaybackStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.onStatus(status);
        }
    }

    private teardownGraph(): void {
        const nodes: Array<AudioNodeLike | null> = [
            ...(this.handBuses ?? []),
            this.clickBus,
            this.reverbSend,
            this.convolver,
            this.resonanceSend,
            this.resonance,
            this.master,
            this.limiter,
            this.softClip,
        ];
        for (const node of nodes) {
            try {
                node?.disconnect();
            } catch {
                // already disconnected
            }
        }
        this.handBuses = null;
        this.clickBus = null;
        this.reverbSend = null;
        this.convolver = null;
        this.resonanceSend = null;
        this.resonance = null;
        this.master = null;
        this.limiter = null;
        this.softClip = null;
    }

    /**
     * Signal path: voices → hand bus → master → limiter → soft clip →
     * speakers, with a parallel send off each hand bus into one shared
     * reverb, and — when the score has pedal edges — a second send into a
     * shorter, brighter convolver for the sympathetic bloom. Both are sends
     * rather than inserts so muting a hand takes its reflections and its
     * resonance with it, and the metronome deliberately misses both — a
     * click smeared by a room stops being the sharp reference the player is
     * following.
     */
    private buildGraph(ctx: AudioContextLike): void {
        const softClip = ctx.createWaveShaper();
        applySoftClip(softClip);
        softClip.connect(ctx.destination);
        this.softClip = softClip;

        const limiter = ctx.createDynamicsCompressor();
        applyLimiterSettings(limiter);
        limiter.connect(softClip);
        this.limiter = limiter;

        const master = ctx.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(limiter);
        this.master = master;

        const rh = ctx.createGain();
        const lh = ctx.createGain();
        rh.connect(master);
        lh.connect(master);
        this.handBuses = [rh, lh];

        // One convolver for the whole engine: the send level sets the depth, and
        // a second instance would only spend CPU rendering the same room twice.
        const send = ctx.createGain();
        send.gain.value = REVERB_WET;
        const convolver = ctx.createConvolver();
        const lowPower = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4;
        convolver.buffer = buildReverbImpulse(ctx, {
            rng: seededUnitRng(REVERB_SEED),
            seconds: lowPower ? REVERB_SECONDS_LOW_POWER : REVERB_SECONDS,
        });
        send.connect(convolver);
        convolver.connect(master);
        rh.connect(send);
        lh.connect(send);
        this.reverbSend = send;
        this.convolver = convolver;

        // Only when the score actually pedals: a second convolver is real CPU,
        // and a silent send still has to render a tail. No edges means the
        // bloom never opens, so it is cheaper not to build it.
        if (this.score.pedals?.length) {
            const resonanceSend = ctx.createGain();
            resonanceSend.gain.value = 0;
            const resonance = ctx.createConvolver();
            resonance.buffer = buildResonanceImpulse(ctx, { rng: seededUnitRng(RESONANCE_SEED) });
            resonanceSend.connect(resonance);
            resonance.connect(master);
            rh.connect(resonanceSend);
            lh.connect(resonanceSend);
            this.resonanceSend = resonanceSend;
            this.resonance = resonance;
        }

        this.clickBus = ctx.createGain();
        this.clickBus.gain.value = CLICK_BUS_GAIN;
        this.clickBus.connect(master);

        this.applyBusGain(HAND_RH);
        this.applyBusGain(HAND_LH);
    }

    private watchStateChanges(ctx: AudioContextLike): void {
        if ('onstatechange' in ctx) {
            ctx.onstatechange = () => {
                // iOS suspends the context on interruptions (calls, Siri,
                // backgrounding) — degrade to a clean pause, never a hang.
                if (ctx.state !== 'running' && (this.status === 'playing' || this.status === 'counting')) {
                    this.pause();
                }
            };
        }
    }

    private applyBusGain(hand: 0 | 1): void {
        const bus = this.handBuses?.[hand];
        if (!bus || !this.ctx) {
            return;
        }
        const target = this.muted[hand] ? 0 : this.volumes[hand];
        bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }

    private startScheduler(): void {
        this.stopScheduler();
        this.timer = setInterval(() => this.schedulerTick(), SCHEDULER_INTERVAL_MS);
        this.schedulerTick();
    }

    private stopScheduler(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private promotePendingAnchor(now: number): void {
        if (this.pendingAnchor && now >= this.pendingAnchor.ctxTime) {
            this.anchor = this.pendingAnchor;
            this.pendingAnchor = null;
        }
    }

    /** Time a tick will sound, against the anchor scheduling currently targets. */
    private timeOfTick(tick: number): number {
        const anchor = this.pendingAnchor ?? this.anchor;
        return anchor.ctxTime + (secondsAtTick(this.map, tick) - anchor.baseSeconds);
    }

    /** An anchor at a tick, pinned to a context time. */
    private anchorAt(tick: number, ctxTime: number): Anchor {
        return { tick, ctxTime, baseSeconds: secondsAtTick(this.map, tick) };
    }

    /**
     * The transport shows an absolute BPM, but with a tempo map it means "the
     * printed opening tempo, rescaled" — the whole map moves by one factor.
     */
    private scaleFor(bpm: number): number {
        const nominal = this.score.tempos?.[0]?.bpm ?? this.score.defaultBpm ?? bpm;
        return nominal > 0 ? bpm / nominal : 1;
    }

    private schedulerTick(): void {
        const ctx = this.ctx;
        if (!ctx || (this.status !== 'playing' && this.status !== 'counting')) {
            return;
        }
        const now = ctx.currentTime;
        this.promotePendingAnchor(now);
        if (this.status === 'counting' && now >= this.anchor.ctxTime) {
            this.setStatus('playing');
        }
        const horizon = now + HORIZON_S;

        for (let wraps = 0; wraps < 4; wraps++) {
            const regionEnd = this.loop ? this.loop.endTick : this.score.totalTicks;

            this.scheduleNotesUpTo(regionEnd, horizon);
            this.schedulePedalEdgesUpTo(regionEnd, horizon);
            if (this.metronome) {
                this.scheduleBeatsUpTo(regionEnd, horizon);
            }

            if (this.loop && this.timeOfTick(this.loop.endTick) < horizon && !this.pendingAnchor) {
                // Seamless wrap: future content re-anchors at the loop start.
                // A wrap is a damper: if the pedal is still down at B, the bloom
                // lifts with the notes, then re-reads the state at A.
                const wrapAt = this.timeOfTick(this.loop.endTick);
                this.liftResonanceAtLoopEnd(regionEnd, wrapAt);
                this.pendingAnchor = {
                    tick: this.loop.startTick,
                    ctxTime: wrapAt,
                    baseSeconds: secondsAtTick(this.map, this.loop.startTick),
                };
                this.nextNoteIndex = firstNoteIndexAtOrAfter(this.score.notes, this.loop.startTick);
                this.nextBeat = null;
                this.syncResonanceFrom(this.loop.startTick, wrapAt, false);
                // Do not scheduleSustainingNotesAt here — notes that began before the
                // loop start would ghost-retrigger on every wrap.
                continue;
            }
            break;
        }

        // The final barline is the end — the last notes' release tails keep
        // ringing on their own after the scheduler stops.
        if (!this.loop && this.getPositionTicks() >= this.score.totalTicks) {
            this.stopScheduler();
            this.pausedTick = this.score.totalTicks;
            this.setStatus('ended');
        }
    }

    /**
     * The tick a note actually stops sounding at: its pedal-aware end, clamped
     * into the region being played. Looping is why the clamp lives in exactly
     * one place — a pedal held past the B point must still be cut there, or the
     * wrap would carry the previous pass's harmony over the new one.
     */
    private effectiveEndTick(index: number, note: ScoreNote, regionEnd: number): number {
        return Math.min(this.pedalEnds[index] ?? note.t + note.d, regionEnd);
    }

    /**
     * How hard a note is struck: its own dynamic, plus the shaping decided at
     * construction and its deterministic jitter. Deliberately separate from
     * {@link attackOffsetFor} — a note resumed mid-ring has to match the
     * loudness its attack had, but must not be nudged in time a second time.
     */
    private velocityFor(index: number, note: ScoreNote): number {
        const shape = this.shapes[index];
        return (
            (note.v ?? DEFAULT_VELOCITY) +
            noteJitter(note.t, note.p, note.h).dv +
            (shape?.lift ?? 0) +
            (shape?.accent ?? 0) -
            (shape?.dip ?? 0)
        );
    }

    /** Seconds a note's attack is pushed late: its chord roll plus its jitter. */
    private attackOffsetFor(index: number, note: ScoreNote): number {
        return (this.shapes[index]?.roll ?? 0) + noteJitter(note.t, note.p, note.h).dt;
    }

    private scheduleNotesUpTo(regionEnd: number, horizon: number): void {
        const notes = this.score.notes;
        while (this.nextNoteIndex < notes.length) {
            const note = notes[this.nextNoteIndex];
            if (!note || note.t >= regionEnd) {
                break;
            }
            const startAt = this.timeOfTick(note.t);
            if (startAt >= horizon) {
                break;
            }
            const index = this.nextNoteIndex;
            this.nextNoteIndex += 1;
            // Durations convert through the map, so a note sounding across a
            // fermata rings through the hold instead of being cut at it. The
            // hold is measured from the unshifted onset, so a rolled chord's
            // notes all ring for their written length — never from a clamped
            // attack, which would shorten the note when the roll is pulled back.
            const endTick = this.effectiveEndTick(index, note, regionEnd);
            const cutAtRegion = (this.pedalEnds[index] ?? note.t + note.d) > regionEnd;
            let onset = startAt + this.attackOffsetFor(index, note);
            if (this.loop) {
                // Chord roll + jitter can push an upper note past B even when
                // its grid tick is inside the loop; wrapping that attack onto
                // the next downbeat flams the seam.
                onset = Math.min(onset, this.timeOfTick(regionEnd) - 0.001);
            }
            this.scheduleNote(
                note.p,
                note.h,
                onset,
                Math.max(0, this.timeOfTick(endTick) - startAt),
                this.velocityFor(index, note),
                releaseTauOverrideFor(note, endTick, cutAtRegion),
            );
        }
    }

    /**
     * Walk pedal edges the same way notes are walked: a cursor, a horizon, and
     * never into the past. A re-catch pair on one tick is two events at the
     * same time; the later `setTargetAtTime` wins, which is `down`.
     */
    private schedulePedalEdgesUpTo(regionEnd: number, horizon: number): void {
        const send = this.resonanceSend;
        const ctx = this.ctx;
        const pedals = this.score.pedals;
        if (!send || !ctx || !pedals) {
            return;
        }
        while (this.nextPedalIndex < pedals.length) {
            const edge = pedals[this.nextPedalIndex];
            if (!edge || edge.tick >= regionEnd) {
                break;
            }
            const startAt = this.timeOfTick(edge.tick);
            if (startAt >= horizon) {
                break;
            }
            this.nextPedalIndex += 1;
            send.gain.setTargetAtTime(
                edge.k === 'down' ? RESONANCE_WET : 0,
                Math.max(ctx.currentTime, startAt),
                RESONANCE_RAMP_S,
            );
        }
    }

    private firstPedalIndexAtOrAfter(tick: number): number {
        const pedals = this.score.pedals;
        if (!pedals) {
            return 0;
        }
        let i = 0;
        while (i < pedals.length && (pedals[i]?.tick ?? 0) < tick) {
            i += 1;
        }
        return i;
    }

    /**
     * (Re)start the bloom from a transport position: cursor on the next edge
     * at or after that tick (and not before a loop's A), send opened or closed
     * to match the pedal there. `cancel` drops automation still ahead — a seek
     * or a fresh play — so a wrap can keep the lift at B and then reopen.
     */
    private syncResonanceFrom(tick: number, at: number, cancel: boolean): void {
        const send = this.resonanceSend;
        const ctx = this.ctx;
        if (!send || !ctx) {
            return;
        }
        const cursorTick = this.loop ? Math.max(tick, this.loop.startTick) : tick;
        this.nextPedalIndex = this.firstPedalIndexAtOrAfter(cursorTick);
        const when = Math.max(ctx.currentTime, at);
        if (cancel) {
            send.gain.cancelScheduledValues(when);
        }
        send.gain.setTargetAtTime(pedalStateAt(this.score.pedals, tick) ? RESONANCE_WET : 0, when, RESONANCE_RAMP_S);
    }

    /** A wrap is a damper: if the pedal is still holding at B, close the bloom. */
    private liftResonanceAtLoopEnd(regionEnd: number, wrapAt: number): void {
        const send = this.resonanceSend;
        const ctx = this.ctx;
        if (!send || !ctx || !pedalStateAt(this.score.pedals, regionEnd)) {
            return;
        }
        send.gain.setTargetAtTime(0, Math.max(ctx.currentTime, wrapAt), RESONANCE_RAMP_S);
    }

    /**
     * After seek/play into the middle of a sustained note, schedule the
     * remaining ring so chords don't go silent until the next attack.
     * When a loop is active, ignore notes that began before the loop start
     * so play/seek at A does not revive pre-loop tails.
     */
    private scheduleSustainingNotesAt(tick: number): void {
        const regionStart = this.loop ? this.loop.startTick : 0;
        const regionEnd = this.loop ? this.loop.endTick : this.score.totalTicks;
        const startAt = this.timeOfTick(tick);
        const notes = this.score.notes;
        for (let index = 0; index < notes.length; index++) {
            const note = notes[index];
            if (!note || note.t >= tick) {
                break;
            }
            if (note.t < regionStart) {
                continue;
            }
            // The key decides what is resumed, the pedal only how long it then
            // rings. A note whose written end has passed is a string the damper
            // is merely letting decay — striking it again here would be a
            // hammer blow the score does not contain, and under a long take
            // that is every note since the foot went down at once.
            if (note.t + note.d <= tick) {
                continue;
            }
            const noteEnd = this.effectiveEndTick(index, note, regionEnd);
            if (noteEnd <= tick) {
                continue;
            }
            const cutAtRegion = (this.pedalEnds[index] ?? note.t + note.d) > regionEnd;
            // No attack offset here: the roll and the timing jitter belong to an
            // onset that already happened, and this tail starts wherever the
            // transport landed.
            this.scheduleNote(
                note.p,
                note.h,
                startAt,
                Math.max(0, this.timeOfTick(noteEnd) - startAt),
                this.velocityFor(index, note),
                releaseTauOverrideFor(note, noteEnd, cutAtRegion),
            );
        }
    }

    private scheduleBeatsUpTo(regionEnd: number, horizon: number): void {
        for (let guard = 0; guard < 128; guard++) {
            if (this.nextBeat === null) {
                this.nextBeat = this.firstBeatAtOrAfter(Math.max(this.schedulingPositionFloor(), 0));
            }
            if (this.nextBeat === null || this.nextBeat.tick >= regionEnd) {
                return;
            }
            const at = this.timeOfTick(this.nextBeat.tick);
            if (at >= horizon) {
                return;
            }
            this.scheduleClick(at, this.nextBeat.accent);
            this.nextBeat = this.firstBeatAtOrAfter(this.nextBeat.tick + 1);
        }
    }

    /** Where beat scheduling should begin: the scheduling anchor's tick. */
    private schedulingPositionFloor(): number {
        return (this.pendingAnchor ?? this.anchor).tick;
    }

    private firstBeatAtOrAfter(tick: number): BeatTick | null {
        const index = measureIndexAtTick(this.score.measures, tick);
        if (index < 0) {
            return null;
        }
        for (let i = index; i < this.score.measures.length; i++) {
            const measure = this.score.measures[i];
            if (!measure) {
                return null;
            }
            for (const beat of beatsForMeasure(measure, this.score.timeSignatures)) {
                if (beat.tick >= tick) {
                    return beat;
                }
            }
        }
        return null;
    }

    /**
     * A piano has one set of strings per key: striking a note that is still
     * ringing stops that ring, it does not lay a second copy over it. Honouring
     * that is also the only thing keeping a pedalled passage bounded — under a
     * held pedal a repeated note would otherwise stack a voice per strike until
     * the cap cut the music off — so stealing runs before the cap is consulted.
     *
     * Same-tick unisons are the exception: two hands on one key are one sound,
     * and the louder strike (the one carrying the melody lift) is the one that
     * should speak. Returning false means the incoming voice is the quieter
     * copy and must not be scheduled.
     */
    private stealSamePitch(midi: number, startAt: number, velocity: number): boolean {
        // Chord roll + jitter can split two same-tick strikes by up to this
        // much; 1 ms is the "same instant" floor, and anything inside the roll
        // ceiling is still one musical event, not a re-strike.
        const unisonWindow = CHORD_ROLL_MAX_S + 2 * JITTER_TIME_S + 0.001;
        for (const voice of [...this.active]) {
            if (voice.midi !== midi || voice.stopsAt <= startAt) {
                continue;
            }
            const unison = Math.abs(voice.startAt - startAt) <= unisonWindow;
            if (unison && velocity <= voice.velocity) {
                return false;
            }
            this.stealVoice(voice, startAt);
        }
        return true;
    }

    private stealVoice(voice: ScheduledVoice, at: number): void {
        try {
            voice.gain.gain.cancelScheduledValues(at);
            voice.gain.gain.setTargetAtTime(0, at, STEAL_TAU_S);
            for (const source of voice.sources) {
                try {
                    source.stop(at + STEAL_TAU_S * RELEASE_STOP_TAUS);
                } catch {
                    // never started / already stopped
                }
            }
        } catch {
            // never started / already stopped
        }
        // Its nodes go in onended; the slot is free from here.
        this.active.delete(voice);
    }

    private scheduleNote(
        midi: number,
        hand: 0 | 1,
        startAt: number,
        durationSec: number,
        velocity: number,
        releaseTauSec?: number,
    ): void {
        const ctx = this.ctx;
        const buffers = this.buffers;
        const bus = this.handBuses?.[hand];
        if (!ctx || !buffers || !bus) {
            return;
        }
        if (!this.stealSamePitch(midi, startAt, velocity)) {
            return;
        }
        if (this.active.size >= MAX_ACTIVE_SOURCES) {
            if (!this.warnedSourceCap) {
                this.warnedSourceCap = true;
                this.onWarning?.('too_many_voices');
            }
            // Dropping the incoming note is the most audible failure: steal the
            // voice that is nearest to finishing so the new attack still speaks.
            let victim: ScheduledVoice | undefined;
            for (const voice of this.active) {
                if (!victim || voice.stopsAt < victim.stopsAt) {
                    victim = voice;
                }
            }
            if (victim) {
                this.stealVoice(victim, startAt);
            }
        }
        const entry = schedulePianoVoice({
            ctx,
            buffers,
            midi,
            velocity,
            startAt,
            holdSec: durationSec,
            destination: bus,
            releaseTauSec,
        });
        if (!entry) {
            return;
        }
        this.active.add(entry);
        entry.source.onended = () => {
            this.active.delete(entry);
            entry.dispose();
        };
    }

    private scheduleClick(at: number, accent: boolean): void {
        const ctx = this.ctx;
        const clickBus = this.clickBus;
        if (!ctx || !clickBus) {
            return;
        }
        const osc = ctx.createOscillator();
        osc.frequency.value = accent ? 1800 : 1300;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setValueAtTime(accent ? 0.9 : 0.6, at);
        gain.gain.setTargetAtTime(0, at + 0.012, 0.015);
        osc.connect(gain);
        gain.connect(clickBus);
        osc.start(at);
        osc.stop(at + 0.09);
    }

    private cancelActiveNotes(): void {
        const now = this.ctx?.currentTime ?? 0;
        for (const { sources, gain } of this.active) {
            // Clear the voice's own release first: automation runs in time
            // order, so a key release falling inside the ramp would restore
            // full gain and the source would be cut there — the very pop the
            // ramp exists to prevent.
            gain.gain.cancelScheduledValues(now);
            gain.gain.setTargetAtTime(0, now, 0.02); // declick
            for (const source of sources) {
                try {
                    source.stop(now + 0.08);
                } catch {
                    // never started / already stopped
                }
            }
        }
        this.active.clear();
        const send = this.resonanceSend;
        if (send) {
            send.gain.cancelScheduledValues(now);
            send.gain.setTargetAtTime(0, now, 0.02);
        }
    }
}
