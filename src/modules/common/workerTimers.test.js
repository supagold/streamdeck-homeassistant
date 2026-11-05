import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkerTimers } from './workerTimers.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// A minimal in-memory Worker: runs the worker's own setTimeout logic via fake timers.
function fakeGlobals() {
  const posted = []
  class FakeWorker {
    constructor() {
      FakeWorker.instance = this
    }
    postMessage(message) {
      posted.push(message)
      if (message.type === 'set') {
        this.handle = setTimeout(() => this.onmessage({ data: message.id }), message.ms)
      } else if (message.type === 'clear') {
        clearTimeout(this.handle)
      }
    }
  }
  return {
    posted,
    FakeWorker,
    globals: {
      Worker: FakeWorker,
      Blob: class {},
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
      setTimeout: (...a) => setTimeout(...a),
      clearTimeout: (...a) => clearTimeout(...a)
    }
  }
}

describe('createWorkerTimers', () => {
  it('falls back to the page timers when Worker is unavailable', () => {
    const timers = createWorkerTimers({
      setTimeout: (...a) => setTimeout(...a),
      clearTimeout: (...a) => clearTimeout(...a)
    })
    expect(timers.kind).toBe('page')
    const spy = vi.fn()
    timers.setTimeout(spy, 50)
    vi.advanceTimersByTime(50)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('runs the delay in the worker and calls back on the main thread', () => {
    const { globals, posted } = fakeGlobals()
    const timers = createWorkerTimers(globals)
    expect(timers.kind).toBe('worker')
    const spy = vi.fn()
    timers.setTimeout(spy, 100)
    expect(posted[0]).toMatchObject({ type: 'set', ms: 100 })
    vi.advanceTimersByTime(99)
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('clearTimeout cancels a pending timer and never fires it', () => {
    const { globals, posted } = fakeGlobals()
    const timers = createWorkerTimers(globals)
    const spy = vi.fn()
    const id = timers.setTimeout(spy, 100)
    timers.clearTimeout(id)
    expect(posted.at(-1)).toMatchObject({ type: 'clear' })
    vi.advanceTimersByTime(500)
    expect(spy).not.toHaveBeenCalled()
  })

  it('gives independent ids and fires each callback once', () => {
    const { globals } = fakeGlobals()
    const timers = createWorkerTimers(globals)
    const a = vi.fn()
    const b = vi.fn()
    const ida = timers.setTimeout(a, 10)
    const idb = timers.setTimeout(b, 20)
    expect(ida).not.toBe(idb)
    vi.advanceTimersByTime(30)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('falls back when constructing the worker throws', () => {
    const { globals } = fakeGlobals()
    globals.Worker = class {
      constructor() {
        throw new Error('blocked')
      }
    }
    expect(createWorkerTimers(globals).kind).toBe('page')
  })
})
