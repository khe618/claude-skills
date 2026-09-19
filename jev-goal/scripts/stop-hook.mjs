#!/usr/bin/env node
// Claude Code Stop hook: goal gate (deterministic) + Jev nudge battery. See docs/specs/2026-09-19-jev-stop-nudge-design.md.
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { askJev, JevError, RULE, truncate, capList } from './lib/jev.mjs';
import { redact } from './lib/redact.mjs';
import {
  parseTranscript, isHeadless, chain, segment, segmentBefore, finalAssistantText, toolCalls, freezeInvocations,
  sentinelPositions, lastHumanPromptIndex, entryText, isMutating, extractNudgeReason, WAITING_TOOLS, EDIT_TOOLS,
} from './lib/transcript.mjs';
import { goalStates, gateDecision } from './lib/goal-gate.mjs';

export const TRIGGER = 0.8; // trigger fires at P(true) >= TRIGGER (raw, unrounded)
export const VETO = 0.5;    // veto holds at P(true) >= VETO (raw, unrounded)
const NUDGE_CAP = 2;
const CAPS = { request: 4000, before: 3000, final: 6000, nudgeBefore: 3000, summary: 200 };
const TRIGGER_IDS = ['promises_pending', 'request_unmet'];
const VETO_IDS = ['asks_user', 'blocked_external', 'declined', 'restatement'];

const mode = (process.env.JEV_STOP_HOOK ?? 'off').toLowerCase();
const logPath = process.env.JEV_STOP_HOOK_LOG ?? join(homedir(), '.claude', 'jev-stop-hook', 'log.jsonl');

main().catch(() => process.exit(0));

async function main() {
  if (mode !== 'shadow' && mode !== 'enforce') return;
  const input = await readStdin();
  const transcriptPath = input.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) return;

  const record = {
    at: new Date().toISOString(), session: input.session_id ?? null, cwd: input.cwd ?? null, mode,
    nudgeCount: 0, gateCount: 0, gate: null, batteryRan: false, answers: null, fired: null, wouldBlock: false, blocked: false,
    reason: null, finalMessagePreview: null, usage: null, error: null, label: null,
  };
  let decision = null;

  try {
    const entries = parseTranscript(transcriptPath);
    if (!entries.length || isHeadless(entries)) return;
    const promptIdx = lastHumanPromptIndex(entries);
    if (promptIdx < 0) return;
    const ch = chain(entries);
    const seg = segment(entries);
    const finalText = finalAssistantText(seg);
    record.finalMessagePreview = redact(finalText).slice(0, 80);
    const nudgePositions = sentinelPositions(ch, 'jev-stop-nudge');
    record.nudgeCount = nudgePositions.length;
    record.gateCount = sentinelPositions(ch, 'jev-goal-gate').length;

    // --- goal gate -------------------------------------------------------
    const owned = freezeInvocations(entries);
    if (owned.length) {
      const editTimestamps = toolCalls(entries).filter((c) => EDIT_TOOLS.has(c.name)).map((c) => c.timestamp);
      const states = goalStates(owned, { editTimestamps });
      const gd = gateDecision(states, { gateCount: record.gateCount, latestPromptIso: entries[promptIdx].timestamp, finalText });
      record.gate = {
        owned: owned.map((f) => basename(f)),
        states: Object.fromEntries(states.map((s) => [basename(s.file), s.state])),
        blockedOn: gd && !gd.yielded ? gd.kind : null,
        gateYielded: !!gd?.yielded,
      };
      if (gd && !gd.yielded) decision = gd.reason;
      // While a goal exists the gate is the authority; the battery never runs.
      return;
    }

    // --- battery eligibility ---------------------------------------------
    const segCalls = toolCalls(seg);
    if (!segCalls.some((c) => isMutating(c.name))) return;
    if (segCalls.some((c) => WAITING_TOOLS.has(c.name))) return;
    if (record.nudgeCount >= NUDGE_CAP) return;
    let previousNudge = null;
    if (record.nudgeCount === 1) {
      const pos = nudgePositions[0];
      const after = toolCalls(ch).filter((c) => c.index > pos && isMutating(c.name));
      if (!after.length) return;
      previousNudge = {
        reason: redact(extractNudgeReason(entryText(ch[pos])) ?? ''), // only OUR block, never other hooks' text
        assistantMessageBefore: truncate(redact(finalAssistantText(segmentBefore(ch, pos))), CAPS.nudgeBefore, 0),
        mutatingCallsAfter: after.length,
      };
    }

    // --- battery ----------------------------------------------------------
    const summarised = segCalls.map((c) => ({ name: redact(c.name), summary: truncate(redact(c.summary), CAPS.summary, 0), ok: c.ok }));
    const state = {
      latestUserRequest: truncate(redact(entryText(entries[promptIdx])), CAPS.request, 0),
      assistantMessageBeforeRequest: promptIdx > 0 ? truncate(redact(finalAssistantText(segmentBefore(entries, promptIdx))), CAPS.before, 0) || null : null,
      finalAssistantMessage: truncate(redact(finalText), CAPS.final, 0),
      toolCallsThisSegment: capList(summarised, 39, 20),
      previousNudge,
    };
    if (process.env.JEV_STOP_HOOK_DUMP_STATE) {
      // Test-only: write the exact object sent to the judge. Never set in a real registration.
      try { writeFileSync(process.env.JEV_STOP_HOOK_DUMP_STATE, JSON.stringify(state, null, 2)); } catch { /* ignore */ }
    }
    const questions = buildQuestions(!!previousNudge);
    record.batteryRan = true;
    const result = await askJev({ questions, state, timeoutMs: 25_000, maxRetries: 0, allowFake: true });
    record.usage = result.usage;
    const raw = Object.fromEntries(Object.keys(questions).map((id) => [id, Number(result.answers[id]?.probability ?? 0)]));
    record.answers = Object.fromEntries(Object.entries(raw).map(([id, p]) => [id, round2(p)])); // rounded for the log only
    const triggers = TRIGGER_IDS.filter((id) => raw[id] >= TRIGGER);
    const vetoes = VETO_IDS.filter((id) => id in raw && raw[id] >= VETO);
    record.fired = { triggers, vetoes };
    if (triggers.length && !vetoes.length) {
      decision = nudgeReason(triggers, raw, record.nudgeCount + 1);
    }
  } catch (e) {
    record.error = e instanceof JevError ? { code: e.code, status: e.status ?? null, message: e.message } : { code: 'exception', message: String(e?.message ?? e) };
    decision = null;
  } finally {
    record.wouldBlock = !!decision;
    record.blocked = !!decision && mode === 'enforce';
    record.reason = decision;
    if (record.blocked) process.stdout.write(JSON.stringify({ decision: 'block', reason: decision }) + '\n');
    if (record.gate || record.batteryRan || record.error) appendLog(record);
  }
}

