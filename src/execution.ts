import {
  ActeraError,
  type BoundAgentClient,
  type ActionIntent,
  type ExecutionOutcome,
  type IntendedCall,
  type RequestOptions,
  type ReportExecutionInput,
} from './index.js'

export interface ExecutionBinding {
  hostId: string
  targetId: string
  targetBindingRevision?: string
  targetAccountId?: string
  credentialReference?: string
  executionPrincipalId?: string
  requiredScopes?: string[]
  adapterKind: string
  adapterVersion: string
  method: string
}

export interface ExecutionContext {
  intentId: string
  attemptId: string
  downstreamIdempotencyKey: string
  signal?: AbortSignal
}

export interface ExecutionOptions extends RequestOptions {
  claimRequestId?: string
  reportKey?: string
}

/** What the host concluded about one dispatched call. Returned by `classifyOutcome`. */
export interface OutcomeClassification {
  outcome: ExecutionOutcome
  externalReceipt?: string
  errorCode?: string
  errorDetail?: string
}

export type ExecutionResult<T> =
  | { status: 'COMPLETED'; intent: ActionIntent; result: T }
  | { status: 'PENDING' | 'CANCELLED' | 'EXPIRED' | 'EXECUTING' | 'FAILED' | 'UNKNOWN'; intent: ActionIntent }

/** The intent, claim, or provider result violated the execution contract. Nothing is dispatched after it. */
export class ExecutionContractError extends ActeraError {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionContractError'
  }
}

/** A claim may have committed. Retrieve state; never retry the provider call to recover this error. */
export class ExecutionClaimError extends ActeraError {
  constructor(
    readonly intentId: string,
    readonly claimRequestId: string,
    cause: unknown,
  ) {
    super('Execution claim response is unavailable; retrieve the intent before recovery', { cause })
    this.name = 'ExecutionClaimError'
  }
}

/** Persist report in the customer's infrastructure and retry ONLY reportActionExecution(report). */
export class ExecutionReportError extends ActeraError {
  constructor(
    readonly report: ReportExecutionInput,
    readonly intent: ActionIntent,
    cause: unknown,
  ) {
    super('Execution outcome could not be recorded; retry this report without dispatching again', { cause })
    this.name = 'ExecutionReportError'
  }
}

export interface ExecutionConfig<T> {
  client: Pick<BoundAgentClient, 'getActionIntent' | 'claimActionExecution' | 'reportActionExecution'>
  binding: ExecutionBinding
  /** Resolve refreshed credentials/bindings before claiming. Never return credential secrets. */
  resolveBinding?: () => ExecutionBinding | Promise<ExecutionBinding>
  dispatch: (call: IntendedCall, context: ExecutionContext) => Promise<T>
  /** Interpret provider completion, not just HTTP/MCP transport success. Pending is UNKNOWN. */
  classifyOutcome: (result: T) => OutcomeClassification
}

/** Stateless coordinator. Persistence, scheduling, provider recovery and report retries belong to the host. */
export class ActeraExecution<T> {
  constructor(readonly config: ExecutionConfig<T>) {
    if (typeof config.classifyOutcome !== 'function' || typeof config.dispatch !== 'function')
      throw new ExecutionContractError('Execution requires a dispatcher and outcome classifier')
  }

  async resume(intentId: string, options: ExecutionOptions = {}): Promise<ExecutionResult<T>> {
    options.signal?.throwIfAborted()
    const intent = await this.config.client.getActionIntent(intentId, options)
    return this.execute(intent, options)
  }

