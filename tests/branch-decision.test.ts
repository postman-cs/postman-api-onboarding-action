import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(__dirname, '..');
const workflowRepository = { id: 101, full_name: 'postman-cs/example', default_branch: 'main' };

type Repository = { id?: number | string; full_name?: string; default_branch?: string };
type PullRequest = {
  head?: { ref?: string; repo?: Repository | null };
  base?: { ref?: string; repo?: Repository | null };
};
type Decision = {
  tier: string;
  reason: string;
  channel?: { pattern: string; code: string };
  identity: {
    eventName?: string;
    isPrContext: boolean;
    isForkPr: boolean;
    sameRepository: boolean;
    eventEligible: boolean;
    headBranch?: string;
  };
};

function branchDecisionScript(): string {
  const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as {
    runs: { steps: Array<{ id?: string; run?: string }> };
  };
  const run = manifest.runs.steps.find((step) => step.id === 'branch_decision')?.run ?? '';
  const match = run.match(/^node <<'NODE'\n(?<script>[\s\S]*?)\nNODE\s*$/);
  if (!match?.groups?.script) throw new Error('branch_decision Node script not found');
  return match.groups.script;
}

function repository(overrides: Repository = {}): Repository {
  return { ...workflowRepository, ...overrides };
}

function pullRequest(
  options: {
    branch?: string;
    headRepo?: Repository | null;
    baseRepo?: Repository | null;
  } = {}
): PullRequest {
  return {
    head: {
      ref: options.branch ?? 'release/attacker-controlled',
      repo: options.headRepo === undefined ? repository() : options.headRepo
    },
    base: {
      ref: 'main',
      repo: options.baseRepo === undefined ? repository() : options.baseRepo
    }
  };
}

function directPrEvent(request: PullRequest, eventRepository: Repository = repository()): Record<string, unknown> {
  return { repository: eventRepository, pull_request: request };
}

function nestedPrEvent(
  eventName: 'workflow_run' | 'check_run' | 'check_suite',
  requests: PullRequest[],
  eventRepository: Repository = repository()
): Record<string, unknown> {
  return { repository: eventRepository, [eventName]: { pull_requests: requests } };
}

