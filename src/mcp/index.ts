import {
  ActeraError,
  isActeraUnavailable,
  type BoundAgentClient,
  type ActionIntent,
  type ActionIntentHandle,
  type Decision,
  type ExecutionOutcome,
  type RequestOptions,
} from '../index.js'
import {
  ActeraExecution,
  executionResult,
  type ExecutionBinding,
  type ExecutionOptions,
  type OutcomeClassification,
  type ExecutionContext,
} from '../execution.js'

export interface CallToolRequest {
  name: string
  arguments?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type CallToolHandler<TRequest extends CallToolRequest = CallToolRequest, TResult = unknown> = (
  request: TRequest,
) => Promise<TResult>

export interface CallToolInterceptor<TRequest extends CallToolRequest = CallToolRequest> {
  <TResult>(request: TRequest, next: CallToolHandler<TRequest, TResult>, rest?: readonly unknown[]): Promise<TResult>
}

export interface ActeraInvocation {
  /** Stable business operation identity; persist across workflow restarts. */
  operationKey?: string
  traceId: string
  toolCallId: string
  sessionId?: string
  evaluationContext?: Record<string, unknown>
}

export type UnavailableBehavior = 'deny' | 'defer' | 'allow'
export interface ActionBehavior {
  mode: 'enforce' | 'monitor'
  onUnavailable: UnavailableBehavior
}
export interface ActionBehaviorConfig {
  default?: ActionBehavior
  tools?: Readonly<Record<string, ActionBehavior>>
}
export interface ActeraEvent {
  tool: string
  operationKey: string
  effect?: Decision['effect']
  outcome?: ExecutionOutcome
  reason?: string
}

export interface ActeraAuthorizationConfig<TRequest extends CallToolRequest = CallToolRequest> {
  client: Pick<BoundAgentClient, 'authorizeAction'> & Partial<Pick<BoundAgentClient, 'recordDecisionReport'>>
  resolveInvocation: (
    request: Readonly<TRequest>,
  ) => ActeraInvocation | undefined | Promise<ActeraInvocation | undefined>
  behavior?: ActionBehaviorConfig
  onEvent?: (event: ActeraEvent) => void | Promise<void>
  continuation?: Pick<ActeraMcpContinuation<TRequest, unknown>, 'intendedCall' | 'executeAuthorized'>
  /** Selects calls whose exact invocation must be persisted and claim-gated. Defaults to every call. */
  manageExecution?: (request: Readonly<TRequest>) => boolean
}

/** Actera returned a decision that stops the call: blocked or awaiting approval. */
export class ActeraDecisionError extends ActeraError {
  constructor(
    message: string,
    readonly decision: Decision,
  ) {
    super(message)
    this.name = 'ActeraDecisionError'
  }
}

export class ActeraBlockedError extends ActeraDecisionError {
  constructor(decision: Decision) {
    super(decisionMessage('Actera blocked this MCP tool call', decision), decision)
    this.name = 'ActeraBlockedError'
  }
}

export class ActeraApprovalRequiredError extends ActeraDecisionError {
  readonly handle: ActionIntentHandle | undefined
  constructor(decision: Decision) {
    super(decisionMessage('Actera approval is required', decision), decision)
    this.name = 'ActeraApprovalRequiredError'
    this.handle = decision.action_intent?.handle ?? undefined
  }
}

export type ResumeResult<TResult> =
  | {
      status: 'PENDING' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'EXECUTING' | 'FAILED' | 'UNKNOWN'
      intent: ActionIntent
    }
  | { status: 'COMPLETED'; intent: ActionIntent; result: TResult }

export interface ActeraMcpContinuationConfig<TRequest extends CallToolRequest, TResult> {
  client: Pick<BoundAgentClient, 'getActionIntent' | 'claimActionExecution' | 'reportActionExecution'>
  hostId: string
  targetId: string
  targetBindingRevision?: string
  targetAccountId?: string
  credentialReference?: string
  executionPrincipalId?: string
  requiredScopes?: string[]
  adapterVersion?: string
  resolveBinding?: () => ExecutionBinding | Promise<ExecutionBinding>
  dispatch: (request: TRequest, context: ExecutionContext) => Promise<TResult>
  classifyOutcome: (result: TResult) => OutcomeClassification
}

/**
 * Durable execution for managed MCP calls. Managed calls are dispatched through `config.dispatch`, not through
 * the remaining interceptor chain, so interceptors placed after Actera do not observe them.
 */
export class ActeraMcpContinuation<TRequest extends CallToolRequest, TResult> {
  readonly execution: ActeraExecution<TResult>
  constructor(readonly config: ActeraMcpContinuationConfig<TRequest, TResult>) {
    if (typeof config.classifyOutcome !== 'function' || typeof config.dispatch !== 'function')
      throw new ActeraError('Managed MCP continuation requires a dispatcher and outcome classifier')
    this.execution = new ActeraExecution({
      client: config.client,
      binding: {
        ...config,
        adapterKind: 'mcp-typescript',
        adapterVersion: config.adapterVersion ?? '1',
        method: 'tools/call',
      },
      ...(config.resolveBinding ? { resolveBinding: config.resolveBinding } : {}),
      dispatch: (call, context) =>
        config.dispatch(
          { name: call.tool_name, arguments: call.arguments ?? {}, _meta: call.metadata ?? {} } as TRequest,
          context,
        ),
      classifyOutcome: (value) =>
        isRecord(value) && value.isError === true
          ? { outcome: 'UNKNOWN', errorCode: 'MCP_ERROR_OUTCOME_UNKNOWN' }
          : config.classifyOutcome(value),
    })
  }

