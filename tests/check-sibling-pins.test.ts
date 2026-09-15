/**
 * Pure sibling-pin contract tests.
 *
 * These fixtures prove the validators accept valid pinned manifests/source
 * shapes and reject undeclared producer outputs and golden-shape drift — all
 * from supplied content, never from local sibling checkouts or live network.
 */
import { describe, expect, it } from 'vitest';

import {
  COLLECTIONS_JSON_KEYS,
  REPO_SYNC_SUMMARY_GATED_KEYS,
  REPO_SYNC_SUMMARY_KEYS,
  SIBLING_PIN_MAX_SOURCE_BYTES,
  SIBLING_PIN_NETWORK_TIMEOUT_MS,
  gitTagExistsExecOptions,
  pinnedFileFetchInit,
  pinnedRawFileUrl,
  readBoundedResponseText,
  validateBranchDecisionInterface,
  validateCollectionsJsonShape,
  validateEnvironmentUidsEmit,
  validateForwardedWithKeys,
  validateGatedSkipSummaryKeys,
  validatePinnedSourceShapes,
  validateReferencedOutputs,
  validateRepoSyncSummaryKeys,
  validateSiblingPinContracts
} from '../scripts/check-sibling-pins.mjs';

const VALID_BOOTSTRAP_INDEX = `
outputs['collections-json'] = JSON.stringify({ baseline: a, contract: b, smoke: c });
result['collections-json'] = JSON.stringify({ baseline: a, contract: b, smoke: c });
payload['collections-json'] = JSON.stringify({ baseline: a, contract: b, smoke: c });
`;

const VALID_BRANCH_DECISION = `
export interface BranchDecision {
  tier: string;
  strategy: string;
  identity: string;
  canonicalBranch?: string;
  channel?: string;
  reason: string;
}
`;

const VALID_REPO_SYNC_INDEX = `
setOutput('environment-uids-json', JSON.stringify(envUids));
parseJsonMap(getInput('environment-uids-json', env) || '{}');

function createRepoSummary(input) {
  return JSON.stringify({
    commitSha,
    environmentCount,
    environmentSyncStatus,
    mockEnvironmentStatus,
    mockEnvironmentUid,
    mockAuthRequired,
    mockUrl,
    mockVisibility,
    monitorId,
    pushed,
    resolvedCurrentRef,
    workspaceLinkStatus,
  });
}

outputs['repo-sync-summary-json'] = JSON.stringify({
  status: 'skipped-branch-gate',
  reason: decision.reason
});
`;

function siblingBundle(overrides: {
  bootstrapAction?: string;
  bootstrapIndex?: string;
  repoSyncAction?: string;
  repoSyncIndex?: string;
  branchDecision?: string;
  smokeAction?: string;
  insightsAction?: string;
} = {}) {
  return {
    'postman-bootstrap-action': {
      tag: 'v2.15.0',
      tagExists: true,
      actionYmlText:
        overrides.bootstrapAction ??
        `
inputs:
  api-key: {}
outputs:
  workspace-id:
    description: workspace
  collections-json:
    description: collections
`,
      sources: {
        'src/index.ts': overrides.bootstrapIndex ?? VALID_BOOTSTRAP_INDEX
      }
    },
    'postman-repo-sync-action': {
      tag: 'v2.7.1',
      tagExists: true,
      actionYmlText:
        overrides.repoSyncAction ??
        `
inputs:
  environment-uids-json: {}
  branch-decision: {}
outputs:
  repo-sync-summary-json:
    description: summary
  environment-uids-json:
    description: env map
`,
      sources: {
        'src/index.ts': overrides.repoSyncIndex ?? VALID_REPO_SYNC_INDEX,
        'src/lib/repo/branch-decision.ts': overrides.branchDecision ?? VALID_BRANCH_DECISION
      }
    },
    'postman-smoke-flow-action': {
      tag: 'v3.2.1',
      tagExists: true,
      actionYmlText:
        overrides.smokeAction ??
        `
inputs:
  workspace-id: {}
outputs:
  smoke-status:
    description: status
`
    },
    'postman-insights-onboarding-action': {
      tag: 'v2.4.1',
      tagExists: true,
      actionYmlText:
        overrides.insightsAction ??
        `
inputs:
  workspace-id: {}
outputs:
  insights-status:
    description: status
`
    }
  };
}

