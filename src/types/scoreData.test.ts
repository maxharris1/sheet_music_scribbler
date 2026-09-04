import { afterEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { parseScoreData, SCORE_DATA_VERSION, tempoIsInferred } from '@/types/scoreData';
import type { ScoreData, ScorePedal } from '@/types/scoreData';

/**
 * A payload as it arrives from Postgres jsonb or the Dexie cache — `unknown` to
 * parseScoreData, so the fixture is deliberately not typed as ScoreData.
 */
const payload = (overrides: Record<string, unknown> = {}): unknown => ({
    ...tinyScore,
    version: SCORE_DATA_VERSION,
    ...overrides,
});

const score = (overrides: Partial<ScoreData> = {}): ScoreData => ({ ...tinyScore, ...overrides });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('parseScoreData', () => {
    it('puts pedal edges in tick order', () => {
        const parsed = parseScoreData(
            payload({
                pedals: [
                    { tick: 4800, k: 'up' },
                    { tick: 0, k: 'down' },
                    { tick: 2400, k: 'up' },
                ],
            }),
        );

        expect(parsed?.pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 2400, k: 'up' },
            { tick: 4800, k: 'up' },
        ]);
    });

    /**
     * The re-catch is the whole reason the sort must be stable: 'up' then 'down'
     * on one tick is a lift-and-retake, and swapping them leaves the damper down
     * across a change that exists precisely to clear it.
     */
    it('leaves a re-catch lifting before it retakes', () => {
        const parsed = parseScoreData(
            payload({
                pedals: [
                    { tick: 4800, k: 'up' },
                    { tick: 4800, k: 'down' },
                    { tick: 0, k: 'down' },
                ],
            }),
        );

        expect(parsed?.pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 4800, k: 'up' },
            { tick: 4800, k: 'down' },
        ]);
    });

    it('still reads a v1 cache that predates pedals', () => {
        const parsed = parseScoreData(payload({ version: 1, pedals: undefined }));

        expect(parsed?.version).toBe(1);
        expect(parsed?.pedals).toBeUndefined();
    });

    it('refuses a payload from a writer newer than it understands', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(parseScoreData(payload({ version: SCORE_DATA_VERSION + 1 }))).toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    /**
     * The reader's ceiling and the writer's `capPedals` cap must be the same
     * number, or the service ships a score its own clients reject wholesale.
     */
    it('rejects more pedal edges than the service is allowed to write', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const edges = (count: number): ScorePedal[] =>
            Array.from({ length: count }, (_, i) => ({ tick: i * 240, k: i % 2 === 0 ? 'down' : 'up' }) as ScorePedal);

        expect(parseScoreData(payload({ pedals: edges(256) }))?.pedals).toHaveLength(256);
        expect(parseScoreData(payload({ pedals: edges(257) }))).toBeNull();
    });
});

describe('tempoIsInferred', () => {
    it('owns up to a tempo read off an Italian term', () => {
        expect(tempoIsInferred(score({ tempos: [{ tick: 0, bpm: 108, src: 'word' }] }))).toBe(true);
    });

    /**
     * Both warning branches exist for scores with no `tempos[0]` to look at: a
     * shard merge that lost the map, and a meter-derived guess, which is carried
     * as `defaultBpm` plus a warning because a new `src` value would fail the
     * strict enum on already-deployed clients.
     */
    it('owns up to a tempo the merge lost or the meter guessed', () => {
        expect(tempoIsInferred(score({ tempos: undefined, warnings: ['tempo_inferred'] }))).toBe(true);
        expect(tempoIsInferred(score({ tempos: undefined, warnings: ['tempo_defaulted'] }))).toBe(true);
    });

    it('stays quiet about a printed metronome mark', () => {
        expect(tempoIsInferred(score({ tempos: [{ tick: 0, bpm: 132, src: 'metronome' }], warnings: [] }))).toBe(false);
    });

    /**
     * Warnings are score-wide — the merge unions them across shards — so a
     * second half that prints no tempo of its own must not turn the metronome
     * mark at the top of page 1 into a guess.
     */
    it('stays quiet when a printed opening tempo outranks a warning from later in the score', () => {
        const printed: ScoreData['tempos'] = [{ tick: 0, bpm: 96, src: 'metronome' }];
        expect(tempoIsInferred(score({ tempos: printed, warnings: ['tempo_defaulted'] }))).toBe(false);
        expect(tempoIsInferred(score({ tempos: printed, warnings: ['tempo_inferred'] }))).toBe(false);
    });

    /**
     * The converse must hold too: the service ships `tempo_defaulted` precisely
     * when the opening itself was guessed, and a score whose first printed
     * tempo arrives pages in still opens on that guess. A map with entries is
     * not a map with an opening.
     */
    it('owns up to a guessed opening even when a tempo is printed later in the score', () => {
        const later: ScoreData['tempos'] = [{ tick: 1920, bpm: 132, src: 'sound' }];
        expect(tempoIsInferred(score({ tempos: later, warnings: ['tempo_defaulted'] }))).toBe(true);
        expect(tempoIsInferred(score({ tempos: later, warnings: [] }))).toBe(false);
    });
});
