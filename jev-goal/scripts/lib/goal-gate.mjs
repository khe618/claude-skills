import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { confirmationToken } from './token.mjs';

export function parseSlug(filePath) {
  const slug = basename(filePath).replace(/\.json$/, '');
  const m = /^(.*?)(?:-(\d+))?$/.exec(slug);
  const base = m[1] || slug;
  const revision = m[2] ? Number(m[2]) : 1;
  return { slug, base, revision };
}

export function readRoundsTolerant(roundsPath) {
  if (!existsSync(roundsPath)) return { rounds: [], corrupt: false };
  const raw = readFileSync(roundsPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const writerMidAppend = !raw.endsWith('\n'); // only then may the last line legitimately be incomplete
  const rounds = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      rounds.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1 && writerMidAppend) break;
      return { rounds: [], corrupt: true };
    }
  }
  return { rounds, corrupt: false };
}

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

function readOne(file) {
  const { slug, base, revision } = parseSlug(file);
  const out = { file, slug, base, revision, frozen: false, state: 'open', task: slug, maxRounds: 10, rounds: [], lastRound: null, lockSha256: null, frozenAt: null };
  const lockPath = file + '.lock';
  let lock = null;
  if (existsSync(lockPath)) {
    try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { lock = null; }
  }
  if (lock && typeof lock.sha256 === 'string') { out.frozen = true; out.lockSha256 = lock.sha256; out.frozenAt = lock.frozenAt ?? null; }
  // A missing criteria file, or a missing lock file, is the documented way to abandon a goal: release
  // it rather than treating it as a corrupt/invalid state that would keep blocking the session.
  if (!existsSync(file) || !existsSync(lockPath)) return { ...out, state: 'released', frozen: false, error: 'criteria or lock file missing' };
  if (!out.frozen) return { ...out, state: 'invalid', error: 'lock file unparseable' };
  let spec;
  try { spec = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { ...out, state: 'invalid', error: `criteria unparseable: ${e.message}` }; }
  out.task = typeof spec.task === 'string' ? spec.task : slug;
  out.maxRounds = Number.isInteger(spec.maxRounds) && spec.maxRounds >= 1 ? spec.maxRounds : 10;
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sha !== lock.sha256) return { ...out, state: 'invalid', error: 'criteria modified after freeze' };
  const { rounds, corrupt } = readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl'));
  if (corrupt) return { ...out, state: 'invalid', error: 'rounds file corrupt' };
  out.rounds = rounds;
  out.lastRound = rounds.at(-1) ?? null;
  return out;
}

export function goalStates(ownedFiles, { editTimestamps = [] } = {}) {
  const states = ownedFiles.map(readOne);
  // Supersession: the highest revision per base that HAS a parseable lock wins, valid or not.
  const newest = new Map();
  for (const s of states) {
    if (!s.frozen) continue;
    const cur = newest.get(s.base);
    if (!cur || s.revision > cur.revision) newest.set(s.base, s);
  }
  const lastEditMs = editTimestamps.map(ms).filter((t) => t !== null).reduce((a, b) => Math.max(a, b), -Infinity);
  for (const s of states) {
    if (s.state === 'released') continue; // takes no part in supersession, stays released
    if (s.frozen && newest.get(s.base) !== s) { s.state = 'superseded'; continue; }
    if (s.state === 'invalid') continue;
    const lr = s.lastRound;
    if (!lr) { s.state = 'open'; continue; }
    if (lr.passed) {
      const passMs = ms(lr.at);
      s.state = passMs !== null && lastEditMs > passMs ? 'reopened' : 'passed';
      continue;
    }
    s.state = s.rounds.length >= s.maxRounds ? 'exhausted' : 'open';
  }
  return states;
}

const sentinel = () => `jev-goal-gate#${randomBytes(4).toString('hex')}`;
const GRADE = 'node ~/.claude/skills/jev-goal/scripts/grade.mjs grade';

export function gateDecision(states, { gateCount, latestPromptIso, finalText }) {
  if (gateCount >= 3) return { yielded: true };
  const live = states.filter((s) => s.state !== 'superseded' && s.state !== 'released');
  const invalid = live.filter((s) => s.state === 'invalid');
  if (invalid.length) {
    const lines = invalid.map((s) => `  ${basename(s.file)}: ${s.error}`).join('\n');
    return {
      kind: 'invalid', files: invalid.map((s) => s.file),
      reason: `${sentinel()}: frozen criteria are in an invalid state.\n${lines}\nRestore the frozen criteria file exactly, or start <slug>-<n+1>.json for a genuinely new task, freeze it, then grade.`,
    };
  }
  const open = live.filter((s) => s.state === 'open' || s.state === 'reopened');
  if (open.length) {
    const lines = open.map((s) => {
      const detail = s.state === 'reopened' ? 'files changed after the passing grade'
        : s.rounds.length === 0 ? 'not yet graded' : `round ${s.lastRound.round}, failing: ${(s.lastRound.failed ?? []).join(', ') || 'none listed'}`;
      return `  ${basename(s.file)} (${s.task}): ${detail}`;
    }).join('\n');
    return {
      kind: 'open', files: open.map((s) => s.file),
      reason: `${sentinel()}: criteria frozen this session are not passing.\n${lines}\nRun \`${GRADE} <file>\` and keep working until it passes. If the criteria cannot be met, say why in one sentence and stop; the gate yields after three blocks.`,
    };
  }
  const promptMs = ms(latestPromptIso);
  const needConfirm = live.filter((s) => s.state === 'passed' && ms(s.lastRound.at) !== null && promptMs !== null && ms(s.lastRound.at) > promptMs &&
    !String(finalText ?? '').includes(confirmationToken(s.slug, s.lockSha256, s.lastRound.round, s.lastRound.at)));
  if (needConfirm.length) {
    const lines = needConfirm.map((s) => `  ${basename(s.file)} (${s.task})`).join('\n');
    return {
      kind: 'confirmation', files: needConfirm.map((s) => s.file),
      reason: `${sentinel()}: criteria passed this turn but the final message has no confirmation block.\n${lines}\nPaste the block between \`--- jev-goal confirmation\` and \`--- end confirmation ---\` from the grade output (it includes the token line), then summarise the work.`,
    };
  }
  return null;
}
