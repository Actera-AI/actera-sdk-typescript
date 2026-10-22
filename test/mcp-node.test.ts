import { describe, expect, it } from 'vitest'
import { createInvocationContext } from '../src/mcp/node.js'

describe('createInvocationContext', () => {
  it('isolates concurrent invocation identity with AsyncLocalStorage', async () => {
    const context = createInvocationContext()
    const read = (traceId: string) =>
      context.run(
        {
          traceId,
          toolCallId: `call-${traceId}`,
        },
        async () => {
          await Promise.resolve()
          return context.getStore()?.traceId
        },
      )

    await expect(Promise.all([read('one'), read('two')])).resolves.toEqual(['one', 'two'])
    expect(context.getStore()).toBeUndefined()
  })
})
