/**
 * WS7 composite handoff contracts (repository-local).
 *
 * Every `steps.<id>.outputs.<name>` reference inside action.yml is an edge from
 * a producing step to a consumer (a later step's `with:`/`env:` or the
 * composite `outputs:` block). This suite enumerates every edge mechanically
 * and asserts the local half of each contract:
 * - edge surface ratchet
 * - referenced step ids exist
 * - uses-step producers are mapped and match their `uses:` targets
 * - local `run:` steps write the referenced names to `$GITHUB_OUTPUT`
 * - composite outputs forward something real
 * - the local branch_decision serializer matches the BranchDecision key set
 *
 * Cross-repository producer declarations and golden payload shapes are
 * validated against the exact immutable sibling tags in action.yml by
 * `scripts/check-sibling-pins.mjs` (see tests/check-sibling-pins.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

type Step = {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type ActionManifest = {
  runs: { using: string; steps?: Step[] };
  outputs?: Record<string, { description?: string; value?: string }>;
};

function loadManifest(): ActionManifest {
  return parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as ActionManifest;
}

/** Map step id -> sibling repo name for every uses-step that produces outputs. */
const USES_PRODUCERS: Record<string, string> = {
  bootstrap: 'postman-bootstrap-action',
  smoke_flow: 'postman-smoke-flow-action',
  repo_sync: 'postman-repo-sync-action',
  insights_onboarding: 'postman-insights-onboarding-action'
};

/** Outputs a local `run:` step writes via `>> $GITHUB_OUTPUT` / appendFileSync(GITHUB_OUTPUT). */
function runStepOutputs(step: Step): Set<string> {
  const script = step.run ?? '';
  const names = new Set<string>();
  // shell form: echo "name=value" >> "$GITHUB_OUTPUT" (any quoting)
  for (const match of script.matchAll(/echo\s+"?([A-Za-z0-9_-]+)=[^\n]*?"?\s*>>\s*"?\$\{?GITHUB_OUTPUT\}?"?/g)) {
    names.add(match[1]!);
  }
  // node form: appendFileSync(process.env.GITHUB_OUTPUT, `a=...\nb=...`)
  for (const match of script.matchAll(/appendFileSync\(\s*process\.env\.GITHUB_OUTPUT\s*,\s*`([^`]*)`/g)) {
    for (const segment of match[1]!.split('\\n')) {
      const pair = segment.match(/^([A-Za-z0-9_-]+)=/);
      if (pair) names.add(pair[1]!);
    }
  }
  return names;
}

type Edge = { step: string; output: string; site: string };

/** Every steps.<id>.outputs.<name> reference in the manifest with its consuming site. */
function collectEdges(manifest: ActionManifest): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const record = (site: string, text: string) => {
    for (const match of text.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
      const key = `${match[1]}.${match[2]}@${site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ step: match[1]!, output: match[2]!, site });
    }
  };
  for (const [name, output] of Object.entries(manifest.outputs ?? {})) {
    record(`outputs.${name}`, output.value ?? '');
  }
  for (const step of manifest.runs.steps ?? []) {
    const site = `step ${step.id ?? '(anonymous)'}`;
    record(`${site} if`, step.if ?? '');
    for (const [key, value] of Object.entries(step.with ?? {})) record(`${site} with.${key}`, value);
    for (const [key, value] of Object.entries(step.env ?? {})) record(`${site} env.${key}`, value);
    record(`${site} run`, step.run ?? '');
  }
  return edges;
}

describe('composite handoff edges', () => {
  const manifest = loadManifest();
  const steps = manifest.runs.steps ?? [];
  const stepById = new Map(steps.filter((step) => step.id).map((step) => [step.id!, step]));
  const edges = collectEdges(manifest);

  it('uses-step producer mappings match uses targets and cover every output-producing uses-step', () => {
    for (const [stepId, repo] of Object.entries(USES_PRODUCERS)) {
      const step = stepById.get(stepId);
      expect(step?.uses, `mapped producer ${stepId} has no uses target`).toMatch(
        new RegExp(`^postman-cs/${repo}@[^@\\s]+$`)
      );
    }

    for (const step of steps) {
      if (!step.uses || !edges.some((edge) => edge.step === step.id)) continue;
      expect(
        USES_PRODUCERS[step.id ?? ''],
        `uses-step ${step.id ?? '(anonymous)'} produces referenced outputs but is not mapped to a sibling producer`
      ).toBeDefined();
    }
  });

  it('covers the full edge surface (ratchet: update this count when edges change)', () => {
    // Every distinct (producer step, output, consuming site) triple.
    expect(edges.length).toBe(54);
    const distinctPairs = new Set(edges.map((edge) => `${edge.step}.${edge.output}`));
    expect(distinctPairs.size).toBe(34);
  });

  it('every referenced step id exists in the composite', () => {
    for (const edge of edges) {
      expect(stepById.has(edge.step), `${edge.site} references unknown step ${edge.step}`).toBe(true);
    }
  });

  it('every run-step edge resolves to a literal GITHUB_OUTPUT write in that step', () => {
    for (const edge of edges) {
      if (USES_PRODUCERS[edge.step]) continue;
      const producer = stepById.get(edge.step);
      expect(producer, `${edge.site} references unknown local step ${edge.step}`).toBeDefined();
      const written = runStepOutputs(producer!);
      expect(
        written.has(edge.output),
        `${edge.site} references ${edge.step}.outputs.${edge.output}, never written to GITHUB_OUTPUT by that step`
      ).toBe(true);
    }
  });

  it('every composite output forwards from a real producer output or a declared input', () => {
    for (const [name, output] of Object.entries(manifest.outputs ?? {})) {
      const value = output.value ?? '';
      const stepRefs = [...value.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)];
      const inputRefs = [...value.matchAll(/inputs\.([A-Za-z0-9_-]+)/g)];
      const statusRefs = [...value.matchAll(/steps\.([A-Za-z0-9_-]+)\.(outcome|conclusion)/g)];
      expect(
        stepRefs.length + inputRefs.length + statusRefs.length,
        `composite output ${name} forwards nothing`
      ).toBeGreaterThan(0);
      // Status forwards must still point at a real step.
      for (const ref of statusRefs) {
        expect(stepById.has(ref[1]!), `output ${name} references unknown step ${ref[1]}`).toBe(true);
      }
    }
  });
});

describe('local golden handoff shapes', () => {
  it('branch-decision: the composite decide step serializes the BranchDecision key set', () => {
    const manifest = loadManifest();
    const decide = (manifest.runs.steps ?? []).find((step) => step.id === 'branch_decision');
    expect(decide?.run).toBeDefined();
    expect(decide!.run).toContain(
      "const decision = { tier, strategy, identity, canonicalBranch, ...(channel && tier === 'channel' ? { channel } : {}), reason };"
    );
  });
});
