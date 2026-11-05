// Dial rotation controller: optimistic display, batched sends, read-back.
//
// For each dial (context) a turn does three things:
//   1. render  - show the new position on the strip immediately (optimistic)
//   2. send    - after a short batching window, call the Home Assistant service
//   3. readback - once things have settled, ask Home Assistant what the entity
//                 really is, and snap the display to it (retrying briefly while
//                 a light is still fading)
//
// While steps 2-3 are outstanding the dial is "pending": the host must not
// repaint the dial from incoming state pushes, or the display would flicker back
// to older values. The controller is DOM- and Home Assistant-free: everything
// outside it is injected, so it is unit tested with fake timers.

export const DIAL_DEFAULTS = Object.freeze({
  bucketMs: 100, // batching window for ticks before one service call
  minSendIntervalMs: 250, // at most one call per this long; slow devices queue commands and replay them late
  idleSendMs: 500, // "When the dial stops" mode: send this long after the last tick
  deviceTimeoutMs: 3000, // wait up to this long for the device to reach the last target before the next call (0 = don't wait)
  ackPollMs: 100, // how often to look for the device having caught up while waiting
  readbackDelayMs: 800, // quiet time after the last send before the first read-back
  readbackRetryMs: 500, // wait between read-back retries while the value still differs
  maxStalledReadbacks: 6, // consecutive read-backs showing no movement before accepting what Home Assistant reports
  maxReadbacks: 24, // hard cap on read-backs per turn (~12 s) even if the value keeps moving
  tolerancePct: 4 // |real - target| within this counts as "matches"
})

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export class DialRotation {
  #dials = new Map()
  #deps

  /**
   * @param {object} deps
   * @param {(context:string)=>object|undefined} deps.getSettings   action settings for a dial
   * @param {(context:string)=>number|null} deps.getInitialPercent  known real position, or null if unknown/unsupported
   * @param {(context:string, vars:object)=>Promise<boolean>|boolean} deps.send   perform the rotation service call
   * @param {(context:string, percent:number)=>Promise<void>|void} deps.render    draw an optimistic position
   * @param {(context:string)=>Promise<number|null>} deps.readback   fetch fresh state; resolve its position (null = unavailable)
   * @param {(context:string)=>number|null} [deps.peekPercent]       cheap look (no network) at the latest known real position; enables waiting for the device between calls
   * @param {(context:string)=>void} deps.settle                     draw the real, cached state once the dial is no longer pending
   * @param {{setTimeout:Function, clearTimeout:Function}} [deps.timers]
   */
  constructor(deps) {
    this.#deps = {
      log: () => {}, // optional (context, message) sink for diagnosing timing problems
      now: () => Date.now(),
      timers: {
        setTimeout: (...a) => setTimeout(...a),
        clearTimeout: (...a) => clearTimeout(...a)
      },
      ...deps
    }
  }

  #dial(context) {
    let d = this.#dials.get(context)
    if (!d) {
      d = {
        percent: null,
        amount: 0,
        optimistic: false,
        pending: false,
        sending: false,
        lastSendAt: null,
        lastSentTarget: null,
        lastReal: null,
        stalled: 0,
        generation: 0,
        attempts: 0,
        sendTimer: null,
        readbackTimer: null,
        rendering: false,
        dirty: false
      }
      this.#dials.set(context, d)
    }
    return d
  }

  #opts(settings) {
    const s = settings ?? {}
    return {
      bucketMs: Math.max(0, finiteOr(s.rotationTickBucketSizeMs, DIAL_DEFAULTS.bucketMs)), // 0 is valid: one call per tick
      minSendIntervalMs: Math.max(
        0,
        finiteOr(s.minSendIntervalMs, DIAL_DEFAULTS.minSendIntervalMs)
      ),
      deviceTimeoutMs: Math.max(0, finiteOr(s.deviceTimeoutMs, DIAL_DEFAULTS.deviceTimeoutMs)),
      readbackDelayMs: Math.max(0, finiteOr(s.readbackDelayMs, DIAL_DEFAULTS.readbackDelayMs)),
      idle: s.sendMode === 'idle',
      idleSendMs: Math.max(0, finiteOr(s.idleSendMs, DIAL_DEFAULTS.idleSendMs)),
      optimisticDisplay: s.optimisticDisplay !== false,
      multiplier: finiteOr(s.rotationTickMultiplier, 1) || 1
    }
  }

  isPending(context) {
    return this.#dials.get(context)?.pending === true
  }

  /** The host rendered real state at `percent`. Ignored while a turn is in flight. */
  syncFromState(context, percent) {
    const d = this.#dial(context)
    if (d.pending || percent === null || percent === undefined) return
    d.percent = clamp(percent, 0, 100)
  }

  rotate(context, ticks) {
    const settings = this.#deps.getSettings(context)
    if (!settings) return
    const opts = this.#opts(settings)
    const d = this.#dial(context)
    const t = this.#deps.timers

    if (d.percent === null) {
      const known = this.#deps.getInitialPercent(context)
      d.percent = known ?? 0
      d.optimistic = known !== null && known !== undefined
    } else if (!d.pending) {
      // Re-check each burst: the entity (or its domain support) may have changed.
      const known = this.#deps.getInitialPercent(context)
      if (known !== null && known !== undefined) {
        d.percent = clamp(known, 0, 100)
        d.optimistic = true
      }
    }

    const scaled = ticks * opts.multiplier
    d.percent = clamp(d.percent + scaled, 0, 100)
    d.amount += scaled

    // A new turn invalidates any read-back that is waiting or in flight.
    d.generation++
    d.attempts = 0
    d.stalled = 0
    d.lastReal = null
    if (d.readbackTimer) {
      t.clearTimeout(d.readbackTimer)
      d.readbackTimer = null
    }

    if (opts.optimisticDisplay && d.optimistic) {
      d.pending = true
      this.#scheduleRender(context)
    }

    // "When the dial stops": every tick restarts the wait.
    if (opts.idle && d.sendTimer) {
      t.clearTimeout(d.sendTimer)
      d.sendTimer = null
    }

    // While a call is in flight further ticks only accumulate; #flush sends the
    // newest absolute target as soon as the call returns (no timer needed).
    if (d.sendTimer || d.sending) return
    this.#scheduleSend(context, opts)
  }

  // Wait out the batching window and the minimum gap since the previous call, whichever is longer.
  #scheduleSend(context, opts) {
    const d = this.#dials.get(context)
    if (!d) return
    if (opts.idle) {
      d.sendTimer = this.#deps.timers.setTimeout(() => this.#flush(context), opts.idleSendMs)
      return
    }
    const sinceLast = d.lastSendAt === null ? Infinity : this.#deps.now() - d.lastSendAt
    const delay = Math.max(opts.bucketMs, opts.minSendIntervalMs - sinceLast)
    if (delay > 0) {
      d.sendTimer = this.#deps.timers.setTimeout(() => this.#flushWhenReady(context, opts), delay)
    } else {
      this.#flushWhenReady(context, opts)
    }
  }

  // Adaptive pacing: slow devices (cloud or Bluetooth lights) apply commands one at a time
  // and replay a queue late. Hold the next call until the device reports it has reached
  // the previous target, or the timeout passes, so no queue can build up.
  #flushWhenReady(context, opts) {
    const d = this.#dials.get(context)
    if (!d) return
    if (
      opts.deviceTimeoutMs > 0 &&
      this.#deps.peekPercent &&
      d.lastSendAt !== null &&
      d.lastSentTarget !== null
    ) {
      const waited = this.#deps.now() - d.lastSendAt
      const seen = this.#deps.peekPercent(context)
      const caughtUp =
        seen !== null &&
        seen !== undefined &&
        Math.abs(seen - d.lastSentTarget) <= DIAL_DEFAULTS.tolerancePct
      if (!caughtUp && waited < opts.deviceTimeoutMs) {
        d.sendTimer = this.#deps.timers.setTimeout(
          () => this.#flushWhenReady(context, opts),
          Math.min(DIAL_DEFAULTS.ackPollMs, opts.deviceTimeoutMs - waited)
        )
        return
      }
    }
    this.#flush(context)
  }

  #scheduleRender(context) {
    const d = this.#dial(context)
    if (d.rendering) {
      d.dirty = true // coalesce: only the newest position matters
      return
    }
    d.rendering = true
    Promise.resolve()
      .then(() => this.#deps.render(context, d.percent))
      .catch(() => {})
      .finally(() => {
        d.rendering = false
        if (d.dirty && d.pending) {
          d.dirty = false
          this.#scheduleRender(context)
        } else {
          d.dirty = false
        }
      })
  }

  async #flush(context) {
    const d = this.#dials.get(context)
    if (!d) return
    d.sendTimer = null
    const settings = this.#deps.getSettings(context)
    const opts = this.#opts(settings)
    const vars = { ticks: d.amount, rotationPercent: d.percent, rotationAbsolute: 2.55 * d.percent }
    d.amount = 0
    d.lastSendAt = this.#deps.now()
    d.lastSentTarget = vars.rotationPercent

    let ok = false
    d.sending = true
    try {
      ok = (await this.#deps.send(context, vars)) !== false
    } catch {
      ok = false
    } finally {
      d.sending = false
    }
    this.#deps.log(
      context,
      `send ticks=${vars.ticks} target=${vars.rotationPercent.toFixed(1)} ok=${ok}`
    )

    const current = this.#dials.get(context)
    if (!current) return // disposed while sending
    if (current.amount !== 0) return this.#scheduleSend(context, opts) // turned further during the call: send the newest target, respecting the minimum gap
    if (!current.pending || current.sendTimer) return // not optimistic, or another send is already scheduled
    const generation = current.generation
    if (current.readbackTimer) this.#deps.timers.clearTimeout(current.readbackTimer)
    // A failed call leaves the display wrong: look immediately.
    current.readbackTimer = this.#deps.timers.setTimeout(
      () => this.#readback(context, generation, opts),
      ok ? opts.readbackDelayMs : 0
    )
  }

  async #readback(context, generation, opts) {
    const d = this.#dials.get(context)
    if (!d || d.generation !== generation) return
    d.readbackTimer = null
    d.attempts++

    let real = null
    try {
      real = await this.#deps.readback(context)
    } catch {
      real = null
    }
    if (!this.#dials.has(context) || d.generation !== generation) return // turned again while waiting
    this.#deps.log(
      context,
      `readback #${d.attempts} real=${real === null ? 'null' : real.toFixed(1)} target=${d.percent.toFixed(1)}`
    )

    const matches = real !== null && Math.abs(real - d.percent) <= DIAL_DEFAULTS.tolerancePct
    // Slow devices replay queued commands one by one, so a value that is still
    // moving means "not there yet"; only give up once it has stopped moving.
    const moved = real !== null && d.lastReal !== null && Math.abs(real - d.lastReal) > 0.5
    d.stalled = moved ? 0 : d.stalled + 1
    d.lastReal = real
    if (
      !matches &&
      real !== null &&
      d.stalled < DIAL_DEFAULTS.maxStalledReadbacks &&
      d.attempts < DIAL_DEFAULTS.maxReadbacks
    ) {
      // Probably still catching up to the target; look again shortly.
      d.readbackTimer = this.#deps.timers.setTimeout(
        () => this.#readback(context, generation, opts),
        DIAL_DEFAULTS.readbackRetryMs
      )
      return
    }
    this.#finish(context, real)
  }

  #finish(context, real) {
    const d = this.#dials.get(context)
    if (!d) return
    d.pending = false
    d.attempts = 0
    d.stalled = 0
    d.lastReal = null
    d.dirty = false
    if (real !== null) d.percent = clamp(real, 0, 100)
    this.#deps.log(context, `settle on real=${real === null ? 'null' : real.toFixed(1)}`)
    this.#deps.settle(context)
  }

  /** Stop all work for a dial that left the screen. */
  dispose(context) {
    const d = this.#dials.get(context)
    if (!d) return
    const t = this.#deps.timers
    if (d.sendTimer) t.clearTimeout(d.sendTimer)
    if (d.readbackTimer) t.clearTimeout(d.readbackTimer)
    this.#dials.delete(context)
  }
}
