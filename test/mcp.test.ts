import { decisionFixture, intentFixture } from './fixtures.js'
import { describe, expect, it, vi } from 'vitest'
import { ActeraUnavailableError, type BoundAgentClient, type Decision } from '../src/index.js'
import {
  ActeraApprovalRequiredError,
  ActeraAuthorizationError,
  ActeraBlockedError,
  ActeraDeferredError,
  createActeraAuthorization,
  createActeraMcpContinuation,
  interceptMcpClient,
  type CallToolInterceptor,
  type CallToolRequest,
} from '../src/mcp/index.js'

function decision(effect: NonNullable<Decision['effect']>): Decision {
  return decisionFixture({ id: `decision-${effect}`, effect, explanation: `because-${effect}` })
}

function client(result: unknown = { content: [{ type: 'text', text: 'ok' }] }) {
  return {
    marker: 'stripe',
    calls: [] as Array<{ request: CallToolRequest; options?: { timeout: number } }>,
    async callTool(request: CallToolRequest, options?: { timeout: number }) {
      this.calls.push({ request, ...(options ? { options } : {}) })
      return result
    },
    serverName() {
      return this.marker
    },
  }
}

describe('interceptMcpClient', () => {
  it('runs an ordered Koa-style chain and preserves the client API and call options', async () => {
    const raw = client()
    const order: string[] = []
    const first: CallToolInterceptor = async (request, next) => {
      order.push('first:before')
      const result = await next({ ...request, arguments: { ...request.arguments, first: true } })
      order.push('first:after')
      return result
    }
    const second: CallToolInterceptor = async (request, next) => {
      order.push('second')
      return next({ ...request, arguments: { ...request.arguments, second: true } })
    }
    const wrapped = interceptMcpClient(raw, [first, second])

    await expect(
      wrapped.callTool({ name: 'stripe_api_write', arguments: { amount: 80 } }, { timeout: 5000 }),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(raw.calls).toEqual([
      {
        request: { name: 'stripe_api_write', arguments: { amount: 80, first: true, second: true } },
        options: { timeout: 5000 },
      },
    ])
    expect(order).toEqual(['first:before', 'second', 'first:after'])
    expect(wrapped.serverName()).toBe('stripe')
    expect(wrapped).not.toBe(raw)
  })

  it('rejects an interceptor that invokes next more than once', async () => {
    const duplicate: CallToolInterceptor = async (request, next) => {
      await next(request)
      return next(request)
    }
    await expect(interceptMcpClient(client(), [duplicate]).callTool({ name: 'tool' })).rejects.toThrow(
      'next() called more than once',
    )
  })
})

describe('createActeraAuthorization', () => {
  const invocation = {
    traceId: 'trace-1',
    toolCallId: 'call-2',
    sessionId: 'ticket-3',
    evaluationContext: {
      customer: { id: 'customer-4', fraud_flagged: false },
      resource: { untrusted: true },
      mcp: { source: 'support-demo', trace_id: 'cannot-override' },
    },
  }

  it('authorizes once, preserves opaque arguments, and calls the underlying MCP client on ALLOW', async () => {
    const authorizeAction = vi.fn(async () => decision('ALLOW'))
    const raw = client()
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: { authorizeAction },
        resolveInvocation: () => invocation,
      }),
    ])
    const request = { name: 'stripe_api_write', arguments: { operation: 'CreateRefund', amount: 8000 } }

    await wrapped.callTool(request)

    expect(authorizeAction).toHaveBeenCalledOnce()
    expect(authorizeAction).toHaveBeenCalledWith(
      {
        mode: 'ENFORCING',
        action: { type: 'stripe_api_write', attributes: request.arguments },
        context: {
          customer: { id: 'customer-4', fraud_flagged: false },
          resource: request.arguments,
          mcp: { source: 'support-demo', trace_id: 'trace-1', tool_call_id: 'call-2', session_id: 'ticket-3' },
        },
        idempotencyKey: 'trace-1:call-2',
      },
      expect.anything(),
    )
    expect(raw.calls).toHaveLength(1)
    expect(request).toEqual({ name: 'stripe_api_write', arguments: { operation: 'CreateRefund', amount: 8000 } })
  })

  for (const [effect, ErrorType] of [
    ['BLOCK', ActeraBlockedError],
    ['REQUIRE_APPROVAL', ActeraApprovalRequiredError],
  ] as const) {
    it(`stops the MCP call for ${effect}`, async () => {
      const raw = client()
      const recordDecisionReport = vi.fn()
      const wrapped = interceptMcpClient(raw, [
        createActeraAuthorization({
          client: { authorizeAction: async () => decision(effect), recordDecisionReport },
          resolveInvocation: () => invocation,
        }),
      ])

      const error = await wrapped.callTool({ name: 'stripe_api_write' }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ErrorType)
      expect(error).toMatchObject({ decision: { id: `decision-${effect}`, effect } })
      expect(String(error)).toContain(`decision-${effect}`)
      expect(raw.calls).toHaveLength(0)
      expect(recordDecisionReport).not.toHaveBeenCalled()
    })
  }

  it('fails closed with a distinct infrastructure error by default', async () => {
    const failure = new Error('runtime unavailable')
    const wrapped = interceptMcpClient(client(), [
      createActeraAuthorization({
        client: {
          authorizeAction: async () => {
            throw failure
          },
        },
        resolveInvocation: () => invocation,
      }),
    ])

    const error = await wrapped.callTool({ name: 'stripe_api_write' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ActeraAuthorizationError)
    expect(error).toMatchObject({ cause: failure })
  })

  it('fails closed when Actera returns a malformed effect', async () => {
    const raw = client()
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: { authorizeAction: async () => ({ id: 'decision-broken', effect: 'UNKNOWN' }) as unknown as Decision },
        resolveInvocation: () => invocation,
      }),
    ])

    await expect(wrapped.callTool({ name: 'stripe_api_write' })).rejects.toThrow('unsupported decision effect: UNKNOWN')
    expect(raw.calls).toHaveLength(0)
  })

  it('can explicitly allow a call only when Actera is classified as unavailable', async () => {
    const raw = client()
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: {
          authorizeAction: async () => {
            throw new ActeraUnavailableError(new Error('runtime unavailable'))
          },
        },
        resolveInvocation: () => invocation,
        behavior: { default: { mode: 'enforce', onUnavailable: 'allow' } },
        onEvent: () => {
          throw new Error('telemetry offline')
        },
      }),
    ])

    await expect(wrapped.callTool({ name: 'stripe_api_write' })).resolves.toBeDefined()
    expect(raw.calls).toHaveLength(1)
  })

  it('defers a call with a typed error when Actera is unavailable', async () => {
    const raw = client()
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: {
          authorizeAction: async () => {
            throw new ActeraUnavailableError(new Error('runtime unavailable'))
          },
        },
        resolveInvocation: () => invocation,
        behavior: { default: { mode: 'enforce', onUnavailable: 'defer' } },
      }),
    ])

    await expect(wrapped.callTool({ name: 'stripe_api_write' })).rejects.toBeInstanceOf(ActeraDeferredError)
    expect(raw.calls).toHaveLength(0)
  })

  it('observes policy without enforcing its effect and records the outcome', async () => {
    const raw = client()
    const recordDecisionReport = vi.fn(async () => ({
      id: 'report-1',
      workspace_id: 'workspace-1',
      agent_id: 'agent-1',
      decision_id: 'decision-1',
      idempotency_key: 'report',
      outcome: 'SUCCESS' as const,
      action: { type: 'stripe_api_write' },
      context: {},
      details: {},
      occurred_at: '2026-10-15T00:00:00Z',
      recorded_at: '2026-10-15T00:00:00Z',
    }))
    const onEvent = vi.fn()
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: {
          authorizeAction: async () =>
            decisionFixture({
              mode: 'MONITORING',
              status: 'MONITORED',
              effect: 'REQUIRE_APPROVAL',
              explanation: 'would need review',
            }),
          recordDecisionReport,
        },
        resolveInvocation: () => invocation,
        behavior: { default: { mode: 'monitor', onUnavailable: 'deny' } },
        onEvent,
      }),
    ])

    await expect(wrapped.callTool({ name: 'stripe_api_write', arguments: { amount: 80 } })).resolves.toBeDefined()
    await vi.waitFor(() => expect(recordDecisionReport).toHaveBeenCalledTimes(1))
    expect(raw.calls).toHaveLength(1)
    expect(recordDecisionReport).toHaveBeenCalledWith(
      containing({
        decisionId: 'decision-1',
        outcome: 'SUCCESS' as const,
      }),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: 'REQUIRE_APPROVAL',
        outcome: 'SUCCESS' as const,
      }),
    )
  })

  it('does not dispatch when an observation response is malformed', async () => {
    const raw = client()
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: {
          authorizeAction: async () =>
            decisionFixture({ mode: 'MONITORING', status: 'MONITORED', effect: 'UNSPECIFIED' }),
        },
        resolveInvocation: () => invocation,
        behavior: { default: { mode: 'monitor', onUnavailable: 'allow' } },
      }),
    ])

    await expect(wrapped.callTool({ name: 'stripe_api_write' })).rejects.toThrow('unsupported decision effect')
    expect(raw.calls).toHaveLength(0)
  })

  it('fails closed when trusted invocation identity is missing', async () => {
    const authorizeAction = vi.fn(async () => decision('ALLOW'))
    const wrapped = interceptMcpClient(client(), [
      createActeraAuthorization({
        client: { authorizeAction },
        resolveInvocation: () => undefined,
      }),
    ])

    await expect(wrapped.callTool({ name: 'stripe_api_write' })).rejects.toThrow('invocation context is unavailable')
    expect(authorizeAction).not.toHaveBeenCalled()
  })

  it('captures, claims, dispatches and reports an allowed managed call exactly once', async () => {
    const raw = client({ content: [{ type: 'text', text: 'refund re_123' }] })
    const intent = intentFixture({
      id: 'intent-1',
      decision_id: 'decision-1',
      execution_status: 'READY',
      expires_at: '2099-01-01T00:00:00Z',
      invocation_fingerprint: 'fingerprint-1',
      intended_call: {
        envelope_schema_version: 1,
        adapter_kind: 'mcp-typescript',
        adapter_version: '1',
        method: 'tools/call',
        host_id: 'demo-host',
        target_id: 'stripe-mcp',
        tool_name: 'stripe_api_write',
        arguments: { stripe_api_operation_id: 'CreateRefund', parameters: { amount: 8000 } },
      },
    })
    const authorizeAction = vi.fn(async (input: Parameters<BoundAgentClient['authorizeAction']>[0]) => ({
      ...decision('ALLOW'),
      action_intent: intent,
      captured: input,
    }))
    const claimActionExecution = vi.fn(async () => ({
      intent: { ...intent, execution_status: 'EXECUTING' },
      dispatchGranted: true,
      attemptId: 'attempt-1',
      downstreamIdempotencyKey: 'provider-key',
    }))
    const reportActionExecution = vi.fn(async (input: Parameters<BoundAgentClient['reportActionExecution']>[0]) => ({
      ...intent,
      execution_status: 'COMPLETED',
      result: input.result ?? {},
    }))
    const continuation = createActeraMcpContinuation({
      client: { getActionIntent: vi.fn(), claimActionExecution, reportActionExecution },
      hostId: 'demo-host',
      targetId: 'stripe-mcp',
      classifyOutcome: () => ({ outcome: 'SUCCESS' as const }),
      dispatch: (request) => raw.callTool(request),
    })
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({ client: { authorizeAction }, resolveInvocation: () => invocation, continuation }),
    ])
    const request = {
      name: 'stripe_api_write',
      arguments: { stripe_api_operation_id: 'CreateRefund', parameters: { amount: 8000 } },
    }

    await expect(wrapped.callTool(request)).resolves.toEqual({ content: [{ type: 'text', text: 'refund re_123' }] })
    expect(raw.calls).toHaveLength(1)
    expect(claimActionExecution).toHaveBeenCalledOnce()
    expect(reportActionExecution).toHaveBeenCalledWith(
      containing({ intentId: 'intent-1', attemptId: 'attempt-1', outcome: 'SUCCESS' as const }),
      expect.anything(),
    )
    expect(authorizeAction).toHaveBeenCalledWith(
      containing({
        intendedCall: containing({
          method: 'tools/call',
          host_id: 'demo-host',
          target_id: 'stripe-mcp',
          tool_name: request.name,
          arguments: request.arguments,
        }),
      }),
      expect.anything(),
    )
  })

  it('authorizes read calls without creating executable intents when the host classifies only writes as managed', async () => {
    const raw = client({ content: [{ type: 'text', text: 'read result' }] })
    const authorizeAction = vi.fn(async () => decision('ALLOW'))
    const claimActionExecution = vi.fn()
    const continuation = createActeraMcpContinuation({
      client: { getActionIntent: vi.fn(), claimActionExecution, reportActionExecution: vi.fn() },
      hostId: 'demo-host',
      targetId: 'stripe-mcp',
      classifyOutcome: () => ({ outcome: 'SUCCESS' as const }),
      dispatch: (request) => raw.callTool(request),
    })
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: { authorizeAction },
        resolveInvocation: () => invocation,
        continuation,
        manageExecution: (request) => request.name === 'stripe_api_write',
      }),
    ])

    await expect(wrapped.callTool({ name: 'stripe_api_read', arguments: { id: 'ch_123' } })).resolves.toEqual({
      content: [{ type: 'text', text: 'read result' }],
    })
    expect(raw.calls).toHaveLength(1)
    expect(claimActionExecution).not.toHaveBeenCalled()
    expect(authorizeAction).toHaveBeenCalledWith(notContaining({ intendedCall: anything() }), expect.anything())
  })

  it('returns a resumable handle and never dispatches while approval is pending', async () => {
    const raw = client()
    const handle = {
      intent_id: 'intent-approval',
      decision_id: 'decision-approval',
      operation_key: 'trace-1:call-2',
      status: 'CAPTURED',
    }
    const continuation = createActeraMcpContinuation({
      client: { getActionIntent: vi.fn(), claimActionExecution: vi.fn(), reportActionExecution: vi.fn() },
      hostId: 'demo-host',
      targetId: 'stripe-mcp',
      classifyOutcome: () => ({ outcome: 'SUCCESS' as const }),
      dispatch: (request) => raw.callTool(request),
    })
    const wrapped = interceptMcpClient(raw, [
      createActeraAuthorization({
        client: {
          authorizeAction: async () => ({ ...decision('REQUIRE_APPROVAL'), action_intent: intentFixture({ handle }) }),
        },
        resolveInvocation: () => invocation,
        continuation,
      }),
    ])

    const error = await wrapped
      .callTool({ name: 'stripe_api_write', arguments: { amount: 8000 } })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ActeraApprovalRequiredError)
    expect(error).toMatchObject({ handle })
    expect(raw.calls).toHaveLength(0)
  })
})

