import { capHolds, capPedals, capTempoEvents } from './caps.js';
import { ERROR_CODES, JobError } from './errors.js';
import type { StructureSummary } from './repeats.js';
import { activeTimeSigAt } from './seamCompare.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER, scoreDataSchema } from './scoreData.js';
import type { ScoreData, ScoreTimeSig } from './scoreData.js';

export interface ScoreDataPart {
    score: ScoreData;
    /** 1-based inclusive Audiveris sheet range this part was transcribed from. */
    sheets: { from: number; to: number };
    /** Unresolved tie-starts at end of this part's MusicXML (from parse). */
    openTiesAtEnd?: number;
    /** What this part's repeat and jump marks imply beyond its own page range. */
    structure?: StructureSummary;
}

/**
 * Concatenate page-range ScoreData parts into one play-along score.
 * When ranges overlap by one page, the later part drops the overlap page and
 * may inherit time/key/clef from the earlier part.
 */
export const mergeScoreDataParts = (parts: ScoreDataPart[]): ScoreData => {
    if (parts.length === 0) {
        throw new JobError(ERROR_CODES.internal, 'mergeScoreDataParts: no parts');
    }
    if (parts.length === 1) {
        return parts[0]!.score;
    }

    const sorted = [...parts].sort((a, b) => a.sheets.from - b.sheets.from);
    let tickOffset = 0;
    let measureN = 1;
    const notes: ScoreData['notes'] = [];
    const measures: ScoreData['measures'] = [];
    const systems: ScoreData['systems'] = [];
    const timeSignatures: ScoreData['timeSignatures'] = [];
    const keySignatures: NonNullable<ScoreData['keySignatures']> = [];
    const clefs: NonNullable<ScoreData['clefs']> = [];
    const tempos: NonNullable<ScoreData['tempos']> = [];
    const holds: NonNullable<ScoreData['holds']> = [];
    const pedals: NonNullable<ScoreData['pedals']> = [];
    const warnings = new Set<string>();
    let defaultBpm: number | null = null;
    /**
     * Whether the part that supplied the surviving `defaultBpm` was the one
     * guessing it from the meter. `tempo_defaulted` is a statement about the
     * opening of the finished score, not about one shard: a heading is printed
     * on page 1 only, so the second shard of any score is normally tempo-less
     * and would otherwise tell the reader that nothing was printed anywhere.
     */
    let defaultedAtOpening = false;
    /**
     * How far this part's engraved-bar identities must be pushed to clear every
     * identity the earlier parts already claimed. Each part numbered its own
     * bars from zero, and three client consumers — pass ordinals, loop-seam
     * detection, fingering-region grouping — read srcIndex as an identity that
     * only ever grows across the merged score.
     */
    let srcBase = 0;
    let prev: ScoreDataPart | null = null;

    for (const part of sorted) {
        const { score, sheets } = part;
        for (const w of score.warnings) {
            // Travels with the guess it describes, re-added after the loop, or
            // not at all: a later part's guess is discarded here, so its
            // disclosure has nothing left to disclose.
            if (w === 'tempo_defaulted') {
                continue;
            }
            warnings.add(w);
        }
        if (defaultBpm === null && score.defaultBpm !== null) {
            defaultBpm = score.defaultBpm;
            defaultedAtOpening = score.warnings.includes('tempo_defaulted');
        }

        const overlapPage0 =
            prev && prev.sheets.to >= sheets.from ? sheets.from - 1 : null;

        let working = score;
        if (overlapPage0 !== null) {
            working = dropPageFromScore(score, overlapPage0, sheets.from);
            warnings.add('merged_dropped_overlap_page');
        }

        const inherited = maybeInheritAttributes(working, timeSignatures, keySignatures, clefs, tickOffset);
        working = inherited.score;
        for (const w of inherited.warnings) {
            warnings.add(w);
        }

        // After dropping the overlap (first page of this range), remaining pages
        // start at sheets.from+1.
        const mapFrom = overlapPage0 !== null ? sheets.from + 1 : sheets.from;
        const pageMap = buildPageMap(working, mapFrom, overlapPage0);
        const sysOffset = systems.length;

        for (const system of working.systems) {
            const page = pageMap.get(system.page) ?? system.page;
            if (overlapPage0 !== null && page === overlapPage0) {
                continue;
            }
            systems.push({ ...system, page });
        }

        const localDroppedTicks = new Set<number>();
        for (const [localIndex, measure] of working.measures.entries()) {
            const page =
                measure.page < 0 ? -1 : (pageMap.get(measure.page) ?? measure.page);
            if (overlapPage0 !== null && page === overlapPage0) {
                for (let t = measure.tick; t < measure.tick + measure.dTicks; t++) {
                    localDroppedTicks.add(t);
                }
                continue;
            }
            const sys = measure.sys < 0 ? -1 : measure.sys + sysOffset;
            measures.push({
                ...measure,
                n: measureN++,
                tick: measure.tick + tickOffset,
                srcIndex: (measure.srcIndex ?? localIndex) + srcBase,
                page,
                sys,
            });
        }

        for (const note of working.notes) {
            if (localDroppedTicks.has(note.t)) {
                continue;
            }
            // Also drop notes whose start falls inside a dropped measure range
            // even if tick wasn't enumerated (sparse).
            if (overlapPage0 !== null && noteOnDroppedPage(working, note.t, overlapPage0, pageMap)) {
                continue;
            }
            notes.push({ ...note, t: note.t + tickOffset });
        }
        for (const ts of working.timeSignatures) {
            if (overlapPage0 !== null && noteOnDroppedPage(working, ts.tick, overlapPage0, pageMap)) {
                continue;
            }
            timeSignatures.push({ ...ts, tick: ts.tick + tickOffset });
        }
        for (const ks of working.keySignatures ?? []) {
            if (overlapPage0 !== null && noteOnDroppedPage(working, ks.tick, overlapPage0, pageMap)) {
                continue;
            }
            keySignatures.push({ ...ks, tick: ks.tick + tickOffset });
        }
        for (const clef of working.clefs ?? []) {
            if (overlapPage0 !== null && noteOnDroppedPage(working, clef.tick, overlapPage0, pageMap)) {
                continue;
            }
            clefs.push({ ...clef, tick: clef.tick + tickOffset });
        }
        // Tempo at the seam is seeded, not inherited. Shard B is parsed with
        // shard A's expression state at the overlap page, so a rit. that A
        // carried in and an a tempo that B opens with actually meet. Concatenating
        // the maps still works after that: A's last point is the pulse in force
        // when B's first surviving tick arrives, and restating it would only
        // add a point that says what the reader already knows.
        for (const tempo of working.tempos ?? []) {
            if (overlapPage0 !== null && noteOnDroppedPage(working, tempo.tick, overlapPage0, pageMap)) {
                continue;
            }
            tempos.push({ ...tempo, tick: tempo.tick + tickOffset });
        }
        for (const hold of working.holds ?? []) {
            if (overlapPage0 !== null && noteOnDroppedPage(working, hold.tick, overlapPage0, pageMap)) {
                continue;
            }
            holds.push({ ...hold, tick: hold.tick + tickOffset });
        }
        // Pedal edges are moments, so unlike time/key/clef there is nothing to
        // inherit at the seam: a depression in part A that part B never releases
        // is a lost edge in the engraving, and the merge has no way to invent
        // the release without guessing where the harmony changed.
        for (const pedal of working.pedals ?? []) {
            if (overlapPage0 !== null && noteOnDroppedPage(working, pedal.tick, overlapPage0, pageMap)) {
                continue;
            }
            pedals.push({ ...pedal, tick: pedal.tick + tickOffset });
        }

        // Taken over the whole array rather than only the measures pushed above:
        // the base must clear every identity this part could have emitted, so a
        // bar skipped at the seam is still not handed out again by the next part.
        const maxSrcIndex = working.measures.reduce(
            (highest, m, i) => Math.max(highest, m.srcIndex ?? i),
            -1,
        );
        srcBase += maxSrcIndex + 1;

        const keptMeasures = working.measures.filter((m) => {
            const page = m.page < 0 ? -1 : (pageMap.get(m.page) ?? m.page);
            return !(overlapPage0 !== null && page === overlapPage0);
        });
        const partTicks =
            keptMeasures.length > 0
                ? Math.max(...keptMeasures.map((m) => m.tick + m.dTicks))
                : working.totalTicks;
        tickOffset += partTicks;
        prev = part;
    }

    if (timeSignatures.length === 0) {
        warnings.add('merged_missing_time_signature');
    }
    if (defaultedAtOpening) {
        warnings.add('tempo_defaulted');
    }

    // Two parts that each fit the schema comfortably can breach it once joined,
    // and the self-check below rejects the whole score when they do.
    const cappedTempos = capTempoEvents(tempos);
    const cappedHolds = capHolds(holds);
    const cappedPedals = capPedals(pedals);

    const candidate: ScoreData = {
        version: SCORE_DATA_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm,
        timeSignatures,
        ...(keySignatures.length > 0 ? { keySignatures } : {}),
        ...(clefs.length > 0 ? { clefs } : {}),
        ...(cappedTempos.length > 0 ? { tempos: cappedTempos } : {}),
        ...(cappedHolds.length > 0 ? { holds: cappedHolds } : {}),
        ...(cappedPedals.length > 0 ? { pedals: cappedPedals } : {}),
        totalTicks: Math.max(1, tickOffset),
        notes,
        measures,
        systems,
        warnings: [...warnings].slice(0, 32),
    };

    const checked = scoreDataSchema.safeParse(candidate);
    if (!checked.success) {
        throw new JobError(
            ERROR_CODES.internal,
            `Merged ScoreData failed self-check: ${checked.error.issues[0]?.message}`,
        );
    }
    return checked.data;
};

