import { decisionFixture } from './fixtures.js'
import { describe, expect, it, vi } from 'vitest'
import { ActeraClient, ActeraHttpError, ActeraUnavailableError, fromApiKey, type Effect } from '../src/index.js'

const apiKey = 'actera_' + 'x'.repeat(40)

describe('ActeraClient', () => {
  it('uses agent-bound routes and rejects mismatched agent projections', async () => {
    const requests: Request[] = []
    const client = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: fromApiKey(apiKey),
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (request.url.endsWith('/readiness'))
          return Response.json({ agent_id: 'agent', status: 'ACTIVE', ready: true })
        if (request.url.endsWith('/status'))
          return Response.json({ id: 'decision', agent_id: 'other-agent', status: 'APPROVED' })
        return Response.json({
          approval_token: 'actera_reviewer_' + 'y'.repeat(43),
          browser_url: 'https://actera.example/auth/reviewer-link?code=x',
          workspace_id: 'workspace',
        })
      },
    })
    const agent = client.agent({ agentId: 'agent' })
    expect((await agent.getReadiness()).ready).toBe(true)
    await expect(agent.getDecisionStatus('decision')).rejects.toThrow('another Decision or agent')
    await agent.startReviewerLink()
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1/agents/agent/readiness',
      '/v1/decisions/decision/status',
      '/v1/reviewer-links',
    ])
    expect(await requests[2]!.json()).toEqual({})
  })

  it('uses refreshable credentials and never sends a caller-selected workspace', async () => {
    let request: Request | undefined
    const getToken = vi.fn(async () => ({ token: apiKey, expiresAt: Date.now() + 60_000 }))
    const client = new ActeraClient({
      baseUrl: 'https://actera.example/',
      credentials: { getToken },
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json(
          decisionFixture({ agent_id: 'refund-agent', action_type: 'stripe.refund', idempotency_key: 'attempt-1' }),
        )
      },
    })
    const agent = client.agent({ agentId: 'refund-agent' })
    await agent.authorizeAction({
      action: { type: 'stripe.refund', attributes: { amount_minor: 8000 } },
      idempotencyKey: 'attempt-1',
    })
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ audience: 'https://actera.example' }))
    expect(request?.headers.get('authorization')).toBe(`Bearer ${apiKey}`)
    expect(request?.headers.has('actera-workspace-id')).toBe(false)
    expect(await request?.json()).toMatchObject({ agent: { id: 'refund-agent' }, idempotency_key: 'attempt-1' })
  })

  it('keeps agent identity out of individual authorization inputs and maps bound context', async () => {
    let body: unknown
    const client = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: fromApiKey(apiKey),
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as unknown
        return Response.json(
          decisionFixture({ agent_id: 'support-agent', action_type: 'ticket.close', idempotency_key: 'op-1' }),
        )
      },
    })
    const agent = client.agent({ agentId: 'support-agent' }).withContext({
      initiator: { id: 'user-1', issuer: 'https://issuer.example' },
      business: { accountId: 'account-1' },
    })
    await agent.authorizeAction({
      action: { type: 'ticket.close' },
      context: { ticket: { id: 't-1' } },
      idempotencyKey: 'op-1',
    })
    expect(body).toEqual({
      mode: 'ENFORCING',
      agent: { id: 'support-agent' },
      action: { type: 'ticket.close' },
      idempotency_key: 'op-1',
      context: {
        ticket: { id: 't-1' },
        initiator: { id: 'user-1', issuer: 'https://issuer.example' },
        business: { accountId: 'account-1' },
      },
    })
    await expect(
      agent.authorizeAction({ action: { type: 'ticket.close' }, context: { business: {} }, idempotencyKey: 'op-2' }),
    ).rejects.toThrow('bound with withContext')
  })

  for (const effect of ['ALLOW', 'REQUIRE_APPROVAL', 'BLOCK'] satisfies Effect[]) {
    it(`returns ${effect} without renaming it`, async () => {
      const payload = decisionFixture({ effect, agent_id: 'agent', idempotency_key: 'key' })
      const client = new ActeraClient({
        baseUrl: 'https://actera.example',
        credentials: fromApiKey(apiKey),
        fetch: async () => Response.json(payload),
      })
      await expect(
        client.agent({ agentId: 'agent' }).authorizeAction({ action: { type: 'tool' }, idempotencyKey: 'key' }),
      ).resolves.toEqual(payload)
    })
  }

  it('distinguishes authorization rejection from service unavailability', async () => {
    const rejected = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: fromApiKey(apiKey),
      fetch: async () => new Response('{"code":"PermissionDenied","message":"agent denied"}', { status: 403 }),
    }).agent({ agentId: 'agent' })
    await expect(rejected.authorizeAction({ action: { type: 'tool' }, idempotencyKey: 'key' })).rejects.toBeInstanceOf(
      ActeraHttpError,
    )
    const unavailable = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: fromApiKey(apiKey),
      fetch: async () => {
        throw new TypeError('offline')
      },
    }).agent({ agentId: 'agent' })
    await expect(
      unavailable.authorizeAction({ action: { type: 'tool' }, idempotencyKey: 'key' }),
    ).rejects.toBeInstanceOf(ActeraUnavailableError)
  })

  it('rejects malformed, mismatched, and oversized authorization responses', async () => {
    for (const payload of [
      {},
      decisionFixture({ agent_id: 'another-agent', idempotency_key: 'key' }),
      decisionFixture({ agent_id: 'agent', idempotency_key: 'another-key' }),
      decisionFixture({ agent_id: 'agent', idempotency_key: 'key', effect: 'UNSPECIFIED' }),
    ]) {
      const client = new ActeraClient({
        baseUrl: 'https://actera.example',
        credentials: fromApiKey(apiKey),
        fetch: async () => Response.json(payload),
      })
      await expect(
        client.agent({ agentId: 'agent' }).authorizeAction({ action: { type: 'tool' }, idempotencyKey: 'key' }),
      ).rejects.toThrow('invalid authorization decision')
    }
    const oversized = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: fromApiKey(apiKey),
      fetch: async () => new Response('{}', { headers: { 'content-length': String((8 << 20) + 1) } }),
    })
    await expect(
      oversized.agent({ agentId: 'agent' }).authorizeAction({ action: { type: 'tool' }, idempotencyKey: 'key' }),
    ).rejects.toThrow('size limit')
  })

  it('requires manual redirect handling for credential-bearing requests', async () => {
    let redirect: string | undefined
    const client = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: fromApiKey(apiKey),
      fetch: async (_input, init) => {
        redirect = init?.redirect
        return new Response(null, { status: 307, headers: { location: 'https://another.example/collect' } })
      },
    })
    await expect(
      client.agent({ agentId: 'agent' }).authorizeAction({ action: { type: 'tool' }, idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ status: 307 })
    expect(redirect).toBe('manual')
  })

  it('collects only intents belonging to the bound agent', async () => {
    const client = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: fromApiKey(apiKey),
      fetch: async () =>
        Response.json({
          intents: [
            { id: 'one', agent_id: 'agent-a' },
            { id: 'two', agent_id: 'agent-b' },
          ],
          next_page_token: '',
        }),
    })
    await expect(client.agent({ agentId: 'agent-a' }).listActionIntents()).resolves.toEqual([
      { id: 'one', agent_id: 'agent-a' },
    ])
  })

  it('rejects reserved identity headers and expired provider credentials', async () => {
    expect(
      () =>
        new ActeraClient({
          baseUrl: 'https://actera.example',
          credentials: fromApiKey(apiKey),
          headers: { 'Actera-Workspace-Id': 'workspace' },
        }),
    ).toThrow('managed by ActeraClient credentials')
    const client = new ActeraClient({
      baseUrl: 'https://actera.example',
      credentials: { getToken: () => ({ token: apiKey, expiresAt: Date.now() - 1 }) },
      fetch: async () => Response.json({}),
    })
    await expect(
      client.agent({ agentId: 'agent' }).authorizeAction({ action: { type: 'tool' }, idempotencyKey: 'key' }),
    ).rejects.toThrow('expired token')
    expect(() => new ActeraClient({ baseUrl: 'http://public.example', credentials: fromApiKey(apiKey) })).toThrow(
      'requires HTTPS',
    )
  })
})

