import type { components } from './generated/schema.js'

export type ExecutionOutcome = Exclude<components['schemas']['v1ExecutionOutcome'], 'OUTCOME_UNSPECIFIED'>

export type Effect = components['schemas']['v1Effect']
export type Actor = components['schemas']['v1Actor']
export type Action = components['schemas']['v1Action']
export type IntendedCall = components['schemas']['v1IntendedCall']
export type ActionIntent = components['schemas']['v1CustomerActionIntent']
export type ActionIntentHandle = components['schemas']['v1ActionIntentHandle']
export type Decision = components['schemas']['v1CustomerDecision']
export type DecisionReport = components['schemas']['v1DecisionReport']
export type DecisionReportInput = {
  outcome: ExecutionOutcome
  idempotencyKey: string
  action: Action
  context?: Record<string, unknown>
  details?: Record<string, unknown>
  occurredAt?: string
  decisionId: string
}
export type AgentReadiness = components['schemas']['v1GetAgentReadinessResponse']
export type DecisionStatus = components['schemas']['v1GetDecisionStatusResponse']
export type ReviewerLink = components['schemas']['v1StartReviewerLinkResponse']

type CreateDecisionRequest = components['schemas']['acteraApiV1CreateDecisionRequest']
const maxResponseBytes = 8 << 20

/** The production Actera API, used when `baseUrl` is omitted. */
export const defaultBaseUrl = 'https://app.actera.dev'

export interface CredentialRequest {
  audience: string
  signal?: AbortSignal
}
export interface AccessToken {
  token: string
  expiresAt?: number
}
export interface CredentialProvider {
  getToken(request: CredentialRequest): AccessToken | Promise<AccessToken>
}
export function fromApiKey(apiKey: string): CredentialProvider {
  const token = apiKey.trim()
  if (!token.startsWith('actera_') || token.length < 32) throw new ActeraError('A valid Actera API key is required')
  return { getToken: () => ({ token }) }
}

export interface AuthorizeInput {
  action: Action
  context?: Record<string, unknown>
  idempotencyKey: string
  mode?: 'MONITORING' | 'ENFORCING'
  intendedCall?: IntendedCall
}
export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}
export interface ReportExecutionInput {
  intentId: string
  attemptId: string
  /** Idempotency key for this report, distinct from the decision's `idempotencyKey`. */
  reportKey: string
  outcome: ExecutionOutcome
  result?: Record<string, unknown>
  externalReceipt?: string
  errorCode?: string
  errorDetail?: string
}
export interface IntentPageInput {
  statuses?: string[]
  hostId?: string
  pageSize?: number
  pageToken?: string
}
export interface ActeraClientOptions {
  /** Defaults to the production API, `defaultBaseUrl`. */
  baseUrl?: string
  credentials: CredentialProvider
  headers?: Record<string, string>
  fetch?: typeof fetch
}
/** Context bound once with `withContext()` and merged into every request as `context.initiator` and `context.business`. */
export interface AgentContext {
  initiator?: {
    id: string
    issuer?: string
    tenantId?: string
  }
  business?: Record<string, unknown>
}

/** Base class for every error the SDK raises. Transport, contract, and SDK-side validation errors all extend it. */
export class ActeraError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ActeraError'
  }
}

