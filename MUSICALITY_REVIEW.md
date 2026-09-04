# Musicality review — OMR → ScoreData → playback

> **Addendum — 2026-09-02.** This review was written against the pipeline as it stood before
> svc-5. The probe transcript, the case study and the priorities below are a record of that
> state, not of today's; read them as history. What has been fixed since:
>
> - **svc-5** — dynamics resolve per staff (the P0 bleed, and with it the P3 accent that
>   landed on the wrong note); hairpins are interpolated (P1); articulation gates sounding
>   length, so staccato is short and slurs are not (P0); there is a real tempo map, with
>   rit./accel./a tempo and fermatas (P1); repeats and voltas are unrolled into performance
>   order (P1); and every warning the analysis stores is disclosed in the transport instead of
>   being kept to ourselves.
> - **svc-7, this pass** — D.C., D.S., segno, coda and Fine are read and performed, or refused
>   as a whole and disclosed; the tempo map and fermatas survive the shard merge, which is what
>   left every ≥4-page score — the Schubert case study included — at a flat fallback tempo; the
>   opening tempo comes from a wider vocabulary, or from the meter when nothing at all is
>   printed, and says which; sustain pedal is read (P2). On the client, the engine this
>   document's thesis calls a MIDI note list gains a dB-domain dynamic range, reverb, keyboard
>   panning, a velocity-tracked filter, deterministic humanization and pitch-dependent release.
> - **svc-8** — a 4+ page score is still two shards, but the second is now parsed with the
>   first's tempo and dynamics at the overlap, so a rit. that crossed the cut, an a tempo that
>   opened the next page, and a pp printed only on page 1 all survive. A later movement with
>   no heading of its own starts at its meter default rather than the previous movement's
>   ritardando floor. Gradual marks are shaded (poco / molto) and the stepped family —
>   meno mosso, più mosso, ritenuto, l'istesso tempo, doppio movimento — is read.
> - **svc-9** — ornaments (trill, mordent, turn) and arpeggio signs are spelled as ordinary
>   notes at the tempo in force; appoggiaturas take the beat and acciaccaturas scale with
>   the pulse; a "swing" heading long–shorts pairs of eighths.
>
> Still open, and still described accurately below: velocity-layered samples, the measure
> counter across concatenated movements, `totalTicks` cutting off secondary parts, and both
> rhythm findings in the case study (No. 1's triplets, No. 2's misread meter) — those two are
> Audiveris's limits, not ours.
>
> None of this reaches a document that was already analyzed until it is regenerated. The engine
> generation bump is what puts that offer on the reader's screen.

Review of what Cleffy hears when it looks at a score, and where that diverges from what a
musician reads on the page. Findings below were verified by running the real parser
(`services/omr-service/src/musicxml.ts`) over a grand-staff excerpt carrying ordinary piano
markings — not by reading the code alone.

## Thesis

**ScoreData models pitch, time, and hand. It does not model performance.** It is a MIDI note
list with page geometry attached. Everything a musician would call _interpretation_ —
articulation, phrasing, dynamic shape, tempo shape — is either dropped at the MusicXML parse
step or has no field to live in. The timing/geometry layer is genuinely strong; the
expression layer is largely absent, and the places where it _is_ present (sfz, printed
dynamics) have a bug that actively corrupts the rest.

## The probe

Input: a 3-bar grand-staff excerpt. RH marked **f** with four **staccato** quarters, then an
**accented (>)** note, a **slur**, a **trill**, under a **crescendo**; LH marked **p** with
**pedal**; a **repeat** barline; a **rit.**, a **fermata**, and a second tempo mark (♩=60).

Output (`t` = tick, `d` = duration, `v` = velocity):

```
=== defaultBpm: 120 | totalTicks: 5760
=== warnings: ["repeats_ignored"]
  t=    0  d= 480  C5   RH  v=0.82     <- f, correct
  t=    0  d=1920  C3   LH  v=0.46     <- p, correct
  t=  480  d= 480  D5   RH  v=0.82
  t=  960  d= 480  E5   RH  v=0.82
  t= 1440  d= 480  F5   RH  v=0.82
  t= 1920  d= 480  G5   RH  v=0.46     <- accented, forte melody note. Now PIANO.
  t= 1920  d=1920  G2   LH  v=0.46
  t= 2400  d= 480  A5   RH  v=0.46
  t= 2880  d= 480  B5   RH  v=0.46
  t= 3360  d= 480  C6   RH  v=0.46
  t= 3840  d= 960  C5   RH  v=0.46
  t= 3840  d=1920  C3   LH  v=0.46
  t= 4800  d= 960  E5   RH  v=0.46
```

