import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function makeBuilder({ cwd = 'C:\\proj', entrypoint = 'cli' } = {}) {
  const list = [];
  let t = Date.parse('2026-09-19T10:00:00.000Z');
  let n = 0;
  const base = (type) => ({ type, uuid: randomUUID(), timestamp: new Date((t += 1000)).toISOString(), cwd, entrypoint, isSidechain: false, sessionId: 'sess' });
  const api = {
    human(text, { legacy = false, list: asList = false } = {}) {
      const e = { ...base('user'), message: { role: 'user', content: asList ? [{ type: 'text', text }] : text } };
      if (!legacy) { e.origin = { kind: 'human' }; e.promptSource = 'typed'; }
      list.push(e); return e;
    },
    feedback(text) { list.push({ ...base('user'), isMeta: true, message: { role: 'user', content: `Stop hook feedback:\n${text}` } }); },
    meta(text) { list.push({ ...base('user'), isMeta: true, message: { role: 'user', content: text } }); },
    notification(text) { list.push({ ...base('user'), origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: text } }); },
    assistantText(text) { list.push({ ...base('assistant'), message: { role: 'assistant', content: [{ type: 'text', text }] } }); },
    toolUse(name, input, id = `toolu_${++n}`) { list.push({ ...base('assistant'), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }); return id; },
    toolResult(id, content = 'ok', isError = false) {
      const block = { type: 'tool_result', tool_use_id: id, content };
      if (isError) block.is_error = true;
      list.push({ ...base('user'), message: { role: 'user', content: [block] } });
    },
    sidechain(entry) { list.push({ ...entry, isSidechain: true }); },
    raw(obj) { list.push(obj); },
    entries() { return list.slice(); },
    write() {
      const dir = mkdtempSync(join(tmpdir(), 'jev-transcript-'));
      const p = join(dir, 'transcript.jsonl');
      writeFileSync(p, list.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return p;
    },
  };
  return api;
}
