import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareSemver,
  decideAliasAdvance,
  parseAliasArgs,
  parseLsRemoteLines,
  resolveTagCommit
} from '../scripts/check-release-alias.mjs';

const helper = join(process.cwd(), 'scripts/check-release-alias.mjs');
const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const tagObject = 'c'.repeat(40);

function runHelper(major: string, candidate: string, stdin: string) {
  return spawnSync(process.execPath, [helper, major, candidate], {
    input: stdin,
    encoding: 'utf8'
  });
}

describe('check-release-alias parser and decision', () => {
  it('advances when the alias is absent', () => {
    const decision = decideAliasAdvance({
      majorAlias: 'v2',
      candidateTag: 'v2.1.2',
      lsRemoteText: `${commitA}\trefs/tags/v2.1.2\n`
    });
    expect(decision).toEqual({ status: 0, reason: 'absent' });
    const cli = runHelper('v2', 'v2.1.2', `${commitA}\trefs/tags/v2.1.2\n`);
    expect(cli.status).toBe(0);
  });

  it('resolves lightweight aliases and advances for same or older targets', () => {
    const same = [
      `${commitA}\trefs/tags/v2`,
      `${commitA}\trefs/tags/v2.1.2`
    ].join('\n');
    expect(decideAliasAdvance({ majorAlias: 'v2', candidateTag: 'v2.1.2', lsRemoteText: same }).reason).toBe('same');
    expect(runHelper('v2', 'v2.1.2', same).status).toBe(0);

    const older = [
      `${commitA}\trefs/tags/v2`,
      `${commitA}\trefs/tags/v2.1.1`
    ].join('\n');
    expect(decideAliasAdvance({ majorAlias: 'v2', candidateTag: 'v2.1.2', lsRemoteText: older }).reason).toBe('older');
    expect(runHelper('v2', 'v2.1.2', older).status).toBe(0);
  });

  it('resolves annotated aliases via peeled refs and refuses regression', () => {
    const newer = [
      `${tagObject}\trefs/tags/v2`,
      `${commitB}\trefs/tags/v2^{}`,
      `${tagObject}\trefs/tags/v2.1.3`,
      `${commitB}\trefs/tags/v2.1.3^{}`,
      `${commitA}\trefs/tags/v2.1.2`
    ].join('\n');
    const decision = decideAliasAdvance({ majorAlias: 'v2', candidateTag: 'v2.1.2', lsRemoteText: newer });
    expect(decision).toEqual({ status: 10, reason: 'newer', currentVersion: '2.1.3' });
    const cli = runHelper('v2', 'v2.1.2', newer);
    expect(cli.status).toBe(10);
    expect(cli.stdout).toBe('2.1.3');
    expect(resolveTagCommit(parseLsRemoteLines(newer), 'v2')).toBe(commitB);
  });

  it('accepts zero-patch minor immutable tags when mapping the alias commit', () => {
    const rows = [
      `${commitA}\trefs/tags/v2`,
      `${commitA}\trefs/tags/v2.2`
    ].join('\n');
    const decision = decideAliasAdvance({ majorAlias: 'v2', candidateTag: 'v2.2', lsRemoteText: rows });
    expect(decision.status).toBe(0);
    expect(decision.currentVersion).toBe('2.2.0');
    expect(compareSemver('2.2', '2.2.0')).toBe(0);
  });

  it('rejects malformed and mismatched-major inputs', () => {
    expect(() => parseAliasArgs('2', 'v2.1.2')).toThrow(/malformed major alias/);
    expect(() => parseAliasArgs('v2', 'v3.0.0')).toThrow(/mismatched major/);
    expect(() => parseAliasArgs('v2', 'main')).toThrow(/malformed candidate/);
    expect(runHelper('v2', 'v3.0.0', '').status).not.toBe(0);
    expect(runHelper('v2', 'not-a-tag', '').status).not.toBe(0);
  });

  it('fails when an existing alias cannot be resolved to a same-major immutable tag', () => {
    const unresolved = `${commitA}\trefs/tags/v2\n${commitB}\trefs/tags/v2.1.2\n`;
    expect(() => decideAliasAdvance({
      majorAlias: 'v2',
      candidateTag: 'v2.1.2',
      lsRemoteText: unresolved
    })).toThrow(/cannot be safely resolved/);
    expect(runHelper('v2', 'v2.1.2', unresolved).status).not.toBe(0);
  });
});
