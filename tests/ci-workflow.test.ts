import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('PR CI sibling-pin freshness', () => {
  it('runs check-sibling-pins.mjs as a normal PR gate', () => {
    expect(ciWorkflow).toContain('node scripts/check-sibling-pins.mjs');
    expect(ciWorkflow).toMatch(/run\s+sibling-pins\s+node scripts\/check-sibling-pins\.mjs/);
  });

  it('caps the single-runner gate queue at two concurrent checks', () => {
    expect(ciWorkflow).toContain('MAX_PARALLEL_GATES=2');
    expect(ciWorkflow).toContain('wait -n -p finished_pid');
  });
});
