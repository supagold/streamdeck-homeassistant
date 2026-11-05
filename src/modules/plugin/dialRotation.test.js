import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DialRotation, DIAL_DEFAULTS } from './dialRotation.js'

const CTX = 'ctx1'

function harness({ settings = {}, initialPercent = 40, send, readback } = {}) {
  const log = []
  const state = { real: initialPercent }
  const deps = {
    getSettings: () => settings,
    getInitialPercent: () => state.real,
    send: send ?? vi.fn(async (_c, vars) => (log.push(['send', vars]), true)),
    render: vi.fn(async (_c, pct) => void log.push(['render', pct])),
    readback: readback ?? vi.fn(async () => state.real),
    settle: vi.fn(() => log.push(['settle']))
  }
  const dial = new DialRotation(deps)
  return { dial, deps, log, state }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('optimistic display', () => {
  it('renders the new position immediately, before anything is sent', async () => {
    const { dial, deps } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.render).toHaveBeenCalledWith(CTX, 45)
    expect(deps.send).not.toHaveBeenCalled()
    expect(dial.isPending(CTX)).toBe(true)
  })

  it('sends one call per batching window with the summed ticks', async () => {
    const { dial, deps } = harness({
      settings: { rotationTickMultiplier: 5, rotationTickBucketSizeMs: 100 }
    })
    dial.rotate(CTX, 1)
    dial.rotate(CTX, 1)
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(deps.send).toHaveBeenCalledWith(CTX, {
      ticks: 15,
      rotationPercent: 55,
      rotationAbsolute: 2.55 * 55
    })
  })

  it('a bucket size of 0 sends on every tick (not treated as the default)', async () => {
    const { dial, deps } = harness({ settings: { rotationTickBucketSizeMs: 0 } })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(0)
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.send).toHaveBeenCalledTimes(2)
  })

  it('clamps at 0 and 100', async () => {
    const { dial, deps } = harness({ initialPercent: 98, settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 3)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.render).toHaveBeenLastCalledWith(CTX, 100)
    dial.rotate(CTX, -100)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.render).toHaveBeenLastCalledWith(CTX, 0)
  })

  it('coalesces renders while one is still in flight and ends on the newest value', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const { dial, deps } = harness({ settings: { rotationTickMultiplier: 5 } })
    deps.render.mockImplementationOnce(() => gate)
    dial.rotate(CTX, 1)
    dial.rotate(CTX, 1)
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.render).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.render).toHaveBeenCalledTimes(2)
    expect(deps.render).toHaveBeenLastCalledWith(CTX, 55)
  })

  it('does nothing optimistic when optimisticDisplay is off, but still sends', async () => {
    const { dial, deps } = harness({ settings: { optimisticDisplay: false } })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(DIAL_DEFAULTS.bucketMs)
    expect(deps.render).not.toHaveBeenCalled()
    expect(dial.isPending(CTX)).toBe(false)
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it('does nothing optimistic for entities with unknown position, and counts up from 0 like before', async () => {
    const { dial, deps } = harness({
      initialPercent: null,
      settings: { rotationTickMultiplier: 5 }
    })
    dial.rotate(CTX, 2)
    await vi.advanceTimersByTimeAsync(DIAL_DEFAULTS.bucketMs)
    expect(deps.render).not.toHaveBeenCalled()
    expect(deps.send).toHaveBeenCalledWith(CTX, {
      ticks: 10,
      rotationPercent: 10,
      rotationAbsolute: 25.5
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.readback).not.toHaveBeenCalled()
  })

  it('ignores a dial with no settings', async () => {
    const { dial, deps } = harness()
    deps.getSettings = () => undefined
    const d2 = new DialRotation({ ...deps, getSettings: () => undefined })
    d2.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(deps.send).not.toHaveBeenCalled()
    expect(dial.isPending(CTX)).toBe(false)
  })
})

describe('read-back', () => {
  it('reads back after the delay and settles on a match', async () => {
    const { dial, deps, state, log } = harness({
      settings: { rotationTickMultiplier: 5, readbackDelayMs: 800 }
    })
    dial.rotate(CTX, 1)
    state.real = 45 // Home Assistant ended up where we asked
    await vi.advanceTimersByTimeAsync(100) // send
    await vi.advanceTimersByTimeAsync(799)
    expect(deps.readback).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.readback).toHaveBeenCalledTimes(1)
    expect(deps.settle).toHaveBeenCalledTimes(1)
    expect(dial.isPending(CTX)).toBe(false)
    expect(log.map((x) => x[0])).toEqual(['render', 'send', 'settle'])
  })

  it('retries while the real value is still catching up, then settles', async () => {
    const { dial, deps, state } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 4) // target 60
    state.real = 40
    await vi.advanceTimersByTimeAsync(100 + 800)
    expect(deps.readback).toHaveBeenCalledTimes(1)
    expect(dial.isPending(CTX)).toBe(true)
    state.real = 59
    await vi.advanceTimersByTimeAsync(DIAL_DEFAULTS.readbackRetryMs)
    expect(deps.readback).toHaveBeenCalledTimes(2)
    expect(deps.settle).toHaveBeenCalledTimes(1)
    expect(dial.isPending(CTX)).toBe(false)
  })

  it('gives up after maxReadbacks and accepts what Home Assistant reports', async () => {
    const { dial, deps, state } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 4)
    state.real = 10 // never reaches target
    await vi.advanceTimersByTimeAsync(100 + 800 + DIAL_DEFAULTS.readbackRetryMs * 10)
    expect(deps.readback).toHaveBeenCalledTimes(DIAL_DEFAULTS.maxReadbacks)
    expect(deps.settle).toHaveBeenCalledTimes(1)
    expect(dial.isPending(CTX)).toBe(false)
    // and the dial's position now follows reality
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.render).toHaveBeenLastCalledWith(CTX, 15)
  })

  it('a failed send reads back immediately instead of waiting', async () => {
    const send = vi.fn(async () => false)
    const { dial, deps, state } = harness({ send, settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 1)
    state.real = 40 // the change never happened
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(1) // fake clock bumps a 0 ms timer scheduled mid-tick to 1 ms
    expect(deps.readback).toHaveBeenCalledTimes(1)
  })

  it('a rejected send is treated like a failure, not an unhandled error', async () => {
    const send = vi.fn(async () => {
      throw new Error('boom')
    })
    const { dial, deps } = harness({ send })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.readback).toHaveBeenCalledTimes(1)
  })

  it('a readback that throws still ends the pending state', async () => {
    const readback = vi.fn(async () => {
      throw new Error('offline')
    })
    const { dial, deps } = harness({ readback })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100 + 800)
    expect(deps.settle).toHaveBeenCalledTimes(1)
    expect(dial.isPending(CTX)).toBe(false)
  })

  it('turning again while a read-back is waiting cancels it', async () => {
    const { dial, deps, state } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100 + 400) // send done, readback not due yet
    dial.rotate(CTX, 1)
    state.real = 50
    await vi.advanceTimersByTimeAsync(100 + 799)
    expect(deps.readback).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.readback).toHaveBeenCalledTimes(1)
    expect(dial.isPending(CTX)).toBe(false)
  })

  it('turning again while a read-back is in flight discards its result', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const readback = vi.fn(() => gate)
    const { dial, deps } = harness({ readback, settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100 + 800)
    expect(readback).toHaveBeenCalledTimes(1)
    dial.rotate(CTX, 1) // new turn while waiting
    release(40) // stale answer
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.settle).not.toHaveBeenCalled()
    expect(dial.isPending(CTX)).toBe(true)
  })
})

describe('state sync and cleanup', () => {
  it('syncFromState is ignored while pending and applied afterwards', async () => {
    const { dial, deps, state } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 1)
    dial.syncFromState(CTX, 99)
    state.real = 45
    await vi.advanceTimersByTimeAsync(100 + 800)
    expect(dial.isPending(CTX)).toBe(false)
    dial.syncFromState(CTX, 80)
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.render).toHaveBeenLastCalledWith(CTX, expect.any(Number))
  })

  it('dispose cancels timers', async () => {
    const { dial, deps } = harness()
    dial.rotate(CTX, 1)
    dial.dispose(CTX)
    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.readback).not.toHaveBeenCalled()
    expect(dial.isPending(CTX)).toBe(false)
  })

  it('keeps dials independent', async () => {
    const { dial, deps } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate('a', 1)
    dial.rotate('b', -1)
    await vi.advanceTimersByTimeAsync(100)
    expect(deps.send).toHaveBeenCalledTimes(2)
    expect(deps.send).toHaveBeenCalledWith('a', expect.objectContaining({ rotationPercent: 45 }))
    expect(deps.send).toHaveBeenCalledWith('b', expect.objectContaining({ rotationPercent: 35 }))
  })
})
