const FIELD_KEYS = ['context', 'objective', 'scope', 'evidence', 'done when'];
const BLOCK_RE = /\b(work after|after reconciling|continue the existing|depends on|blocked by|once .* merge|reconcile with origin)\b/i;

function fieldKey(label) {
  const k = label.trim().toLowerCase();
  return k === 'done when' ? 'doneWhen' : k;
}

export function parseTasks(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const tasks = [];
  let cur = null;

  const headerRe = /^(\d+)\.\s*\[(open|in progress)\]\s*(.+?)\s*$/;
  const fieldRe = /^\s*-\s*([A-Za-z ]+?):\s*(.*)$/;

  for (const line of lines) {
    const h = line.match(headerRe);
    if (h) {
      if (cur) tasks.push(finalize(cur));
      cur = { num: Number(h[1]), state: h[2], title: h[3], fields: {}, _rawLines: [] };
      continue;
    }
    if (!cur) continue;
    cur._rawLines.push(line);
    const f = line.match(fieldRe);
    if (f && FIELD_KEYS.includes(f[1].trim().toLowerCase())) {
      cur.fields[fieldKey(f[1])] = f[2].trim();
      cur._lastField = fieldKey(f[1]);
    } else if (line.trim() && cur._lastField) {
      cur.fields[cur._lastField] += ' ' + line.trim();
    }
  }
  if (cur) tasks.push(finalize(cur));
  return tasks;
}

function finalize(t) {
  delete t._lastField;
  t.raw = (t._rawLines || []).join('\n').replace(/\s+$/, '');
  delete t._rawLines;
  const haystack = [t.title, t.fields.scope, t.fields.evidence, t.fields.objective]
    .filter(Boolean).join(' ');
  const m = haystack.match(BLOCK_RE);
  t.blocked = Boolean(m);
  t.blockReason = m ? m[0] : null;
  t.effort = estimateEffort(t.fields.scope || '');
  return t;
}

function estimateEffort(scope) {
  if (/\b(redesign|rework|cross-cutting|migration)\b/i.test(scope) || scope.length > 600) return 'L';
  if (/\b(rename|test-only|comment|copy)\b/i.test(scope) || scope.length < 200) return 'S';
  return 'M';
}