/**
 * Split into N ranges that share `overlapPages` at each interior boundary.
 * Production uses n=2: pageCount=5, overlap=1 → [{1,3},{3,5}].
 */
export const splitSheetRangesOverlapping = (
    pageCount: number,
    n: number,
    overlapPages = 1,
): Array<{ from: number; to: number }> => {
    if (pageCount < 1 || n < 1) {
        return [];
    }
    const shards = Math.min(n, pageCount);
    if (shards === 1) {
        return [{ from: 1, to: pageCount }];
    }
    const overlap = Math.max(0, Math.min(overlapPages, pageCount - 1));
    if (shards === 2) {
        const mid = Math.ceil(pageCount / 2);
        const aTo = Math.min(pageCount, mid + Math.max(0, overlap - 1));
        const bFrom = Math.max(1, mid - Math.max(0, overlap - 1));
        // Ensure overlap: aTo >= bFrom when overlap >= 1
        if (overlap >= 1) {
            const cut = mid;
            return [
                { from: 1, to: Math.min(pageCount, cut + overlap - 1) },
                { from: Math.max(1, cut - overlap + 1), to: pageCount },
            ];
        }
        return [
            { from: 1, to: aTo },
            { from: bFrom, to: pageCount },
        ];
    }
    // n>2: fall back to disjoint cores (unused in production).
    return splitSheetRanges(pageCount, shards);
};