  intendedCall(request: TRequest, invocation: ActeraInvocation) {
    return {
      envelope_schema_version: 1,
      adapter_kind: 'mcp-typescript',
      adapter_version: this.config.adapterVersion ?? '1',
      method: 'tools/call',
      tool_name: request.name,
      arguments: request.arguments ?? {},
      metadata: request._meta ?? {},
      host_id: this.config.hostId,
      host_operation_id: invocation.operationKey ?? invocation.traceId,
      logical_tool_call_id: invocation.operationKey ?? invocation.toolCallId,
      operation_key: invocation.operationKey ?? invocation.traceId + ':' + invocation.toolCallId,
      target_id: this.config.targetId,
      target_binding_revision: this.config.targetBindingRevision ?? '',
      target_account_id: this.config.targetAccountId ?? '',
      credential_reference: this.config.credentialReference ?? '',
      execution_principal_id: this.config.executionPrincipalId ?? '',
      required_scopes: this.config.requiredScopes ?? [],
    }
  }

  async executeAuthorized(intent: ActionIntent, options: ExecutionOptions = {}): Promise<ResumeResult<TResult>> {
    return this.execution.execute(intent, options)
  }

  async resumeToolCall(
    handle: ActionIntentHandle,
    options: ExecutionOptions & { waitMs?: number; pollIntervalMs?: number } = {},
  ): Promise<ResumeResult<TResult>> {
    if (!handle.intent_id) throw new ActeraAuthorizationError('Approval handle has no intent id')
    const deadline = Date.now() + (options.waitMs ?? 0)
    for (;;) {
      options.signal?.throwIfAborted()
      const intent = await this.config.client.getActionIntent(handle.intent_id, options)
      if (intent.execution_status === 'READY' || intent.execution_status === 'COMPLETED')
        return this.executeAuthorized(intent, options)
      const observed = executionResult<TResult>(intent)
      if (observed.status !== 'PENDING' || Date.now() >= deadline) return observed
      await delay(Math.max(1, Math.min(options.pollIntervalMs ?? 1000, deadline - Date.now())), options.signal)
    }
  }
}

export function createActeraMcpContinuation<TRequest extends CallToolRequest, TResult>(
  config: ActeraMcpContinuationConfig<TRequest, TResult>,
) {
  if (!config.hostId || !config.targetId) throw new ActeraError('Managed MCP continuation requires hostId and targetId')
  return new ActeraMcpContinuation(config)
}

/** The call could not be authorized: invalid invocation, unsupported decision, or an unhandled service failure. */
export class ActeraAuthorizationError extends ActeraError {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ActeraAuthorizationError'
  }
}

export class ActeraDeferredError extends ActeraAuthorizationError {
  constructor(
    readonly operationKey: string,
    cause: unknown,
  ) {
    super(`Actera is unavailable; operation ${operationKey} was deferred`, cause)
    this.name = 'ActeraDeferredError'
  }
}

