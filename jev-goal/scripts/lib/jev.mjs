// Shared Jev client for grade.mjs and stop-hook.mjs.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(scriptsDir, '.env'), quiet: true, override: false });

export const MODEL = 'typesafe-ai/jev';
export const RULE =
  'Answer true only if the evidence output in state clearly demonstrates it. ' +
  'If the relevant evidence is missing, errored, or ambiguous, answer false.';

export class JevError extends Error {
  constructor(code, message, { status, hint } = {}) {
    super(message);
    this.code = code; // 'no_key' | 'grader_unavailable'
    this.status = status;
    this.hint = hint ?? '';
  }
}

export function truncate(text, head = 24000, tail = 8000) {
  const s = text ?? '';
  if (s.length <= head + tail) return s;
  const omitted = s.length - head - tail;
  const tailPart = tail > 0 ? s.slice(-tail) : ''; // s.slice(-0) would return the whole string
  return s.slice(0, head) + `\n...[${omitted} chars omitted]...\n` + tailPart;
}

let bashPath;
export function findBash() {
  if (bashPath !== undefined) return bashPath;
  if (process.platform !== 'win32') return (bashPath = '/bin/bash');
  const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'];
  return (bashPath = candidates.find((p) => existsSync(p)) ?? null);
}

export function classifyGatewayError(e) {
  const last = e?.errors?.at(-1) ?? e;
  const status = last?.statusCode ?? last?.cause?.statusCode;
  const message = (last?.message ?? String(e)).split('\n')[0];
  const hint =
    status === 429 ? 'Rate limited: wait 60-120s and run grade again.'
    : status === 402 ? 'Out of gateway credits or budget.'
    : status === 401 ? 'AI_GATEWAY_API_KEY rejected.'
    : 'Transient failure: run grade again.';
  return { status, message, hint };
}

export async function askJev({ questions, state, timeoutMs = 25000, maxRetries = 2, allowFake = false }) {
  if (allowFake && process.env.JEV_FAKE_ERROR) {
    const status = Number(process.env.JEV_FAKE_ERROR) || undefined;
    throw new JevError('grader_unavailable', `fake gateway error ${status ?? ''}`.trim(), { status, hint: 'fake' });
  }
  if (allowFake && process.env.JEV_FAKE_ANSWERS) {
    const map = JSON.parse(process.env.JEV_FAKE_ANSWERS);
    const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'boolean', probability: Number(map[id] ?? 0) }]));
    return { answers, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new JevError('no_key', `AI_GATEWAY_API_KEY missing (set it in ${join(scriptsDir, '.env')})`);
  }
  // timeoutMs 0 means no abort at all (grade.mjs keeps its historical no-timeout behaviour).
  const ac = timeoutMs > 0 ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const { experimental_evaluate: evaluate } = await import('ai');
    const r = await evaluate({ model: MODEL, state, questions, maxRetries, ...(ac ? { abortSignal: ac.signal } : {}) });
    return { answers: r.answers, usage: { inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens } };
  } catch (e) {
    const { status, message, hint } = classifyGatewayError(e);
    throw new JevError('grader_unavailable', message, { status, hint });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Keep the first `head` and last `tail` items with one marker item in between: head + 1 + tail total.
export function capList(list, head, tail) {
  if (list.length <= head + tail + 1) return list;
  return [...list.slice(0, head), { name: '...', summary: `${list.length - head - tail} calls omitted`, ok: true }, ...list.slice(-tail)];
}
