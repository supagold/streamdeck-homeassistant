// Timers that keep their promised precision when the plugin page is hidden.
//
// The Stream Deck app runs this plugin in a page that is never visible, and
// Chromium clamps setTimeout/setInterval in such pages to about once per second
// (measured in the plugin log: every "send" landed exactly 1 s after the last).
// That quietly turned a 100-300 ms batching window into 1 s. Timers inside a
// dedicated Web Worker are not clamped, so the delay is executed there and the
// callback is run back on the main thread when the worker reports in.
//
// Falls back to the page's own timers if workers are unavailable.

const WORKER_SOURCE = `
const pending = new Map()
onmessage = (e) => {
  const { type, id, ms } = e.data
  if (type === 'set') {
    pending.set(id, setTimeout(() => { pending.delete(id); postMessage(id) }, ms))
  } else if (type === 'clear') {
    clearTimeout(pending.get(id))
    pending.delete(id)
  }
}
`

export function createWorkerTimers(globals = globalThis) {
  const fallback = {
    setTimeout: (...args) => globals.setTimeout(...args),
    clearTimeout: (...args) => globals.clearTimeout(...args),
    kind: 'page'
  }
  try {
    if (typeof globals.Worker !== 'function' || typeof globals.Blob !== 'function') return fallback
    const url = globals.URL.createObjectURL(
      new globals.Blob([WORKER_SOURCE], { type: 'text/javascript' })
    )
    const worker = new globals.Worker(url)
    globals.URL.revokeObjectURL(url)

    const callbacks = new Map()
    let nextId = 1
    let broken = false
    worker.onmessage = (event) => {
      const callback = callbacks.get(event.data)
      if (callback) {
        callbacks.delete(event.data)
        callback()
      }
    }
    worker.onerror = () => {
      broken = true
    }

    return {
      kind: 'worker',
      setTimeout(callback, ms = 0) {
        if (broken) return fallback.setTimeout(callback, ms)
        const id = nextId++
        callbacks.set(id, callback)
        worker.postMessage({ type: 'set', id, ms })
        return id
      },
      clearTimeout(id) {
        if (callbacks.delete(id)) worker.postMessage({ type: 'clear', id })
        else fallback.clearTimeout(id)
      }
    }
  } catch {
    return fallback
  }
}