/** A non-2xx response. `code` and `fieldErrors` are filled when the body is a structured API error. */
export class ActeraHttpError extends ActeraError {
  readonly code: string | undefined
  readonly fieldErrors: components['schemas']['v1FieldError'][]
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Actera request failed with HTTP ${status}${body ? `: ${body}` : ''}`)
    this.name = 'ActeraHttpError'
    const error = parseAPIError(body)
    this.code = error?.code
    this.fieldErrors = error?.field_errors ?? []
    if (error?.message) this.message = error.message
  }
}
/** The service could not be reached, timed out, or answered 502/503/504. Callers decide the fallback. */
export class ActeraUnavailableError extends ActeraError {
  constructor(readonly cause: unknown) {
    super('Actera is unavailable', { cause })
    this.name = 'ActeraUnavailableError'
  }
}
export function isActeraUnavailable(error: unknown): error is ActeraUnavailableError {
  return error instanceof ActeraUnavailableError
}

/** Authenticated HTTPS client for one Actera base URL. Create agent-scoped clients with `agent()`. */
export class ActeraClient {
  readonly #baseUrl: string
  readonly #credentials: CredentialProvider
  readonly #headers: Record<string, string>
  readonly #fetch: typeof fetch

  constructor(options: ActeraClientOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? defaultBaseUrl)
    if (!options.credentials || typeof options.credentials.getToken !== 'function')
      throw new ActeraError('ActeraClient requires credentials')
    for (const name of Object.keys(options.headers ?? {})) {
      if (['authorization', 'actera-workspace-id'].includes(name.toLowerCase()))
        throw new ActeraError(`${name} is managed by ActeraClient credentials`)
    }
    this.#credentials = options.credentials
    this.#headers = { ...options.headers }
    this.#fetch = options.fetch ?? globalThis.fetch
    if (!this.#fetch) throw new ActeraError('ActeraClient requires a fetch implementation')
  }

  /** Bind every subsequent call to one agent; the response is checked against that agent. */
  agent(input: { agentId: string }): BoundAgentClient {
    return new BoundAgentClient(this, required(input.agentId, 'agentId'))
  }

  async getReviewerLinkStatus(options: RequestOptions = {}): Promise<boolean> {
    const response = await this.request('/reviewer-links/status', {}, options)
    const result = (await readResponseJSON(response)) as components['schemas']['v1GetReviewerLinkStatusResponse']
    return result.linked === true
  }

  /**
   * Low-level request to `/v1` + `path` with credentials, timeout, size limits, and redirect rejection applied.
   * Prefer the typed methods on `BoundAgentClient`.
   */
  async request(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<Response> {
    const timeout = options.timeoutMs ?? 30_000
    if (!Number.isFinite(timeout) || timeout <= 0) throw new ActeraError('timeoutMs must be positive')
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])])
    let access: AccessToken
    try {
      access = await this.#credentials.getToken({ audience: this.#baseUrl, signal })
    } catch (cause) {
      if (options.signal?.aborted) throw options.signal.reason
      throw cause
    }
    if (!access?.token?.trim()) throw new ActeraError('Actera credential provider returned no token')
    if (access.expiresAt !== undefined && access.expiresAt <= Date.now())
      throw new ActeraError('Actera credential provider returned an expired token')
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1${path}`, {
        ...init,
        redirect: 'manual',
        signal,
        headers: this.#requestHeaders(access.token, init.headers),
      })
    } catch (cause) {
      if (options.signal?.aborted) throw options.signal.reason
      throw new ActeraUnavailableError(cause)
    }
    if (response.redirected) throw new ActeraError('Actera request was redirected')
    if (!response.ok) {
      const error = new ActeraHttpError(response.status, (await readResponseText(response)).trim())
      if ([502, 503, 504].includes(response.status)) throw new ActeraUnavailableError(error)
      throw error
    }
    return response
  }

  #requestHeaders(token: string, additional?: RequestInit['headers']): Headers {
    const headers = new Headers({ 'Content-Type': 'application/json', ...this.#headers })
    if (additional) {
      new Headers(additional).forEach((value, name) => {
        if (['authorization', 'actera-workspace-id'].includes(name.toLowerCase()))
          throw new ActeraError(`${name} is managed by ActeraClient credentials`)
        headers.set(name, value)
      })
    }
    headers.set('Authorization', `Bearer ${token}`)
    return headers
  }
}

