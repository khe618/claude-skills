import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeBranch } from './sanitize.mjs';

const DEFAULT_BASE = join(homedir(), '.claude', 'review-captures');

export function captureDir(slug, branch, baseDir = DEFAULT_BASE) {
  return join(baseDir, slug, sanitizeBranch(branch));
}

export function findCapture(slug, branch, baseDir = DEFAULT_BASE) {
  const dir = captureDir(slug, branch, baseDir);
  const png = join(dir, 'shot.png');
  const gif = join(dir, 'clip.gif');
  const sum = join(dir, 'summary.md');
  const image = existsSync(png) ? png : existsSync(gif) ? gif : null;
  return {
    image,
    summary: existsSync(sum) ? readFileSync(sum, 'utf8').trim() : null,
    capturedAt: image ? statSync(image).mtime.toISOString() : null,
  };
}

export function saveCapture({ slug, branch, imagePath, summary, baseDir = DEFAULT_BASE }) {
  const dir = captureDir(slug, branch, baseDir);
  mkdirSync(dir, { recursive: true });
  const ext = imagePath.toLowerCase().endsWith('.gif') ? 'clip.gif' : 'shot.png';
  copyFileSync(imagePath, join(dir, ext));
  if (summary != null) writeFileSync(join(dir, 'summary.md'), String(summary).trim() + '\n');
  return dir;
}
