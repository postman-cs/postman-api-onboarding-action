import { execFileSync } from 'node:child_process';
import process from 'node:process';

const scratchDirectories = new Set([
  '.factory',
  '.hkd',
  '.omc',
  '.omx',
  '.plans',
  '.worktrees',
]);

const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
}).split('\0');
const violations = trackedPaths.filter(
  (path) => path && path.split('/').some((part) => scratchDirectories.has(part)),
);

if (violations.length > 0) {
  process.stderr.write(
    `Tracked scratch paths are forbidden:\n${violations.map((path) => `  ${path}`).join('\n')}\n`,
  );
  process.exitCode = 1;
}
