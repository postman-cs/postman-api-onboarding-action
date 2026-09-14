import { spawnSync } from 'node:child_process';

export default function setup(): void {
  // Validate and initialize the Ruby runtime before Vitest fans out workers.
  // The monorepo example tests execute its exact resolver payload with Ruby;
  // doing the first process start amid parallel test startup makes Windows
  // runner contention part of an otherwise fast resolver assertion.
  const result = spawnSync('ruby', ['-e', 'exit'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Ruby runtime preflight failed: ${result.error?.message ?? `${result.stdout}${result.stderr}`}`,
    );
  }
}
