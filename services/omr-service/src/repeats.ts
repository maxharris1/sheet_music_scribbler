import type { MeasureRepeatMarks } from './musicxml.js';

/**
 * Turn engraved repeat structure into the order the measures are actually
 * performed in.
 *
 * The output is an index list, so a bar played twice simply appears twice. That
 * is what lets unrolling be a structural clone downstream: measure geometry is
 * per-measure, so a duplicate with the same page/system/x-span sweeps the same
 * printed bar again for free.
 *
 * Scope is repeats, voltas, and ONE jump: a D.C. or D.S. with whatever segno,
 * To Coda, coda and Fine belong to it. Those arrive as often from OCR'd words as
 * from <sound> attributes, and the failure costs are asymmetric — a wrong repeat
 * misplaces eight bars, a wrong D.S. reorders pages. So the marks are validated
 * as a set before a single measure is planned, and anything that does not add up
 * (a second jump, a D.S. with no segno above it, a coda on the wrong side of the
 * words that call for it) degrades the WHOLE plan to linear rather than being
 * patched over. Half-understood structure is the one outcome worse than none.
 *
 * The converse matters just as much: a segno, a Fine or a coda sign with no jump
 * anywhere to send the player back to it is decoration or a misread, and must
 * cost the score nothing — not even its ordinary repeats.
 */

export interface RepeatPlan {
    /** Measure indices in performance order. */
    order: number[];
    /** True when the structure could not be resolved and this is just linear. */
    degraded: boolean;
    /** True when a `:|` was actually retaken, not merely printed. */
    performsRepeats: boolean;
    /** True when a D.C./D.S. actually fired. */
    performsJumps: boolean;
}

export interface RepeatLimits {
    /** Hard ceiling from the ScoreData schema; never ship a half-unrolled score. */
    maxMeasures: number;
}

const linear = (count: number, degraded: boolean): RepeatPlan => ({
    order: Array.from({ length: count }, (_, i) => i),
    degraded,
    performsRepeats: false,
    performsJumps: false,
});

/** A jump that survived validation: everything the loop needs, already checked. */
export interface ResolvedJump {
    /** The measure whose END carries the D.C./D.S. */
    at: number;
    kind: 'dc' | 'ds';
    /** Where the jump lands: the segno, or 0 for a D.C. — the head, pickup and all. */
    target: number;
    /** Measure whose END diverts to the coda, on the post-jump pass only. */
    toCoda?: number;
    /** Where that diversion lands. */
    codaTarget?: number;
    /** Measure whose END ends the performance, on the post-jump pass only. */
    fine?: number;
}

const indicesWhere = (marks: readonly MeasureRepeatMarks[], pred: (mark: MeasureRepeatMarks) => boolean): number[] => {
    const out: number[] = [];
    for (let i = 0; i < marks.length; i++) {
        const mark = marks[i];
        if (mark && pred(mark)) {
            out.push(i);
        }
    }
    return out;
};

/**
 * Read the jump marks as a whole: `null` when there is nothing to perform,
 * `'invalid'` when there is something we refuse to guess at.
 *
 * Multi-jump roadmaps (a D.S. that leads to a second D.C.) are real music but
 * beyond this version — resolving them needs an ordering the marks alone do not
 * carry, so they are declined rather than half-performed.
 */