  async execute(intent: ActionIntent, options: ExecutionOptions = {}): Promise<ExecutionResult<T>> {
    options.signal?.throwIfAborted()
    const binding = await (this.config.resolveBinding?.() ?? this.config.binding)
    validateExecutionIntent(intent, binding)
    if (intent.execution_status !== 'READY') return executionResult<T>(intent)
    if (
      !intent.expires_at ||
      Date.parse(intent.expires_at) <= Date.now() ||
      !Number.isFinite(Date.parse(intent.expires_at))
    )
      throw new ExecutionContractError('Executable intent has expired or has no valid expiry')
    const originalCall = canonical(intent.intended_call)
    const claimRequestId = options.claimRequestId ?? crypto.randomUUID()
    options.signal?.throwIfAborted()
    let claim: Awaited<ReturnType<BoundAgentClient['claimActionExecution']>>
    try {
      claim = await this.config.client.claimActionExecution(
        {
          intentId: intent.id,
          invocationFingerprint: intent.invocation_fingerprint,
          claimRequestId,
          hostId: binding.hostId,
        },
        options,
      )
    } catch (cause) {
      throw new ExecutionClaimError(intent.id, claimRequestId, cause)
    }
    validateExecutionIntent(claim.intent, binding)
    if (
      claim.intent.id !== intent.id ||
      claim.intent.invocation_fingerprint !== intent.invocation_fingerprint ||
      canonical(claim.intent.intended_call) !== originalCall
    )
      throw new ExecutionContractError('Claim response changed the approved invocation')
    if (!claim.dispatchGranted) return executionResult<T>(claim.intent)
    if (!claim.attemptId || !claim.downstreamIdempotencyKey || claim.intent.execution_status !== 'EXECUTING')
      throw new ExecutionContractError('Dispatch grant is missing execution identity')
    const context: ExecutionContext = {
      intentId: intent.id,
      attemptId: claim.attemptId,
      downstreamIdempotencyKey: claim.downstreamIdempotencyKey,
      ...(options.signal ? { signal: options.signal } : {}),
    }
    let value: T | undefined
    let result: Record<string, unknown> = {}
    let outcome: OutcomeClassification
    if (options.signal?.aborted) {
      // Nothing was dispatched, so this is a definitive cancellation rather than a failure.
      outcome = { outcome: 'CANCELLED', errorCode: 'CANCELLED_BEFORE_DISPATCH' }
    } else {
      try {
        value = await this.config.dispatch(structuredClone(claim.intent.intended_call!), context)
        result = encodeResult(value)
        outcome = this.config.classifyOutcome(value)
        if (!['SUCCESS', 'FAILURE', 'CANCELLED', 'UNKNOWN'].includes(outcome.outcome))
          throw new ExecutionContractError('Provider returned an unsupported outcome')
      } catch (cause) {
        // A thrown dispatch/classification/serialization error cannot prove absence of side effects.
        outcome = {
          outcome: 'UNKNOWN',
          errorCode: 'DISPATCH_OUTCOME_UNKNOWN',
          errorDetail: cause instanceof Error ? cause.message.slice(0, 500) : 'Provider outcome unavailable',
        }
      }
    }
    const report: ReportExecutionInput = {
      intentId: intent.id,
      attemptId: claim.attemptId,
      reportKey: options.reportKey ?? `${claim.attemptId}:${outcome.outcome}`,
      ...outcome,
      result,
    }
    let reported: ActionIntent
    try {
      // Cancellation after dispatch must not suppress accounting. Bound reporting separately.
      reported = await this.config.client.reportActionExecution(report, { timeoutMs: options.timeoutMs ?? 30_000 })
    } catch (cause) {
      throw new ExecutionReportError(report, claim.intent, cause)
    }
    return executionResult<T>(reported)
  }
}

export function validateExecutionIntent(intent: ActionIntent, binding: ExecutionBinding): void {
  const call = intent.intended_call
  if (!intent.id || !intent.invocation_fingerprint || !call || call.envelope_schema_version !== 1 || !call.tool_name)
    throw new ExecutionContractError('Actera returned an incomplete executable intent')
  const expected: Record<string, string> = {
    host_id: binding.hostId,
    target_id: binding.targetId,
    adapter_kind: binding.adapterKind,
    adapter_version: binding.adapterVersion,
    method: binding.method,
    target_binding_revision: binding.targetBindingRevision ?? '',
    target_account_id: binding.targetAccountId ?? '',
    credential_reference: binding.credentialReference ?? '',
    execution_principal_id: binding.executionPrincipalId ?? '',
  }
  if (!binding.hostId || !binding.targetId)
    throw new ExecutionContractError('Execution binding requires host and target')
  for (const [key, value] of Object.entries(expected)) {
    if ((call[key as keyof IntendedCall] ?? '') !== value)
      throw new ExecutionContractError(`Execution binding changed: ${key}`)
  }
  if (canonical([...(call.required_scopes ?? [])].sort()) !== canonical([...(binding.requiredScopes ?? [])].sort()))
    throw new ExecutionContractError('Execution scopes changed')
}

export function executionResult<T>(intent: ActionIntent): ExecutionResult<T> {
  switch (intent.execution_status) {
    case 'COMPLETED':
      return { status: 'COMPLETED', intent, result: decodeResult<T>(intent.result ?? {}) }
    case 'CAPTURED':
      return { status: 'PENDING', intent }
    case 'READY':
      return { status: 'PENDING', intent }
    case 'CANCELLED':
    case 'EXPIRED':
    case 'EXECUTING':
    case 'FAILED':
    case 'UNKNOWN':
      return { status: intent.execution_status, intent }
    default:
      throw new ExecutionContractError('Actera returned an unsupported execution state')
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b)))
      : child,
  )
}

function encodeResult(value: unknown): Record<string, unknown> {
  if (value === undefined) return { actera_result_version: 1, present: false }
  const encoded = JSON.stringify(value, (_key, child: unknown) => {
    if (
      typeof child === 'number' &&
      (!Number.isFinite(child) || (Number.isInteger(child) && !Number.isSafeInteger(child)))
    )
      throw new ExecutionContractError('Provider result contains an unsafe number')
    return child
  })
  if (encoded === undefined) throw new ExecutionContractError('Provider result is not JSON serializable')
  return { actera_result_version: 1, present: true, value: JSON.parse(encoded) as unknown }
}

function decodeResult<T>(result: Record<string, unknown>): T {
  if (result.actera_result_version !== 1) return result as T
  return (result.present ? result.value : undefined) as T
}
