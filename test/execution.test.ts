import { describe, it, expect, vi } from 'vitest'
import {
  ActeraExecution,
  ExecutionClaimError,
  ExecutionContractError,
  ExecutionReportError,
  type ExecutionBinding,
} from '../src/execution.js'
import {
  ActeraAuthorizationError,
  ActeraBlockedError,
  createActeraAuthorization,
  createActeraMcpContinuation,
} from '../src/mcp/index.js'
import {
  ActeraError,
  ActeraHttpError,
  ActeraUnavailableError,
  type ActionIntent,
  type ReportExecutionInput,
} from '../src/index.js'
import { intentFixture, decisionFixture } from './fixtures.js'

const binding: ExecutionBinding = {
  hostId: 'host',
  targetId: 'provider',
  targetAccountId: 'account-A',
  credentialReference: 'cred-A',
  adapterKind: 'mcp-typescript',
  adapterVersion: '1',
  method: 'tools/call',
}
function fixture(value: unknown = { receipt: 'r1' }) {
  let current = intentFixture({
    id: 'i1',
    invocation_fingerprint: 'fp',
    execution_status: 'READY',
    expires_at: '2099-01-01T00:00:00Z',
    intended_call: {
      envelope_schema_version: 1,
      method: 'tools/call',
      adapter_kind: 'mcp-typescript',
      adapter_version: '1',
      host_id: 'host',
      target_id: 'provider',
      target_account_id: 'account-A',
      credential_reference: 'cred-A',
      tool_name: 'refund',
      arguments: { amount: 25 },
    },
  })
  const client = {
    getActionIntent: vi.fn(async () => structuredClone(current)),
    claimActionExecution: vi.fn(async () => {
      const granted = current.execution_status === 'READY'
      current = { ...current, execution_status: 'EXECUTING' }
      return {
        intent: structuredClone(current),
        dispatchGranted: granted,
        attemptId: 'a1',
        downstreamIdempotencyKey: 'provider-key',
      }
    }),
    reportActionExecution: vi.fn(async (report: ReportExecutionInput) => {
      current = {
        ...current,
        execution_status:
          report.outcome === 'SUCCESS' ? 'COMPLETED' : report.outcome === 'FAILURE' ? 'FAILED' : 'UNKNOWN',
        result: report.result ?? {},
      }
      return structuredClone(current)
    }),
  }
  const dispatch = vi.fn(async () => value)
  const config = { client, binding, dispatch, classifyOutcome: () => ({ outcome: 'SUCCESS' as const }) }
  return {
    client,
    dispatch,
    config,
    execution: new ActeraExecution(config),
    set: (intent: ActionIntent) => {
      current = intent
    },
    get: () => current,
  }
}

