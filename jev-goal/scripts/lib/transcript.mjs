import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const MUTATING = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'Agent', 'Skill']);
export const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'ToolSearch', 'ListAgents', 'ReadNotifications', 'WebSearch', 'WebFetch', 'TodoRead', 'AskUserQuestion']);
export const WAITING_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export function isMutating(name) {
  return MUTATING.has(name) || (typeof name === 'string' && name.startsWith('mcp__'));
}

export function parseTranscript(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if (e.isSidechain === true) continue;
    out.push(e);
  }
  return out;
}

export function isHeadless(entries) {
  return entries.some((e) => e.entrypoint === 'sdk-cli');
}

const content = (e) => e?.message?.content;
const isStringUser = (e) => e.type === 'user' && typeof content(e) === 'string';

export function entryText(e) {
  const c = content(e);
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

export function isHumanPrompt(e) {
  if (e.type !== 'user') return false;
  if (e.origin && typeof e.origin === 'object') return e.origin.kind === 'human';
  return typeof content(e) === 'string' && e.isMeta !== true;
}

export function lastHumanPromptIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (isHumanPrompt(entries[i])) return i;
  return -1;
}

export function chain(entries) {
  const i = lastHumanPromptIndex(entries);
  return i < 0 ? [] : entries.slice(i);
}

export function segment(entries) {
  return segmentBefore(entries, entries.length);
}

// Entries strictly between the last string-content user entry before `index` and `index`.
export function segmentBefore(entries, index) {
  let start = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (isStringUser(entries[i])) { start = i; break; }
  }
  return entries.slice(start + 1, index);
}

export function finalAssistantText(entries) {
  return entries.filter((e) => e.type === 'assistant').map(entryText).filter(Boolean).join('\n');
}

export function summarize(name, input) {
  const inp = input ?? {};
  if (name === 'Bash') {
    const first = String(inp.command ?? '').trim().split(/\s+/)[0];
    return first || 'Bash';
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name)) return String(inp.file_path ?? name);
  if (name === 'Agent') return String(inp.description ?? name);
  if (name === 'Skill') return String(inp.skill ?? name);
  if (name === 'Grep' || name === 'Glob') return String(inp.pattern ?? name);
  return name;
}

export function toolCalls(entries) {
  // Results are keyed by id; the first result that appears AFTER the call wins. Earlier or duplicate results are ignored.
  const resultsById = new Map(); // id -> [{ index, block }]
  entries.forEach((e, index) => {
    const c = content(e);
    if (e.type !== 'user' || !Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      if (!resultsById.has(b.tool_use_id)) resultsById.set(b.tool_use_id, []);
      resultsById.get(b.tool_use_id).push({ index, block: b });
    }
  });
  const calls = [];
  entries.forEach((e, index) => {
    const c = content(e);
    if (e.type !== 'assistant' || !Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      const r = (resultsById.get(b.id) ?? []).find((x) => x.index > index)?.block;
      calls.push({ name: b.name, summary: summarize(b.name, b.input), ok: !(r && r.is_error === true), timestamp: e.timestamp, index, id: b.id, input: b.input });
    }
  });
  return calls;
}

const FREEZE_RE = /grade\.mjs["']?\s+freeze\s+("([^"]+)"|'([^']+)'|(\S+))/;
const MSYS_DRIVE_RE = /^\/([A-Za-z])(\/|$)/; // "/c/proj/x" as Git Bash wrote it, before MSYS argument conversion

function normaliseShellPath(raw) {
  const m = MSYS_DRIVE_RE.exec(raw);
  return m ? `${m[1].toUpperCase()}:/${raw.slice(m[0].length)}` : raw;
}

export function freezeInvocations(entries) {
  const out = [];
  for (const call of toolCalls(entries)) {
    if (call.name !== 'Bash' || !call.ok) continue;
    const m = FREEZE_RE.exec(String(call.input?.command ?? ''));
    if (!m) continue;
    const raw = normaliseShellPath(m[2] ?? m[3] ?? m[4]);
    const cwd = normaliseShellPath(entries[call.index]?.cwd ?? process.cwd());
    const p = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function sentinelPositions(entries, kind) {
  const re = new RegExp(`${kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#[0-9a-f]{8}`);
  const out = [];
  entries.forEach((e, i) => {
    if (e.type === 'user' && e.isMeta === true && re.test(entryText(e))) out.push(i);
  });
  return out;
}

// Our nudge block runs from its sentinel through the closing instruction line. Anything else in the entry
// (other hooks' reasons, concatenated by Claude Code) is not ours and must not leave the machine.
const NUDGE_BLOCK_RE = /jev-stop-nudge#[0-9a-f]{8}[\s\S]*?If you can advance the request now, do it\. If you are genuinely waiting on the user, say so in one sentence and stop\./;

export function extractNudgeReason(text) {
  const m = NUDGE_BLOCK_RE.exec(String(text ?? ''));
  return m ? m[0] : null;
}
