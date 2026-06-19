import { writeFileSync, mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const here = dirname(fileURLToPath(import.meta.url));

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function fillTemplate(template, card) {
  const chips = (card.chips || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  let visual = '';
  if (card.imagePath) {
    visual = `<img src="${pathToFileURL(card.imagePath).href}" alt="screenshot">`;
  } else if (card.exampleHtml) {
    visual = card.exampleHtml; // caller-controlled, pre-escaped
  }
  return template
    .replaceAll('{{REPO}}', esc(card.repo))
    .replaceAll('{{NUMBER}}', esc(card.number))
    .replaceAll('{{BRANCH}}', esc(card.branch))
    .replaceAll('{{STATE}}', esc(card.state))
    .replaceAll('{{TITLE}}', esc(card.title))
    .replaceAll('{{CHIPS}}', chips)
    .replaceAll('{{WHAT_IT_DOES}}', esc(card.whatItDoes))
    .replaceAll('{{VISUAL}}', visual);
}

export async function renderCard(card, outPng, opts = {}) {
  const tpl = readFileSync(join(here, '../templates/pr-card.html'), 'utf8');
  const html = fillTemplate(tpl, card);

  const dir = mkdtempSync(join(tmpdir(), 'card-'));
  const htmlPath = join(dir, 'card.html');
  writeFileSync(htmlPath, html);

  const chrome = opts.chromePath || DEFAULT_CHROME;
  const height = opts.height || 1600;
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2', `--window-size=1080,${height}`,
    `--screenshot=${outPng}`, pathToFileURL(htmlPath).href,
  ], { stdio: 'ignore' });

  if (!statSync(outPng).size) throw new Error('empty screenshot');
  return outPng;
}
