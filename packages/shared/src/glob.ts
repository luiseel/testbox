/** Minimal glob: `*` within a segment, `**` across segments. */
export function matchGlob(relPosix: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPosix);
}

export function isIgnored(relPosix: string, patterns: readonly string[]): boolean {
  const parts = relPosix.split('/');
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      if (matchGlob(relPosix, pattern)) return true;
      if (parts.some((part) => matchGlob(part, pattern))) return true;
    } else if (relPosix === pattern || parts.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}
