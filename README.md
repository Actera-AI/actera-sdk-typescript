# Actera TypeScript SDK

Authorize actions and manage their execution through the Actera HTTPS API.
The SDK includes browser-compatible clients, execution coordination, and MCP
adapters. It has no runtime dependencies.

Copyright 2026 Actera. Licensed under [Apache-2.0](LICENSE). The Actera service
requires a separate account and machine key.

## Status

This is an alpha release. The SDK is usable, tested, and versioned, but its
public API can still change between minor versions before 1.0. Breaking changes
are listed in [CHANGELOG.md](CHANGELOG.md). Pin an exact version.

## Installation

Requires Node.js 22 or later for development and server-side use.

```sh
npm install --save-exact @actera-ai/sdk
```

Versions published from CI carry npm provenance, which links each version to
the commit and workflow run that built it. The same archive and its
`SHA256SUMS` are attached to each
[GitHub release](https://github.com/Actera-AI/actera-sdk-typescript/releases)
for installing without the registry.

Browser applications must obtain short-lived credentials through their host
application. Never bundle a machine API key into browser code.

## Connect and monitor

Connect an agent in Actera and store its scoped machine key. Every attempted action
creates a decision through `POST /v1/decisions`. Set mode to `MONITORING` to record
policy results, or `ENFORCING` to apply them. The SDK defaults to enforcing. Agent
registration and policy configuration do not switch the caller's mode.

When no policy applies, Actera uses the agent's configured `ALLOW` or `BLOCK`
default. The integration decides whether to act on the decision.
Afterward, append an execution report using the decision ID, original
action, and a stable report idempotency key. Reports use the outcome values
`SUCCESS`, `FAILURE`, `CANCELLED`, or `UNKNOWN`. Reports are accepted even when
execution contradicts a block. They never grant authority or change accounting.
Missing execution reports mean the outcome is unknown. A successful report
converts an enforcing reservation into completed usage exactly once per decision,
including late or duplicate reports.

## Usage

This server-side example requests a decision. It does not dispatch the action.
Set `ACTERA_API_KEY` in your application's environment. The client connects to
the production API at `https://app.actera.dev` unless you pass `baseUrl`.

```ts
import { ActeraClient, fromApiKey } from '@actera-ai/sdk'

const client = new ActeraClient({
  credentials: fromApiKey(process.env.ACTERA_API_KEY!),
})
const agent = client.agent({ agentId: 'payments-agent' })
const decision = await agent.authorizeAction({
  action: { type: 'payment.create', attributes: { amount_minor: 2500 } },
  idempotencyKey: 'payment-order-123',
})

console.log(decision.status)
```

Reuse an idempotency key for retries of the same logical action. Credentials
determine the workspace and allowed agents; callers cannot choose a workspace.
For rotating tokens, supply a `CredentialProvider` instead of `fromApiKey`.
Requests accept cancellation signals and timeouts. HTTPS is required except on
loopback, and redirects are rejected.

For agent integrations, a workspace administrator issues one agent-bound
machine key with explicit operation scopes. Use it directly with this client.
`agent.getReadiness()` and `agent.getDecisionStatus(id)` return narrow
projections for that agent. Reviewer linking uses
`agent.startReviewerLink()`; its token belongs in a separate
client for `getReviewerLinkStatus()`. The reviewer token can approve or reject
only eligible Decisions in its bound workspace and agent.

| Import                     | Provides                                          |
| -------------------------- | ------------------------------------------------- |
| `@actera-ai/sdk`           | Decisions, host reports, and action intents       |
| `@actera-ai/sdk/execution` | Managed execution with a host-supplied dispatcher |
| `@actera-ai/sdk/mcp`       | MCP interception and approval continuation        |
| `@actera-ai/sdk/mcp/node`  | Node.js MCP transport helpers                     |

Managed execution requires a successful claim before dispatch. The host owns
durable state, scheduling, provider reconciliation, and outcome classification.
Apply the supplied idempotency key through the provider's supported interface.
A lost claim response is not permission to execute. On `ExecutionReportError`,
persist its `report` and retry reporting without repeating the external action.

Every error the SDK raises extends `ActeraError` and carries a stable `name`.
Transport failures are `ActeraUnavailableError`, non-2xx responses are
`ActeraHttpError`, and contract violations during managed execution are
`ExecutionContractError`.

## MCP

Wrap an MCP client so every `callTool` is authorized first. Invocation identity
comes from your host; on Node.js, `createInvocationContext()` provides an
`AsyncLocalStorage` for it.

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ActeraClient, fromApiKey } from '@actera-ai/sdk'
import { createActeraAuthorization, interceptMcpClient } from '@actera-ai/sdk/mcp'
import { createInvocationContext } from '@actera-ai/sdk/mcp/node'

