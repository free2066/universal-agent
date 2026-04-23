import { logError } from '../utils/log.js'

type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      // Isolate onChange and each listener so a throwing callback doesn't
      // prevent the remaining listeners from being notified (which would
      // leave React components with stale state).
      try {
        onChange?.({ newState: next, oldState: prev })
      } catch (e: unknown) {
        logError(e instanceof Error ? e : new Error(`[store] onChange threw: ${e}`))
      }
      for (const listener of listeners) {
        try {
          listener()
        } catch (e: unknown) {
          logError(e instanceof Error ? e : new Error(`[store] listener threw: ${e}`))
        }
      }
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