function buildQuestions(withRestatement) {
  const q = (question) => ({ type: 'boolean', instructions: { question, rule: RULE } });
  const questions = {
    asks_user: q('Does the final assistant message end by asking the user a question, or asking them to choose between options or approve something, such that the assistant needs that answer before it can continue?'),
    blocked_external: q('Does the final assistant message state that further progress needs the user\'s permission, information only the user has, or an event outside the assistant\'s control?'),
    declined: q('Does the final assistant message state that the assistant will not or cannot do the requested work, and give a reason such as safety, scope, or impossibility?'),
    promises_pending: q('Does the final assistant message say the assistant will do, or still needs to do, specific work that the same message does not report as already done?'),
    request_unmet: q('Does the latest user request ask for a concrete deliverable that the final assistant message does not report as done?'),
  };
  if (withRestatement) {
    questions.restatement = q('Compared with the assistant message before the previous nudge, does the final assistant message repeat the same promises or the same blocker without reporting new progress?');
  }
  return questions;
}

const EXPLAIN = {
  request_unmet: 'the latest request asks for a deliverable the final message does not report as done.',
  promises_pending: 'the final message describes work not yet done.',
};

function nudgeReason(triggers, p, n) {
  const id = randomBytes(4).toString('hex');
  const lines = triggers.map((t) => `  ${t} P(true)=${p[t].toFixed(2)}: ${EXPLAIN[t]}`);
  return [
    `jev-stop-nudge#${id} (${n}/${NUDGE_CAP}): the user's request looks unfinished.`,
    ...lines,
    'If you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.',
  ].join('\n');
}

const round2 = (x) => Math.round(Number(x) * 100) / 100;

function appendLog(record) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch { /* best effort */ }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    process.stdin.on('error', () => resolve({}));
  });
}
