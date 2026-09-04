import { describe, expect, it } from 'vitest';

import {
    buildNoteShapes,
    buildPedalEnds,
    buildResonanceImpulse,
    buildReverbImpulse,
    buildSoftClipCurve,
    clampVelocity,
    ACCOMP_DIP,
    CHORD_ROLL_MAX_S,
    CHORD_ROLL_S,
    DOWNBEAT_ACCENT,
    DYN_RANGE_DB,
    DYN_REF_GAIN,
    filterCutoffHz,
    JITTER_TIME_S,
    JITTER_VEL,
    MELODY_LIFT,
    noteJitter,
    OFFBEAT_DIP,
    panForMidi,
    pedalStateAt,
    PEDAL_RELEASE_TAU_S,
    releaseTauFor,
    RESONANCE_SECONDS,
    seededUnitRng,
    SOFTCLIP_CEILING,
    SOFTCLIP_KNEE,
    velocityToGain,
} from '@/features/playback/expression';
import type { ImpulseFactory } from '@/features/playback/expression';
import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { SECONDARY_ACCENT } from '@/features/playback/scoreTime';
import { DEFAULT_VELOCITY } from '@/types/scoreData';
import type { ScoreData, ScoreNote, ScorePedal } from '@/types/scoreData';

/** Decibel difference between two velocities, the way the ear measures it. */
const dbBetween = (from: number, to: number): number => 20 * Math.log10(velocityToGain(to) / velocityToGain(from));

describe('velocityToGain', () => {
    it('plays the score default at the reference gain', () => {
        expect(velocityToGain(DEFAULT_VELOCITY)).toBe(DYN_REF_GAIN);
    });

    it('spends exactly DYN_RANGE_DB decibels across the velocity range', () => {
        expect(dbBetween(0, 1)).toBeCloseTo(DYN_RANGE_DB, 10);
        expect(dbBetween(0.25, 0.75)).toBeCloseTo(DYN_RANGE_DB / 2, 10);
    });

    it('is linear in decibels, which is what makes a hairpin sound even', () => {
        // Equal velocity steps must be equal loudness steps, not equal gain steps.
        const steps = [0.2, 0.4, 0.6, 0.8].map((v, i, all) => (i === 0 ? 0 : dbBetween(all[i - 1] ?? 0, v)));
        for (const step of steps.slice(1)) {
            expect(step).toBeCloseTo(DYN_RANGE_DB * 0.2, 10);
        }
    });

    it('opens the pp-to-ff span the old power curve could not', () => {
        // The server's own pp and ff levels, ~21 dB apart instead of ~13.7.
        expect(dbBetween(0.34, 0.92)).toBeCloseTo(20.88, 2);
    });

    it('exceeds unity above the default velocity, which the limiter absorbs', () => {
        expect(velocityToGain(1)).toBeGreaterThan(1);
        expect(velocityToGain(DEFAULT_VELOCITY - 0.01)).toBeLessThan(DYN_REF_GAIN);
    });
});

describe('noteJitter', () => {
    it('is a pure function of the note identity', () => {
        expect(noteJitter(1920, 64, 0)).toEqual(noteJitter(1920, 64, 0));
        // Re-walking the score a thousand times must not drift.
        const first = noteJitter(0, 72, 0);
        for (let i = 0; i < 1000; i++) {
            expect(noteJitter(0, 72, 0)).toEqual(first);
        }
    });

    it('separates notes that differ in any one of tick, pitch, or hand', () => {
        const base = noteJitter(480, 60, 0);
        expect(noteJitter(481, 60, 0)).not.toEqual(base);
        expect(noteJitter(480, 61, 0)).not.toEqual(base);
        expect(noteJitter(480, 60, 1)).not.toEqual(base);
    });

    it('stays inside its stated bounds over a wide sweep', () => {
        let sumDt = 0;
        let count = 0;
        for (let tick = 0; tick < 40_000; tick += 37) {
            for (let pitch = 21; pitch <= 108; pitch += 11) {
                for (const hand of [0, 1]) {
                    const { dt, dv } = noteJitter(tick, pitch, hand);
                    expect(Math.abs(dt)).toBeLessThanOrEqual(JITTER_TIME_S);
                    expect(Math.abs(dv)).toBeLessThanOrEqual(JITTER_VEL);
                    sumDt += dt;
                    count += 1;
                }
            }
        }
        // Unbiased: humanization must not drag the whole performance late.
        expect(Math.abs(sumDt / count)).toBeLessThan(JITTER_TIME_S / 20);
    });

    it('draws timing and loudness independently', () => {
        const samples = Array.from({ length: 200 }, (_, i) => noteJitter(i * 240, 60, 0));
        const dts = new Set(samples.map((s) => s.dt));
        const dvs = new Set(samples.map((s) => s.dv));
        expect(dts.size).toBeGreaterThan(190);
        expect(dvs.size).toBeGreaterThan(190);
        expect(samples.some((s) => s.dt > 0 && s.dv < 0)).toBe(true);
    });
});