function containing(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value)
}
function notContaining(value: Record<string, unknown>): unknown {
  return expect.not.objectContaining(value)
}

function anything(): unknown {
  return expect.anything()
}

it.each(['monitor', 'enforce'] as const)('reports MCP error results as unknown in %s mode', async (mode) => {
  const result = { isError: true, content: [{ type: 'text', text: 'Tool failed' }] }
  const raw = client(result)
  const recordDecisionReport = vi.fn(async () => ({
    id: 'report',
    workspace_id: 'workspace',
    agent_id: 'agent',
    decision_id: 'decision',
    idempotency_key: 'key',
    outcome: 'UNKNOWN' as const,
    action: { type: 'generic_tool' },
    context: {},
    details: {},
    occurred_at: '2026-10-17T00:00:00Z',
    recorded_at: '2026-10-17T00:00:00Z',
  }))
  const wrapped = interceptMcpClient(raw, [
    createActeraAuthorization({
      client: { authorizeAction: async () => decision('ALLOW'), recordDecisionReport },
      resolveInvocation: () => ({ traceId: 'trace', toolCallId: 'call' }),
      behavior: { default: { mode, onUnavailable: 'deny' } },
    }),
  ])
  await expect(wrapped.callTool({ name: 'generic_tool' })).resolves.toEqual(result)
  expect(recordDecisionReport).toHaveBeenCalledWith(containing({ outcome: 'UNKNOWN' }))
  expect(recordDecisionReport).not.toHaveBeenCalledWith(containing({ outcome: 'SUCCESS' }))
})

