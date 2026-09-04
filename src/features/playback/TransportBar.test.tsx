import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { TransportBar } from '@/features/playback/TransportBar';
import type { TransportBarProps } from '@/features/playback/TransportBar';
import { useViewerStore } from '@/state/store';

const makeEngine = () => {
    return {
        play: vi.fn(async () => {}),
        pause: vi.fn(),
        stop: vi.fn(),
        seek: vi.fn(),
        getPositionTicks: vi.fn(() => 0),
    } as unknown as PlaybackEngine;
};

const renderBar = (overrides: Partial<TransportBarProps> = {}) => {
    const engine = makeEngine();
    const props: TransportBarProps = {
        state: {
            kind: 'ready',
            score: tinyScore,
            bpmDefault: 90,
            bpmOverride: null,
            engineVersion: 'audiveris-5.6.1+svc-5',
        },
        role: 'owner',
        onGenerate: vi.fn(),
        getEngine: () => engine,
        pageCount: 2,
        warning: null,
        onDismissWarning: vi.fn(),
        ...overrides,
    };
    const utils = render(<TransportBar {...props} />);
    return { engine, props, ...utils };
};

beforeEach(() => {
    act(() => useViewerStore.getState().resetPlayback());
});

afterEach(cleanup);

const setStore = (mutate: () => void) => act(mutate);

