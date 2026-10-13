const ASSIGNMENT =
  /(token|password|secret|api[_-]?key|authorization)\s*[=:]\s*([^\s]+)/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/g;

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  const unique = [...new Set(secrets.filter((s) => s.length >= 6))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of unique) {
    out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(BEARER, 'Bearer [REDACTED]');
  out = out.replace(ASSIGNMENT, '$1=[REDACTED]');
  return out;
}
