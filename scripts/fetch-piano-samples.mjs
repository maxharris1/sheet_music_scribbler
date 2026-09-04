// Regenerate the bundled piano voice: public/audio/piano/*.mp3
//
// Source: Salamander Grand Piano by Alexander Holm (CC BY 3.0), mirrored at
// github.com/sfzinstruments/SalamanderGrandPiano. We keep 29 anchors (every
// minor third, C1–C8) at three velocity layers — v4 soft, v9 mid, v14 loud —
// and slim each one for the web: ffmpeg downmixes to mono 22.05 kHz, then we
// trim to 6 s with a 250 ms fade. The playback engine applies its own release
// envelope at note end, so the long natural tails are dead weight.
//
// Loudness stays the job of velocityToGain: after onset-trim, soft and loud
// are scaled so their RMS over the first 1.5 s matches the mid layer. Layers
// only change timbre.
//
// Usage (one-time dep, not part of the app):
//   npm install --no-save @breezystack/lamejs
//   node scripts/fetch-piano-samples.mjs
//
// Keep the anchor list in sync with PIANO_ANCHORS in
// src/features/playback/pianoSampler.ts.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lamejs from '@breezystack/lamejs';

const ANCHORS = [
    'C1',
    'Ds1',
    'Fs1',
    'A1',
    'C2',
    'Ds2',
    'Fs2',
    'A2',
    'C3',
    'Ds3',
    'Fs3',
    'A3',
    'C4',
    'Ds4',
    'Fs4',
    'A4',
    'C5',
    'Ds5',
    'Fs5',
    'A5',
    'C6',
    'Ds6',
    'Fs6',
    'A6',
    'C7',
    'Ds7',
    'Fs7',
    'A7',
    'C8',
];

const SOURCE = 'https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/master/Samples';
const CREDIT =
    'Salamander Grand Piano by Alexander Holm, CC BY 3.0, via github.com/sfzinstruments/SalamanderGrandPiano';

// v4 / v9 / v14 map onto MIDI ~28 / 68 / 108, then into our 0..1 velocity.
const LAYERS = [
    { suffix: '', velocity: 0.54, salamander: 9, role: 'mid' },
    { suffix: '-soft', velocity: 0.22, salamander: 4, role: 'soft' },
    { suffix: '-loud', velocity: 0.85, salamander: 14, role: 'loud' },
];

const OUT_DIR = new URL('../public/audio/piano/', import.meta.url);
const CACHE_DIR = join(tmpdir(), 'cleffy-salamander-flac');
const FFMPEG = '/usr/bin/ffmpeg';
const OUT_RATE = 22050;
const MAX_SECONDS = 6;
const FADE_SECONDS = 0.25;
const RMS_SECONDS = 1.5;
const KBPS = 48;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

const salamanderNote = (anchor) => anchor.replaceAll('Ds', 'D#').replaceAll('Fs', 'F#');

const flacUrl = (anchor, salamander) => {
    const file = `${salamanderNote(anchor)}v${salamander}.flac`;
    return `${SOURCE}/${encodeURIComponent(file)}`;
};