Every staccato quarter is `d=480` — full length. The accent is inaudible. The crescendo is
flat. The fermata does not hold. The tempo stays 120. And the right hand is playing *piano*
from bar 2 to the end of the piece.

---

## P0 — Dynamics bleed across hands; the melody gets overwritten

**The most damaging finding.** The score says RH _forte_, LH _piano_. From bar 2 onward
**everything plays at piano, including the melody**, and it never recovers.

Root cause (`musicxml.ts:356`, `431-478`): `currentVelocity` is a single variable per part,
and the `<staff>` child of `<direction>` is ignored. Dynamics are applied in **document
order**, not musical time. MusicXML writes a measure as `[staff-1 voices] <backup> [staff-2
voices]`, so the **lower staff's dynamic is always the last one seen in a bar** — and it
governs the next bar's upper staff.

Rule of thumb for the current behavior: _the last dynamic printed in a measure sets the
volume for every note in the next measure, both hands._ For piano writing — melody `f`,
accompaniment `p`, which is most piano writing — this systematically flattens the melody into
the accompaniment.

**Fix:** key the dynamic state by staff, and resolve each note's velocity from a
`(tick, staff)` lookup rather than from a mutable cursor walked in document order. Same
change fixes the `pendingAccent` leak below. No schema change; service-side only.

## P0 — `>` accents are invisible

`<articulations>` is never read — there is not one reference to `notations`, `articulations`,
`staccato`, `accent`, `tenuto`, or `marcato` anywhere in the OMR service. The sforzando
family (`sf`, `sfz`, `fz`, `fp`) _is_ handled, because those arrive as `<dynamics>`.

That is backwards by frequency. In real repertoire `>` is the common accent by a wide margin;
`sfz` is comparatively rare. The net effect is that the accent layer of the music is absent
while a rarer notation works.

**Fix:** read `<notations><articulations>` — `accent` → +0.15 velocity, `strong-accent` →
+0.25, `tenuto` → full gate + slight boost. Service-side; no schema change.

## P0 — Nothing is ever shortened, so everything is legato

Every note sounds its full notated value, and `PlaybackEngine` adds a 60 ms release tail
(`RELEASE_TAU_S`) on top — so consecutive notes in a hand actually **overlap**. There is no
gate, duty cycle, or note-off gap anywhere in the system.

Musically: a staccato Alberti bass and a slurred nocturne line have identical touch. This is
the single thing a musician would notice first, and it reads as "the playback sounds mushy /
smeared" rather than as a missing feature.

**Fix is cheap.** `note.d` is consumed **only** by `PlaybackEngine` (lines 458, 479) —
nothing else in the app reads it, fingering included. So `d` is already a _sounding_ duration
in practice, and the OMR service can shorten it directly:

| marking      | gate         |
| ------------ | ------------ |
| staccatissimo| ~0.25        |
| staccato     | ~0.50        |
| (unmarked)   | ~0.90        |
| tenuto/slur  | 1.0          |

No schema change, no client change.

## P1 — One tempo for the entire piece

`defaultBpm` is a scalar, and the `if (defaultBpm === null)` guards (`musicxml.ts:435, 443`)
capture only the **first** tempo mark in the document. The probe's second mark (♩=60 in bar 3)
was dropped — output stayed 120.

Compounding it: `<words>` is never parsed at all, so **"rit.", "accel.", "a tempo", "Rubato",
"Andante", "Swing"** are all invisible; and `<fermata>` is ignored, so the final chord does not
hold. Playback is metronomic from the first bar to the last.

Also worth knowing: most published scores give a tempo as _words_ ("Allegro"), not a metronome
mark. When Audiveris emits no `<sound tempo>`, `defaultBpm` is null and the app falls back to
`DEFAULT_BPM = 100` (`store.ts:38`) — a flat 100 bpm regardless of what the page says.

**Fix:** ScoreData v3 `tempos: [{tick, bpm}]`, plus a per-note hold for fermatas. The engine's
anchor-swap timebase already re-anchors cleanly on `setBpm`, so it can follow a tempo map with
modest changes — the missing piece is the field, not the machinery.

## P1 — Hairpins are not interpolated