/** Split 1-based page count into up to `n` contiguous sheet ranges (no overlap). */
export const splitSheetRanges = (
    pageCount: number,
    n: number,
): Array<{ from: number; to: number }> => {
    if (pageCount < 1 || n < 1) {
        return [];
    }
    const shards = Math.min(n, pageCount);
    const ranges: Array<{ from: number; to: number }> = [];
    let start = 1;
    for (let i = 0; i < shards; i++) {
        const remainingPages = pageCount - start + 1;
        const remainingShards = shards - i;
        const size = Math.ceil(remainingPages / remainingShards);
        const end = start + size - 1;
        ranges.push({ from: start, to: end });
        start = end + 1;
    }
    return ranges;
};

/** Whether parallel merge should fall back to a full serial Audiveris run. */
export const seamIsUnsafe = (parts: ScoreDataPart[]): { unsafe: boolean; reasons: string[] } => {
    const reasons: string[] = [];
    const sorted = [...parts].sort((a, b) => a.sheets.from - b.sheets.from);
    // A jump is a statement about the whole score, so it is judged per part and
    // not per seam: the segno a D.S. returns to may be printed in a range this
    // shard never saw, and each half would then plan a roadmap that is plausible
    // and wrong. Only a serial run has the page in front of it.
    for (const part of sorted) {
        if (part.structure?.hasJumpMarks) {
            reasons.push(`structure_jumps sheets=${part.sheets.from}-${part.sheets.to}`);
        }
    }
    for (let i = 0; i < sorted.length - 1; i++) {
        const earlier = sorted[i]!;
        const later = sorted[i + 1]!;
        if ((earlier.openTiesAtEnd ?? 0) > 0) {
            reasons.push(`open_ties_at_end sheets=${earlier.sheets.from}-${earlier.sheets.to}`);
        }
        // A repeat or volta whose two halves land in different shards is planned
        // twice, once by each half, and neither planning is the one engraved:
        // the earlier shard never retakes, the later one returns to a top it
        // does not contain. Concatenation cannot repair either.
        if (
            earlier.structure?.openForwardAtEnd ||
            earlier.structure?.openVoltaAtEnd ||
            later.structure?.bareBackwardAtStart
        ) {
            reasons.push(`repeat_seam sheets=${earlier.sheets.from}-${earlier.sheets.to}`);
        }
        const earlierSig = activeTimeSigAt(
            earlier.score.timeSignatures,
            Math.max(0, earlier.score.totalTicks - 1),
        );
        const laterSig =
            activeTimeSigAt(later.score.timeSignatures, 0) ??
            later.score.timeSignatures[0] ??
            null;
        if (earlierSig && laterSig && (earlierSig.num !== laterSig.num || earlierSig.den !== laterSig.den)) {
            // Inherit may fix empty later; disagreement with an explicit later sig is unsafe.
            if (later.score.timeSignatures.some((s) => s.tick === 0)) {
                reasons.push(
                    `meter_seam ${earlierSig.num}/${earlierSig.den} vs ${laterSig.num}/${laterSig.den}`,
                );
            }
        }
    }
    return { unsafe: reasons.length > 0, reasons };
};