describe('customer-owned execution recovery', () => {
  it('fails closed when a managed ALLOW omits its intent', async () => {
    const f = fixture()
    const continuation = createActeraMcpContinuation({
      ...binding,
      client: f.client,
      dispatch: f.dispatch,
      classifyOutcome: f.config.classifyOutcome,
    })
    const next = vi.fn()
    const middleware = createActeraAuthorization({
      continuation,
      client: { authorizeAction: async () => decisionFixture() },
      resolveInvocation: () => ({ agentId: 'agent', traceId: 't', toolCallId: 'c' }),
    })
    await expect(middleware({ name: 'refund' }, next)).rejects.toThrow('no executable intent')
    expect(next).not.toHaveBeenCalled()
    expect(f.client.claimActionExecution).not.toHaveBeenCalled()
  })

  it.each(['targetId', 'targetAccountId', 'credentialReference', 'hostId', 'adapterVersion', 'method'] as const)(
    'rejects changed %s before claiming',
    async (field) => {
      const f = fixture()
      const execution = new ActeraExecution({ ...f.config, resolveBinding: () => ({ ...binding, [field]: 'changed' }) })
      await expect(execution.resume('i1')).rejects.toBeInstanceOf(ExecutionContractError)
      expect(f.client.claimActionExecution).not.toHaveBeenCalled()
      expect(f.dispatch).not.toHaveBeenCalled()
    },
  )

  it('passes provider key and attempt to the dispatcher and never redispatches completed work', async () => {
    const f = fixture()
    const first = await f.execution.resume('i1', { claimRequestId: 'stable-claim' })
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { amount: 25 } }),
      expect.objectContaining({ intentId: 'i1', attemptId: 'a1', downstreamIdempotencyKey: 'provider-key' }),
    )
    const resumed = await new ActeraExecution(f.config).resume('i1')
    expect(resumed).toEqual(first)
    expect(f.dispatch).toHaveBeenCalledOnce()
  })

  it.each([null, 'text', 42, [1, 2], undefined, { nested: true }])(
    'preserves result shape through persisted replay: %j',
    async (value) => {
      const f = fixture(value)
      // Explicit undefined must not trigger the fixture's default argument.
      f.dispatch.mockResolvedValue(value)
      const first = await f.execution.resume('i1')
      const second = await new ActeraExecution(f.config).resume('i1')
      expect(first).toMatchObject({ status: 'COMPLETED', result: value })
      expect(second).toEqual(first)
    },
  )

  it('makes a failed report persistable and recoverable without another provider call', async () => {
    const f = fixture()
    f.client.reportActionExecution.mockRejectedValueOnce(new Error('network unavailable'))
    const error = await f.execution.resume('i1', { reportKey: 'stable-report' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExecutionReportError)
    const persisted = JSON.stringify((error as ExecutionReportError).report)
    // Customer restart/outbox: only the report is replayed.
    await f.client.reportActionExecution(JSON.parse(persisted) as ReportExecutionInput)
    const observed = await new ActeraExecution(f.config).resume('i1')
    expect(observed).toMatchObject({ status: 'COMPLETED', result: { receipt: 'r1' } })
    expect(f.dispatch).toHaveBeenCalledOnce()
    expect((error as ExecutionReportError).report.reportKey).toBe('stable-report')
  })

  it('treats a lost claim response as uncertain and does not obtain a second dispatch permit', async () => {
    const f = fixture()
    f.client.claimActionExecution.mockImplementationOnce(async () => {
      f.set({ ...f.get(), execution_status: 'EXECUTING' })
      throw new Error('response lost')
    })
    await expect(f.execution.resume('i1', { claimRequestId: 'c1' })).rejects.toMatchObject({
      intentId: 'i1',
      claimRequestId: 'c1',
    })
    const error = new ExecutionClaimError('i1', 'c1', new Error('lost'))
    expect(error.claimRequestId).toBe('c1')
    expect(await new ActeraExecution(f.config).resume('i1')).toMatchObject({ status: 'EXECUTING' })
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('retains UNKNOWN for provider exceptions and pending domain outcomes', async () => {
    const f = fixture()
    f.dispatch.mockRejectedValueOnce(new Error('provider timeout'))
    expect(await f.execution.resume('i1')).toMatchObject({ status: 'UNKNOWN' })
    expect(await f.execution.resume('i1')).toMatchObject({ status: 'UNKNOWN' })
    expect(f.dispatch).toHaveBeenCalledOnce()
    const pending = fixture({ status: 'pending' })
    const execution = new ActeraExecution({
      ...pending.config,
      classifyOutcome: () => ({ outcome: 'UNKNOWN', errorCode: 'PROVIDER_PENDING' }),
    })
    expect(await execution.resume('i1')).toMatchObject({ status: 'UNKNOWN' })
    expect(pending.client.reportActionExecution).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'UNKNOWN', errorCode: 'PROVIDER_PENDING' }),
      expect.anything(),
    )
  })

  it('does not claim or dispatch when already aborted or expired', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(f.execution.resume('i1', { signal: controller.signal })).rejects.toThrow()
    f.set({ ...f.get(), expires_at: '2000-01-01T00:00:00Z' })
    await expect(f.execution.resume('i1')).rejects.toThrow('expired')
    expect(f.client.claimActionExecution).not.toHaveBeenCalled()
  })

  it('reports CANCELLED without dispatching when aborted after the claim', async () => {
    const f = fixture()
    const controller = new AbortController()
    const claim = f.client.claimActionExecution.getMockImplementation()!
    f.client.claimActionExecution.mockImplementationOnce(async () => {
      controller.abort()
      return claim()
    })
    const result = await f.execution.resume('i1', { signal: controller.signal })
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.client.reportActionExecution).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'CANCELLED', errorCode: 'CANCELLED_BEFORE_DISPATCH' }),
      expect.anything(),
    )
    expect(result.status).toBe('UNKNOWN')
  })

  it('derives every SDK error from ActeraError with a stable name', () => {
    const errors = [
      new ActeraHttpError(500, ''),
      new ActeraUnavailableError(new Error('offline')),
      new ExecutionContractError('contract'),
      new ExecutionClaimError('i1', 'c1', new Error('lost')),
      new ExecutionReportError(
        { intentId: 'i1', attemptId: 'a1', reportKey: 'r1', outcome: 'UNKNOWN' },
        intentFixture(),
        new Error('lost'),
      ),
      new ActeraAuthorizationError('denied'),
      new ActeraBlockedError(decisionFixture()),
    ]
    for (const error of errors) {
      expect(error).toBeInstanceOf(ActeraError)
      expect(error.name).toBe(error.constructor.name)
    }
  })

  it('keeps authorization identity stable across trace changes with an explicit operation key', async () => {
    const f = fixture()
    const continuation = createActeraMcpContinuation({
      ...binding,
      client: f.client,
      dispatch: f.dispatch,
      classifyOutcome: f.config.classifyOutcome,
    })
    const base = { agentId: 'agent', operationKey: 'refund-order-1', traceId: 't1', toolCallId: 'c1' }
    expect(continuation.intendedCall({ name: 'refund' }, base)).toEqual(
      continuation.intendedCall({ name: 'refund' }, { ...base, traceId: 't2', toolCallId: 'c2' }),
    )
  })
})