`<wedge>` is never read, so dynamics are step functions. A four-bar `cresc.` from _p_ to _f_
plays as flat _p_ until the _f_ arrives, then jumps. Confirmed in the probe (bar 2, flat).

**Fix:** this needs no schema change and no engine change — interpolate at build time and emit
the ramped value into each note's `v`. Combined with the per-staff fix above, this is the
highest value-per-unit-effort work available.

## P1 — Repeats are dropped, and the user is never told

`repeats_ignored` is correctly produced. **But `score.warnings` is never surfaced anywhere in
the UI.** Its only two consumers in the entire app are the fingering cache key
(`fingering/cache.ts:63`) and a `no_geometry` check (`regionFromScoreData.ts:158`). The
transport's warning banner (`TransportBar.tsx:55`) carries only runtime audio codes
(`samples_unavailable`, `too_many_voices`).

So the following all happen silently: `repeats_ignored`, `measure_underfull`,
`measure_overfull`, `multi_part_collapsed`, `single_staff_all_rh`, `measure_geometry_mismatch`,
`grace_notes_skipped`, `multiple_movements_concatenated`.

Two of those are worse than a missing feature:

- **1st/2nd endings play back-to-back.** That is not "a different form" — it is a wrong note
  sequence presented as correct.
- **`measure_underfull` / `measure_overfull` are OMR rhythm damage** — the strongest available
  signal that a bar was misread — and it is thrown away.

For a practice tool this is a trust problem. A student following the page loses sync and has
no way to know the software, not their reading, is wrong. Surfacing these is a small UI change
against data that already exists.

## P2 — Pedal, ornaments, grace-note nuance, swing

- **Pedal:** `<pedal>` ignored. Romantic repertoire loses all harmonic blend.
- **Ornaments:** trill / mordent / turn / arpeggiate play as plain notes (probe: the trill
  became a plain quarter). Reasonable v1 scope, but a real gap for baroque and classical.
- **Grace notes:** always crushed acciaccatura at a fixed `GRACE_TICKS = 110`. `<grace
  slash="no">` — an appoggiatura, which should take half the principal's value **on** the
  beat — plays identically. `steal-time-following` / `steal-time-previous` ignored. (Minor: the
  comment at `musicxml.ts:43` says "≈55 ms at 120 bpm"; 110/480 quarter at 120 bpm is ~115 ms.)
- **Swing:** no swing flag in ScoreData; eighths are always straight. If charts/lead sheets are
  a target use case, this is a significant feel gap.

## P3 — Smaller items

- **Accent lands on the wrong note.** `pendingAccent` is consumed by the next pitched note in
  _document_ order, which after a `<backup>` may be a lower-staff note or one in the next bar.
  Same root cause as the P0 dynamics bleed; fixed by the same change.
- **Two velocity defaults.** Parser `DEFAULT_VELOCITY = 0.72` vs engine `note.v ?? 0.75`.
  Unmarked notes take 0.75; the 0.72 is only an accent/grace base. Harmless today, but two
  sources of truth.
- **Measure counter jumps backwards** after `multiple_movements_concatenated` — movement 2
  restarts numbering at 1.
- **`totalTicks` is the lead part's last barline.** Secondary-part notes past it exist in
  `notes` but never sound; the engine stops there.

---

## What is genuinely well done

Worth stating plainly, because the weaknesses above are concentrated in one layer and it would
be easy to read this as a broader indictment. It isn't.

- **Tick normalization to 480/quarter** makes triplets (160) and quintuplets (96) exact. Right
  call.
- **Tie merging with a musical-adjacency fallback** (`musicxml.ts:528-544`) for Audiveris
  renumbering voices across system breaks — a thoughtful fix to a real OMR failure mode, and
  the kind of thing that only comes from having been bitten by it.
- **Compound meters click in dotted quarters** (`clickBeatTicks`). Most tools get 6/8 wrong.
- **Count-in handles pickups** by counting the lead-in beats of the entry bar
  (`countInClicks`). Genuinely well done; commonly botched.
- **Beat-unit → quarter-BPM conversion including dots** (`beatUnitToQuarters`) is correct.
- **Attack-lag compensation** — notes start early by the sample's own rise time so the note is
  _heard_ on the beat rather than beginning there. That is a musician's ear in the code, and
  most sequencers do not bother.