const COMPOSITE_YML = `
name: composite
inputs: {}
outputs:
  summary:
    value: \${{ steps.repo_sync.outputs.repo-sync-summary-json }}
  collections:
    value: \${{ steps.bootstrap.outputs.collections-json }}
runs:
  using: composite
  steps:
    - id: bootstrap
      uses: postman-cs/postman-bootstrap-action@v2.15.0
      with:
        api-key: x
    - id: smoke_flow
      uses: postman-cs/postman-smoke-flow-action@v3.2.1
      with:
        workspace-id: \${{ steps.bootstrap.outputs.workspace-id }}
    - id: repo_sync
      uses: postman-cs/postman-repo-sync-action@v2.7.1
      with:
        environment-uids-json: '{}'
        branch-decision: '{}'
    - id: insights_onboarding
      uses: postman-cs/postman-insights-onboarding-action@v2.4.1
      with:
        workspace-id: \${{ steps.bootstrap.outputs.workspace-id }}
`;

describe('network timeout bounds', () => {
  it('exports a positive finite default timeout for git and fetch operations', () => {
    expect(SIBLING_PIN_NETWORK_TIMEOUT_MS).toBe(30_000);
    expect(Number.isFinite(SIBLING_PIN_NETWORK_TIMEOUT_MS)).toBe(true);
    expect(SIBLING_PIN_NETWORK_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('builds bounded git ls-remote exec options without live network calls', () => {
    expect(gitTagExistsExecOptions()).toEqual({
      encoding: 'utf8',
      timeout: SIBLING_PIN_NETWORK_TIMEOUT_MS
    });
    expect(gitTagExistsExecOptions(5_000)).toEqual({ encoding: 'utf8', timeout: 5_000 });
  });

  it('builds bounded fetch init with AbortSignal.timeout and preserves pinned-tag URLs', () => {
    const init = pinnedFileFetchInit();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);

    const customInit = pinnedFileFetchInit(1_500);
    expect(customInit.signal).toBeInstanceOf(AbortSignal);

    expect(
      pinnedRawFileUrl('postman-bootstrap-action', 'v2.15.0', 'action.yml')
    ).toBe('https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/v2.15.0/action.yml');
  });

  it('caps each sibling response independently and accepts content exactly at the cap', async () => {
    expect(SIBLING_PIN_MAX_SOURCE_BYTES).toBe(2 * 1024 * 1024);
    await expect(readBoundedResponseText(new Response('12345678'), 8)).resolves.toBe(
      '12345678'
    );
  });

  it('rejects an oversized declared Content-Length before consuming the body', async () => {
    let pulled = false;
    const response = {
      headers: new Headers({ 'content-length': '9' }),
      body: {
        getReader() {
          pulled = true;
          throw new Error('body reader must not be created');
        }
      }
    } as unknown as Response;

    await expect(readBoundedResponseText(response, 8)).rejects.toThrow(
      'sibling source exceeds 8 bytes'
    );
    expect(pulled).toBe(false);
  });

  it('rejects a streamed response that lies about its smaller Content-Length', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('1234'));
          controller.enqueue(new TextEncoder().encode('56789'));
          controller.close();
        }
      }),
      { headers: { 'content-length': '1' } }
    );

    await expect(readBoundedResponseText(response, 8)).rejects.toThrow(
      'sibling source exceeds 8 bytes'
    );
  });

  it('fails closed on malformed lengths and invalid UTF-8', async () => {
    await expect(
      readBoundedResponseText(new Response('ok', { headers: { 'content-length': 'NaN' } }), 8)
    ).rejects.toThrow('sibling source Content-Length is malformed');

    const invalidUtf8 = new Response(Uint8Array.from([0xc3, 0x28]));
    await expect(readBoundedResponseText(invalidUtf8, 8)).rejects.toThrow(
      'sibling source is not valid UTF-8'
    );
  });
});