/** Operations for one agent. Immutable: `withContext()` returns a new client. */
export class BoundAgentClient {
  constructor(
    readonly client: ActeraClient,
    readonly agentId: string,
    readonly context: Readonly<AgentContext> = Object.freeze({}),
  ) {}

  withContext(context: AgentContext): BoundAgentClient {
    return new BoundAgentClient(this.client, this.agentId, freezeContext(context))
  }

  /** Append host-reported evidence to a Decision, including blocked Decisions. */
  async recordDecisionReport(input: DecisionReportInput, options: RequestOptions = {}): Promise<DecisionReport> {
    if (!['SUCCESS', 'FAILURE', 'CANCELLED', 'UNKNOWN'].includes(input.outcome))
      throw new ActeraError('A valid execution outcome is required')
    const response = await this.client.request(
      `/decisions/${encodeURIComponent(required(input.decisionId, 'decisionId'))}/reports`,
      {
        method: 'POST',
        body: JSON.stringify({
          agent: { id: this.agentId },
          action: input.action,
          idempotency_key: required(input.idempotencyKey, 'idempotencyKey'),
          outcome: input.outcome,
          context: mergeContext(this.context, input.context),
          details: input.details,
          occurred_at: input.occurredAt,
          decision_id: input.decisionId,
        }),
      },
      options,
    )
    const activity = (await readResponseJSON(response)) as DecisionReport
    if (!activity.id || activity.agent_id !== this.agentId || activity.idempotency_key !== input.idempotencyKey)
      throw new ActeraError('Actera returned activity for another agent or request')
    return activity
  }

  async getReadiness(options: RequestOptions = {}): Promise<AgentReadiness> {
    const response = await this.client.request(`/agents/${encodeURIComponent(this.agentId)}/readiness`, {}, options)
    const readiness = (await readResponseJSON(response)) as AgentReadiness
    if (readiness.agent_id !== this.agentId) throw new ActeraError('Actera returned readiness for another agent')
    return readiness
  }

  async getDecisionStatus(decisionId: string, options: RequestOptions = {}): Promise<DecisionStatus> {
    const id = required(decisionId, 'decisionId')
    const response = await this.client.request(`/decisions/${encodeURIComponent(id)}/status`, {}, options)
    const decision = (await readResponseJSON(response)) as DecisionStatus
    if (decision.id !== id || decision.agent_id !== this.agentId)
      throw new ActeraError('Actera returned status for another Decision or agent')
    return decision
  }

  async startReviewerLink(options: RequestOptions = {}): Promise<ReviewerLink> {
    const response = await this.client.request(
      '/reviewer-links',
      {
        method: 'POST',
        body: '{}',
      },
      options,
    )
    return (await readResponseJSON(response)) as ReviewerLink
  }

  /** Create a Decision for one intended action. Defaults to `ENFORCING`; reuse `idempotencyKey` for retries. */
  async authorizeAction(input: AuthorizeInput, options: RequestOptions = {}): Promise<Decision> {
    const body: CreateDecisionRequest = {
      agent: { id: this.agentId },
      action: input.action,
      idempotency_key: input.idempotencyKey,
      mode: input.mode ?? 'ENFORCING',
    }
    const context = mergeContext(this.context, input.context)
    if (Object.keys(context).length > 0) body.context = context
    if (input.intendedCall !== undefined) body.intended_call = input.intendedCall
    const response = await this.client.request('/decisions', { method: 'POST', body: JSON.stringify(body) }, options)
    return parseDecision(await readResponseJSON(response), this.agentId, input)
  }

  async getActionIntent(intentId: string, options: RequestOptions = {}): Promise<ActionIntent> {
    const response = await this.client.request(`/action-intents/${encodeURIComponent(intentId)}`, {}, options)
    return this.#boundIntent(((await readResponseJSON(response)) as { intent?: ActionIntent }).intent)
  }