const invocation = createInvocationContext()
const agent = new ActeraClient({
  credentials: fromApiKey(process.env.ACTERA_API_KEY!),
}).agent({ agentId: 'support-agent' })

const mcp = interceptMcpClient(new Client({ name: 'support', version: '1.0.0' }), [
  createActeraAuthorization({
    client: agent,
    resolveInvocation: () => invocation.getStore(),
    behavior: { default: { mode: 'enforce', onUnavailable: 'deny' } },
  }),
])

await invocation.run({ traceId: 'trace-1', toolCallId: 'call-1' }, () =>
  mcp.callTool({ name: 'ticket_close', arguments: { id: 't-1' } }),
)
```

Each call creates a decision whose `action.type` is the tool name and whose
`action.attributes` are the tool arguments. Policies also see
`context.resource` (the arguments), `context.mcp` with `trace_id`,
`tool_call_id`, and `session_id` (or `operation_key` when one is supplied), and
anything passed as `evaluationContext`. A `BLOCK` decision throws
`ActeraBlockedError`; `REQUIRE_APPROVAL` throws `ActeraApprovalRequiredError`,
whose `handle` can later be resumed with a continuation's `resumeToolCall()`.
After an allowed call, the SDK records `SUCCESS`, or `UNKNOWN` when the tool
returned `isError` or threw, since neither proves the tool had no effect.
Call options passed after the request, such as the MCP client's `signal` and
`timeout`, bound the Actera request as well.

MCP adapters require explicit `mode`, `onUnavailable`, and `classifyOutcome`
choices. Only connectivity failures and HTTP 502/503/504 use the configured
unavailability behavior. Authentication errors and malformed responses never
silently permit execution. With a continuation configured, managed calls are
dispatched through its `dispatch` function rather than the remaining interceptor
chain, so interceptors placed after Actera do not see them. See the
[execution tests](test/execution.test.ts) and [MCP tests](test/mcp.test.ts) for
complete lifecycle examples.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm generate:api
git diff --exit-code
```

CI tests Node.js 22 and 24, browser and Node types, and installation of the
packed archive in an isolated consumer. Tests use synthetic fixtures and need
no backend credentials. Wire types are generated from the API contract pinned in
[contract/manifest.json](contract/manifest.json). See
[CONTRIBUTING.md](CONTRIBUTING.md) for contract updates and the
[code of conduct](CODE_OF_CONDUCT.md) for participation expectations.

## Releases

CI cancels superseded runs and skips the test matrix only for explicitly
informational documentation changes. Distribution and secret checks still run.
Main-branch selection includes changes since the last successful CI run, so a
documentation push cannot hide cancelled code checks. **Run workflow** on `ci`
forces all checks; `ci-result` is the aggregate check for branch protection.

Releases reuse successful full CI for the exact tagged commit on `main`, including
the `release-ready` check. They do not repeat the test suite. A tag pushed while CI
is running is picked up when CI succeeds. A failed, cancelled or documentation-only
run cannot authorize a release. Prefer tagging the current main commit after CI
passes; to release a documentation-only commit, run `ci` manually on main first.
The release workflow can also be retried manually with an existing version tag.

Update `package.json` and [CHANGELOG.md](CHANGELOG.md), then tag the reviewed
commit `v<version>`. CI validates the source and packed package, publishes that
archive to npm as `@actera-ai/sdk` through trusted publishing, and attaches the same
archive with its checksums to a GitHub release. No npm token is stored. A version
already on npm is skipped, so a failed release can be retried. SDK versions are
independent of backend and contract versions.

npm accepts trusted publishing only for a package that already exists, so the
first version is published by a maintainer. After the first release succeeds,
download its archive, check it against `SHA256SUMS`, and publish that file:

```sh
gh release download v0.0.2 --repo Actera-AI/actera-sdk-typescript
sha256sum --check SHA256SUMS
npm publish ./actera-ai-sdk-0.0.2.tgz --access public
```

Then, in the package settings on npmjs.com, add a trusted publisher for GitHub
Actions with organization `Actera-AI`, repository `actera-sdk-typescript` and
workflow `release.yml`, and set publishing access to require two-factor
authentication and disallow tokens. Later releases publish from CI.

## Security

Report vulnerabilities privately to [hello@actera.dev](mailto:hello@actera.dev).
See [SECURITY.md](SECURITY.md) for what to include.