describe('filterCutoffHz', () => {
    it('is fully open at and above the soft layer, and darkens below it', () => {
        expect(filterCutoffHz(0)).toBe(800);
        expect(filterCutoffHz(0.11)).toBeCloseTo(800 * Math.pow(20, 0.5), 9);
        expect(filterCutoffHz(0.22)).toBe(16_000);
        expect(filterCutoffHz(DEFAULT_VELOCITY)).toBe(16_000);
        expect(filterCutoffHz(1)).toBe(16_000);
    });

    it('clamps out-of-range velocities rather than sweeping past Nyquist', () => {
        expect(filterCutoffHz(1.5)).toBe(filterCutoffHz(1));
        expect(filterCutoffHz(-1)).toBe(filterCutoffHz(0));
    });
});

describe('releaseTauFor', () => {
    it('rings longest in the bass and shortest in the treble', () => {
        expect(releaseTauFor(24, 1)).toBeCloseTo(0.174, 6);
        expect(releaseTauFor(60, DEFAULT_VELOCITY)).toBeCloseTo(0.0495, 6);
        expect(releaseTauFor(96, 0)).toBeCloseTo(0.036, 6);
    });

    it('stops shortening above middle C — the damper is already tight there', () => {
        expect(releaseTauFor(72, 0.5)).toBe(releaseTauFor(96, 0.5));
    });

    it('lengthens with velocity, because a harder strike has more to shed', () => {
        expect(releaseTauFor(48, 1)).toBeGreaterThan(releaseTauFor(48, 0));
    });

    it('is beaten by the pedal release everywhere — no damper is on the string', () => {
        // The loudest, longest-ringing damped note there is still stops sooner
        // than a pedalled one, or lifting the foot would shorten notes.
        expect(PEDAL_RELEASE_TAU_S).toBeGreaterThan(releaseTauFor(21, 1));
    });
});

describe('panForMidi', () => {
    it('puts middle C centre and the keyboard around it', () => {
        expect(panForMidi(60)).toBe(0);
        expect(panForMidi(75)).toBeCloseTo(0.5, 10);
        expect(panForMidi(45)).toBeCloseTo(-0.5, 10);
        expect(panForMidi(70)).toBeCloseTo(1 / 3, 10);
    });

    it('holds half width at the extremes so mono samples stay one instrument', () => {
        expect(panForMidi(108)).toBe(0.5);
        expect(panForMidi(21)).toBe(-0.5);
    });
});

describe('clampVelocity', () => {
    it('keeps a jittered velocity audible and unclipped', () => {
        expect(clampVelocity(0.5)).toBe(0.5);
        expect(clampVelocity(0)).toBe(0.05);
        expect(clampVelocity(1.4)).toBe(1);
    });
});

/** Minimal AudioContext stand-in: plain Float32Array channels, no Web Audio. */
const impulseFactory = (sampleRate: number): ImpulseFactory => ({
    sampleRate,
    createBuffer(numberOfChannels: number, length: number, rate: number): AudioBuffer {
        const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
        return {
            numberOfChannels,
            length,
            sampleRate: rate,
            duration: length / rate,
            getChannelData: (channel: number) => channels[channel] ?? new Float32Array(length),
        } as unknown as AudioBuffer;
    },
});