export const resolveJump = (marks: readonly MeasureRepeatMarks[]): ResolvedJump | null | 'invalid' => {
    const jumps = indicesWhere(marks, (m) => !!m.jump);
    if (jumps.length === 0) {
        return null;
    }
    if (jumps.length > 1) {
        return 'invalid';
    }
    const at = jumps[0]!;
    const instruction = marks[at]!.jump!;

    const segnos = indicesWhere(marks, (m) => m.segno ?? false);
    const fines = indicesWhere(marks, (m) => m.fine ?? false);
    let toCodas = indicesWhere(marks, (m) => m.toCoda ?? false);
    let codaTargets = indicesWhere(marks, (m) => m.codaTarget ?? false);
    // A bare 𝄌 says nothing about which of its two roles it is playing.
    // Engravers print the diversion first and the coda section second, so a
    // clean pair resolves by position; any other count is a guess we decline.
    let bare = indicesWhere(marks, (m) => (m.codaGlyph ?? false) && !(m.toCoda ?? false) && !(m.codaTarget ?? false));
    if (toCodas.length === 0 && codaTargets.length === 0 && bare.length === 2) {
        toCodas = [bare[0]!];
        codaTargets = [bare[1]!];
        bare = [];
    }

    if (segnos.length > 1 || fines.length > 1 || toCodas.length > 1 || codaTargets.length > 1) {
        return 'invalid';
    }
    if (bare.length > 0 && instruction.al === 'coda') {
        return 'invalid';
    }

    let target = 0;
    if (instruction.kind === 'ds') {
        const segno = segnos[0];
        if (segno === undefined) {
            return 'invalid';
        }
        target = segno;
    }
    // A jump that would land on or after its own instruction is not a reading of
    // the page, it is a loop: a segno under its own D.S., or a "D.C." OCR hung
    // on the head measure, which would replay that measure and nothing else.
    if (target >= at) {
        return 'invalid';
    }
    const resolved: ResolvedJump = { at, kind: instruction.kind, target };

    // A To Coda / coda pair is itself the second half of the phrase. MusicXML
    // has no attribute for the words — <sound tocoda>/<sound coda> IS the
    // instruction — and engravers often let the 𝄌 stand in for "al Coda", so one
    // clean pair with no Fine to contradict it reads a bare jump that way too.
    const inferredCoda =
        instruction.al === null && toCodas.length === 1 && codaTargets.length === 1 && fines.length === 0;
    if (instruction.al === 'coda' || inferredCoda) {
        const toCoda = toCodas[0];
        const codaTarget = codaTargets[0];
        // The diversion has to lie inside the stretch the jump replays, and the
        // coda itself after the instruction — that is what makes it a coda.
        if (toCoda !== undefined && codaTarget !== undefined && toCoda >= target && toCoda < at && codaTarget > at) {
            return { ...resolved, toCoda, codaTarget };
        }
        // Words that say "al Coda" over a pair on the wrong side of them are a
        // mark set we refuse whole. A pair we only inferred is likelier a stray
        // 𝄌 sighting beside a plain jump that performs correctly as it stands,
        // so that one falls back to the plain reading instead.
        if (instruction.al === 'coda') {
            return 'invalid';
        }
    }

    const fine = fines[0];
    if (instruction.al === 'fine' && fine === undefined) {
        return 'invalid';
    }
    // A printed Fine binds a bare "D.C." too: that is how much of the literature
    // writes "D.C. al Fine", leaving the second half of the phrase to the sign —
    // and it is what a bare jump over BOTH a Fine and a coda pair reads as,
    // which is why the inference above stands down whenever a Fine is printed.
    if (fine !== undefined) {
        // The post-jump pass starts at the target, so a Fine above it is never
        // reached: that pass would run to the final barline with the "al Fine"
        // silently dropped. A Fine exactly ON the target is reachable — the bar
        // is played, then the Fine ends the performance.
        if (fine >= at || fine < target) {
            return 'invalid';
        }
        return { ...resolved, fine };
    }
    return resolved;
};

/** What a shard's marks say about structure that reaches beyond the shard. */
export interface StructureSummary {
    /** A `|:` — or a volta still open — after the last `:|`: its partner is elsewhere. */
    openForwardAtEnd: boolean;
    /** A `:|` with no `|:` above it: it returns to a top this range may not hold. */
    bareBackwardAtStart: boolean;
    /** A volta bracket the range never closes. */
    openVoltaAtEnd: boolean;
    /** Any segno/coda/Fine/D.C./D.S. sighting at all — jumps are global by nature. */
    hasJumpMarks: boolean;
}

/**
 * Structure that cannot be resolved from one shard alone. A repeat straddling a
 * seam yields a wrong-but-plausible order once the shards are concatenated, and
 * a jump is worse still: its target may sit in a shard this one never sees, so
 * ANY jump mark is reported, resolvable-looking or not.
 */
