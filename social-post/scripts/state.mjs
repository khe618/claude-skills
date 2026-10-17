// Posting ledger for the weekly social-post run.
//
//   node scripts/state.mjs plan                       # what this run should do (JSON)
//   node scripts/state.mjs status                     # human-readable ledger
//   node scripts/state.mjs mark <slug> <ig|tiktok|x> <posted|failed> [url] [note]
//   node scripts/state.mjs run-start | run-end <ok|partial|failed> [note]
//   node scripts/state.mjs queue-low                  # exit 0 when < 2 unposted decks remain
//
// Env: SOCIAL_POST_REPO (traderprep checkout holding the decks, default the
// social-post worktree) and SOCIAL_POST_STATE (state dir, default
// C:\dev\traderprep-data\social-post). Decks are ordered by slug; a deck is
// "unposted" when it has no ledger entry at all, "partial" when at least one
// platform is not posted.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const PLATFORMS = ['ig', 'tiktok', 'x'];
export const STATUSES = ['posted', 'failed'];

export const DEFAULT_REPO = process.env.SOCIAL_POST_REPO ?? 'C:\\dev\\traderprep-worktrees\\social-post';
export const DEFAULT_STATE_DIR = process.env.SOCIAL_POST_STATE ?? 'C:\\dev\\traderprep-data\\social-post';
export const DECKS_SUBDIR = path.join('marketing', 'social', 'slideshows', 'decks');

const defaults = () => ({
  decksDir: path.join(DEFAULT_REPO, DECKS_SUBDIR),
  stateFile: path.join(DEFAULT_STATE_DIR, 'state.json'),
});

export async function loadState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    return { decks: parsed.decks ?? {}, runs: parsed.runs ?? [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { decks: {}, runs: [] };
    throw err;
  }
}

async function saveState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export async function listDecks(decksDir) {
  const files = await readdir(decksDir);
  return files.filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json')).sort();
}

function missingPlatforms(entry = {}) {
  return PLATFORMS.filter((p) => entry[p]?.status !== 'posted');
}

export async function plan(opts = {}) {
  const { decksDir, stateFile } = { ...defaults(), ...opts };
  const [slugs, state] = await Promise.all([listDecks(decksDir), loadState(stateFile)]);
  const finish = [];
  const unposted = [];
  for (const slug of slugs) {
    const entry = state.decks[slug];
    if (!entry) { unposted.push(slug); continue; }
    const missing = missingPlatforms(entry);
    if (missing.length) finish.push({ slug, platforms: missing });
  }
  return { finish, post: unposted[0] ?? null, remaining: Math.max(0, unposted.length - 1) };
}

export async function queueLow(opts = {}) {
  const { decksDir, stateFile } = { ...defaults(), ...opts };
  const [slugs, state] = await Promise.all([listDecks(decksDir), loadState(stateFile)]);
  const unposted = slugs.filter((s) => !state.decks[s]);
  return unposted.length < 2;
}

export async function mark({ stateFile = defaults().stateFile, slug, platform, status, url, note }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform "${platform}"; use ${PLATFORMS.join('|')}`);
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"; use ${STATUSES.join('|')}`);
  const state = await loadState(stateFile);
  state.decks[slug] ??= {};
  state.decks[slug][platform] = { status, at: new Date().toISOString(), ...(url ? { url } : {}), ...(note ? { note } : {}) };
  await saveState(stateFile, state);
  return state.decks[slug];
}

export async function recordRun({ stateFile = defaults().stateFile, phase, outcome, note }) {
  const state = await loadState(stateFile);
  if (phase === 'start') {
    state.runs.push({ startedAt: new Date().toISOString() });
  } else {
    const run = state.runs.at(-1) ?? {};
    if (!state.runs.length) state.runs.push(run);
    Object.assign(run, { endedAt: new Date().toISOString(), outcome, ...(note ? { note } : {}) });
  }
  state.runs = state.runs.slice(-52);
  await saveState(stateFile, state);
}

export async function status(opts = {}) {
  const { decksDir, stateFile } = { ...defaults(), ...opts };
  const [slugs, state] = await Promise.all([listDecks(decksDir), loadState(stateFile)]);
  const lines = [];
  for (const slug of slugs) {
    const entry = state.decks[slug] ?? {};
    const cells = PLATFORMS.map((p) => {
      const e = entry[p];
      if (!e) return `${p}: -`;
      return `${p}: ${e.status}${e.url ? ' ' + e.url : ''}`;
    });
    lines.push(`${slug}\n  ${cells.join('\n  ')}`);
  }
  const last = state.runs.at(-1);
  lines.push(last ? `last run: ${last.startedAt} -> ${last.outcome ?? 'in progress'}${last.note ? ' (' + last.note + ')' : ''}` : 'last run: never');
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'plan') console.log(JSON.stringify(await plan(), null, 2));
    else if (cmd === 'status') console.log(await status());
    else if (cmd === 'mark') {
      const [slug, platform, st, url, note] = rest;
      console.log(JSON.stringify(await mark({ slug, platform, status: st, url, note })));
    } else if (cmd === 'run-start') await recordRun({ phase: 'start' });
    else if (cmd === 'run-end') await recordRun({ phase: 'end', outcome: rest[0], note: rest[1] });
    else if (cmd === 'queue-low') process.exit((await queueLow()) ? 0 : 1);
    else { console.error('usage: state.mjs plan|status|mark|run-start|run-end|queue-low'); process.exit(2); }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