describe('buildReverbImpulse', () => {
    const options = { seconds: 1, predelayMs: 10, rng: () => 1 };

    it('is stereo and exactly T60 long', () => {
        const ir = buildReverbImpulse(impulseFactory(1000), options);
        expect(ir.numberOfChannels).toBe(2);
        expect(ir.length).toBe(1000);
    });

    it('holds the predelay silent — the cue the ear reads as room size', () => {
        const ir = buildReverbImpulse(impulseFactory(1000), options);
        const data = ir.getChannelData(0);
        for (let i = 0; i < 10; i++) {
            expect(data[i]).toBe(0);
        }
        expect(data[10]).not.toBe(0);
    });

    it('decays 60 dB over T60', () => {
        const ir = buildReverbImpulse(impulseFactory(1000), options);
        const data = ir.getChannelData(0);
        // With a constant noise source the lowpass has settled by here, so what
        // is left is the envelope alone: 10^(-3t/T60).
        expect(data[110] ?? 0).toBeCloseTo(Math.pow(10, -0.3), 3);
        expect(data[510] ?? 0).toBeCloseTo(Math.pow(10, -1.5), 3);
        expect(Math.abs(data[999] ?? 0)).toBeLessThan(0.002);
    });

    it('darkens as the tail develops, the way air absorbs a room', () => {
        // A ±1 square alternation is all high frequency; what survives the
        // filter at the end of the tail must be a smaller share than at its
        // start, or the "lowpass" is not closing.
        let step = 0;
        const alternating = () => (++step % 2 === 0 ? 1 : 0);
        const ir = buildReverbImpulse(impulseFactory(1000), { ...options, rng: alternating });
        const data = ir.getChannelData(0);
        const ripple = (at: number) =>
            Math.abs(
                (data[at] ?? 0) / Math.pow(10, (-3 * (at - 10)) / 1000) -
                    (data[at + 1] ?? 0) / Math.pow(10, (-3 * (at + 1 - 10)) / 1000),
            );
        expect(ripple(800)).toBeLessThan(ripple(110));
    });

    it('gives the two channels independent noise, which is where width comes from', () => {
        let seed = 1;
        const rng = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const ir = buildReverbImpulse(impulseFactory(1000), { ...options, rng });
        expect(ir.getChannelData(0)[500]).not.toBe(ir.getChannelData(1)[500]);
    });

    it('takes its randomness only from the injected source', () => {
        let calls = 0;
        buildReverbImpulse(impulseFactory(1000), {
            ...options,
            rng: () => {
                calls += 1;
                return 0.5;
            },
        });
        expect(calls).toBe(2 * (1000 - 10));
    });

    it('is byte-identical when brightness is omitted or zero', () => {
        const implicit = buildReverbImpulse(impulseFactory(1000), { ...options, rng: seededUnitRng(0xabc) });
        const explicit = buildReverbImpulse(impulseFactory(1000), {
            ...options,
            rng: seededUnitRng(0xabc),
            brightness: 0,
        });
        expect(Array.from(implicit.getChannelData(0))).toEqual(Array.from(explicit.getChannelData(0)));
        expect(Array.from(implicit.getChannelData(1))).toEqual(Array.from(explicit.getChannelData(1)));
        // Pins against the constant-rng envelope the previous implementation used.
        const constant = buildReverbImpulse(impulseFactory(1000), options);
        const data = constant.getChannelData(0);
        expect(data[110]).toBeCloseTo(Math.pow(10, -0.3), 3);
        expect(data[510]).toBeCloseTo(Math.pow(10, -1.5), 3);
    });
});

