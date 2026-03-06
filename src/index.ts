import {
  ACTION_CONTRACT,
  DEFAULT_INTEGRATION_BACKEND,
  ORCHESTRATION_PHASES,
  type ActionInputName,
  type OrchestrationPhase,
} from './contracts';

export type ActionInputs = Partial<Record<ActionInputName, string>>;

export interface OrchestrationPhaseState {
  name: OrchestrationPhase;
  enabled: boolean;
}

export interface ActionPlan {
  name: string;
  integrationBackend: string;
  phases: OrchestrationPhaseState[];
  outputs: Record<string, string>;
}

function readValue(
  inputs: ActionInputs,
  name: ActionInputName,
  fallback = ''
): string {
  const value = inputs[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  return value.trim();
}

export function buildActionPlan(inputs: ActionInputs = {}): ActionPlan {
  const integrationBackend = readValue(
    inputs,
    'integration-backend',
    DEFAULT_INTEGRATION_BACKEND
  );
  const projectName = readValue(inputs, 'project-name');
  const domainCode = readValue(inputs, 'domain-code');
  const workspaceName = domainCode ? `[${domainCode}] ${projectName}` : projectName;
  const collectionsJson = JSON.stringify({
    baseline: '',
    smoke: '',
    contract: '',
  });
  const repoSyncSummaryJson = JSON.stringify({
    repoWriteMode: readValue(inputs, 'repo-write-mode', 'commit-and-push'),
    environmentsJson: readValue(inputs, 'environments-json', '["prod"]'),
    workspaceName,
  });

  const phases: OrchestrationPhaseState[] = [
    { name: ORCHESTRATION_PHASES[0], enabled: true },
    { name: ORCHESTRATION_PHASES[1], enabled: true },
  ];

  return {
    name: ACTION_CONTRACT.name,
    integrationBackend,
    phases,
    outputs: {
      'integration-backend': integrationBackend,
      'workspace-id': '',
      'workspace-url': '',
      'spec-id': '',
      'collections-json': collectionsJson,
      'environment-uids-json': '{}',
      'mock-url': '',
      'monitor-id': '',
      'repo-sync-summary-json': repoSyncSummaryJson,
      'commit-sha': '',
      'orchestration-summary': `bootstrap -> repo-sync via ${integrationBackend}`,
    },
  };
}

export async function run(inputs: ActionInputs = {}): Promise<ActionPlan> {
  return buildActionPlan(inputs);
}
