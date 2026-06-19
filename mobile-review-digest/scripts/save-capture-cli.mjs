// Usage: node save-capture-cli.mjs <slug> <branch> <imagePath> <summaryFile>
import { saveCapture } from './captures.mjs';
import { readFileSync } from 'node:fs';

const [, , slug, branch, imagePath, summaryFile] = process.argv;
try {
  const summary = summaryFile ? readFileSync(summaryFile, 'utf8') : '';
  const dir = saveCapture({ slug, branch, imagePath, summary });
  console.log('saved capture to', dir);
} catch (e) {
  // Best-effort: report but exit 0 so a verify step never fails on capture.
  console.error('capture skipped:', String(e.message || e));
  process.exit(0);
}
