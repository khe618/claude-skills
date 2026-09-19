import { createHash } from 'node:crypto';

export function confirmationToken(slug, lockSha256, round, at) {
  const hex = createHash('sha256').update(`${lockSha256}:${round}:${at}`).digest('hex').slice(0, 12);
  return `${slug}:${round}:${hex}`;
}