- **Perceptual `v^1.6` gain curve** — right instinct; linear gain does flatten dynamics.
- **Playhead rides engraved chord columns** (`measures[].sl`) instead of interpolating linearly
  across the bar. This is the difference between a playhead that looks right and one that
  doesn't.
- **Piano-primary part selection** to dodge Audiveris "Voice" ghost parts, and underfull/overfull
  padding that extends open ties across the inserted gap. Both careful.

## Suggested order of work

Ranked by musical impact per unit of effort. The first three need **no schema change and no
client change** — they are all inside the OMR service.

0. **Meter sanity check** — when a movement's modal bar content disagrees with the declared
   signature by a clean ratio, trust the bars. Would have caught the worst error on the Schubert.
1. **Per-staff dynamics resolved by `(tick, staff)`** — stops the melody being overwritten.
2. **Articulations → gate + velocity** (`staccato`, `accent`, `strong-accent`, `tenuto`) — gives
   the playback touch, and fixes "everything sounds legato."
3. **Hairpin interpolation baked into `v`** — gives it dynamic shape.
4. **Surface `score.warnings` in the transport.** Small UI change, data already exists,
   converts silent wrongness into honest uncertainty.
5. **ScoreData v3: `tempos[]` + fermata holds** — gives it tempo shape (rit./accel./a tempo).
6. **Repeat/volta unrolling at build time**, with `measures[].srcIndex` so the playhead can
   revisit a printed bar. Keeps the engine linear and the geometry mapping intact.
7. Pedal, ornaments, appoggiatura vs acciaccatura, swing.

---

# Case study: Schubert, _Moments musicaux_ D. 780 (Op. 94)

Document `071f3c99-aee2-46cc-a2c5-bbdf22f43781` — Breitkopf & Härtel _Schubert's Werke_,
Serie 11 No. 4. All six pieces, 16 pages, 679 measures, 8198 notes.
Engine `audiveris-5.6.1+svc-4`. Stored warnings: `repeats_ignored`, `measure_overfull`,
`measure_underfull`, `multiple_movements_concatenated`.

Every claim below was checked against the rendered PDF at 400 dpi and against the stored
ScoreData.

## What it got right — and this is the strong half

**Key signatures are essentially perfect.** All twenty key changes across the set are correct,
including internal modulations:

| | printed | read |
| --- | --- | --- |
| No. 1 | C major, → G major middle section | 0 (default), `fifths=1` @42000 ✓ |
| No. 2 | A♭ major, → F♯ minor middle sections | `-4`, `+3` twice ✓ |
| No. 3 | F minor | `-4` ✓ |
| No. 4 | C♯ minor | `+4` ✓ |
| No. 5 | F minor | `-4` ✓ |
| No. 6 | A♭ major | `-4` ✓ |

Catching the enharmonic F♯-minor episodes inside an A♭ movement — twice — is genuinely good.

**Movement segmentation found all six.** **Time signatures: five of six correct.** And rhythm
recognition in the back four movements is strong:

| movement | bars | bars at correct length | rate |
| --- | --- | --- | --- |
| No. 3 (2/4) | 77 | 76 | **99%** |
| No. 4 (2/4) | 182 | 172 | **95%** |
| No. 5 (2/4) | 111 | 110 | **99%** |
| No. 6 (3/4) | 120 | 116 | **97%** |

## No. 2 is read in 6/8. It is printed in 9/8.

Verified at 400 dpi: the signature is unambiguously **9/8**, key of four flats.

This is an Audiveris misread, not a parser bug — but **the parser then amplifies it.** Expected
bar length becomes 1440 ticks instead of 2160, so the underfull-padding path
(`musicxml.ts:643-651`) pads bars to a target derived from the wrong meter:

| movement | bars | at correct length | actual ticks | correct ticks |
| --- | --- | --- | --- | --- |
| No. 2 (9/8) | 94 | **18 (19%)** | 159,960 | 203,040 |

44 bars were padded to exactly 1440 — each one **720 ticks short, a full dotted-quarter beat
of 9/8**. The Andantino runs **21% short overall**, and because the error accumulates bar by
bar, audio and page drift progressively further apart across the whole movement.

The evidence to catch this was already in hand. The modal bar content in that movement is 2160
against a declared 1440 — a clean 3:2 disagreement. **When a movement's bars systematically
disagree with the declared signature by a simple ratio, the signature is wrong, not the bars.**
A meter sanity-check would have caught the single highest-impact error on this document.
Instead the padding logic propagated it, and the user was told nothing.