it('records observation with the bound identity and rejects a mismatched receipt', async () => {
  let wrong = false
  const client = new ActeraClient({
    baseUrl: 'https://actera.example',
    credentials: fromApiKey(apiKey),
    fetch: async (url, init) => {
      expect(String(url)).toBe('https://actera.example/v1/decisions/decision-1/reports')
      const body = JSON.parse(String(init?.body)) as {
        agent: { id: string }
        idempotency_key: string
        outcome: string
      }
      expect(body.agent.id).toBe('observer')
      expect(body.outcome).toBe('SUCCESS')
      return Response.json(
        { id: 'event', agent_id: wrong ? 'other' : 'observer', idempotency_key: body.idempotency_key },
        { status: 201 },
      )
    },
  })
  const agent = client.agent({ agentId: 'observer' })
  const input = {
    idempotencyKey: 'stable-retry-key',
    decisionId: 'decision-1',
    outcome: 'SUCCESS' as const,
    action: { type: 'tool.read' },
  }
  expect((await agent.recordDecisionReport(input)).id).toBe('event')
  wrong = true
  await expect(agent.recordDecisionReport(input)).rejects.toThrow('another agent or request')
})

it('rejects malformed report outcomes before sending a request', async () => {
  const client = new ActeraClient({
    baseUrl: 'https://actera.example',
    credentials: fromApiKey(apiKey),
    fetch: async () => {
      throw new Error('must not send')
    },
  })
  const agent = client.agent({ agentId: 'observer' })
  for (const pair of [{}, { outcome: 'COMPLETED' }]) {
    const input = { decisionId: 'decision', idempotencyKey: 'key', action: { type: 'tool' }, ...pair }
    // Exercise JavaScript callers that cannot rely on compile-time union checks.
    await expect(agent.recordDecisionReport(input as Parameters<typeof agent.recordDecisionReport>[0])).rejects.toThrow(
      'A valid execution outcome',
    )
  }
})