describe('TransportBar states', () => {
    it('renders nothing when unavailable', () => {
        const { container } = renderBar({ state: { kind: 'unavailable' } });
        expect(container).toBeEmptyDOMElement();
    });

    it('offers Generate to owners, passive text to viewers', async () => {
        const onGenerate = vi.fn();
        renderBar({ state: { kind: 'none' }, onGenerate });
        await userEvent.click(screen.getByRole('button', { name: /generate play-along/i }));
        expect(onGenerate).toHaveBeenCalled();

        renderBar({ state: { kind: 'none' }, role: 'viewer' });
        expect(screen.getByText(/no play-along for this score yet/i)).toBeInTheDocument();
        expect(screen.queryAllByRole('button', { name: /generate/i })).toHaveLength(1); // only the owner's
    });

    it('shows analysis progress', () => {
        renderBar({ state: { kind: 'processing', progress: 2 } });
        expect(screen.getByRole('status')).toHaveTextContent('Analyzing score… 2 / 2 pages');
    });

    it('maps failure codes to friendly copy with Retry for editors only', () => {
        renderBar({ state: { kind: 'failed', code: 'no_staves_found' }, role: 'editor' });
        expect(screen.getByText(/couldn't find readable music/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

        renderBar({ state: { kind: 'failed', code: 'queue_full' }, role: 'viewer' });
        expect(screen.getByText(/busy/i)).toBeInTheDocument();
        expect(screen.queryAllByRole('button', { name: /retry/i })).toHaveLength(1);
    });
});

describe('TransportBar ready controls', () => {
    it('play, pause and rewind are separate controls that each hit the engine', async () => {
        const { engine } = renderBar();
        await userEvent.click(screen.getByRole('button', { name: 'Play' }));
        expect(engine.play).toHaveBeenCalledWith({ countIn: true });

        await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
        expect(engine.pause).toHaveBeenCalled();

        await userEvent.click(screen.getByRole('button', { name: /rewind to start/i }));
        expect(engine.stop).toHaveBeenCalled();
    });

    it('does not restart playback when Play is pressed mid-play', async () => {
        const { engine } = renderBar();
        setStore(() => useViewerStore.getState().setPlaybackStatus('playing'));
        await userEvent.click(screen.getByRole('button', { name: 'Play' }));
        expect(engine.play).not.toHaveBeenCalled();
    });

    it('measure steppers hit the engine', async () => {
        const { engine } = renderBar();
        await userEvent.click(screen.getByRole('button', { name: /next measure/i }));
        expect(engine.seek).toHaveBeenCalledWith(480); // m0 → m1 barline
    });

    it('shows the printed measure number and total', () => {
        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(5));
        renderBar();
        expect(screen.getByText('m. 5 / 8')).toBeInTheDocument();
    });

    it('shows the time signature in force at the playhead', () => {
        const shifting = {
            ...tinyScore,
            timeSignatures: [
                { tick: 0, num: 4, den: 4 },
                { tick: 960, num: 3, den: 8 },
            ],
        };
        renderBar({
            state: {
                kind: 'ready',
                score: shifting,
                bpmDefault: null,
                bpmOverride: null,
                engineVersion: 'audiveris-5.6.1+svc-5',
            },
        });
        expect(screen.getByLabelText('Time signature 4/4')).toBeInTheDocument();

        cleanup();
        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(3)); // tick 1440
        renderBar({
            state: {
                kind: 'ready',
                score: shifting,
                bpmDefault: null,
                bpmOverride: null,
                engineVersion: 'audiveris-5.6.1+svc-5',
            },
        });
        expect(screen.getByLabelText('Time signature 3/8')).toBeInTheDocument();
    });

    it('bpm steps by one and clamps into range', async () => {
        renderBar();
        setStore(() => useViewerStore.getState().setBpm(100));
        await userEvent.click(screen.getByRole('button', { name: 'Faster' }));
        expect(useViewerStore.getState().bpm).toBe(101);
        await userEvent.click(screen.getByRole('button', { name: 'Slower' }));
        expect(useViewerStore.getState().bpm).toBe(100);

        setStore(() => useViewerStore.getState().setBpm(41));
        await userEvent.click(screen.getByRole('button', { name: 'Slower' }));
        expect(useViewerStore.getState().bpm).toBe(40);
        await userEvent.click(screen.getByRole('button', { name: 'Slower' }));
        expect(useViewerStore.getState().bpm).toBe(40); // clamped at BPM_MIN
    });

    it('bpm can be typed, and commits clamped on blur', async () => {
        renderBar();
        const field = screen.getByRole('textbox', { name: /tempo in beats per minute/i });
        await userEvent.clear(field);
        await userEvent.type(field, '137');
        expect(useViewerStore.getState().bpm).toBe(100); // uncommitted while typing
        await userEvent.tab();
        expect(useViewerStore.getState().bpm).toBe(137);

        await userEvent.clear(field);
        await userEvent.type(field, '900');
        await userEvent.tab();
        expect(useViewerStore.getState().bpm).toBe(240); // clamped at BPM_MAX
    });

    it('hand mutes toggle store state with aria-pressed', async () => {
        renderBar();
        const lh = screen.getByRole('button', { name: /mute left hand/i });
        expect(lh).toHaveAttribute('aria-pressed', 'false');
        await userEvent.click(lh);
        expect(useViewerStore.getState().muteLH).toBe(true);
        expect(screen.getByRole('button', { name: /mute left hand/i })).toHaveAttribute('aria-pressed', 'true');
    });

    it('disables the left hand for single-staff scores', () => {
        const rhOnly = { ...tinyScore, notes: tinyScore.notes.filter((n) => n.h === 0) };
        renderBar({
            state: {
                kind: 'ready',
                score: rhOnly,
                bpmDefault: null,
                bpmOverride: null,
                engineVersion: 'audiveris-5.6.1+svc-5',
            },
        });
        expect(screen.getByRole('button', { name: /mute left hand/i })).toBeDisabled();
    });

    it('loop is a plain on/off toggle that opens a real range at the playhead', async () => {
        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(2));
        renderBar();
        await userEvent.click(screen.getByRole('button', { name: /loop a few bars/i }));
        expect(useViewerStore.getState().loopRange).toEqual({ a: 2, b: 5 }); // four bars

        await userEvent.click(screen.getByRole('button', { name: /turn off the loop/i }));
        expect(useViewerStore.getState().loopRange).toBeNull();
    });

    it('clamps a loop opened on the last bar of the score', async () => {
        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(8)); // last index
        renderBar();
        await userEvent.click(screen.getByRole('button', { name: /loop a few bars/i }));
        expect(useViewerStore.getState().loopRange).toEqual({ a: 8, b: 8 });
    });

    it('nudges each loop edge by a bar, never letting them cross', async () => {
        setStore(() => useViewerStore.getState().setLoopRange({ a: 2, b: 3 }));
        renderBar();
        await userEvent.click(screen.getByRole('button', { name: /move loop end forward one bar/i }));
        expect(useViewerStore.getState().loopRange).toEqual({ a: 2, b: 4 });
        await userEvent.click(screen.getByRole('button', { name: /move loop start back one bar/i }));
        expect(useViewerStore.getState().loopRange).toEqual({ a: 1, b: 4 });

        // Dragging the end below the start carries the start with it.
        for (let i = 0; i < 4; i++) {
            await userEvent.click(screen.getByRole('button', { name: /move loop end back one bar/i }));
        }
        expect(useViewerStore.getState().loopRange).toEqual({ a: 0, b: 0 });
    });

    it('"Start here" moves the loop start to the playhead', async () => {
        setStore(() => {
            useViewerStore.getState().setLoopRange({ a: 0, b: 5 });
            useViewerStore.getState().setCurrentMeasureIndex(3);
        });
        renderBar();
        await userEvent.click(screen.getByRole('button', { name: /start here/i }));
        expect(useViewerStore.getState().loopRange).toEqual({ a: 3, b: 5 });
    });

    it('shows the dotted-quarter equivalent for compound meters', () => {
        setStore(() => useViewerStore.getState().setBpm(90));
        const compound = { ...tinyScore, timeSignatures: [{ tick: 0, num: 6, den: 8 }] };
        renderBar({
            state: {
                kind: 'ready',
                score: compound,
                bpmDefault: null,
                bpmOverride: null,
                engineVersion: 'audiveris-5.6.1+svc-5',
            },
        });
        expect(screen.getByText(/♩· = 60/)).toBeInTheDocument();

        cleanup();
        renderBar(); // 4/4 score — quarter display only
        expect(screen.queryByText(/♩· =/)).not.toBeInTheDocument();
    });

    it('surfaces the resume-follow affordance when following is suspended', async () => {
        setStore(() => useViewerStore.getState().setFollowMode('suspended'));
        renderBar();
        const resume = screen.getByRole('button', { name: /resume auto-follow/i });
        await userEvent.click(resume);
        expect(useViewerStore.getState().followMode).toBe('on');
    });
});