/** Build the Actera interceptor for `interceptMcpClient`. Defaults to enforce mode and deny on unavailability. */
export function createActeraAuthorization<TRequest extends CallToolRequest = CallToolRequest>(
  config: ActeraAuthorizationConfig<TRequest>,
): CallToolInterceptor<TRequest> {
  return async <TResult>(
    request: TRequest,
    next: CallToolHandler<TRequest, TResult>,
    rest: readonly unknown[] = [],
  ): Promise<TResult> => {
    let decision: Decision
    let managesExecution: boolean
    let invocation: ActeraInvocation | undefined
    let action: { type: string; attributes: Record<string, unknown> }
    let context: Record<string, unknown>
    const behavior = behaviorFor(config.behavior, request.name)
    const options = requestOptions(rest)
    try {
      validateToolRequest(request)
      invocation = await config.resolveInvocation(request)
      validateInvocation(invocation)
      managesExecution = config.continuation !== undefined && (config.manageExecution?.(request) ?? true)
      if (managesExecution && (behavior.mode === 'monitor' || behavior.onUnavailable === 'allow'))
        throw new ActeraAuthorizationError(
          'Managed execution requires enforce mode with deny or defer on unavailability',
        )
      const intendedCall = managesExecution ? config.continuation?.intendedCall(request, invocation) : undefined
      action = { type: request.name, attributes: request.arguments ?? {} }
      context = evaluationContext(request, invocation)
      const authorization = {
        action,
        context,
        idempotencyKey: invocation.operationKey ?? `${invocation.traceId}:${invocation.toolCallId}`,
        ...(intendedCall === undefined ? {} : { intendedCall }),
      }
      decision = await config.client.authorizeAction(
        { ...authorization, mode: behavior.mode === 'monitor' ? 'MONITORING' : 'ENFORCING' },
        options,
      )
    } catch (cause) {
      if (cause instanceof ActeraAuthorizationError) throw cause
      if (isActeraUnavailable(cause)) {
        const operationKey = operationKeyOf(invocation)
        if (behavior.onUnavailable === 'allow') {
          await emit(config, {
            tool: request.name,
            operationKey,
            reason: cause.message,
          })
          return next(request)
        }
        if (behavior.onUnavailable === 'defer') throw new ActeraDeferredError(operationKey, cause)
      }
      throw new ActeraAuthorizationError('Actera could not authorize this MCP tool call', cause)
    }

    if (!['ALLOW', 'BLOCK', 'REQUIRE_APPROVAL'].includes(decision.effect))
      throw new ActeraAuthorizationError(`Actera returned an unsupported decision effect: ${decision.effect}`)
    const report = async (result: { outcome: ExecutionOutcome }) => {
      try {
        await config.client.recordDecisionReport?.({
          action,
          context,
          decisionId: decision.id,
          idempotencyKey: `${decision.id}:${result.outcome}`,
          ...result,
          details: { source: 'mcp_typescript', summary: 'MCP host reported this event.' },
        })
      } catch (error) {
        await emit(config, {
          tool: request.name,
          operationKey: operationKeyOf(invocation),
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const runReported = async () => {
      // A thrown transport error or an MCP error result cannot prove the tool had no effect.
      // This matches the managed execution path.
      let outcome: ExecutionOutcome = 'UNKNOWN'
      try {
        const result = await next(request)
        outcome = isRecord(result) && result.isError === true ? 'UNKNOWN' : 'SUCCESS'
        return result
      } finally {
        await report({ outcome })
        await emit(config, {
          tool: request.name,
          operationKey: operationKeyOf(invocation),
          effect: decision.effect,
          outcome,
        })
      }
    }
    if (behavior.mode === 'monitor') return runReported()

    switch (decision.effect) {
      case 'ALLOW':
        if (managesExecution) {
          const enforced = decision
          if (!config.continuation || !enforced.action_intent)
            throw new ActeraAuthorizationError('Managed authorization returned no executable intent')
          const result = await config.continuation.executeAuthorized(enforced.action_intent, options)
          if (result.status === 'COMPLETED') return result.result as TResult
          throw new ActeraAuthorizationError(`Actera did not grant execution (intent ${result.status})`)
        }
        return runReported()
      case 'BLOCK':
        throw new ActeraBlockedError(decision)
      case 'REQUIRE_APPROVAL':
        if (managesExecution && !decision.action_intent?.handle?.intent_id)
          throw new ActeraAuthorizationError('Managed approval returned no durable handle')
        throw new ActeraApprovalRequiredError(decision)
      case 'UNSPECIFIED':
      default: {
        const error = new ActeraAuthorizationError(
          `Actera returned an unsupported decision effect${decision.effect ? `: ${decision.effect}` : ''}`,
        )
        throw error
      }
    }
  }
}

/** Wrap an MCP client so `callTool` runs through `interceptors` in order; every other member passes through. */
export function interceptMcpClient<
  TRequest extends CallToolRequest,
  TRest extends unknown[],
  TResult,
  TClient extends object,
>(
  client: TClient & { callTool(request: TRequest, ...rest: TRest): Promise<TResult> },
  interceptors: readonly CallToolInterceptor<TRequest>[],
): TClient {
  const originalCallTool = client.callTool.bind(client)

  const callTool = (request: TRequest, ...rest: TRest) => {
    let lastIndex = -1
    const dispatch = (index: number, current: TRequest): Promise<TResult> => {
      if (index <= lastIndex) return Promise.reject(new ActeraError('MCP interceptor next() called more than once'))
      lastIndex = index
      const interceptor = interceptors[index]
      if (!interceptor) return originalCallTool(current, ...rest)
      return interceptor<TResult>(current, (nextRequest) => dispatch(index + 1, nextRequest), rest)
    }
    return dispatch(0, request)
  }

  return new Proxy(client, {
    get(target, property) {
      if (property === 'callTool') return callTool
      const value: unknown = Reflect.get(target, property, target)
      const bound: unknown = typeof value === 'function' ? value.bind(target) : value
      return bound
    },
  })
}

function evaluationContext(request: CallToolRequest, invocation: ActeraInvocation): Record<string, unknown> {
  const supplied = invocation.evaluationContext ?? {}
  if (invocation.operationKey)
    return { ...supplied, resource: request.arguments ?? {}, mcp: { operation_key: invocation.operationKey } }
  const suppliedMcp = isRecord(supplied.mcp) ? supplied.mcp : {}
  const mcp: Record<string, unknown> = {
    ...suppliedMcp,
    trace_id: invocation.traceId,
    tool_call_id: invocation.toolCallId,
  }
  if (invocation.sessionId) mcp.session_id = invocation.sessionId
  return {
    ...supplied,
    resource: request.arguments ?? {},
    mcp,
  }
}

function validateToolRequest(request: CallToolRequest): void {
  if (!request || typeof request.name !== 'string' || request.name.trim() === '') {
    throw new ActeraAuthorizationError('MCP tool name is required')
  }
}

function validateInvocation(invocation: ActeraInvocation | undefined): asserts invocation is ActeraInvocation {
  if (!invocation) throw new ActeraAuthorizationError('Actera invocation context is unavailable')
  if (invocation.operationKey !== undefined && !invocation.operationKey.trim())
    throw new ActeraAuthorizationError('operationKey must not be empty')
  for (const [name, value] of [
    ['traceId', invocation.traceId],
    ['toolCallId', invocation.toolCallId],
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ActeraAuthorizationError(`Actera invocation ${name} is required`)
    }
  }
}

function behaviorFor(config: ActionBehaviorConfig | undefined, tool: string): ActionBehavior {
  const behavior = config?.tools?.[tool] ?? config?.default ?? { mode: 'enforce', onUnavailable: 'deny' }
  if (!['enforce', 'monitor'].includes(behavior.mode) || !['deny', 'defer', 'allow'].includes(behavior.onUnavailable))
    throw new ActeraAuthorizationError(`Invalid Actera behavior configured for tool ${tool}`)
  return behavior
}

function operationKeyOf(invocation: ActeraInvocation | undefined): string {
  if (!invocation) return 'unresolved'
  return invocation.operationKey ?? `${invocation.traceId}:${invocation.toolCallId}`
}

function requestOptions(rest: readonly unknown[]): RequestOptions {
  // MCP clients pass options after the request, for example callTool(params, resultSchema?, options?).
  // Use whichever trailing argument carries a signal or timeout.
  const options: RequestOptions = {}
  for (const candidate of rest) {
    if (!isRecord(candidate)) continue
    if (candidate.signal instanceof AbortSignal) options.signal = candidate.signal
    const timeout =
      typeof candidate.timeoutMs === 'number'
        ? candidate.timeoutMs
        : typeof candidate.timeout === 'number'
          ? candidate.timeout
          : undefined
    if (timeout) options.timeoutMs = timeout
  }
  return options
}

async function emit<TRequest extends CallToolRequest>(config: ActeraAuthorizationConfig<TRequest>, event: ActeraEvent) {
  try {
    await config.onEvent?.(event)
  } catch {
    // Telemetry is best effort. It must not turn an already configured outage
    // bypass, observation, or completed dispatch into an authorization failure.
  }
}

function decisionMessage(prefix: string, decision: Decision): string {
  const explanation = decision.explanation ? `: ${decision.explanation}` : ''
  const id = decision.id ? ` (decision ${decision.id})` : ''
  return `${prefix}${explanation}${id}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
