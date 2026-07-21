import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

describe('README input/output tables', () => {
  it('contains both marker pairs', () => {
    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    for (const marker of [
      '<!-- inputs-table:start -->',
      '<!-- inputs-table:end -->',
      '<!-- outputs-table:start -->',
      '<!-- outputs-table:end -->',
    ]) {
      expect(readme).toContain(marker);
    }
  });

  it.skipIf(process.platform === 'win32')('matches action.yml (run npm run docs:tables to regenerate)', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/render-action-tables.mjs', '--check'], {
        cwd: repoRoot,
        stdio: 'pipe',
      })
    ).not.toThrow();
  });
});