  async listActionIntentsPage(
    input: IntentPageInput = {},
    options: RequestOptions = {},
  ): Promise<{ intents: ActionIntent[]; nextPageToken: string }> {
    const query = new URLSearchParams()
    for (const status of input.statuses ?? []) query.append('statuses', status)
    if (input.hostId) query.set('host_id', input.hostId)
    query.set('page_size', String(input.pageSize ?? 100))
    if (input.pageToken) query.set('page_token', input.pageToken)
    const response = await this.client.request('/action-intents?' + query, {}, options)
    const page = (await readResponseJSON(response)) as components['schemas']['acteraApiV1ListActionIntentsResponse']
    return {
      intents: (page.intents ?? []).filter((intent) => intent.agent_id === this.agentId),
      nextPageToken: page.next_page_token ?? '',
    }
  }

  async *iterateActionIntents(input: IntentPageInput = {}, options: RequestOptions = {}): AsyncGenerator<ActionIntent> {
    let token = input.pageToken ?? ''
    const seen = new Set<string>()
    do {
      options.signal?.throwIfAborted()
      const page = await this.listActionIntentsPage({ ...input, pageToken: token }, options)
      yield* page.intents
      token = page.nextPageToken
      if (token && seen.has(token)) throw new ActeraError('Actera returned a repeated action-intent page token')
      seen.add(token)
    } while (token)
  }

  async listActionIntents(input: IntentPageInput = {}, options: RequestOptions = {}): Promise<ActionIntent[]> {
    const items: ActionIntent[] = []
    for await (const item of this.iterateActionIntents(input, options)) items.push(item)
    return items
  }

