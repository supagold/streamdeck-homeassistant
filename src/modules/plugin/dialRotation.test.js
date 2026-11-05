import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DialRotation, DIAL_DEFAULTS } from './dialRotation.js'

const CTX = 'ctx1'

function harness({ settings = {}, initialPercent = 40, send, readback, peek = false } = {}) {
  const log = []
  const state = { real: initialPercent, seen: initialPercent }
  const deps = {
    getSettings: () => ({ minSendIntervalMs: 0, ...settings }),
    getInitialPercent: () => state.real,
    peekPercent: peek ? () => state.seen : undefined,
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

  it('gives up once the value stops moving and accepts what Home Assistant reports', async () => {
    const { dial, deps, state } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 4)
    state.real = 10 // never reaches target
    await vi.advanceTimersByTimeAsync(100 + 800 + DIAL_DEFAULTS.readbackRetryMs * 10)
    expect(deps.readback).toHaveBeenCalledTimes(DIAL_DEFAULTS.maxStalledReadbacks)
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

describe('in-flight sends', () => {
  it('accumulates ticks while a call is in flight and then sends only the newest target', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const sent = []
    const send = vi.fn(async (_c, vars) => {
      sent.push(vars)
      if (sent.length === 1) await gate
      return true
    })
    const { dial } = harness({
      send,
      settings: { rotationTickMultiplier: 5, rotationTickBucketSizeMs: 100 }
    })
    dial.rotate(CTX, 1) // 45
    await vi.advanceTimersByTimeAsync(100) // first call starts, blocked on the gate
    dial.rotate(CTX, 1) // 50
    dial.rotate(CTX, 1) // 55
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(1) // nothing else goes out while in flight
    release()
    await vi.advanceTimersByTimeAsync(100) // queued ticks wait one batching window after the call returns
    expect(send).toHaveBeenCalledTimes(2)
    expect(sent[1]).toEqual({ ticks: 10, rotationPercent: 55, rotationAbsolute: 2.55 * 55 })
  })

  it('does not schedule a read-back until the last call has returned and nothing is queued', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    let n = 0
    const send = vi.fn(async () => {
      if (++n === 1) await gate
      return true
    })
    const { dial, deps } = harness({ send, settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    dial.rotate(CTX, 1)
    release()
    await vi.advanceTimersByTimeAsync(100) // queued ticks wait one batching window after the call returns
    expect(send).toHaveBeenCalledTimes(2)
    expect(deps.readback).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(800)
    expect(deps.readback).toHaveBeenCalledTimes(1)
  })
})

describe('spacing calls for slow devices', () => {
  it('sends at most one call per minimum interval, always with the newest target', async () => {
    const { dial, deps } = harness({
      settings: {
        rotationTickMultiplier: 5,
        rotationTickBucketSizeMs: 100,
        minSendIntervalMs: 1000
      }
    })
    for (let i = 0; i < 30; i++) {
      dial.rotate(CTX, 1) // a notch every 100 ms for 3 s
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(2000)
    const times = deps.send.mock.calls.length
    expect(times).toBeLessThanOrEqual(5) // would be ~30 without spacing
    expect(deps.send.mock.calls.at(-1)[1].rotationPercent).toBe(100) // 40 + 30 * 5, clamped
  })

  it('waits out the minimum gap after a call returns before sending queued ticks', async () => {
    const { dial, deps } = harness({
      settings: {
        rotationTickMultiplier: 5,
        rotationTickBucketSizeMs: 100,
        minSendIntervalMs: 1000
      }
    })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100) // first call goes out at t=100
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(500)
    expect(deps.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500) // t=1100: gap satisfied
    expect(deps.send).toHaveBeenCalledTimes(2)
  })

  it('a first call after idle is not delayed by the minimum interval', async () => {
    const { dial, deps } = harness({
      settings: { rotationTickBucketSizeMs: 100, minSendIntervalMs: 1000 }
    })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(deps.send).toHaveBeenCalledTimes(1)
  })
})

describe('read-back while a slow device catches up', () => {
  it('keeps waiting while the value is still moving, beyond the stall limit', async () => {
    const { dial, deps, state } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 12) // target 100
    let i = 0
    deps.readback.mockImplementation(async () => {
      i++
      state.real = Math.min(100, 40 + i * 5) // creeping upward, 5 points per look
      return state.real
    })
    await vi.advanceTimersByTimeAsync(100 + 800 + DIAL_DEFAULTS.readbackRetryMs * 20)
    expect(deps.readback.mock.calls.length).toBeGreaterThan(DIAL_DEFAULTS.maxStalledReadbacks)
    expect(deps.settle).toHaveBeenCalledTimes(1)
    expect(dial.isPending(CTX)).toBe(false)
  })

  it('still stops at the hard cap if the value keeps moving but never arrives', async () => {
    const { dial, deps } = harness({ settings: { rotationTickMultiplier: 5 } })
    dial.rotate(CTX, 12) // target 100
    let i = 0
    deps.readback.mockImplementation(async () => 20 + (i++ % 2) * 10) // wobbles 20/30 forever
    await vi.advanceTimersByTimeAsync(
      100 + 800 + DIAL_DEFAULTS.readbackRetryMs * (DIAL_DEFAULTS.maxReadbacks + 2)
    )
    expect(deps.readback).toHaveBeenCalledTimes(DIAL_DEFAULTS.maxReadbacks)
    expect(deps.settle).toHaveBeenCalledTimes(1)
  })
})

describe('waiting for the device between calls', () => {
  const settings = {
    rotationTickMultiplier: 5,
    rotationTickBucketSizeMs: 100,
    minSendIntervalMs: 0,
    deviceTimeoutMs: 3000
  }

  it('holds the next call until the device reports the last target', async () => {
    const { dial, deps, state } = harness({ settings, peek: true })
    dial.rotate(CTX, 1) // target 45
    await vi.advanceTimersByTimeAsync(100)
    expect(deps.send).toHaveBeenCalledTimes(1)
    dial.rotate(CTX, 1) // target 50, queued behind the first call
    await vi.advanceTimersByTimeAsync(1500)
    expect(deps.send).toHaveBeenCalledTimes(1) // the device still shows 40: don't pile on
    state.seen = 45 // the device caught up
    await vi.advanceTimersByTimeAsync(200)
    expect(deps.send).toHaveBeenCalledTimes(2)
    expect(deps.send.mock.calls[1][1].rotationPercent).toBe(50)
  })

  it('stops waiting after the timeout when the device never reports', async () => {
    const { dial, deps } = harness({ settings: { ...settings, deviceTimeoutMs: 1000 }, peek: true })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(800)
    expect(deps.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300) // 1000 ms after the first call
    expect(deps.send).toHaveBeenCalledTimes(2)
  })

  it('does not wait when disabled (deviceTimeoutMs 0)', async () => {
    const { dial, deps } = harness({ settings: { ...settings, deviceTimeoutMs: 0 }, peek: true })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(deps.send).toHaveBeenCalledTimes(2)
  })

  it('does not wait before the very first call', async () => {
    const { dial, deps, state } = harness({ settings, peek: true })
    state.seen = 0 // device state unrelated to any earlier target
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it('treats an unknown device position as not caught up until the timeout', async () => {
    const { dial, deps, state } = harness({
      settings: { ...settings, deviceTimeoutMs: 600 },
      peek: true
    })
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(100)
    state.seen = null
    dial.rotate(CTX, 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(deps.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(deps.send).toHaveBeenCalledTimes(2)
  })
})