describe('forwarded with-keys', () => {
  it('accepts declared inputs and rejects unknown forwards', () => {
    expect(
      validateForwardedWithKeys({
        stepId: 'bootstrap',
        repo: 'postman-bootstrap-action',
        tag: 'v2.15.0',
        withKeys: ['api-key'],
        declaredInputs: ['api-key']
      })
    ).toEqual([]);

    const failures = validateForwardedWithKeys({
      stepId: 'bootstrap',
      repo: 'postman-bootstrap-action',
      tag: 'v2.15.0',
      withKeys: ['missing-key'],
      declaredInputs: ['api-key']
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('postman-bootstrap-action@v2.15.0');
    expect(failures[0]).toContain('`missing-key`');
  });
});

describe('referenced producer outputs', () => {
  it('accepts declared outputs and rejects undeclared references with repo@tag diagnostics', () => {
    const edges = [
      { step: 'bootstrap', output: 'collections-json', site: 'outputs.collections' },
      { step: 'bootstrap', output: 'ghost', site: 'step smoke_flow with.x' }
    ];
    expect(
      validateReferencedOutputs({
        edges,
        stepId: 'bootstrap',
        repo: 'postman-bootstrap-action',
        tag: 'v2.15.0',
        declaredOutputs: ['collections-json', 'workspace-id']
      })
    ).toEqual([
      'step smoke_flow with.x references bootstrap.outputs.ghost, not declared by postman-bootstrap-action@v2.15.0 action.yml'
    ]);
  });
});

describe('golden source shapes', () => {
  it('accepts the pinned collections-json key set', () => {
    expect(validateCollectionsJsonShape(VALID_BOOTSTRAP_INDEX, {
      repo: 'postman-bootstrap-action',
      tag: 'v2.15.0'
    })).toEqual([]);
    expect([...COLLECTIONS_JSON_KEYS].sort()).toEqual(['baseline', 'contract', 'smoke']);
  });

  it('rejects collections-json shape drift with repo@tag file diagnostics', () => {
    const bad = `outputs['collections-json'] = JSON.stringify({ baseline: a, contract: b });
core.setOutput('collections-json', JSON.stringify({ baseline, contract }));
fs.writeFileSync(out, "collections-json=" + JSON.stringify({ baseline: x, contract: y }));`;
    const failures = validateCollectionsJsonShape(bad, {
      repo: 'postman-bootstrap-action',
      tag: 'v2.16.1'
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toContain('postman-bootstrap-action@v2.16.1 src/index.ts');
  });

  it('accepts BranchDecision keys and rejects extras', () => {
    expect(
      validateBranchDecisionInterface(VALID_BRANCH_DECISION, {
        repo: 'postman-repo-sync-action',
        tag: 'v2.7.1'
      })
    ).toEqual([]);

    const failures = validateBranchDecisionInterface(
      `export interface BranchDecision {
  tier: string;
  strategy: string;
  identity: string;
  reason: string;
  unexpected: string;
}`,
      { repo: 'postman-repo-sync-action', tag: 'v2.8.7' }
    );
    expect(failures[0]).toContain('postman-repo-sync-action@v2.8.7 src/lib/repo/branch-decision.ts');
    expect(failures[0]).toContain('unexpected');
  });

  it('accepts and rejects repo-sync summary shapes', () => {
    expect(
      validateRepoSyncSummaryKeys(VALID_REPO_SYNC_INDEX, {
        repo: 'postman-repo-sync-action',
        tag: 'v2.7.1'
      })
    ).toEqual([]);
    expect(REPO_SYNC_SUMMARY_KEYS).toHaveLength(12);

    const failures = validateRepoSyncSummaryKeys(
      `function createRepoSummary(input) {
  return JSON.stringify({
    commitSha,
    pushed
  });
}`,
      { repo: 'postman-repo-sync-action', tag: 'v2.8.7' }
    );
    expect(failures[0]).toContain('postman-repo-sync-action@v2.8.7 src/index.ts');
    expect(failures[0]).toContain('createRepoSummary');
  });

  it('detects repo-sync summary drift when the final key has no trailing comma', () => {
    const goldenBody = REPO_SYNC_SUMMARY_KEYS.map((key, index) => {
      const isLast = index === REPO_SYNC_SUMMARY_KEYS.length - 1;
      return `    ${key}${isLast ? '' : ','}`;
    }).join('\n');
    const goldenSource = `function createRepoSummary(i) {
  return JSON.stringify({
${goldenBody}
  });
}`;
    expect(
      validateRepoSyncSummaryKeys(goldenSource, {
        repo: 'postman-repo-sync-action',
        tag: 'v2.7.1'
      })
    ).toEqual([]);

    const driftSource = `function createRepoSummary(i) {
  return JSON.stringify({
${goldenBody},
    leakedSecretToken
  });
}`;
    const failures = validateRepoSyncSummaryKeys(driftSource, {
      repo: 'postman-repo-sync-action',
      tag: 'v2.8.7'
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toContain('postman-repo-sync-action@v2.8.7 src/index.ts');
    expect(failures[0]).toContain('leakedSecretToken');
  });

  it('rejects a missing summary terminator without backtracking over repeated markers', () => {
    const hostileSource =
      'function createRepoSummary(input) {\n' + 'JSON.stringify({\n'.repeat(100_000);
    const started = performance.now();
    const failures = validateRepoSyncSummaryKeys(hostileSource, {
      repo: 'postman-repo-sync-action',
      tag: 'v2.8.7'
    });
    expect(failures[0]).toContain('createRepoSummary JSON.stringify shape not found');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('accepts and rejects gated-skip summary shapes', () => {
    expect(
      validateGatedSkipSummaryKeys(VALID_REPO_SYNC_INDEX, {
        repo: 'postman-repo-sync-action',
        tag: 'v2.7.1'
      })
    ).toEqual([]);
    expect([...REPO_SYNC_SUMMARY_GATED_KEYS].sort()).toEqual(['reason', 'status']);

    const failures = validateGatedSkipSummaryKeys(
      `outputs['repo-sync-summary-json'] = JSON.stringify({
  status: 'skipped-branch-gate',
  reason: decision.reason,
  extra: true
});`,
      { repo: 'postman-repo-sync-action', tag: 'v2.8.7' }
    );
    expect(failures[0]).toContain('postman-repo-sync-action@v2.8.7 src/index.ts');
    expect(failures[0]).toContain('extra');
  });

  it('accepts and rejects environment-uids-json producer and consumer signatures', () => {
    expect(
      validateEnvironmentUidsEmit(VALID_REPO_SYNC_INDEX, {
        repo: 'postman-repo-sync-action',
        tag: 'v2.7.1'
      })
    ).toEqual([]);

    const missingEmit = validateEnvironmentUidsEmit(
      `parseJsonMap(getInput('environment-uids-json', env) || '{}');`,
      { repo: 'postman-repo-sync-action', tag: 'v2.8.7' }
    );
    expect(missingEmit[0]).toContain('postman-repo-sync-action@v2.8.7 src/index.ts');
    expect(missingEmit[0]).toContain(
      'missing environment-uids-json setOutput(JSON.stringify(envUids)) emit'
    );

    const missingConsumer = validateEnvironmentUidsEmit(
      `setOutput('environment-uids-json', JSON.stringify(envUids));`,
      { repo: 'postman-repo-sync-action', tag: 'v2.8.7' }
    );
    expect(missingConsumer[0]).toContain('postman-repo-sync-action@v2.8.7 src/index.ts');
    expect(missingConsumer[0]).toContain('missing environment-uids-json parseJsonMap consumer');
  });
});

describe('validateSiblingPinContracts', () => {
  it('accepts a fully valid pinned sibling bundle', () => {
    expect(
      validateSiblingPinContracts({
        compositeYmlText: COMPOSITE_YML,
        siblings: siblingBundle()
      })
    ).toEqual([]);
  });

  it('rejects undeclared producer outputs without reading sibling directories', () => {
    const failures = validateSiblingPinContracts({
      compositeYmlText: COMPOSITE_YML,
      siblings: siblingBundle({
        bootstrapAction: `
inputs:
  api-key: {}
outputs:
  workspace-id:
    description: workspace
`
      })
    });
    expect(failures.some((failure) => failure.includes('collections-json'))).toBe(true);
    expect(failures.some((failure) => failure.includes('postman-bootstrap-action@v2.15.0 action.yml'))).toBe(
      true
    );
  });

  it('rejects Bootstrap source shape drift using supplied pinned content only', () => {
    const failures = validateSiblingPinContracts({
      compositeYmlText: COMPOSITE_YML,
      siblings: siblingBundle({
        bootstrapIndex: `outputs['collections-json'] = JSON.stringify({ nope: 1 });
core.setOutput('collections-json', JSON.stringify({ nope: 1 }));
fs.writeFileSync(out, "collections-json=" + JSON.stringify({ nope: 1 }));`
      })
    });
    expect(failures.some((failure) => failure.includes('postman-bootstrap-action@v2.15.0 src/index.ts'))).toBe(
      true
    );
  });

  it('rejects Repo Sync source drift through the composite validator', () => {
    const failures = validateSiblingPinContracts({
      compositeYmlText: COMPOSITE_YML,
      siblings: siblingBundle({
        repoSyncIndex: `parseJsonMap(getInput('environment-uids-json', env) || '{}');`
      })
    });
    expect(
      failures.some((failure) => failure.includes('postman-repo-sync-action@v2.7.1 src/index.ts'))
    ).toBe(true);
    expect(
      failures.some((failure) =>
        failure.includes('missing environment-uids-json setOutput(JSON.stringify(envUids)) emit')
      )
    ).toBe(true);
  });

  it('validatePinnedSourceShapes reports missing supplied files with repo@tag paths', () => {
    const failures = validatePinnedSourceShapes({
      repo: 'postman-repo-sync-action',
      tag: 'v2.8.7',
      sources: {}
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        'postman-repo-sync-action@v2.8.7 src/index.ts: source content was not supplied',
        'postman-repo-sync-action@v2.8.7 src/lib/repo/branch-decision.ts: source content was not supplied'
      ])
    );
  });
});