const dropPageFromScore = (
    score: ScoreData,
    absolutePage0: number,
    sheetFrom1Based: number,
): ScoreData => {
    // Map local page ids → absolute, then filter absolutePage0.
    const pageMap = buildPageMap(score, sheetFrom1Based, null);
    const dropLocal = [...pageMap.entries()].find(([, abs]) => abs === absolutePage0)?.[0];
    if (dropLocal === undefined) {
        return score;
    }
    const measures = score.measures.filter((m) => m.page !== dropLocal);
    const systems = score.systems.filter((s) => s.page !== dropLocal);
    const droppedRanges = score.measures
        .filter((m) => m.page === dropLocal)
        .map((m) => ({ start: m.tick, end: m.tick + m.dTicks }));
    const inDropped = (t: number) => droppedRanges.some((r) => t >= r.start && t < r.end);
    const notes = score.notes.filter((n) => !inDropped(n.t));
    const timeSignatures = score.timeSignatures.filter((s) => !inDropped(s.tick));
    const keySignatures = (score.keySignatures ?? []).filter((s) => !inDropped(s.tick));
    const clefs = (score.clefs ?? []).filter((s) => !inDropped(s.tick));
    // Every tick-carrying array has to be rebuilt here, however empty it looks:
    // the spread of `score` below hands back whatever this function does not
    // replace, so an omission leaks the dropped page's events at their original,
    // unshifted ticks — where they would land on the music that follows.
    const tempos = (score.tempos ?? []).filter((t) => !inDropped(t.tick));
    const holds = (score.holds ?? []).filter((h) => !inDropped(h.tick));
    const pedals = (score.pedals ?? []).filter((p) => !inDropped(p.tick));
    // The dropped page is always this shard's first, so what survives starts a
    // page's worth of ticks in. Pull it back to zero: the caller concatenates
    // parts by adding the running length of everything before, and a remainder
    // left where it stood would open a hole of exactly the dropped page's
    // duration at the seam. An empty array must not vote here — a literal 0
    // among the candidates would make the minimum 0 and the rebase a no-op.
    const minTick = Math.min(
        ...(measures.length > 0 ? measures.map((m) => m.tick) : [Number.POSITIVE_INFINITY]),
        ...(notes.length > 0 ? notes.map((n) => n.t) : [Number.POSITIVE_INFINITY]),
    );
    const shift = Number.isFinite(minTick) && minTick > 0 ? minTick : 0;

    const rebasedMeasures = measures.map((m) => ({ ...m, tick: m.tick - shift }));
    const totalTicks =
        rebasedMeasures.length > 0
            ? Math.max(...rebasedMeasures.map((m) => m.tick + m.dTicks))
            : Math.max(1, score.totalTicks - shift);

    return {
        ...score,
        measures: rebasedMeasures,
        systems,
        notes: notes.map((n) => ({ ...n, t: n.t - shift })),
        timeSignatures: timeSignatures.map((s) => ({ ...s, tick: s.tick - shift })),
        ...(keySignatures.length > 0
            ? { keySignatures: keySignatures.map((s) => ({ ...s, tick: s.tick - shift })) }
            : { keySignatures: undefined }),
        ...(clefs.length > 0
            ? { clefs: clefs.map((s) => ({ ...s, tick: s.tick - shift })) }
            : { clefs: undefined }),
        ...(tempos.length > 0
            ? { tempos: tempos.map((t) => ({ ...t, tick: t.tick - shift })) }
            : { tempos: undefined }),
        ...(holds.length > 0
            ? { holds: holds.map((h) => ({ ...h, tick: h.tick - shift })) }
            : { holds: undefined }),
        ...(pedals.length > 0
            ? { pedals: pedals.map((p) => ({ ...p, tick: p.tick - shift })) }
            : { pedals: undefined }),
        totalTicks,
    };
};