function decide(
  options: {
    eventName?: string;
    event?: Record<string, unknown>;
    eventBody?: string;
    strategy?: 'legacy' | 'publish-gate' | 'preview';
    ref?: string;
    refName?: string;
    headRef?: string;
    canonicalBranch?: string;
    workflowRepositoryId?: number | string | null;
    workflowRepositoryName?: string;
  } = {}
): { decision: Decision; status: number; stderr: string; stdout: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'branch-decision-'));
  try {
    const eventPath = path.join(root, 'event.json');
    const outputPath = path.join(root, 'output.txt');
    const envPath = path.join(root, 'env.txt');
    writeFileSync(
      eventPath,
      options.eventBody ?? JSON.stringify(options.event ?? { repository: repository() })
    );
    writeFileSync(outputPath, '');
    writeFileSync(envPath, '');
    const result = spawnSync(process.execPath, ['-e', branchDecisionScript()], {
      env: {
        ...process.env,
        BRANCH_STRATEGY: options.strategy ?? 'publish-gate',
        CANONICAL_BRANCH: options.canonicalBranch ?? 'main',
        CHANNELS: '',
        GITHUB_EVENT_NAME: options.eventName ?? 'workflow_dispatch',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: options.ref ?? 'refs/heads/main',
        GITHUB_REF_NAME: options.refName ?? 'main',
        GITHUB_HEAD_REF: options.headRef ?? '',
        GITHUB_REPOSITORY: options.workflowRepositoryName ?? workflowRepository.full_name,
        GITHUB_REPOSITORY_ID:
          options.workflowRepositoryId === null
            ? ''
            : String(options.workflowRepositoryId ?? workflowRepository.id),
        GITHUB_SHA: '0123456789abcdef',
        GITHUB_OUTPUT: outputPath,
        GITHUB_ENV: envPath
      },
      encoding: 'utf8'
    });
    const serialized = readFileSync(outputPath, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('branch-decision='))
      ?.slice('branch-decision='.length);
    if (!serialized) {
      throw new Error(`branch-decision output not found: ${result.stdout}${result.stderr}`);
    }
    return {
      decision: JSON.parse(serialized) as Decision,
      status: result.status ?? 1,
      stderr: result.stderr,
      stdout: result.stdout
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function decideDirectPr(
  options: {
    eventName?: 'pull_request' | 'pull_request_target' | 'pull_request_review' | 'pull_request_review_comment';
    request?: PullRequest;
    strategy?: 'legacy' | 'publish-gate' | 'preview';
    headRef?: string;
    eventRepository?: Repository;
  } = {}
): Decision {
  const request = options.request ?? pullRequest();
  const branch = request.head?.ref ?? '';
  return decide({
    eventName: options.eventName ?? 'pull_request',
    event: directPrEvent(request, options.eventRepository),
    strategy: options.strategy,
    ref: 'refs/pull/1/merge',
    refName: '1/merge',
    headRef: options.headRef ?? branch
  }).decision;
}

describe('branch decision event trust boundary', () => {
  it.each(['legacy', 'publish-gate', 'preview'] as const)(
    'keeps a fork PR gated under %s even when its head matches a release channel',
    (strategy) => {
      const decision = decideDirectPr({
        strategy,
        request: pullRequest({ headRepo: repository({ id: 202, full_name: 'attacker/fork' }) })
      });
      expect(decision.tier).toBe('gated');
      expect(decision.reason).toContain('credentials and mutations are ineligible');
      expect(decision.identity).toMatchObject({
        isPrContext: true,
        isForkPr: true,
        sameRepository: false,
        eventEligible: false
      });
      expect(decision).not.toHaveProperty('channel');
    }
  );

  it.each(['pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment'] as const)(
    'allows a positively identified same-repository %s event',
    (eventName) => {
      const decision = decideDirectPr({ eventName });
      expect(decision.tier).toBe('channel');
      expect(decision.channel).toEqual({ pattern: 'release/*', code: 'RC' });
      expect(decision.identity).toMatchObject({
        eventName,
        isPrContext: true,
        isForkPr: false,
        sameRepository: true,
        eventEligible: true,
        headBranch: 'release/attacker-controlled'
      });
    }
  );

  it('allows a positively identified same-repository PR under legacy strategy', () => {
    const decision = decideDirectPr({ strategy: 'legacy' });
    expect(decision.tier).toBe('legacy');
    expect(decision.reason).toContain('same-repository pull_request');
  });

  it('uses equal valid IDs as primary identity while rejecting a present conflicting name', () => {
    const missingNames = repository({ full_name: undefined });
    const byId = decideDirectPr({
      request: pullRequest({ headRepo: missingNames, baseRepo: missingNames }),
      eventRepository: missingNames
    });
    expect(byId.tier).toBe('channel');
    expect(byId.identity).toMatchObject({ sameRepository: true, isForkPr: false });

    const conflictingName = decideDirectPr({
      request: pullRequest({ headRepo: repository({ full_name: 'attacker/fork' }) })
    });
    expect(conflictingName.tier).toBe('gated');
    expect(conflictingName.identity.isForkPr).toBe(true);
  });

  it('uses normalized names only when both repository IDs are absent', () => {
    const nameOnly = repository({ id: undefined, full_name: 'POSTMAN-CS/EXAMPLE' });
    const decision = decide({
      eventName: 'pull_request_target',
      event: directPrEvent(
        pullRequest({ headRepo: nameOnly, baseRepo: repository({ id: undefined }) }),
        repository({ id: undefined })
      ),
      ref: 'refs/pull/1/merge',
      headRef: 'release/attacker-controlled',
      workflowRepositoryId: null,
      workflowRepositoryName: 'postman-cs/example'
    }).decision;
    expect(decision.tier).toBe('channel');
    expect(decision.identity).toMatchObject({ sameRepository: true, isForkPr: false, eventEligible: true });
  });

  it.each([
    { label: 'only one ID is absent', head: repository({ id: undefined }) },
    { label: 'one ID is malformed', head: repository({ id: 'not-decimal' }) },
    { label: 'one ID is zero', head: repository({ id: 0 }) },
    { label: 'one name is malformed', head: repository({ full_name: 'not-a-repository-name' }) }
  ])('does not use a name fallback when $label', ({ head }) => {
    const decision = decideDirectPr({ request: pullRequest({ headRepo: head }) });
    expect(decision.tier).toBe('gated');
    expect(decision.identity).toMatchObject({ sameRepository: false, isForkPr: true, eventEligible: false });
  });

  it.each([
    {
      label: 'missing head repository',
      request: pullRequest({ headRepo: null })
    },
    {
      label: 'missing repository ID',
      request: pullRequest({ headRepo: repository({ id: undefined }) })
    },
    {
      label: 'same name with a different ID',
      request: pullRequest({ headRepo: repository({ id: 999 }) })
    },
    {
      label: 'same ID with a different name',
      request: pullRequest({ headRepo: repository({ full_name: 'attacker/fork' }) })
    },
    {
      label: 'base repository mismatch',
      request: pullRequest({ baseRepo: repository({ id: 303, full_name: 'other/base' }) })
    },
    {
      label: 'missing head branch',
      request: pullRequest({ branch: '' })
    }
  ])('fails closed for direct PR metadata: $label', ({ request }) => {
    const decision = decideDirectPr({ request });
    expect(decision.tier).toBe('gated');
    expect(decision.identity.eventEligible).toBe(false);
    expect(decision.identity.sameRepository).toBe(false);
    expect(decision.identity.isForkPr).toBe(true);
  });

  it('fails closed when payload and GITHUB_HEAD_REF disagree', () => {
    const decision = decideDirectPr({ headRef: 'release/different' });
    expect(decision.tier).toBe('gated');
    expect(decision.reason).toContain('does not match GITHUB_HEAD_REF');
    expect(decision.identity.isForkPr).toBe(true);
  });

  it.each(['workflow_run', 'check_run', 'check_suite'] as const)(
    'accepts one positively identified same-repository PR nested under %s',
    (eventName) => {
      const request = pullRequest({ branch: 'release/nested' });
      const decision = decide({
        eventName,
        event: nestedPrEvent(eventName, [request]),
        ref: 'refs/heads/main',
        headRef: ''
      }).decision;
      expect(decision.tier).toBe('channel');
      expect(decision.identity).toMatchObject({
        eventName,
        isPrContext: true,
        sameRepository: true,
        eventEligible: true,
        headBranch: 'release/nested'
      });
    }
  );

  it.each(['workflow_run', 'check_run', 'check_suite'] as const)(
    'gates a nested fork under %s',
    (eventName) => {
      const request = pullRequest({ headRepo: repository({ id: 202, full_name: 'attacker/fork' }) });
      const decision = decide({
        eventName,
        event: nestedPrEvent(eventName, [request]),
        ref: 'refs/heads/main',
        headRef: ''
      }).decision;
      expect(decision.tier).toBe('gated');
      expect(decision.identity).toMatchObject({ isPrContext: true, isForkPr: true, eventEligible: false });
    }
  );

  it.each([
    { eventName: 'workflow_run', requests: [] },
    { eventName: 'check_run', requests: [pullRequest(), pullRequest({ branch: 'release/second' })] },
    { eventName: 'check_suite', requests: [pullRequest({ headRepo: null })] }
  ] as const)('gates ambiguous or incomplete nested metadata for $eventName', ({ eventName, requests }) => {
    const decision = decide({
      eventName,
      event: nestedPrEvent(eventName, [...requests]),
      ref: 'refs/heads/main',
      headRef: ''
    }).decision;
    expect(decision.tier).toBe('gated');
    expect(decision.identity).toMatchObject({ eventEligible: false, sameRepository: false, isForkPr: true });
  });

  it.each(['issue_comment', 'merge_group', 'repository_dispatch', 'status', 'unknown_event'])(
    'gates non-allowlisted event %s even with a canonical-looking ref',
    (eventName) => {
      const decision = decide({ eventName, event: { repository: repository() } }).decision;
      expect(decision.tier).toBe('gated');
      expect(decision.reason).toContain('not credential-eligible');
    }
  );

  it.each([
    { eventName: 'workflow_dispatch', ref: 'refs/heads/main', expectedTier: 'canonical' },
    { eventName: 'push', ref: 'refs/heads/release/trusted', expectedTier: 'channel' },
    { eventName: 'schedule', ref: 'refs/heads/main', expectedTier: 'canonical' }
  ])('allows trusted non-PR event $eventName', ({ eventName, ref, expectedTier }) => {
    const decision = decide({ eventName, ref, refName: ref.slice('refs/heads/'.length) }).decision;
    expect(decision.tier).toBe(expectedTier);
    expect(decision.identity).toMatchObject({
      eventName,
      isPrContext: false,
      sameRepository: true,
      eventEligible: true
    });
  });

  it('gates a trusted non-PR event carrying an inconsistent PR head ref', () => {
    const decision = decide({ eventName: 'push', headRef: 'release/spoofed' }).decision;
    expect(decision.tier).toBe('gated');
    expect(decision.identity).toMatchObject({ isPrContext: true, isForkPr: true, eventEligible: false });
  });

  it('gates a trusted non-PR event carrying a top-level PR marker', () => {
    const decision = decide({
      eventName: 'workflow_dispatch',
      event: { repository: repository(), pull_request: pullRequest() }
    }).decision;
    expect(decision.tier).toBe('gated');
    expect(decision.identity).toMatchObject({ isPrContext: true, isForkPr: true, eventEligible: false });
  });

  it('gates a self-consistent payload that does not match the runtime workflow repository', () => {
    const foreign = repository({ id: 404, full_name: 'other/repository' });
    const decision = decide({
      eventName: 'pull_request',
      event: directPrEvent(pullRequest({ headRepo: foreign, baseRepo: foreign }), foreign),
      ref: 'refs/pull/1/merge',
      headRef: 'release/attacker-controlled'
    }).decision;
    expect(decision.tier).toBe('gated');
    expect(decision.reason).toContain('does not match the workflow repository');
  });

  it('gates a missing event name and an unreadable event payload', () => {
    const missingName = decide({ eventName: '', event: { repository: repository() } }).decision;
    const unreadable = decide({ eventName: 'workflow_dispatch', eventBody: '{not-json' }).decision;
    expect(missingName.tier).toBe('gated');
    expect(missingName.reason).toContain('event name is missing');
    expect(unreadable.tier).toBe('gated');
    expect(unreadable.reason).toContain('payload is missing or unreadable');
  });

  it('bounds GITHUB_EVENT_PATH reads and marks an oversized PR payload unproven', () => {
    const oversized = decide({
      eventName: 'pull_request',
      eventBody: JSON.stringify({ repository: repository(), padding: 'x'.repeat(1024 * 1024) }),
      ref: 'refs/pull/1/merge',
      headRef: 'release/attacker-controlled'
    }).decision;
    expect(oversized.tier).toBe('gated');
    expect(oversized.reason).toContain('payload is missing or unreadable');
    expect(oversized.identity).toMatchObject({ isPrContext: true, isForkPr: true, eventEligible: false });
    expect(branchDecisionScript()).toContain('MAX_EVENT_PAYLOAD_BYTES = 1 * 1024 * 1024');
  });
});
