import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const dir = new URL('../contract/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir)))
const bytes = readFileSync(new URL('actera.openapi.json', dir))
assert.equal(
  createHash('sha256').update(bytes).digest('hex'),
  manifest.sha256,
  'Contract digest changed; update through the contract release process',
)
const contract = JSON.parse(bytes)
const actual = Object.entries(contract.paths)
  .flatMap(([route, item]) =>
    Object.keys(item)
      .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map((m) => `${m.toUpperCase()} ${route}`),
  )
  .sort()
assert.deepEqual(
  actual,
  [
    'GET /v1/action-intents',
    'GET /v1/action-intents/{intent_id}',
    'GET /v1/agents/{agent_id}/readiness',
    'GET /v1/decisions/{decision_id}/status',
    'GET /v1/reviewer-links/status',
    'POST /v1/action-intents/{intent_id}/cancel',
    'POST /v1/action-intents/{intent_id}/claim',
    'POST /v1/action-intents/{intent_id}/report',
    'POST /v1/decisions/{decision_id}/reports',
    'POST /v1/decisions',
    'POST /v1/reviewer-links',
  ].sort(),
  'Review changes to the supported SDK operations',
)
for (const type of ['v1Decision', 'v1ActionIntent', 'v1ActionExecutionEvent'])
  assert.ok(!contract.components.schemas[type], `${type} is internal`)
for (const type of ['v1CustomerDecision', 'v1CustomerActionIntent'])
  assert.ok(contract.components.schemas[type], `${type} is required`)
console.log(`Contract ${manifest.version}: digest and eleven-operation boundary verified`)

// Review every distributed schema and customer response field explicitly.
assert.deepEqual(
  Object.keys(contract.components.schemas).sort(),
  [
    'acteraApiV1CancelActionIntentResponse',
    'acteraApiV1ClaimActionExecutionResponse',
    'acteraApiV1CreateDecisionRequest',
    'acteraApiV1CreateDecisionResponse',
    'acteraApiV1GetActionIntentResponse',
    'acteraApiV1ListActionIntentsResponse',
    'acteraApiV1RecordDecisionReportResponse',
    'acteraApiV1ReportActionExecutionResponse',
    'protobufNullValue',
    'v1Action',
    'v1ActionIntentHandle',
    'v1Actor',
    'v1Cancellation',
    'v1CustomerActionIntent',
    'v1CustomerDecision',
    'v1DecisionReport',
    'v1Effect',
    'v1Error',
    'v1ExecutionClaim',
    'v1ExecutionOutcome',
    'v1ExecutionReport',
    'v1FieldError',
    'v1GetAgentReadinessResponse',
    'v1GetDecisionStatusResponse',
    'v1GetReviewerLinkStatusResponse',
    'v1IntendedCall',
    'v1RecordDecisionReportRequest',
    'v1StartReviewerLinkRequest',
    'v1StartReviewerLinkResponse',
  ].sort(),
  'Schema inventory changed; review the distribution boundary',
)
assert.deepEqual(
  Object.keys(contract.components.schemas.v1CustomerDecision.properties).sort(),
  [
    'action_intent',
    'action_type',
    'agent_id',
    'effect',
    'explanation',
    'id',
    'idempotency_key',
    'mode',
    'status',
    'workspace_id',
  ],
  'Customer projection changed; review every added field',
)
assert.deepEqual(
  Object.keys(contract.components.schemas.v1CustomerActionIntent.properties).sort(),
  [
    'agent_id',
    'attempt_id',
    'created_at',
    'decision_id',
    'downstream_idempotency_key',
    'error_code',
    'error_detail',
    'execution_status',
    'expires_at',
    'external_receipt',
    'handle',
    'id',
    'intended_call',
    'invocation_fingerprint',
    'result',
    'updated_at',
    'version',
    'workspace_id',
  ],
  'Customer projection changed; review every added field',
)

// Reject dangling references, external references, and unused schemas.
const visited = new Set()
function visit(value) {
  if (!value || typeof value !== 'object') return
  if (value.$ref) {
    assert.match(value.$ref, /^#\/components\/schemas\//, 'Contract references must be self-contained schemas')
    const name = value.$ref.slice('#/components/schemas/'.length)
    assert.ok(contract.components.schemas[name], `Missing schema: ${name}`)
    if (!visited.has(name)) {
      visited.add(name)
      visit(contract.components.schemas[name])
    }
  }
  for (const child of Object.values(value)) visit(child)
}
visit(contract.paths)
assert.deepEqual(
  Object.keys(contract.components.schemas)
    .filter((name) => !visited.has(name))
    .sort(),
  ['acteraApiV1CreateDecisionResponse', 'acteraApiV1RecordDecisionReportResponse', 'protobufNullValue'],
  'Unexpected unreferenced schemas in distribution',
)
visit(contract.components.schemas)
