#!/usr/bin/env node
/**
 * CI guard: PRs that touch OMR parser/geometry/contract/flags must change
 * the ENGINE_VERSION string in job.ts (not merely touch the file).
 *
 * Usage: node scripts/check-engine-version.mjs [--base REF]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Repo-root-relative, matching `git diff --name-only` output directly. The app's
 * ScoreData schema is watched too: it is kept in lockstep with the service copy,
 * and a change there is just as much a contract change — editing it alone used to
 * slip past this guard entirely.
 *
 * The test is "could this change what a given PDF turns into", not "does this
 * parse anything". Structure planning, shard merging and the schema-cap thinning
 * all rewrite the score after the parse, and all three shipped silently before
 * they were listed here.
 */
const WATCHED = [
    'services/omr-service/src/musicxml.ts',
    'services/omr-service/src/omrGeometry.ts',
    'services/omr-service/src/buildScoreData.ts',
    'services/omr-service/src/repeats.ts',
    'services/omr-service/src/mergeScoreData.ts',
    'services/omr-service/src/caps.ts',
    'services/omr-service/src/scoreData.ts',
    'services/omr-service/src/audiveris.ts',
    'services/omr-service/src/ornaments.ts',
    'src/types/scoreData.ts',
];

const ENGINE_FILE = 'src/job.ts';
const VERSION_RE = /export const ENGINE_VERSION = '(audiveris-\d+\.\d+\.\d+\+svc-\d+)'/;

const revExists = (ref) => {
    try {
        execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, { cwd: ROOT, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

/**
 * On pull_request events GITHUB_BASE_REF is a bare branch name ("main"), and a CI
 * clone has no local branch of that name — only the remote-tracking ref. Try the
 * bare name first, then origin/<name>.
 */
const resolveBase = (candidate) => {
    if (revExists(candidate)) {
        return candidate;
    }
    const remote = `origin/${candidate}`;
    return revExists(remote) ? remote : null;
};

const baseArg = process.argv.find((a) => a.startsWith('--base='));
const requested =
    baseArg?.slice('--base='.length) || process.env.GITHUB_BASE_REF || process.env.ENGINE_VERSION_BASE || 'origin/main';
const base = resolveBase(requested);

if (base === null) {
    // Loud, not silent: a skipped guard is how an unbumped ENGINE_VERSION ships.
    console.log(`::warning::[engine-version] SKIPPED — no such ref '${requested}'. Guard did not run.`);
    process.exit(0);
}

const extractVersion = (src) => {
    const m = src.match(VERSION_RE);
    return m?.[1] ?? null;
};

let diff = '';
try {
    diff = execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT, encoding: 'utf8' });
} catch {
    console.log(`::warning::[engine-version] SKIPPED — could not diff against '${base}'. Guard did not run.`);
    process.exit(0);
}

const changed = new Set(
    diff
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
);

const hit = WATCHED.filter((f) => changed.has(f));
if (hit.length === 0) {
    console.log('[engine-version] ok: no watched parser files changed');
    process.exit(0);
}

const headSrc = readFileSync(join(ROOT, ENGINE_FILE), 'utf8');
const headVer = extractVersion(headSrc);
if (!headVer) {
    console.error('[engine-version] FAIL: ENGINE_VERSION constant missing or malformed in job.ts');
    process.exit(1);
}

let baseVer = null;
try {
    const baseSrc = execSync(`git show ${base}:services/omr-service/${ENGINE_FILE}`, {
        cwd: ROOT,
        encoding: 'utf8',
    });
    baseVer = extractVersion(baseSrc);
} catch {
    // File may not exist on base — treat as first introduction (baseVer stays null).
}

if (baseVer !== null && baseVer === headVer) {
    console.error(
        `[engine-version] FAIL: changed ${hit.join(', ')} but ENGINE_VERSION is still '${headVer}'.\n` +
            `Bump audiveris-<semver>+svc-<n> in ${ENGINE_FILE}.`,
    );
    process.exit(1);
}

console.log(`[engine-version] ok: ${baseVer ?? '(none)'} → ${headVer} (touched ${hit.join(', ')})`);