it.each(['monitor', 'enforce'] as const)('reports a thrown tool call as unknown in %s mode', async (mode) => {
  const raw = {
    async callTool(request: CallToolRequest): Promise<{ content: unknown[] }> {
      throw new Error(`transport reset for ${request.name}`)
    },
  }
  const recordDecisionReport = vi.fn(async () => ({
    id: 'report',
    workspace_id: 'workspace',
    agent_id: 'agent',
    decision_id: 'decision',
    idempotency_key: 'key',
    outcome: 'UNKNOWN' as const,
    action: { type: 'generic_tool' },
    context: {},
    details: {},
    occurred_at: '2026-10-17T00:00:00Z',
    recorded_at: '2026-10-17T00:00:00Z',
  }))
  const wrapped = interceptMcpClient(raw, [
    createActeraAuthorization({
      client: { authorizeAction: async () => decision('ALLOW'), recordDecisionReport },
      resolveInvocation: () => ({ traceId: 'trace', toolCallId: 'call' }),
      behavior: { default: { mode, onUnavailable: 'deny' } },
    }),
  ])
  await expect(wrapped.callTool({ name: 'generic_tool' })).rejects.toThrow('transport reset')
  expect(recordDecisionReport).toHaveBeenCalledWith(containing({ outcome: 'UNKNOWN' }))
})

it('reads call options from any trailing argument, including after a result schema', async () => {
  const authorizeAction = vi.fn(async () => decision('ALLOW'))
  const raw = {
    calls: [] as unknown[][],
    async callTool(_request: CallToolRequest, ...rest: unknown[]): Promise<{ content: unknown[] }> {
      this.calls.push(rest)
      return { content: [] }
    },
  }
  const wrapped = interceptMcpClient(raw, [
    createActeraAuthorization({
      client: { authorizeAction },
      resolveInvocation: () => ({ traceId: 'trace', toolCallId: 'call' }),
    }),
  ])
  const controller = new AbortController()
  const schema = { parse: () => undefined }
  const options = { signal: controller.signal, timeout: 5000 }
  await wrapped.callTool({ name: 'generic_tool' }, schema, options)
  expect(authorizeAction).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal, timeoutMs: 5000 })
  expect(raw.calls).toEqual([[schema, options]])
})
