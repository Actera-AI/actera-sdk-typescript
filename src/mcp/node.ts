import { AsyncLocalStorage } from 'node:async_hooks'
import type { ActeraInvocation } from './index.js'

export function createInvocationContext<
  TInvocation extends ActeraInvocation = ActeraInvocation,
>(): AsyncLocalStorage<TInvocation> {
  return new AsyncLocalStorage<TInvocation>()
}
