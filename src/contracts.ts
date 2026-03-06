export const ACTION_NAME = 'postman-api-onboarding-action';
export const ACTION_ENTRYPOINT = ACTION_NAME;
export const DEFAULT_INTEGRATION_BACKEND = 'bifrost';
export const ORCHESTRATION_PHASES = ['bootstrap', 'repo-sync'] as const;

export type OrchestrationPhase = (typeof ORCHESTRATION_PHASES)[number];

export type ActionInputName =
  | 'project-name'
  | 'domain'
  | 'domain-code'
  | 'requester-email'
  | 'spec-url'
  | 'environments-json'
  | 'system-env-map-json'
  | 'governance-mapping-json'
  | 'postman-api-key'
  | 'postman-access-token'
  | 'github-token'
  | 'gh-fallback-token'
  | 'github-auth-mode'
  | 'repo-write-mode'
  | 'integration-backend';

export type ActionOutputName =
  | 'integration-backend'
  | 'workspace-id'
  | 'workspace-url'
  | 'spec-id'
  | 'collections-json'
  | 'environment-uids-json'
  | 'mock-url'
  | 'monitor-id'
  | 'repo-sync-summary-json'
  | 'commit-sha'
  | 'orchestration-summary';

export interface InputContract {
  description: string;
  required: boolean;
  default?: string;
}

export interface OutputContract {
  description: string;
}

export const INPUT_CONTRACT: Record<ActionInputName, InputContract> = {
  'project-name': {
    description: 'Service project name used across bootstrap and repo sync phases.',
    required: true,
  },
  domain: {
    description: 'Business domain used for governance assignment.',
    required: false,
  },
  'domain-code': {
    description: 'Short domain code used in workspace naming.',
    required: false,
  },
  'requester-email': {
    description: 'Requester email used for workspace membership.',
    required: false,
  },
  'spec-url': {
    description: 'URL to the OpenAPI document to bootstrap.',
    required: true,
  },
  'environments-json': {
    description: 'JSON array of environment slugs to materialize.',
    required: false,
    default: '["prod"]',
  },
  'system-env-map-json': {
    description: 'JSON map of environment slug to system environment id.',
    required: false,
    default: '{}',
  },
  'governance-mapping-json': {
    description: 'JSON map of business domain to governance group name.',
    required: false,
    default: '{}',
  },
  'postman-api-key': {
    description: 'Postman API key used for bootstrap and sync operations.',
    required: true,
  },
  'postman-access-token': {
    description: 'Postman access token used for Bifrost and governance integration.',
    required: false,
  },
  'github-token': {
    description: 'GitHub token used for repo variables and generated commits.',
    required: false,
  },
  'gh-fallback-token': {
    description: 'Fallback GitHub token for variable and workflow-file APIs.',
    required: false,
  },
  'github-auth-mode': {
    description: 'GitHub auth mode for repository APIs.',
    required: false,
    default: 'github_token_first',
  },
  'repo-write-mode': {
    description: 'Repo mutation mode for generated assets and workflow files.',
    required: false,
    default: 'commit-and-push',
  },
  'integration-backend': {
    description: 'Integration backend used to coordinate onboarding phases.',
    required: false,
    default: DEFAULT_INTEGRATION_BACKEND,
  },
};

export const OUTPUT_CONTRACT: Record<ActionOutputName, OutputContract> = {
  'integration-backend': {
    description: 'Resolved integration backend for the onboarding run.',
  },
  'workspace-id': {
    description: 'Postman workspace ID.',
  },
  'workspace-url': {
    description: 'Postman workspace URL.',
  },
  'spec-id': {
    description: 'Uploaded Postman spec ID.',
  },
  'collections-json': {
    description: 'JSON summary of generated collections.',
  },
  'environment-uids-json': {
    description: 'JSON map of environment slug to Postman environment uid.',
  },
  'mock-url': {
    description: 'Mock server URL.',
  },
  'monitor-id': {
    description: 'Smoke monitor ID.',
  },
  'repo-sync-summary-json': {
    description: 'JSON summary of repo materialization and workspace sync planning.',
  },
  'commit-sha': {
    description: 'Commit SHA placeholder for repo-write-mode.',
  },
  'orchestration-summary': {
    description: 'Human-readable summary of the onboarding orchestration plan.',
  },
};

export const ACTION_CONTRACT = {
  name: ACTION_NAME,
  entrypoint: ACTION_ENTRYPOINT,
  description: 'Public beta action contract for Postman API onboarding orchestration.',
  defaultIntegrationBackend: DEFAULT_INTEGRATION_BACKEND,
  phases: ORCHESTRATION_PHASES,
  inputs: INPUT_CONTRACT,
  outputs: OUTPUT_CONTRACT,
} as const;