describe('buildResonanceImpulse', () => {
    it('is stereo and exactly RESONANCE_SECONDS long', () => {
        const ir = buildResonanceImpulse(impulseFactory(1000), { rng: () => 1 });
        expect(ir.numberOfChannels).toBe(2);
        expect(ir.length).toBe(Math.round(RESONANCE_SECONDS * 1000));
    });

    it('keeps more high end in the tail than the room IR', () => {
        // Mean absolute first difference of the latter half, envelope-stripped:
        // the bloom's raised lowpass floor must leave more ripple than the room.
        const hfEnergy = (buffer: AudioBuffer, seconds: number, predelay: number): number => {
            const data = buffer.getChannelData(0);
            const rate = buffer.sampleRate;
            let sum = 0;
            let n = 0;
            const start = Math.max(predelay + 1, Math.floor(data.length * 0.5));
            for (let i = start; i < data.length; i++) {
                const elapsed = (i - predelay) / rate;
                const prevElapsed = (i - 1 - predelay) / rate;
                const envelope = Math.pow(10, (-3 * elapsed) / seconds);
                const prevEnvelope = Math.pow(10, (-3 * prevElapsed) / seconds);
                if (envelope < 1e-6 || prevEnvelope < 1e-6) {
                    continue;
                }
                const a = (data[i] ?? 0) / envelope;
                const b = (data[i - 1] ?? 0) / prevEnvelope;
                sum += Math.abs(a - b);
                n += 1;
            }
            return n === 0 ? 0 : sum / n;
        };
        const resonance = buildResonanceImpulse(impulseFactory(2000), { rng: seededUnitRng(7) });
        const reverb = buildReverbImpulse(impulseFactory(2000), { rng: seededUnitRng(7) });
        expect(hfEnergy(resonance, RESONANCE_SECONDS, 8)).toBeGreaterThan(hfEnergy(reverb, 1.8, 30));
    });
});

describe('pedalStateAt', () => {
    const down = (tick: number): ScorePedal => ({ tick, k: 'down' });
    const up = (tick: number): ScorePedal => ({ tick, k: 'up' });

    it('is up before any edge, and when there are no edges', () => {
        expect(pedalStateAt([{ tick: 480, k: 'down' }], 479)).toBe(false);
        expect(pedalStateAt([], 0)).toBe(false);
        expect(pedalStateAt(undefined, 0)).toBe(false);
    });

    it('is down after a down, and up after an up', () => {
        const pedals = [down(0), up(960)];
        expect(pedalStateAt(pedals, 0)).toBe(true);
        expect(pedalStateAt(pedals, 480)).toBe(true);
        expect(pedalStateAt(pedals, 960)).toBe(false);
        expect(pedalStateAt(pedals, 1440)).toBe(false);
    });

    it('resolves a re-catch tick to down', () => {
        expect(pedalStateAt([down(0), up(1920), down(1920)], 1920)).toBe(true);
        expect(pedalStateAt([up(480), down(480)], 480)).toBe(true);
    });
});

