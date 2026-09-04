import { applyLimiterSettings, applySoftClip, schedulePianoVoice } from '@/features/playback/PlaybackEngine';
import type { AudioContextLike, GainNodeLike, ScheduledVoice } from '@/features/playback/PlaybackEngine';
import { loadPianoBuffers } from '@/features/playback/pianoSampler';
import type { PianoBuffers } from '@/features/playback/pianoSampler';
import { getSharedAudioContext, resetSharedAudioContext } from '@/features/playback/sharedAudioContext';
import { DEFAULT_VELOCITY } from '@/types/scoreData';

/**
 * One-shot chord audition for review/diagram UIs — the same Salamander samples
 * and the same voice path as score playback (schedulePianoVoice), but no
 * transport, score, or hand buses. Shares the AudioContext and buffer cache
 * with PlaybackEngine so the first Hear after Play is free.
 */

const HOLD_S = 0.6;
/**
 * Trim ahead of the limiter, matching the engine's master. Audition is dry by
 * design — playback has a 0.22 reverb send that this chain deliberately lacks —
 * so a chord heard in the margin is slightly quieter than that chord in the
 * score. Before this shared path, audition ran straight into the destination
 * and was both louder than playback and free to clip.
 */
const AUDITION_GAIN = 0.8;

interface AuditionChain {
    /** The context it was built on; resetSharedAudioContext replaces that. */
    ctx: AudioContextLike;
    input: GainNodeLike;
}

let buffers: PianoBuffers | null = null;
let loadPromise: Promise<PianoBuffers> | null = null;
let active: ScheduledVoice[] = [];
let chain: AuditionChain | null = null;
/** Bumped to cancel in-flight buffer loads / abandoned auditions. */
let generation = 0;

const ensureBuffers = async (ctx: AudioContextLike): Promise<PianoBuffers> => {
    if (buffers) {
        return buffers;
    }
    if (!loadPromise) {
        loadPromise = loadPianoBuffers(ctx).then((loaded) => {
            buffers = loaded;
            return loaded;
        });
    }
    try {
        return await loadPromise;
    } catch (err) {
        loadPromise = null;
        throw err;
    }
};

/**
 * Built on first use and kept for the life of the context. Deliberately dry:
 * a convolver here would have to outlive individual auditions and share a
 * lifetime with the engine's own reverb, and a two-second chord in the margin
 * does not need a room to sound like a piano.
 */
const ensureChain = (ctx: AudioContextLike): GainNodeLike => {
    if (chain?.ctx === ctx) {
        return chain.input;
    }
    const softClip = ctx.createWaveShaper();
    applySoftClip(softClip);
    softClip.connect(ctx.destination);
    const limiter = ctx.createDynamicsCompressor();
    applyLimiterSettings(limiter);
    limiter.connect(softClip);
    const input = ctx.createGain();
    input.gain.value = AUDITION_GAIN;
    input.connect(limiter);
    chain = { ctx, input };
    return input;
};

const silenceActive = (): void => {
    if (active.length === 0) {
        return;
    }
    const now = getSharedAudioContext().currentTime;
    for (const voice of active) {
        try {
            voice.gain.gain.cancelScheduledValues(now);
            voice.gain.gain.setTargetAtTime(0, now, 0.02);
            for (const source of voice.sources) {
                try {
                    source.stop(now + 0.08);
                } catch {
                    // already stopped
                }
            }
        } catch {
            // already stopped
        }
        voice.dispose();
    }
    active = [];
};

/** Silence voices and cancel any in-flight auditionNotes awaiting buffers. */
export const stopAudition = (): void => {
    generation += 1;
    silenceActive();
};

/**
 * Play `midis` together as a short piano chord. Re-entrant: a new call cuts
 * off the previous chord. Empty input is a no-op. Must run from a user gesture
 * so the AudioContext can resume on iOS. If `stopAudition` runs while buffers
 * are still loading, this call aborts and does not start voices.
 */
export const auditionNotes = async (midis: readonly number[]): Promise<void> => {
    const unique = [...new Set(midis.filter((m) => Number.isFinite(m)))];
    if (unique.length === 0) {
        return;
    }

    const gen = ++generation;
    silenceActive();

    const ctx = getSharedAudioContext() as unknown as AudioContextLike;
    await ctx.resume().catch(() => undefined);
    if (gen !== generation) {
        return;
    }
    const piano = await ensureBuffers(ctx);
    if (gen !== generation) {
        return;
    }

    const destination = ensureChain(ctx);
    const now = ctx.currentTime;
    for (const midi of unique) {
        const voice = schedulePianoVoice({
            ctx,
            buffers: piano,
            midi,
            // An audition has no dynamic of its own; the score's own default is
            // the one level the rest of playback is calibrated against.
            velocity: DEFAULT_VELOCITY,
            startAt: now,
            holdSec: HOLD_S,
            destination,
        });
        if (!voice) {
            continue;
        }
        active.push(voice);
        voice.source.onended = () => {
            active = active.filter((v) => v !== voice);
            voice.dispose();
        };
    }
};

/** Test hook — drop shared state between cases. */
export const resetAuditionState = (): void => {
    stopAudition();
    resetSharedAudioContext();
    buffers = null;
    loadPromise = null;
    chain = null;
};
