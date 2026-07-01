import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ACTION_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(ACTION_ROOT, 'src');

const SKIP_DIRS = new Set(['node_modules', 'tests', 'dist', '.git']);

type Violation = {
  file: string;
  line: number;
  pattern: string;
  text: string;
};

function walkTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) {
      return [];
    }

    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      return walkTypeScriptFiles(abs);
    }
    return abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Remove // and block comments without touching string/template contents. */
function stripComments(source: string): string {
  let result = '';
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      result += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      result += '\n';
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      result += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          result += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          result += source[i];
          i += 1;
          break;
        }
        result += source[i];
        i += 1;
      }
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

function isPmakAssetClient(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? '';
  return base === 'postman-assets-client.ts' || base === 'postman-smoke-client.ts';
}

/** PMAK public-REST collection CRUD — never allowlisted. Scoped to PMAK asset clients only. */
function hasPmakCollectionCrud(relPath: string, line: string): boolean {
  if (!isPmakAssetClient(relPath)) {
    return false;
  }
  if (/\/collections\?/.test(line)) {
    return true;
  }
  if (/['"`]\/collections\/['"`]/.test(line)) {
    return true;
  }
  return line.includes('/collections/${');
}

function matchPatterns(relPath: string, line: string): string[] {
  const hits: string[] = [];

  if (/collection\/v2\.(?:0|1)\.0/.test(line)) {
    hits.push('v2-schema-url');
  }
  if (hasPmakCollectionCrud(relPath, line)) {
    hits.push('pmak-collection-crud');
  }
  if (/format\s*:\s*['"]v2\.1\.0['"]/.test(line)) {
    hits.push('format-v2-literal');
  }
  if (
    /\bfrom\s+['"]postman-collection['"]/.test(line) ||
    /\bimport\s+['"]postman-collection['"]/.test(line)
  ) {
    hits.push('postman-collection-import');
  }
  if (/\bimport\b/.test(line) && /@postman\/runtime\.models\/v2/.test(line)) {
    hits.push('runtime-models-v2-import');
  }

  return hits;
}

function scanSourceFile(absPath: string): Violation[] {
  const relPath = relative(ACTION_ROOT, absPath).replace(/\\/g, '/');
  const stripped = stripComments(readFileSync(absPath, 'utf8'));
  const violations: Violation[] = [];

  stripped.split('\n').forEach((line, index) => {
    for (const pattern of matchPatterns(relPath, line)) {
      violations.push({
        file: relPath,
        line: index + 1,
        pattern,
        text: line.trim()
      });
    }
  });

  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `${v.file}:${v.line}: ${v.pattern} — ${v.text}`)
    .join('\n');
}

describe('no collection v2.x in production src/', () => {
  it('has no forbidden collection v2.x patterns', () => {
    const hasSrc = existsSync(SRC_ROOT);
    expect(hasSrc, 'composite action should not ship runtime src/').toBe(false);

    const files = walkTypeScriptFiles(ACTION_ROOT);
    const violations = files.flatMap(scanSourceFile);

    expect(violations, formatViolations(violations)).toEqual([]);
  });
});