export const summarizeStructure = (marks: readonly MeasureRepeatMarks[]): StructureSummary => {
    let firstForward = -1;
    let firstBackward = -1;
    let lastBackward = -1;
    let voltaOpen = false;
    let hasJumpMarks = false;
    for (let i = 0; i < marks.length; i++) {
        const mark = marks[i];
        if (!mark) {
            continue;
        }
        if (mark.repeatForward && firstForward < 0) {
            firstForward = i;
        }
        if (mark.repeatBackward) {
            if (firstBackward < 0) {
                firstBackward = i;
            }
            lastBackward = i;
        }
        if (mark.endingStart) {
            voltaOpen = true;
        }
        if (mark.endingStop) {
            voltaOpen = false;
        }
        if (mark.segno || mark.codaTarget || mark.toCoda || mark.codaGlyph || mark.fine || mark.jump) {
            hasJumpMarks = true;
        }
    }

    let openForwardAtEnd = false;
    for (let i = lastBackward + 1; i < marks.length && !openForwardAtEnd; i++) {
        const mark = marks[i];
        if (!mark) {
            continue;
        }
        const unclosedVolta = !!mark.endingStart && !marks.slice(i).some((later) => later.endingStop);
        openForwardAtEnd = mark.repeatForward || unclosedVolta;
    }

    return {
        openForwardAtEnd,
        bareBackwardAtStart: firstBackward >= 0 && (firstForward < 0 || firstBackward < firstForward),
        openVoltaAtEnd: voltaOpen,
        hasJumpMarks,
    };
};

/**
 * One past the end of the volta bracket beginning at `from`.
 *
 * Only ONE bracket, deliberately: the pass that does not belong to a first
 * ending usually belongs to the second, so the caller must get the chance to
 * test the next bracket rather than being carried past every one of them.
 */
const pastEndingBlock = (marks: readonly MeasureRepeatMarks[], from: number): number => {
    let i = from;
    while (i < marks.length && !marks[i]?.endingStop) {
        i += 1;
    }
    return i + 1;
};

/** True when some bracket in the group starting at `from` belongs to `pass`. */
const endingGroupTakesPass = (marks: readonly MeasureRepeatMarks[], from: number, pass: number): boolean => {
    let i = from;
    while (i < marks.length) {
        const brackets = marks[i]?.endingStart;
        if (!brackets) {
            return false;
        }
        if (brackets.includes(pass)) {
            return true;
        }
        const next = pastEndingBlock(marks, i);
        if (next <= i) {
            return false;
        }
        i = next;
    }
    return false;
};

/**
 * The total number of passes the repeat governing `from` makes.
 *
 * A post-jump traversal takes no repeats, but it is still the LAST pass, so its
 * voltas are the ones the final pass would have taken. Sections with brackets
 * but no `:|` at all are read as an ordinary two-pass repeat.
 */
const finalPassOf = (marks: readonly MeasureRepeatMarks[], from: number): number => {
    let passes = 0;
    for (let i = from; i < marks.length; i++) {
        const mark = marks[i];
        if (!mark) {
            break;
        }
        if (i > from && mark.repeatForward) {
            break;
        }
        if (mark.repeatBackward) {
            passes = Math.max(passes, mark.repeatTimes);
        }
    }
    return passes > 0 ? passes : 2;
};

/** The forward repeat a jump target lands under, so its voltas read correctly. */
const forwardGoverning = (marks: readonly MeasureRepeatMarks[], upTo: number, fallback: number): number => {
    for (let i = upTo; i >= 0; i--) {
        if (marks[i]?.repeatForward) {
            return i;
        }
    }
    return fallback;
};