describe('analysis warnings', () => {
    const withWarnings = (warnings: string[]) =>
        renderBar({
            state: {
                kind: 'ready',
                score: { ...tinyScore, warnings },
                bpmDefault: 90,
                bpmOverride: null,
                engineVersion: 'audiveris-5.6.1+svc-5',
            },
        });

    it('says nothing when the analysis was clean', () => {
        withWarnings([]);
        expect(screen.queryByRole('button', { name: /things? to know/i })).toBeNull();
    });

    it('discloses that repeats were dropped, collapsed until asked', () => {
        withWarnings(['repeats_ignored']);
        const toggle = screen.getByRole('button', { name: /1 thing to know/i });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText(/first and second endings/i)).toBeNull();
    });

    it('explains each warning once expanded', async () => {
        withWarnings(['repeats_ignored', 'measure_underfull']);
        await userEvent.click(screen.getByRole('button', { name: /2 things to know/i }));
        expect(screen.getByText(/first and second endings/i)).toBeInTheDocument();
        expect(screen.getByText(/padded, so notes there may fall early/i)).toBeInTheDocument();
    });

    it('ranks the most misleading warning first', async () => {
        withWarnings(['grace_notes_skipped', 'no_geometry', 'repeats_ignored']);
        await userEvent.click(screen.getByRole('button', { name: /3 things to know/i }));
        const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
        expect(items[0]).toMatch(/repeats/i);
    });

    it('warns before the bar count starts revisiting bars', async () => {
        withWarnings(['jumps_performed']);
        await userEvent.click(screen.getByRole('button', { name: /1 thing to know/i }));
        expect(screen.getByText(/playhead jumps back/i)).toBeInTheDocument();
    });

    it('explains a roadmap it could not follow and a tempo nobody printed', async () => {
        withWarnings(['jumps_ignored', 'tempo_defaulted', 'tempo_inferred']);
        await userEvent.click(screen.getByRole('button', { name: /3 things to know/i }));
        expect(screen.getByText(/plays straight through in page order/i)).toBeInTheDocument();
        expect(screen.getByText(/chosen from the time signature/i)).toBeInTheDocument();
        expect(screen.getByText(/estimated from the tempo word/i)).toBeInTheDocument();
    });

    it('explains realised ornaments and swung eighths', async () => {
        withWarnings(['ornaments_realized', 'swing_applied']);
        await userEvent.click(screen.getByRole('button', { name: /2 things to know/i }));
        expect(
            screen.getByText(/trills, mordents, turns and arpeggio signs are played out as written/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/pairs of eighth notes are played long–short/i)).toBeInTheDocument();
    });

    it('ignores codes it has no copy for rather than leaking them raw', () => {
        withWarnings(['something_new_from_the_service']);
        expect(screen.queryByRole('button', { name: /things? to know/i })).toBeNull();
        expect(screen.queryByText(/something_new_from_the_service/)).toBeNull();
    });
});