## No. 1 loses its triplets

| movement | bars | at correct length | rate |
| --- | --- | --- | --- |
| No. 1 (3/4) | 95 | 64 | **67%** |

67% is an **upper bound** — silently padded underfull bars also land on exactly 1440 and are
indistinguishable from correct ones in the stored data.

The failures have a signature. Of the 31 wrong bars: **19 are exactly 1680 ticks (1440 + 240)**
and **7 are exactly 1920 (1440 + 480)**. 240 ticks is precisely what a triplet-eighth group
gains when its `<time-modification>` is lost — 3×160 read as 3×240. So 19 bars dropped one
triplet, 7 dropped two.

The duration histogram corroborates it: across the whole movement, only **49 triplet-eighths
(160 ticks)** against **923 plain eighths (240)** — while the printed page carries triplet
brackets in nearly every bar of the opening material.

Bar 1's left hand came out as `(640, 160, 160)`. **640 is not a legal note value in 3/4** — it
is the residue of a swallowed triplet member.

## Zero grace notes. Out of 8198.

Not one note in the document has the 110-tick grace length. Page 1 alone has at least six
printed grace notes; the set is full of them. `grace_notes_skipped` never even fired, which
means Audiveris emitted no `<grace>` elements at all — the noteheads were dropped or folded in
as ordinary notes. Schubert's ornamental graces are simply gone.

## Both hands play at the same volume for the entire work

**95.9% of simultaneous RH/LH onsets carry identical velocity** (1772 of 1848). The 4% that
differ are only the `fz`/`sfz` accent landing on whichever note happened to come first in
document order.

This is the P0 dynamics-bleed bug measured on real repertoire — in music built almost entirely
on a singing line over a quieter accompaniment.

The whole dynamic range of the set reduces to seven values:

| velocity | notes | share | |
| --- | --- | --- | --- |
| 0.34 | 3460 | 42.2% | `pp` |
| 0.46 | 3454 | 42.1% | `p` |
| 0.82 | 885 | 10.8% | `f` |
| 0.92 | 333 | 4.1% | `ff` |
| 0.66 | 51 | 0.6% | accent over `p` |
| 0.70 | 13 | 0.2% | `mf` |
| 0.54 | 2 | 0.0% | accent over `pp` |

**84% of the work plays at _p_ or _pp_.** Every value is an exact `DYNAMIC_LEVELS` constant or
an accent offset — **there is not one intermediate value in 8198 notes**. That is direct proof
that no hairpin is interpolated: the score's many `cresc.`, `decresc.`, `dim.` and printed
wedges produce nothing at all.

Spot-check matching the synthetic probe: the `>` accent on bar 2 of No. 1 came out at `v=0.46`,
identical to its neighbours.

## The whole set plays at a flat 100 bpm

`bpm_default` is **null**. Every tempo in this edition is a word — _Moderato_, _Andantino_,
_Allegro moderato_, _Moderato_, _Allegro vivace_, _Allegretto_ — and `<words>` is never parsed,
so nothing reached `defaultBpm` and the app fell back to `DEFAULT_BPM = 100`.

**No. 5 "Allegro vivace" and No. 2 "Andantino" play at exactly the same speed.**

## Structural

- **All six pieces are one 679-bar timeline.** The transport's measure counter resets to 1 five
  times mid-score; measure-seek and A-B loop numbering are ambiguous as a result.
- **Repeats and voltas dropped.** Pages 1–2 carry repeat barlines and visible `1.` / `2.`
  endings; both endings play back-to-back.
- None of the four stored warnings is shown to the user.

## Verdict on this document

The **pitch and key layer is strong** — keys, modulations, hand split, and the rhythm of four
of six movements are all good enough to practise against. The failures cluster in exactly two
places:

1. **Rhythm, where the notation is dense** (No. 1's triplets, No. 2's misread meter). Both are
   Audiveris limits, but both were *detectable* from data the pipeline already computes and
   *worsened* by padding against a wrong target.
2. **Everything expressive** — dynamics, accents, articulation, tempo, graces, repeats — which
   is the pipeline's own gap, not Audiveris's.

For a student, the practical result: Nos. 3–6 are usable play-alongs at the wrong tempo and a
flat dynamic. No. 2 drifts out of sync with the page. No. 1 stumbles wherever Schubert wrote a
triplet. And nothing on screen says any of this is happening.
