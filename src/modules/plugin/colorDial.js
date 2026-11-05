import { HUE_NAMES } from './hueNames.js'

// Linked light dials: one or more dials share a model of one light.
//
// A color dial picks a color (a hue bar that wraps) or a white temperature (a bar
// that stops at each end, cool on the left); a press switches between them. A
// brightness dial picks the level. Every dial on the light shares a background: the
// selected color, dimmed to the selected brightness.
//
// Strips update at once. The light is updated while turning ("live", paced) or once
// after the dial stops ("idle"). Color and brightness are separate channels: while
// a channel has a turn outstanding, state pushes do not change it, so its marker does
// not jump back to older values. Everything outside this file is injected, so it is
// unit tested with fake timers.

export const COLOR_DIAL_DEFAULTS = Object.freeze({
  minSendIntervalMs: 300, // live mode: at most one call per this long
  idleSendMs: 500, // idle mode: send this long after the last tick
  settleMs: 3000, // keep ignoring state pushes until they have been quiet this long
  maxSettleMs: 20000, // ...but give up waiting this long after the last send
  hueTolerance: 6, // degrees: a reported hue this close keeps the marker in place
  kelvinTolerance: 100,
  brightnessTolerance: 0.02,
  minKelvin: 2000, // used when the light does not report its own range
  maxKelvin: 6500,
  defaultWhitePosition: 0.75, // warm: the white bar runs cool (left) to warm (right)
  minBackground: 0.12 // keep a trace of the color at low brightness
})

export { HUE_NAMES }
export const MODE_COLOR = 'color'
export const MODE_WHITE = 'white'
export const ROLE_COLOR = 'color'
export const ROLE_BRIGHTNESS = 'brightness'

export const STRIP = Object.freeze({ width: 200, height: 100 })
export const BAR = Object.freeze({ x: 14, y: 74, width: 172, height: 12, border: 3 })
export const EDGE = 3
export const CORNER = 18
export const MARKER = Object.freeze({ width: 6, overhang: 5, outline: 1.5 })
const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", system-ui, sans-serif'

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
const wrap = (value) => ((value % 1) + 1) % 1

/** Move along the bar: the color bar wraps, the white bar stops at each end. */
export function movePosition(mode, position, delta) {
  return mode === MODE_COLOR ? wrap(position + delta) : clamp(position + delta, 0, 1)
}

export function hueToRgb(hue) {
  const h = (((hue % 360) + 360) % 360) / 60
  const x = 1 - Math.abs((h % 2) - 1)
  const table = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x]
  ]
  return table[Math.floor(h)].map((v) => Math.round(v * 255))
}

/** Approximate display color of white light at a temperature. */
export function kelvinToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const g =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  return [r, g, b].map((v) => Math.round(clamp(v, 0, 255)))
}

export function kelvinRange(state) {
  const min = Number(state?.attributes?.min_color_temp_kelvin)
  const max = Number(state?.attributes?.max_color_temp_kelvin)
  return min > 0 && max > min
    ? { min, max }
    : { min: COLOR_DIAL_DEFAULTS.minKelvin, max: COLOR_DIAL_DEFAULTS.maxKelvin }
}

// The white bar runs cool on the left to warm on the right.
export const kelvinAt = (position, range) => range.max - position * (range.max - range.min)
export const positionOfKelvin = (kelvin, range) =>
  clamp((range.max - kelvin) / (range.max - range.min), 0, 1)

/** What a state says about the light; missing values are null. */
export function readLightState(state) {
  const attributes = state?.attributes ?? {}
  const hs = attributes.hs_color
  const hue = Array.isArray(hs) && Number.isFinite(Number(hs[0])) ? Number(hs[0]) : null
  const kelvin = Number(attributes.color_temp_kelvin)
  const raw = attributes.brightness
  const level = raw === null || raw === undefined ? NaN : Number(raw)
  let brightness = null
  if (state?.state === 'off') brightness = 0
  else if (Number.isFinite(level)) brightness = clamp(level / 255, 0, 1)
  const colorMode = attributes.color_mode
  return {
    mode: !colorMode ? null : colorMode === 'color_temp' ? MODE_WHITE : MODE_COLOR,
    hue,
    kelvin: Number.isFinite(kelvin) && kelvin > 0 ? kelvin : null,
    brightness
  }
}