const maybeInheritAttributes = (
    score: ScoreData,
    priorTime: ScoreTimeSig[],
    priorKey: NonNullable<ScoreData['keySignatures']>,
    priorClef: NonNullable<ScoreData['clefs']>,
    _tickOffset: number,
): { score: ScoreData; warnings: string[] } => {
    const warnings: string[] = [];
    const lastTime = priorTime.length > 0 ? priorTime[priorTime.length - 1]! : null;
    const hasLocalTimeAtStart = score.timeSignatures.some((s) => s.tick === 0);
    let timeSignatures = score.timeSignatures;
    if (!hasLocalTimeAtStart && lastTime) {
        timeSignatures = [{ tick: 0, num: lastTime.num, den: lastTime.den }, ...score.timeSignatures];
        warnings.push('merged_inherited_time_signature');
    }

    const lastKey = priorKey.length > 0 ? priorKey[priorKey.length - 1]! : null;
    let keySignatures = score.keySignatures ?? [];
    if (lastKey && !(score.keySignatures ?? []).some((s) => s.tick === 0)) {
        keySignatures = [{ tick: 0, fifths: lastKey.fifths }, ...keySignatures];
        warnings.push('merged_inherited_key_signature');
    }

    const lastClefsByStaff = new Map<number, (typeof priorClef)[number]>();
    for (const c of priorClef) {
        lastClefsByStaff.set(c.staff, c);
    }
    let clefs = score.clefs ?? [];
    const existingStaff = new Set((score.clefs ?? []).filter((c) => c.tick === 0).map((c) => c.staff));
    for (const [, c] of lastClefsByStaff) {
        if (!existingStaff.has(c.staff)) {
            clefs = [{ tick: 0, staff: c.staff, sign: c.sign, ...(c.line !== undefined ? { line: c.line } : {}) }, ...clefs];
            warnings.push('merged_inherited_clef');
        }
    }

    return {
        score: {
            ...score,
            timeSignatures,
            ...(keySignatures.length > 0 ? { keySignatures } : {}),
            ...(clefs.length > 0 ? { clefs } : {}),
        },
        warnings,
    };
};

const noteOnDroppedPage = (
    score: ScoreData,
    tick: number,
    overlapPage0: number,
    pageMap: Map<number, number>,
): boolean => {
    for (const m of score.measures) {
        const page = m.page < 0 ? -1 : (pageMap.get(m.page) ?? m.page);
        if (page === overlapPage0 && tick >= m.tick && tick < m.tick + m.dTicks) {
            return true;
        }
    }
    return false;
};

/** Map whatever page ids the shard emitted onto absolute 0-based pages. */
const buildPageMap = (
    score: ScoreData,
    sheetFrom1Based: number,
    _overlapPage0: number | null,
): Map<number, number> => {
    const seen = new Set<number>();
    for (const system of score.systems) {
        if (system.page >= 0) {
            seen.add(system.page);
        }
    }
    for (const measure of score.measures) {
        if (measure.page >= 0) {
            seen.add(measure.page);
        }
    }
    const ordered = [...seen].sort((a, b) => a - b);
    const map = new Map<number, number>();
    ordered.forEach((page, i) => {
        map.set(page, sheetFrom1Based - 1 + i);
    });
    return map;
};