describe('buildNoteShapes', () => {
    const shapes = buildNoteShapes(tinyScore);

    it('lines up index for index with the score note list', () => {
        expect(shapes).toHaveLength(tinyScore.notes.length);
    });

    it('rolls a chord from the bottom up, the way a hand lands on it', () => {
        // m.1's right-hand chord: E5 below, G5 above.
        expect(shapes[1]?.roll).toBe(0);
        expect(shapes[2]?.roll).toBe(CHORD_ROLL_S);
        // The left hand's lone C3 at the same tick is not part of that chord.
        expect(shapes[3]?.roll).toBe(0);
    });

    it('voices the top of a right-hand chord above what is under it', () => {
        expect(shapes[2]?.lift).toBe(MELODY_LIFT);
        expect(shapes[1]?.lift).toBe(0);
        // A single-line melody is still the tune — the pickup C5 is one note.
        expect(shapes[0]?.lift).toBe(MELODY_LIFT);
    });

    it('dips the left hand when the right is sounding, held or attacking', () => {
        // t=480: RH chord takes the tune, C3 is accompaniment.
        expect(shapes[3]?.lift).toBe(0);
        expect(shapes[3]?.dip).toBe(ACCOMP_DIP);
        // t=4320 attacks under the tie-merged RH A5 still held from m.2 —
        // that bass is accompaniment, not a new melody.
        const underHeld = tinyScore.notes.findIndex((n) => n.t === 4320);
        expect(shapes[underHeld]?.lift).toBe(0);
        expect(shapes[underHeld]?.dip).toBe(ACCOMP_DIP);
    });

    it('lifts a single right-hand melody note and dips the left-hand chord under it', () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 480, d: 480, p: 72, h: 0 },
                { t: 480, d: 480, p: 48, h: 1 },
                { t: 480, d: 480, p: 52, h: 1 },
            ],
        };
        const shaped = buildNoteShapes(score);
        expect(shaped[0]?.lift).toBe(MELODY_LIFT);
        expect(shaped[0]?.dip).toBe(0);
        expect(shaped[1]?.lift).toBe(0);
        expect(shaped[1]?.dip).toBe(ACCOMP_DIP);
        expect(shaped[2]?.lift).toBe(0);
        expect(shaped[2]?.dip).toBe(ACCOMP_DIP);
    });

    it('lifts the top of a left-hand-only onset and dips nothing', () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 480, d: 480, p: 48, h: 1 },
                { t: 480, d: 480, p: 60, h: 1 },
            ],
        };
        const shaped = buildNoteShapes(score);
        expect(shaped[1]?.lift).toBe(MELODY_LIFT);
        expect(shaped[0]?.lift).toBe(0);
        expect(shaped.every((s) => s.dip === 0)).toBe(true);
    });

    it('gives the lift to a left-hand note that sounds above the right', () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 480, d: 480, p: 60, h: 0 },
                { t: 480, d: 480, p: 72, h: 1 },
            ],
        };
        const shaped = buildNoteShapes(score);
        expect(shaped[1]?.lift).toBe(MELODY_LIFT);
        expect(shaped[1]?.dip).toBe(0);
        expect(shaped[0]?.lift).toBe(0);
        expect(shaped[0]?.dip).toBe(ACCOMP_DIP);
    });

    it('dips LH eighths under a held right-hand melody, and does not lift them', () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 480, d: 960, p: 72, h: 0 },
                { t: 480, d: 240, p: 48, h: 1 },
                { t: 720, d: 240, p: 52, h: 1 },
                { t: 960, d: 240, p: 55, h: 1 },
                { t: 1200, d: 240, p: 60, h: 1 },
            ],
        };
        const shaped = buildNoteShapes(score);
        expect(shaped[0]?.lift).toBe(MELODY_LIFT);
        expect(shaped[0]?.dip).toBe(0);
        for (const i of [1, 2, 3, 4]) {
            expect(shaped[i]?.lift).toBe(0);
            expect(shaped[i]?.dip).toBe(ACCOMP_DIP);
        }
    });

    it('lifts RH melody eighths over a sustained bass, and dips the bass only if the RH is already sounding', () => {
        const together: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 480, d: 1920, p: 48, h: 1 },
                { t: 480, d: 240, p: 72, h: 0 },
                { t: 720, d: 240, p: 74, h: 0 },
                { t: 960, d: 240, p: 76, h: 0 },
                { t: 1200, d: 240, p: 77, h: 0 },
            ],
        };
        const withRh = buildNoteShapes(together);
        expect(withRh[0]?.lift).toBe(0);
        expect(withRh[0]?.dip).toBe(ACCOMP_DIP);
        for (const i of [1, 2, 3, 4]) {
            expect(withRh[i]?.lift).toBe(MELODY_LIFT);
            expect(withRh[i]?.dip).toBe(0);
        }

        const bassFirst: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 0, d: 1920, p: 48, h: 1 },
                { t: 480, d: 240, p: 72, h: 0 },
            ],
        };
        const beforeRh = buildNoteShapes(bassFirst);
        expect(beforeRh[0]?.lift).toBe(MELODY_LIFT);
        expect(beforeRh[0]?.dip).toBe(0);
        expect(beforeRh[1]?.lift).toBe(MELODY_LIFT);
        expect(beforeRh[1]?.dip).toBe(0);
    });

    it('accents full bars and never the pickup', () => {
        // m.0 is a one-beat pickup; m.1 at tick 480 is the first real downbeat.
        expect(shapes[0]?.accent).toBe(0);
        expect(shapes[1]?.accent).toBe(DOWNBEAT_ACCENT);
        expect(shapes[3]?.accent).toBe(DOWNBEAT_ACCENT);
        // Tick 8400 is an offbeat eighth inside m.5.
        expect(shapes[12]?.accent).toBe(-OFFBEAT_DIP);
    });

    it('accents the 6/8 downbeat too, on its own bar length', () => {
        expect(shapes[10]?.accent).toBe(DOWNBEAT_ACCENT);
    });

    it('puts secondary weight on beat 3 in 4/4, and dips an eighth off the beat', () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 480, d: 240, p: 72, h: 0 },
                { t: 960, d: 240, p: 72, h: 0 },
                { t: 1440, d: 240, p: 72, h: 0 },
                { t: 1920, d: 240, p: 72, h: 0 },
                { t: 720, d: 240, p: 72, h: 0 },
            ],
        };
        const shaped = buildNoteShapes(score);
        expect(shaped[0]?.accent).toBe(DOWNBEAT_ACCENT);
        expect(shaped[1]?.accent).toBe(0);
        expect(shaped[2]?.accent).toBe(SECONDARY_ACCENT);
        expect(shaped[3]?.accent).toBe(0);
        expect(shaped[4]?.accent).toBe(-OFFBEAT_DIP);
    });

    it('accents the second dotted beat in 6/8', () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [{ t: 8880, d: 240, p: 72, h: 0 }],
        };
        expect(buildNoteShapes(score)[0]?.accent).toBe(SECONDARY_ACCENT);
    });

    it('gives a pickup no metrical weight, on or off the beat', () => {
        const score: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 0, d: 240, p: 72, h: 0 },
                { t: 240, d: 240, p: 72, h: 0 },
            ],
        };
        const shaped = buildNoteShapes(score);
        expect(shaped[0]?.accent).toBe(0);
        expect(shaped[1]?.accent).toBe(0);
    });

    it('caps the roll so a wide chord still lands as one event', () => {
        const cluster: ScoreData = {
            ...tinyScore,
            notes: [48, 55, 60, 64, 67, 72].map((p) => ({ t: 480, d: 480, p, h: 0 as const })),
        };
        expect(buildNoteShapes(cluster).map((s) => s.roll)).toEqual([
            0,
            CHORD_ROLL_S,
            2 * CHORD_ROLL_S,
            CHORD_ROLL_MAX_S,
            CHORD_ROLL_MAX_S,
            CHORD_ROLL_MAX_S,
        ]);
    });

    it('rolls by sounding pitch even when the notes arrive out of order', () => {
        const unordered: ScoreData = {
            ...tinyScore,
            notes: [
                { t: 480, d: 480, p: 72, h: 0 },
                { t: 480, d: 480, p: 60, h: 0 },
            ],
        };
        const rolled = buildNoteShapes(unordered);
        expect(rolled[0]?.roll).toBe(CHORD_ROLL_S);
        expect(rolled[1]?.roll).toBe(0);
    });
});

