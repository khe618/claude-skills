import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderAttention } from './render-digest.mjs';
import { deploy as realDeploy } from './deploy.mjs';

const MARKER = '<!--ATTENTION-SLOT-->';

export function spliceAttention(indexHtml, attentionHtml) {
  if (!indexHtml.includes(MARKER)) return { html: indexHtml, ok: false };
  return { html: indexHtml.replace(MARKER, attentionHtml), ok: true };
}

export function enrich({ siteDir, today, items = [], deployFn = realDeploy }) {
  const lrPath = join(siteDir, 'last-run.json');
  const idxPath = join(siteDir, 'index.html');
  if (!existsSync(lrPath) || !existsSync(idxPath)) return { ok: false, reason: 'missing files' };
  let lr;
  try { lr = JSON.parse(readFileSync(lrPath, 'utf8')); } catch { return { ok: false, reason: 'bad last-run' }; }
  if (lr.date !== today || !['core', 'enriched'].includes(lr.status)) return { ok: false, reason: 'no fresh core' };
  // No early-out on empty items: renderAttention([]) returns an "all clear" note, so we
  // still splice + deploy it (a positive confirmation that the enrich ran).
  const idx = readFileSync(idxPath, 'utf8');
  const { html, ok } = spliceAttention(idx, renderAttention(items));
  if (!ok) return { ok: false, reason: 'no slot' };
  writeFileSync(idxPath, html);                 // vercel deploys the folder, so stage to disk first
  const res = deployFn({ siteDir });
  if (!res.ok) {
    writeFileSync(idxPath, idx);                // ROLL BACK to Job A's exact core bytes
    return { ok: false, reason: 'deploy failed; rolled back: ' + (res.error || '') };
  }
  writeFileSync(lrPath, JSON.stringify({ ...lr, status: 'enriched', url: res.url ?? lr.url }, null, 2) + '\n');
  return { ok: true };
}
