import type { ActionIntent, Decision } from '../src/index.js'

export function decisionFixture(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'decision-1',
    mode: 'ENFORCING',
    workspace_id: 'workspace-1',
    agent_id: 'agent-1',
    action_type: 'tool',
    effect: 'ALLOW',
    status: 'ALLOWED',
    explanation: 'allowed',
    idempotency_key: 'request-1',
    ...overrides,
  }
}

export function intentFixture(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: 'intent-1',
    decision_id: 'decision-1',
    workspace_id: 'workspace-1',
    agent_id: 'agent-1',
    invocation_fingerprint: 'fingerprint-1',
    execution_status: 'READY',
    version: '1',
    attempt_id: '',
    downstream_idempotency_key: '',
    external_receipt: '',
    error_code: '',
    error_detail: '',
    ...overrides,
  }
}