describe('tempo disclosure and stale analyses', () => {
    const ready = (
        over: Partial<Parameters<typeof renderBar>[0]> = {},
        score = tinyScore,
        engine: string | null = 'audiveris-5.6.1+svc-9',
    ) =>
        renderBar({
            state: { kind: 'ready', score, bpmDefault: 90, bpmOverride: null, engineVersion: engine },
            ...over,
        });

    it('marks a tempo estimated from a word rather than passing it off as printed', () => {
        ready({}, { ...tinyScore, tempos: [{ tick: 0, bpm: 94, src: 'word' }] });
        expect(screen.getByText('est.')).toBeInTheDocument();
    });

    it('does not mark a printed tempo as estimated', () => {
        ready({}, { ...tinyScore, tempos: [{ tick: 0, bpm: 94, src: 'metronome' }] });
        expect(screen.queryByText('est.')).toBeNull();
    });

    /**
     * Warnings are score-wide: a shard covering the second half prints no tempo
     * of its own and says so, which must not cast doubt on the metronome mark
     * engraved at the top of the first page.
     */
    it('leaves a printed tempo alone when a later part of the score guessed one', () => {
        ready({}, { ...tinyScore, tempos: [{ tick: 0, bpm: 94, src: 'metronome' }], warnings: ['tempo_defaulted'] });
        expect(screen.queryByText('est.')).toBeNull();
    });

    it('says the tempo came from the meter when the score prints none at all', () => {
        ready({}, { ...tinyScore, tempos: undefined, warnings: ['tempo_defaulted'] });
        expect(screen.getByText('est.').getAttribute('title')).toMatch(/time signature/i);
    });

    it('says the tempo came off a tempo word when one was printed without a number', () => {
        ready({}, { ...tinyScore, tempos: [{ tick: 0, bpm: 94, src: 'word' }] });
        expect(screen.getByText('est.').getAttribute('title')).toMatch(/tempo marking/i);
    });

    it('says the meter guessed the opening when a tempo word arrives later', () => {
        ready({}, { ...tinyScore, tempos: [{ tick: 960, bpm: 120, src: 'word' }], warnings: ['tempo_defaulted'] });
        expect(screen.getByText('est.').getAttribute('title')).toMatch(/time signature/i);
    });

    it('does not treat a later tempo word as the opening estimate', () => {
        ready({}, { ...tinyScore, tempos: [{ tick: 960, bpm: 120, src: 'word' }], warnings: [] });
        expect(screen.queryByText('est.')).toBeNull();
    });

    it('offers to regenerate an analysis made by an older engine', async () => {
        const onGenerate = vi.fn();
        ready({ onGenerate }, tinyScore, 'audiveris-5.6.1+svc-2');
        await userEvent.click(screen.getByRole('button', { name: /regenerate it/i }));
        expect(onGenerate).toHaveBeenCalled();
    });

    it('says nothing when the analysis is current', () => {
        ready();
        expect(screen.queryByRole('button', { name: /regenerate it/i })).toBeNull();
    });

    it('offers a re-run for an analysis with no engine stamp at all', () => {
        // The oldest rows predate version stamping; they are the ones that most
        // need regenerating, and a null must not read as "current".
        ready({}, tinyScore, null);
        expect(screen.getByRole('button', { name: /regenerate it/i })).toBeInTheDocument();
    });

    it('does not offer a re-run to someone who cannot start one', () => {
        ready({ role: 'viewer' }, tinyScore, 'audiveris-5.6.1+svc-2');
        expect(screen.queryByRole('button', { name: /regenerate it/i })).toBeNull();
    });
});

describe('repeated bars in the measure counter', () => {
    const shift = tinyScore.totalTicks;
    const repeated = {
        ...tinyScore,
        measures: [
            ...tinyScore.measures.map((m, i) => ({ ...m, srcIndex: i })),
            ...tinyScore.measures.slice(0, 3).map((m, i) => ({ ...m, srcIndex: i, tick: m.tick + shift })),
        ].sort((a, b) => a.tick - b.tick),
        totalTicks: shift * 2,
    };

    const renderWith = (score: typeof tinyScore) =>
        renderBar({
            state: { kind: 'ready', score, bpmDefault: 90, bpmOverride: null, engineVersion: 'audiveris-5.6.1+svc-5' },
        });

    it('marks which pass of a repeated bar the loop range names', async () => {
        renderWith(repeated);
        // The loop labels name bars; a bar performed twice must say which time.
        act(() => useViewerStore.getState().setLoopRange({ a: 0, b: 2 }));
        expect(document.body.textContent).toMatch(/\(1st\)/);
    });

    it('leaves bar numbers alone when nothing repeats', () => {
        renderWith(tinyScore);
        act(() => useViewerStore.getState().setLoopRange({ a: 0, b: 2 }));
        expect(document.body.textContent).not.toMatch(/\(1st\)|\(2nd\)/);
    });

    /**
     * "D.C. al Fine": bars 1–24, then 1–12 again, and the playthrough stops on
     * the Fine bar. The last bar performed is m. 12, but the score is still 24
     * bars long — counting against the performance would print "m. 21 / 12".
     */
    it('counts against the printed extent when a jump ends the playthrough early', () => {
        const printed = Array.from({ length: 24 }, (_, i) => ({
            n: i + 1,
            tick: i * 1920,
            dTicks: 1920,
            page: 0,
            sys: 0,
            x0: 0.08,
            x1: 0.92,
            srcIndex: i,
        }));
        const alFine = {
            ...tinyScore,
            measures: [...printed, ...printed.slice(0, 12).map((m, i) => ({ ...m, tick: (24 + i) * 1920 }))],
            totalTicks: 36 * 1920,
            warnings: ['jumps_performed'],
        };

        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(20)); // m. 21, first pass
        renderWith(alFine);
        expect(screen.getByText('m. 21 / 24')).toBeInTheDocument();
    });
});
