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
  readbackDelayMs: 800, // quiet time after the last send before the first read-back
  readbackRetryMs: 600, // wait between read-back retries while the value still differs
  maxReadbacks: 4, // read-backs before accepting whatever Home Assistant reports
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
   * @param {(context:string)=>void} deps.settle                     draw the real, cached state once the dial is no longer pending
   * @param {{setTimeout:Function, clearTimeout:Function}} [deps.timers]
   */
  constructor(deps) {
    this.#deps = {
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
      readbackDelayMs: Math.max(0, finiteOr(s.readbackDelayMs, DIAL_DEFAULTS.readbackDelayMs)),
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
    if (d.readbackTimer) {
      t.clearTimeout(d.readbackTimer)
      d.readbackTimer = null
    }

    if (opts.optimisticDisplay && d.optimistic) {
      d.pending = true
      this.#scheduleRender(context)
    }

    if (d.sendTimer) return
    if (opts.bucketMs > 0) {
      d.sendTimer = t.setTimeout(() => this.#flush(context), opts.bucketMs)
    } else {
      this.#flush(context)
    }
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

    let ok = false
    try {
      ok = (await this.#deps.send(context, vars)) !== false
    } catch {
      ok = false
    }

    const current = this.#dials.get(context)
    if (!current || !current.pending || current.sendTimer) return // disposed, not optimistic, or more ticks queued
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

    const matches = real !== null && Math.abs(real - d.percent) <= DIAL_DEFAULTS.tolerancePct
    if (!matches && real !== null && d.attempts < DIAL_DEFAULTS.maxReadbacks) {
      // Probably still fading toward the target; look again shortly.
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
    d.dirty = false
    if (real !== null) d.percent = clamp(real, 0, 100)
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