export const planRepeats = (
    marks: readonly MeasureRepeatMarks[],
    limits: RepeatLimits,
    isPickup: (index: number) => boolean = () => false,
): RepeatPlan => {
    const n = marks.length;
    if (n === 0) {
        return linear(0, false);
    }
    const jump = resolveJump(marks);
    if (jump === 'invalid') {
        return linear(n, true);
    }
    if (jump === null && !marks.some((m) => m.repeatForward || m.repeatBackward)) {
        return linear(n, false);
    }

    // A backward repeat with no forward one returns to the top — but not into a
    // pickup, which is played once on the way in and never again. A D.C. is the
    // exception: "da capo" is the head of the piece, pickup included.
    let firstReal = 0;
    while (firstReal < n && isPickup(firstReal)) {
        firstReal += 1;
    }
    const top = Math.min(firstReal, n - 1);

    let lastForward = top;
    const passOf = new Map<number, number>();
    const order: number[] = [];
    let i = 0;
    let afterJump = false;
    let performsRepeats = false;
    let performsJumps = false;
    // A jump buys the performance up to one whole extra traversal of the score.
    const guard = 6 * n + 64;

    for (let steps = 0; ; steps++) {
        if (i >= n) {
            break;
        }
        if (steps > guard || order.length > limits.maxMeasures) {
            // Pathological structure, or a score whose unrolled length would
            // breach the schema cap. Degrade wholesale rather than truncate.
            return linear(n, true);
        }
        const mark = marks[i];
        if (!mark) {
            break;
        }

        if (mark.repeatForward) {
            lastForward = i;
            if (!passOf.has(i)) {
                passOf.set(i, 1);
            }
        }

        const pass = passOf.get(lastForward) ?? 1;
        const voltaPass = afterJump ? finalPassOf(marks, lastForward) : pass;
        if (mark.endingStart && !mark.endingStart.includes(voltaPass)) {
            if (afterJump && !endingGroupTakesPass(marks, i, voltaPass)) {
                // Nothing here belongs to the final pass, so the brackets are
                // not the shape we took them for. Say so instead of guessing.
                return linear(n, true);
            }
            const skipTo = pastEndingBlock(marks, i);
            if (skipTo <= i) {
                return linear(n, true);
            }
            i = skipTo;
            continue;
        }

        order.push(i);

        if (!afterJump) {
            // The repeat is exhausted before the jump fires: a `:|` sharing the
            // bar with a D.C. is retaken first, and the D.C. waits its turn.
            if (mark.repeatBackward && pass < mark.repeatTimes) {
                passOf.set(lastForward, pass + 1);
                performsRepeats = true;
                i = lastForward;
                continue;
            }
            if (jump && i === jump.at) {
                afterJump = true;
                performsJumps = true;
                i = jump.target;
                lastForward = forwardGoverning(marks, jump.target, top);
                continue;
            }
        } else if (jump) {
            if (i === jump.fine) {
                break;
            }
            if (i === jump.toCoda && jump.codaTarget !== undefined) {
                i = jump.codaTarget;
                continue;
            }
        }
        i += 1;
    }

    if (order.length === 0 || order.length > limits.maxMeasures) {
        return linear(n, true);
    }
    // A volta whose pass never matched can leave bars unplayed; that is a
    // structure we did not understand, not a performance decision. Every legal
    // jump form still performs each printed bar at least once on the way to the
    // instruction, so this stays a sound test with jumps in play.
    const played = new Set(order);
    const unplayed = marks.some((_, index) => !played.has(index));
    return { order, degraded: unplayed, performsRepeats, performsJumps };
};

/** The tick-keyed content unrolling has to remap, alongside measures. */
export interface UnrollableScore {
    measures: Array<{ tick: number; dTicks: number; srcIndex?: number }>;
    notes: Array<{ t: number; d: number }>;
    timeSignatures: Array<{ tick: number }>;
    keySignatures?: Array<{ tick: number }>;
    clefs?: Array<{ tick: number }>;
    tempos?: Array<{ tick: number }>;
    holds?: Array<{ tick: number }>;
    pedals?: Array<{ tick: number }>;
    totalTicks: number;
}

interface Segment {
    /** Index of the printed measure this segment performs. */
    src: number;
    /** Where the printed bar sits in the original timeline. */
    srcTick: number;
    dTicks: number;
    /** Where it sits in the performed timeline. */
    destTick: number;
    /** True when the PREVIOUS segment is not this one's printed predecessor. */
    seamBefore: boolean;
}

/**
 * State events (time/key/clef/tempo) describe what is in force from a tick
 * onward, so they cannot simply be copied: a jump can land in the middle of a
 * span. Walk the performance and re-emit whenever the value in force at a
 * segment's start differs from what the performed timeline last said.
 */
const remapStateEvents = <T extends { tick: number }>(events: readonly T[], segments: readonly Segment[]): T[] => {
    if (events.length === 0) {
        return [];
    }
    const sorted = [...events].sort((a, b) => a.tick - b.tick);
    const inForceAt = (tick: number): T | undefined => {
        let found: T | undefined;
        for (const e of sorted) {
            if (e.tick > tick) {
                break;
            }
            found = e;
        }
        return found;
    };

    const out: T[] = [];
    let emitted: T | undefined;
    for (const seg of segments) {
        const active = inForceAt(seg.srcTick);
        if (active && active !== emitted) {
            out.push({ ...active, tick: seg.destTick });
            emitted = active;
        }
        // Anything changing strictly inside this bar keeps its offset.
        for (const e of sorted) {
            if (e.tick > seg.srcTick && e.tick < seg.srcTick + seg.dTicks) {
                out.push({ ...e, tick: seg.destTick + (e.tick - seg.srcTick) });
                emitted = e;
            }
        }
    }
    return out;
};