describe('buildPedalEnds', () => {
    const note = (t: number, d: number, p = 60): ScoreNote => ({ t, d, p, h: 0 });
    const down = (tick: number): ScorePedal => ({ tick, k: 'down' });
    const up = (tick: number): ScorePedal => ({ tick, k: 'up' });
    const END = tinyScore.totalTicks;

    it('leaves an unpedalled score exactly as written', () => {
        const written = tinyScore.notes.map((n) => n.t + n.d);
        expect(buildPedalEnds(tinyScore.notes, undefined, END)).toEqual(written);
        expect(buildPedalEnds(tinyScore.notes, [], END)).toEqual(written);
    });

    it('holds a note taken under the pedal until the foot lifts', () => {
        expect(buildPedalEnds([note(480, 480)], [down(0), up(1920)], END)).toEqual([1920]);
    });

    it('lets go at the lift, not at the next one', () => {
        // The foot came up long before this note ended; nothing is holding it.
        expect(buildPedalEnds([note(480, 480)], [down(0), up(720), down(1200), up(2400)], END)).toEqual([960]);
    });

    it('damps a note whose end falls on the lift itself', () => {
        // The later span must not reach back and pick this note up again.
        expect(buildPedalEnds([note(480, 480)], [down(0), up(960), down(1200), up(2400)], END)).toEqual([960]);
    });

    it('does not catch a note under a pedal taken as it ends', () => {
        // Syncopated pedalling: the foot falls after the hand lifts precisely so
        // the old harmony is released before the new one is held.
        expect(buildPedalEnds([note(480, 480)], [down(960), up(2400)], END)).toEqual([960]);
    });

    it('clears at a re-catch and holds only what follows it', () => {
        const notes = [note(0, 480, 60), note(1920, 480, 64)];
        const pedals = [down(0), up(1920), down(1920), up(3840)];
        expect(buildPedalEnds(notes, pedals, END)).toEqual([1920, 3840]);
    });

    it('keeps the written end when the pedal is never released', () => {
        // Implicit lift at the written end itself is a no-op: lift > end fails.
        expect(buildPedalEnds([note(480, 480)], [down(0)], 960)).toEqual([960]);
    });

    it('holds a trailing down to the end of the score', () => {
        expect(buildPedalEnds([note(480, 480)], [down(0)], 3840)).toEqual([3840]);
    });

    it('extends only notes after a trailing down that follows an earlier lift', () => {
        const notes = [note(0, 480), note(1920, 480)];
        const pedals = [down(0), up(960), down(1440)];
        expect(buildPedalEnds(notes, pedals, 3840)).toEqual([960, 3840]);
    });

    it('ignores pedalling that happens entirely after the note', () => {
        expect(buildPedalEnds([note(0, 480)], [down(1920), up(3840)], END)).toEqual([480]);
    });

    it('resolves each note against its own end, not the order they start in', () => {
        // A whole note and an eighth beginning together end far apart, so the
        // walk cannot assume note ends arrive sorted.
        const notes = [note(0, 3840, 60), note(480, 480, 62)];
        const pedals = [down(0), up(1920), down(2880), up(5760)];
        expect(buildPedalEnds(notes, pedals, END)).toEqual([5760, 1920]);
    });

    it('stays index-aligned with the note list it was given', () => {
        const ends = buildPedalEnds(tinyScore.notes, [down(0), up(13920)], END);
        expect(ends).toHaveLength(tinyScore.notes.length);
        // Every note in the score is inside the one span, so all of them ring on.
        expect(ends.every((end) => end === 13920)).toBe(true);
    });
});

