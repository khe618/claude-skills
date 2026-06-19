import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderArchiveIndex } from './render-digest.mjs';

export function writeDigest({ siteDir, date, generatedAt, html, status = 'core', url = null, error = null, lastScheduledRunAt = null }) {
  const archiveDir = join(siteDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), html);
  writeFileSync(join(archiveDir, `${date}.html`), html);

  const dates = readdirSync(archiveDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map((f) => f.replace(/\.html$/, ''))
    .sort()
    .reverse();
  writeFileSync(join(archiveDir, 'index.html'), renderArchiveIndex(dates));
  writeFileSync(join(siteDir, 'last-run.json'),
    JSON.stringify({ generatedAt, date, status, url, error, lastScheduledRunAt }, null, 2) + '\n');
  return { dates };
}