/**
 * Rebuild a score in performance order. Measures are cloned with their geometry
 * intact and given new ticks, which is what makes the playhead sweep the same
 * printed bar twice for free.
 */
export const unrollRepeats = <S extends UnrollableScore>(score: S, order: readonly number[]): S => {
    const segments: Segment[] = [];
    // The performance starts where the score starts, which is not necessarily
    // where its first PERFORMED bar sat (and preserves the tick offset that
    // concatenated movements rely on).
    let destTick = score.measures[0]?.tick ?? 0;
    for (let s = 0; s < order.length; s++) {
        const src = order[s]!;
        const measure = score.measures[src];
        if (!measure) {
            continue;
        }
        segments.push({
            src,
            srcTick: measure.tick,
            dTicks: measure.dTicks,
            destTick,
            seamBefore: s > 0 && order[s - 1] !== src - 1,
        });
        destTick += measure.dTicks;
    }
    const totalTicks = Math.max(1, destTick);

    const measures = segments.map((seg) => ({
        ...score.measures[seg.src]!,
        tick: seg.destTick,
        srcIndex: score.measures[seg.src]!.srcIndex ?? seg.src,
    }));

    const notes: S['notes'] = [];
    for (let s = 0; s < segments.length; s++) {
        const seg = segments[s]!;
        const next = segments[s + 1];
        for (const note of score.notes) {
            if (note.t < seg.srcTick || note.t >= seg.srcTick + seg.dTicks) {
                continue;
            }
            const offset = note.t - seg.srcTick;
            let d = note.d;
            // A note held past this bar only keeps its tail when the next
            // segment really is what follows it on the page. Clipping every
            // seam would truncate legitimately long ties inside a run.
            if (next && next.seamBefore) {
                d = Math.min(d, seg.dTicks - offset);
            }
            notes.push({ ...note, t: seg.destTick + offset, d: Math.max(1, d) });
        }
    }

    const point = <T extends { tick: number; k?: 'down' | 'up' }>(events: readonly T[] | undefined): T[] | undefined => {
        if (!events) {
            return undefined;
        }
        const out: T[] = [];
        for (const seg of segments) {
            for (const e of events) {
                // A pedal release engraved on a bar line — some engravers put
                // the stop at the top of the next measure — damps the music
                // before it, so an 'up' takes the left-open, right-closed bar.
                // Handing it to the bar after would let a performed repeat
                // replay the span with the release stranded past the jump. The
                // one tick with no bar before it is the score's head, which
                // bar 0 claims so an edge there (OMR losing the start of a
                // pedal line leaves an orphan release) is not dropped.
                const inSeg =
                    e.k === 'up'
                        ? (e.tick > seg.srcTick || (e.tick === 0 && seg.srcTick === 0)) &&
                          e.tick <= seg.srcTick + seg.dTicks
                        : e.tick >= seg.srcTick && e.tick < seg.srcTick + seg.dTicks;
                if (inSeg) {
                    out.push({ ...e, tick: seg.destTick + (e.tick - seg.srcTick) });
                }
            }
        }
        return out.sort((a, b) => a.tick - b.tick);
    };

    return {
        ...score,
        measures,
        notes: notes.sort((a, b) => a.t - b.t),
        timeSignatures: remapStateEvents(score.timeSignatures, segments),
        ...(score.keySignatures ? { keySignatures: remapStateEvents(score.keySignatures, segments) } : {}),
        ...(score.clefs ? { clefs: remapStateEvents(score.clefs, segments) } : {}),
        ...(score.tempos ? { tempos: remapStateEvents(score.tempos, segments) } : {}),
        ...(score.holds ? { holds: point(score.holds) } : {}),
        // Pedal edges are moments, not state in force: remapping them as state
        // would collapse a re-catch pair and re-emit an edge the player already
        // passed. `point` keeps both halves of a pair, in their engraved order.
        ...(score.pedals ? { pedals: point(score.pedals) } : {}),
        totalTicks,
    };
};