describe('buildSoftClipCurve', () => {
    const curve = buildSoftClipCurve();
    const sampleAt = (x: number): number => {
        const index = Math.round(((x + 1) / 2) * (curve.length - 1));
        return curve[index] ?? 0;
    };

    it('is a straight wire below the knee', () => {
        // The clip must never colour normal material — only the ceiling factor
        // (a fraction of a dB) separates it from identity.
        for (const x of [0, 0.1, 0.25, 0.5, 0.79]) {
            expect(sampleAt(x)).toBeCloseTo(x * SOFTCLIP_CEILING, 3);
            expect(sampleAt(-x)).toBeCloseTo(-x * SOFTCLIP_CEILING, 3);
        }
    });

    it('never exceeds the ceiling and never reverses direction', () => {
        let previous = -Infinity;
        for (const value of curve) {
            expect(Math.abs(value)).toBeLessThanOrEqual(SOFTCLIP_CEILING);
            expect(value).toBeGreaterThanOrEqual(previous);
            previous = value;
        }
    });

    it('bends rather than folds at the knee', () => {
        // Above the knee the curve keeps rising but ever more slowly — a
        // saturation, not a hard corner that would spray harmonics.
        const atKnee = sampleAt(SOFTCLIP_KNEE);
        const above = sampleAt(0.9);
        const top = sampleAt(1);
        expect(above).toBeGreaterThan(atKnee);
        expect(top).toBeGreaterThan(above);
        expect(top - above).toBeLessThan(above - atKnee);
    });
});
