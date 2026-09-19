// Floor, not a guarantee: masks the secret shapes most likely to appear in prompts and replies.
const PATTERNS = [
  /-----BEGIN[\s\S]*?-----END[^\n]*-----/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];
const ASSIGNMENT = /\b((?:[A-Za-z0-9]+_)*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)(?:_[A-Za-z0-9]+)*)\b[ \t]*[=:][ \t]*["']?[^\s"']{4,}["']?/gi;

export function redact(text) {
  let s = text ?? '';
  if (!s) return '';
  for (const p of PATTERNS) s = s.replace(p, '[REDACTED]');
  s = s.replace(ASSIGNMENT, (_m, name) => `${name}=[REDACTED]`);
  return s;
}
