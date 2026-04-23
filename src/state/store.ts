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
        const message = e instanceof Error ? e.message : String(e)
        console.error(`[store] onChange threw: ${message}`)
      }
      for (const listener of listeners) {
        try {
          listener()
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          console.error(`[store] listener threw: ${message}`)
        }
      }
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