const cachePathFor = (anchor, salamander) => join(CACHE_DIR, `${anchor}v${salamander}.flac`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exists = async (path) => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

const downloadFlac = async (url, dest) => {
    if (await exists(dest)) {
        return;
    }
    let lastError = /** @type {unknown} */ (null);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            await writeFile(dest, Buffer.from(await res.arrayBuffer()));
            return;
        } catch (err) {
            lastError = err;
            if (attempt < MAX_ATTEMPTS) {
                await sleep(400 * attempt);
            }
        }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${url}: ${detail} after ${MAX_ATTEMPTS} retries`);
};

const asyncPool = async (items, limit, worker) => {
    let next = 0;
    const run = async () => {
        while (true) {
            const i = next;
            next += 1;
            if (i >= items.length) {
                return;
            }
            await worker(items[i], i);
        }
    };
    const n = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: n }, () => run()));
};

const decodeFlac = (path) =>
    new Promise((resolve, reject) => {
        const proc = spawn(
            FFMPEG,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-i',
                path,
                '-f',
                'f32le',
                '-ac',
                '1',
                '-ar',
                String(OUT_RATE),
                '-',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const chunks = [];
        const errChunks = [];
        proc.stdout.on('data', (chunk) => chunks.push(chunk));
        proc.stderr.on('data', (chunk) => errChunks.push(chunk));
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                const err = Buffer.concat(errChunks).toString().trim() || `exit ${code}`;
                reject(new Error(`ffmpeg ${path}: ${err}`));
                return;
            }
            const buf = Buffer.concat(chunks);
            resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
        });
    });

// Musicality: the note attack must sit at t=0. The source files carry room
// noise before the hammer, and our own lamejs encode adds ~26 ms more (no
// gapless tag, so browsers can't strip it) — untrimmed, every piano note
// lands audibly late against the metronome click and playhead.
const ONSET_PRE_ROLL_S = 0.002;
const FADE_IN_S = 0.002;

const onsetIndex = (input, rate) => {
    let peak = 0;
    for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
    const threshold = Math.max(0.004, peak * 0.01);
    for (let i = 0; i < input.length; i++) {
        if (Math.abs(input[i]) > threshold) {
            return Math.max(0, i - Math.floor(rate * ONSET_PRE_ROLL_S));
        }
    }
    return 0;
};

const trimAndFade = (input, rate) => {
    const start = Math.min(input.length, onsetIndex(input, rate));
    const max = Math.min(input.length, start + Math.floor(rate * MAX_SECONDS));
    const out = input.slice(start, max);
    const fadeIn = Math.min(out.length, Math.floor(rate * FADE_IN_S));
    for (let i = 0; i < fadeIn; i++) {
        out[i] *= i / fadeIn;
    }
    const fadeSamples = Math.min(out.length, Math.floor(rate * FADE_SECONDS));
    for (let i = 0; i < fadeSamples; i++) {
        const k = out.length - fadeSamples + i;
        out[k] *= 1 - i / fadeSamples;
    }
    return out;
};

const rmsOf = (samples, rate, seconds = RMS_SECONDS) => {
    const n = Math.min(samples.length, Math.max(1, Math.floor(rate * seconds)));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / n);
};

const scaleInPlace = (samples, gain) => {
    if (gain === 1) return samples;
    for (let i = 0; i < samples.length; i++) samples[i] *= gain;
    return samples;
};

const encodeMp3 = (mono, rate) => {
    const encoder = new lamejs.Mp3Encoder(1, rate, KBPS);
    const int16 = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(mono[i] * 32767)));
    }
    const chunks = [];
    for (let i = 0; i < int16.length; i += 1152) {
        const chunk = encoder.encodeBuffer(int16.subarray(i, i + 1152));
        if (chunk.length > 0) chunks.push(Buffer.from(chunk));
    }
    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(Buffer.from(tail));
    return Buffer.concat(chunks);
};

await mkdir(OUT_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });

const downloads = ANCHORS.flatMap((anchor) => LAYERS.map((layer) => ({ anchor, layer })));
await asyncPool(downloads, DOWNLOAD_CONCURRENCY, async ({ anchor, layer }) => {
    const url = flacUrl(anchor, layer.salamander);
    const dest = cachePathFor(anchor, layer.salamander);
    await downloadFlac(url, dest);
    console.log(`cached ${anchor}v${layer.salamander}.flac`);
});

// NOTE on residual latency: mp3 always decodes with codec padding at the
// front (lamejs writes no gapless header, so browsers cannot strip it).
// Source-silence is trimmed here, and the app measures each decoded buffer's
// true onset at load time and plays from that offset
// (src/features/playback/pianoSampler.ts) — that pairing is what keeps note
// attacks sample-accurate against the metronome and playhead.

const gains = {};
let total = 0;
let files = 0;

for (const name of ANCHORS) {
    const pcm = {};
    for (const layer of LAYERS) {
        const raw = await decodeFlac(cachePathFor(name, layer.salamander));
        pcm[layer.role] = trimAndFade(raw, OUT_RATE);
    }
    const midRms = rmsOf(pcm.mid, OUT_RATE);
    for (const layer of LAYERS) {
        let gain = 1;
        if (layer.role !== 'mid') {
            const layerRms = rmsOf(pcm[layer.role], OUT_RATE);
            gain = layerRms > 0 ? midRms / layerRms : 1;
            scaleInPlace(pcm[layer.role], gain);
        }
        const fileStem = `${name}${layer.suffix}`;
        gains[fileStem] = gain;
        const mp3 = encodeMp3(pcm[layer.role], OUT_RATE);
        await writeFile(new URL(`${fileStem}.mp3`, OUT_DIR), mp3);
        total += mp3.length;
        files += 1;
        console.log(`${fileStem}.mp3  ${(mp3.length / 1024).toFixed(0)} KiB  gain ${gain.toFixed(3)}`);
    }
}

const expected = ANCHORS.length * LAYERS.length;
if (files !== expected) {
    throw new Error(`expected ${expected} mp3s, wrote ${files} — refusing a partial set`);
}

const manifest = {
    layers: LAYERS.map(({ suffix, velocity }) => ({ suffix, velocity })),
    credit: CREDIT,
    gains,
};
await writeFile(new URL('layers.json', OUT_DIR), `${JSON.stringify(manifest, null, 4)}\n`);
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MiB across ${files} samples`);