/** What a dial's strip should show. */
export function viewFor(role, light, range) {
  const base =
    light.mode === MODE_COLOR
      ? hueToRgb(light.colorPosition * 360)
      : kelvinToRgb(kelvinAt(light.whitePosition, range))
  const dim = Math.max(COLOR_DIAL_DEFAULTS.minBackground, light.brightness)
  const background = base.map((v) => Math.round(v * dim))
  if (role === ROLE_BRIGHTNESS) {
    return {
      role,
      bar: 'level',
      position: light.brightness,
      background,
      base,
      value: `${Math.round(light.brightness * 100)}%`
    }
  }
  return light.mode === MODE_COLOR
    ? {
        role,
        bar: 'hue',
        position: light.colorPosition,
        background,
        value: hueName(light.colorPosition * 360)
      }
    : {
        role,
        bar: 'white',
        position: light.whitePosition,
        background,
        range,
        value: `${Math.round(kelvinAt(light.whitePosition, range) / 50) * 50} K`
      }
}

const css = ([r, g, b]) => `rgb(${r},${g},${b})`

export function hueName(hue) {
  const h = ((hue % 360) + 360) % 360
  let best = HUE_NAMES[0]
  let bestDistance = Infinity
  for (const entry of HUE_NAMES) {
    const d = Math.abs(h - entry[0])
    const distance = Math.min(d, 360 - d)
    if (distance < bestDistance) {
      best = entry
      bestDistance = distance
    }
  }
  return best[1]
}

const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Array.isArray(r) ? r : Math.min(r, w / 2, h / 2))
  ctx.fill()
}

/** Which vertical edges of a strip are rounded: 'both' (default), 'left', 'right' or 'none'. */
export function cornersFor(option) {
  const left = option !== 'right' && option !== 'none'
  const right = option !== 'left' && option !== 'none'
  return { left, right }
}

/**
 * Paint a strip on a 2D canvas context: the shared background, a large value, then a slim black-bordered bar with a black marker. Text is white on dark
 * backgrounds and black on light ones, so it stays readable at any color or brightness.
 */
export function drawStrip(ctx, view) {
  // Black behind a rounded color block, so the corners read as rounded on the deck.
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, STRIP.width, STRIP.height)
  ctx.fillStyle = css(view.background)
  // Rounded edges leave a black margin; a square edge runs flush, so neighboring strips can
  // join into one block that is rounded only at its far left and far right.
  const { left, right } = cornersFor(view.corners)
  const x0 = left ? EDGE : 0
  const x1 = STRIP.width - (right ? EDGE : 0)
  roundedRect(ctx, x0, EDGE, x1 - x0, STRIP.height - EDGE * 2, [
    left ? CORNER : 0,
    right ? CORNER : 0,
    right ? CORNER : 0,
    left ? CORNER : 0
  ])

  const light = luminance(view.background) > 0.55
  const ink = light ? '#000' : '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = ink
  // Light weight, shrunk if needed so long names (Spring Green) fit inside the strip.
  let size = 42
  ctx.font = `300 ${size}px ${FONT}`
  while (size > 22 && ctx.measureText(view.value).width > STRIP.width - 20) {
    size -= 2
    ctx.font = `300 ${size}px ${FONT}`
  }
  ctx.fillText(view.value, STRIP.width / 2, 55)

  ctx.fillStyle = '#000'
  roundedRect(
    ctx,
    BAR.x - BAR.border,
    BAR.y - BAR.border,
    BAR.width + BAR.border * 2,
    BAR.height + BAR.border * 2,
    (BAR.height + BAR.border * 2) / 2
  )

  const gradient = ctx.createLinearGradient(BAR.x, 0, BAR.x + BAR.width, 0)
  if (view.bar === 'hue') {
    for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, css(hueToRgb(i * 60)))
  } else if (view.bar === 'white') {
    for (let i = 0; i <= 8; i++) {
      gradient.addColorStop(i / 8, css(kelvinToRgb(kelvinAt(i / 8, view.range))))
    }
  } else {
    gradient.addColorStop(0, css(view.base.map((v) => Math.round(v * 0.18))))
    gradient.addColorStop(1, css(view.base))
  }
  ctx.fillStyle = gradient
  roundedRect(ctx, BAR.x, BAR.y, BAR.width, BAR.height, BAR.height / 2)

  // Black marker with a hairline white edge so it shows on the black border and dark bars.
  const x = clamp(
    BAR.x + view.position * BAR.width - MARKER.width / 2,
    BAR.x - BAR.border,
    BAR.x + BAR.width + BAR.border - MARKER.width
  )
  const y = BAR.y - MARKER.overhang
  const h = BAR.height + MARKER.overhang * 2
  ctx.fillStyle = '#fff'
  roundedRect(
    ctx,
    x - MARKER.outline,
    y - MARKER.outline,
    MARKER.width + MARKER.outline * 2,
    h + MARKER.outline * 2,
    5
  )
  ctx.fillStyle = '#000'
  roundedRect(ctx, x, y, MARKER.width, h, 3)
}

