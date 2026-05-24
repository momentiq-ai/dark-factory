const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "openai", re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9-_]{20,}/g },
  { name: "cursor", re: /cursor_[A-Za-z0-9-_]{20,}/g },
  { name: "github_pat", re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "private_key", re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g },
  { name: "generic_long_token", re: /(?<![A-Za-z0-9])([A-Za-z0-9_-]{40,})(?![A-Za-z0-9])/g },
];

const SECRET_KEY_HINT = /\b(api[_-]?key|secret|token|password|passphrase|auth[_-]?token)\b\s*[:=]\s*["']?(?!\[REDACTED)([^"'\s]{8,})/gi;

export function redactSecrets(input: string): string {
  let out = input;
  for (const { name, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  out = out.replace(SECRET_KEY_HINT, (_match, key: string) => `${key}=[REDACTED]`);
  return out;
}