  async cancelActionIntent(
    input: { intentId: string; idempotencyKey: string; reason: string },
    options: RequestOptions = {},
  ): Promise<ActionIntent> {
    const response = await this.client.request(
      `/action-intents/${encodeURIComponent(input.intentId)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ idempotency_key: input.idempotencyKey, reason: input.reason }),
      },
      options,
    )
    return this.#boundIntent(((await readResponseJSON(response)) as { intent?: ActionIntent }).intent)
  }

  /** Claim the right to dispatch a managed intent once. Only `dispatchGranted: true` permits execution. */
  async claimActionExecution(
    input: { intentId: string; invocationFingerprint: string; claimRequestId: string; hostId: string },
    options: RequestOptions = {},
  ): Promise<{
    intent: ActionIntent
    dispatchGranted: boolean
    attemptId?: string
    downstreamIdempotencyKey?: string
  }> {
    const response = await this.client.request(
      `/action-intents/${encodeURIComponent(input.intentId)}/claim`,
      {
        method: 'POST',
        body: JSON.stringify({
          invocation_fingerprint: input.invocationFingerprint,
          claim_request_id: input.claimRequestId,
          host_id: input.hostId,
        }),
      },
      options,
    )
    const body = (await readResponseJSON(response)) as {
      intent?: ActionIntent
      dispatch_granted?: boolean
      attempt_id?: string
      downstream_idempotency_key?: string
    }
    return {
      intent: this.#boundIntent(body.intent),
      dispatchGranted: body.dispatch_granted === true,
      ...(body.attempt_id === undefined ? {} : { attemptId: body.attempt_id }),
      ...(body.downstream_idempotency_key === undefined
        ? {}
        : { downstreamIdempotencyKey: body.downstream_idempotency_key }),
    }
  }

  /** Report the outcome of a claimed attempt. `reportKey` must be stable across retries of the same report. */
  async reportActionExecution(input: ReportExecutionInput, options: RequestOptions = {}): Promise<ActionIntent> {
    if (!['SUCCESS', 'FAILURE', 'CANCELLED', 'UNKNOWN'].includes(input.outcome))
      throw new ActeraError('A valid execution outcome is required')
    const response = await this.client.request(
      `/action-intents/${encodeURIComponent(input.intentId)}/report`,
      {
        method: 'POST',
        body: JSON.stringify({
          attempt_id: input.attemptId,
          report_key: input.reportKey,
          outcome: input.outcome,
          result: input.result ?? {},
          external_receipt: input.externalReceipt ?? '',
          error_code: input.errorCode ?? '',
          error_detail: input.errorDetail ?? '',
        }),
      },
      options,
    )
    return this.#boundIntent(((await readResponseJSON(response)) as { intent?: ActionIntent }).intent)
  }

  #boundIntent(intent?: ActionIntent): ActionIntent {
    if (!intent) return missingIntent()
    if (intent.agent_id !== this.agentId) throw new ActeraError('Actera returned an intent for another agent')
    return intent
  }
}

function mergeContext(bound: Readonly<AgentContext>, supplied?: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(supplied ?? {})
  for (const key of ['initiator', 'business'] as const) {
    if (!bound[key]) continue
    if (key in result)
      throw new ActeraError(`context.${key} is bound with withContext() and cannot be supplied per request`)
    result[key] = structuredClone(bound[key])
  }
  return result
}
function freezeContext(context: AgentContext): Readonly<AgentContext> {
  const copy = structuredClone(context)
  if (copy.initiator) Object.freeze(copy.initiator)
  if (copy.business) Object.freeze(copy.business)
  return Object.freeze(copy)
}
function required(value: string, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new ActeraError(`ActeraClient requires ${name}`)
  return normalized
}
function validateBaseUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ActeraError('ActeraClient requires a valid baseUrl')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new ActeraError('ActeraClient baseUrl cannot contain credentials, a query, or a fragment')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
    throw new ActeraError('ActeraClient requires HTTPS except on loopback')
  return parsed.toString().replace(/\/$/, '')
}
function missingIntent(): never {
  throw new ActeraError('Actera response did not include an action intent')
}

async function readResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes)
    throw new ActeraError('Actera response exceeds the size limit')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let result = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxResponseBytes) {
        await reader.cancel()
        throw new ActeraError('Actera response exceeds the size limit')
      }
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function readResponseJSON(response: Response): Promise<unknown> {
  return JSON.parse(await readResponseText(response)) as unknown
}

function supportedEffect(value: unknown): value is Exclude<Effect, 'UNSPECIFIED'> {
  return value === 'ALLOW' || value === 'REQUIRE_APPROVAL' || value === 'BLOCK'
}

function parseDecision(value: unknown, agentId: string, input: AuthorizeInput): Decision {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    !('workspace_id' in value) ||
    typeof value.workspace_id !== 'string' ||
    !value.workspace_id ||
    !('agent_id' in value) ||
    value.agent_id !== agentId ||
    !('action_type' in value) ||
    value.action_type !== input.action.type ||
    !('idempotency_key' in value) ||
    value.idempotency_key !== input.idempotencyKey ||
    !('effect' in value) ||
    !supportedEffect(value.effect) ||
    !('status' in value) ||
    typeof value.status !== 'string' ||
    !value.status
  )
    throw new ActeraError('Actera returned an invalid authorization decision')
  return value as Decision
}

function parseAPIError(body: string): components['schemas']['v1Error'] | undefined {
  try {
    const value: unknown = JSON.parse(body)
    if (
      !value ||
      typeof value !== 'object' ||
      !('code' in value) ||
      typeof value.code !== 'string' ||
      !('message' in value) ||
      typeof value.message !== 'string'
    )
      return undefined
    const field_errors: components['schemas']['v1FieldError'][] = []
    if ('field_errors' in value && Array.isArray(value.field_errors)) {
      for (const candidate of value.field_errors) {
        const record = candidate as unknown
        if (
          record &&
          typeof record === 'object' &&
          'field' in record &&
          'message' in record &&
          typeof record.field === 'string' &&
          typeof record.message === 'string'
        )
          field_errors.push({ field: record.field, message: record.message })
      }
    }
    return { code: value.code, message: value.message, field_errors }
  } catch {
    return undefined
  }
}
