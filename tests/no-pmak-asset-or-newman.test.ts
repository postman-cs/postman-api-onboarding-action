import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ACTION_ROOT = resolve(__dirname, '..');

type PatternId = 'newman' | 'pmak-header' | 'pmak-cli-login';

/**
 * The composite action has no `src/`; it wires sibling actions in `action.yml`.
 * Its only sanctioned PMAK use is `postman login --with-api-key` in the wrapped
 * CLI steps (the Postman CLI has no access-token login). Newman is banned; a
 * PMAK `x-api-key:` header would be a forbidden asset op.
 */
const ALLOWLIST: PatternId[] = ['pmak-cli-login'];

/** Best-effort strip of a YAML `#` comment (unquoted, at line start or after whitespace). */
function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function matchPatterns(line: string): PatternId[] {
  const hits: PatternId[] = [];
  if (/['"]newman['"]|\bnewman\s+run\b|\bnewman\s*\.\s*run\b/i.test(line)) {
    hits.push('newman');
  }
  if (/['"]x-api-key['"]\s*:/i.test(line)) {
    hits.push('pmak-header');
  }
  if (/--with-api-key/.test(line)) {
    hits.push('pmak-cli-login');
  }
  return hits;
}

describe('composite action.yml: no PMAK asset op or Newman', () => {
  const lines = readFileSync(join(ACTION_ROOT, 'action.yml'), 'utf8').split('\n').map(stripYamlComment);
  const hits = lines.flatMap((line, index) =>
    matchPatterns(line).map((pattern) => ({ line: index + 1, pattern, text: line.trim() }))
  );

  it('has no Newman and no un-sanctioned x-api-key / --with-api-key', () => {
    const violations = hits.filter((h) => h.pattern === 'newman' || !ALLOWLIST.includes(h.pattern));
    expect(
      violations,
      violations.map((v) => `action.yml:${v.line}: ${v.pattern} — ${v.text}`).join('\n')
    ).toEqual([]);
  });

  it('still contains the sanctioned --with-api-key CLI login(s)', () => {
    expect(hits.some((h) => h.pattern === 'pmak-cli-login')).toBe(true);
  });

  it('declares no Newman dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ACTION_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const newmanDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ].filter((name) => /(^|[/@-])newman([/-]|$)/i.test(name));
    expect(newmanDeps, `Newman dependencies: ${newmanDeps.join(', ')}`).toEqual([]);
  });
});