const newChannel = () => ({
  pending: false,
  sending: false,
  dirty: false,
  live: true,
  minSendIntervalMs: COLOR_DIAL_DEFAULTS.minSendIntervalMs,
  idleSendMs: COLOR_DIAL_DEFAULTS.idleSendMs,
  context: null,
  lastSendAt: null,
  lastPushAt: null,
  sendTimer: null,
  settleTimer: null
})

export class LinkedDials {
  #lights = new Map()
  #deps

  /**
   * @param {object} deps
   * @param {(context:string)=>object|undefined} deps.getSettings  action settings
   * @param {(context:string)=>string|undefined} deps.getEntityId  the light a dial controls
   * @param {(entityId:string)=>string[]} deps.getContexts         every linked dial on a light
   * @param {(entityId:string)=>object|undefined} deps.getState    latest known entity state
   * @param {(entityId:string, data:object, context:string)=>Promise<boolean>|boolean} deps.send  call light.turn_on
   * @param {(context:string, view:object)=>void} deps.render      paint a strip
   * @param {{setTimeout:Function, clearTimeout:Function}} [deps.timers]
   */
  constructor(deps) {
    this.#deps = {
      log: () => {},
      now: () => Date.now(),
      timers: {
        setTimeout: (...a) => setTimeout(...a),
        clearTimeout: (...a) => clearTimeout(...a)
      },
      ...deps
    }
  }

  #light(entityId) {
    let light = this.#lights.get(entityId)
    if (!light) {
      light = {
        entityId,
        mode: MODE_COLOR,
        colorPosition: 0,
        whitePosition: COLOR_DIAL_DEFAULTS.defaultWhitePosition,
        brightness: 1,
        known: false,
        color: newChannel(),
        brightnessChannel: newChannel()
      }
      this.#lights.set(entityId, light)
      this.#adopt(light, this.#deps.getState(entityId), true, true)
    }
    return light
  }

  #channel(light, role) {
    return role === ROLE_BRIGHTNESS ? light.brightnessChannel : light.color
  }

  #role(context) {
    return this.#deps.getSettings(context)?.dialStyle === ROLE_BRIGHTNESS
      ? ROLE_BRIGHTNESS
      : ROLE_COLOR
  }

  // Take the real state for the given channels, keeping a marker in place when the
  // light reports nearly the same value: lights round values, and markers should not creep.
  #adopt(light, state, adoptColor, adoptBrightness) {
    if (!state) return
    const range = kelvinRange(state)
    const real = readLightState(state)
    const first = !light.known
    light.known = true
    const D = COLOR_DIAL_DEFAULTS
    if (adoptColor) {
      if (real.mode) light.mode = real.mode
      if (real.hue !== null) {
        const distance = Math.abs(light.colorPosition * 360 - real.hue)
        if (first || Math.min(distance, 360 - distance) > D.hueTolerance) {
          light.colorPosition = wrap(real.hue / 360)
        }
      }
      if (real.kelvin !== null) {
        const current = kelvinAt(light.whitePosition, range)
        if (first || Math.abs(current - real.kelvin) > D.kelvinTolerance) {
          light.whitePosition = positionOfKelvin(real.kelvin, range)
        }
      }
    }
    if (adoptBrightness && real.brightness !== null) {
      if (first || Math.abs(light.brightness - real.brightness) > D.brightnessTolerance) {
        light.brightness = real.brightness
      }
    }
  }

  #view(light, context) {
    const view = viewFor(
      this.#role(context),
      light,
      kelvinRange(this.#deps.getState(light.entityId))
    )
    view.corners = this.#deps.getSettings(context)?.stripCorners ?? 'both'
    return view
  }

  #renderAll(light) {
    for (const context of this.#deps.getContexts(light.entityId)) {
      this.#deps.render(context, this.#view(light, context))
    }
  }

  isPending(context) {
    const entityId = this.#deps.getEntityId(context)
    const light = entityId && this.#lights.get(entityId)
    return !!light && (light.color.pending || light.brightnessChannel.pending)
  }

  /** New state arrived for this dial's light. Channels with a turn outstanding ignore it. */
  syncFromState(context, state) {
    const entityId = this.#deps.getEntityId(context)
    if (!entityId) return
    const light = this.#light(entityId)
    const now = this.#deps.now()
    if (light.color.pending) light.color.lastPushAt = now // still changing; see #settle
    if (light.brightnessChannel.pending) light.brightnessChannel.lastPushAt = now
    this.#adopt(light, state, !light.color.pending, !light.brightnessChannel.pending)
    this.#deps.render(context, this.#view(light, context))
  }

  rotate(context, ticks) {
    const settings = this.#deps.getSettings(context)
    const entityId = this.#deps.getEntityId(context)
    if (!settings || !entityId) return
    const light = this.#light(entityId)
    const role = this.#role(context)
    const delta = (ticks * (settings.rotationTickMultiplier || 1)) / 100
    if (role === ROLE_BRIGHTNESS) light.brightness = clamp(light.brightness + delta, 0, 1)
    else if (light.mode === MODE_COLOR) {
      light.colorPosition = movePosition(MODE_COLOR, light.colorPosition, delta)
    } else light.whitePosition = movePosition(MODE_WHITE, light.whitePosition, delta)
    this.#changed(light, role, context, settings)
  }

  /** A press on a color dial switches between color and white, and applies the new mode. */
  toggleMode(context) {
    const settings = this.#deps.getSettings(context)
    const entityId = this.#deps.getEntityId(context)
    if (!settings || !entityId) return
    const light = this.#light(entityId)
    light.mode = light.mode === MODE_COLOR ? MODE_WHITE : MODE_COLOR
    this.#changed(light, ROLE_COLOR, context, { ...settings, sendMode: 'live' })
  }

  #changed(light, role, context, settings) {
    const channel = this.#channel(light, role)
    const t = this.#deps.timers
    channel.pending = true
    channel.dirty = true
    channel.context = context
    channel.live = settings.sendMode !== 'idle'
    channel.minSendIntervalMs = settings.minSendIntervalMs ?? COLOR_DIAL_DEFAULTS.minSendIntervalMs
    channel.idleSendMs = settings.idleSendMs ?? COLOR_DIAL_DEFAULTS.idleSendMs
    if (channel.settleTimer) {
      t.clearTimeout(channel.settleTimer)
      channel.settleTimer = null
    }
    this.#renderAll(light)

    if (!channel.live && channel.sendTimer) {
      t.clearTimeout(channel.sendTimer)
      channel.sendTimer = null
    }
    if (channel.sendTimer || channel.sending) return // #flush looks again when the call returns
    this.#schedule(light, role, channel)
  }

  #schedule(light, role, channel) {
    let delay = channel.idleSendMs
    if (channel.live) {
      const since = channel.lastSendAt === null ? Infinity : this.#deps.now() - channel.lastSendAt
      delay = Math.max(0, channel.minSendIntervalMs - since)
    }
    channel.sendTimer = this.#deps.timers.setTimeout(() => this.#flush(light, role, channel), delay)
  }

  #data(light, role) {
    if (role === ROLE_BRIGHTNESS) return { brightness_pct: Math.round(light.brightness * 100) }
    if (light.mode === MODE_COLOR) return { rgb_color: hueToRgb(light.colorPosition * 360) }
    const range = kelvinRange(this.#deps.getState(light.entityId))
    return { color_temp_kelvin: Math.round(kelvinAt(light.whitePosition, range)) }
  }

  async #flush(light, role, channel) {
    channel.sendTimer = null
    channel.dirty = false
    channel.sending = true
    channel.lastSendAt = this.#deps.now()
    const data = this.#data(light, role)

    let ok = false
    try {
      ok = (await this.#deps.send(light.entityId, data, channel.context)) !== false
    } catch {
      ok = false
    } finally {
      channel.sending = false
    }
    this.#deps.log(channel.context, `${role} send ${JSON.stringify(data)} ok=${ok}`)

    if (channel.dirty) {
      this.#schedule(light, role, channel)
      return
    }
    if (channel.sendTimer) return
    channel.settleTimer = this.#deps.timers.setTimeout(
      () => this.#settle(light, role, channel),
      ok ? COLOR_DIAL_DEFAULTS.settleMs : 0
    )
  }

  // Quiet for a while: confirm against the real state and correct the strips if it differs.
  #settle(light, role, channel) {
    channel.settleTimer = null
    // A slow light can still be working through commands. Reading its state now would
    // drag the marker back to an old value, so wait until its reports go quiet.
    const now = this.#deps.now()
    const quietFor = channel.lastPushAt === null ? Infinity : now - channel.lastPushAt
    const sinceSend = channel.lastSendAt === null ? Infinity : now - channel.lastSendAt
    if (quietFor < COLOR_DIAL_DEFAULTS.settleMs && sinceSend < COLOR_DIAL_DEFAULTS.maxSettleMs) {
      channel.settleTimer = this.#deps.timers.setTimeout(
        () => this.#settle(light, role, channel),
        COLOR_DIAL_DEFAULTS.settleMs - quietFor
      )
      return
    }
    channel.pending = false
    channel.lastPushAt = null
    this.#adopt(
      light,
      this.#deps.getState(light.entityId),
      role === ROLE_COLOR,
      role === ROLE_BRIGHTNESS
    )
    this.#deps.log(channel.context, `${role} settle mode=${light.mode}`)
    this.#renderAll(light)
  }
}
