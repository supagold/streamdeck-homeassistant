import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BAR,
  STRIP,
  drawStrip,
  CORNER,
  cornersFor,
  hueName,
  hueToRgb,
  HUE_NAMES,
  kelvinRange,
  kelvinToRgb,
  LinkedDials,
  movePosition,
  MODE_COLOR,
  MODE_WHITE,
  readLightState,
  ROLE_BRIGHTNESS,
  ROLE_COLOR,
  viewFor
} from './colorDial.js'

const RANGE = { min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6000 }
const colorState = (hue, brightness = 255) => ({
  state: 'on',
  attributes: { color_mode: 'rgb', hs_color: [hue, 100], brightness, ...RANGE }
})
const whiteState = (kelvin, brightness = 255) => ({
  state: 'on',
  attributes: {
    color_mode: 'color_temp',
    color_temp_kelvin: kelvin,
    hs_color: [28, 60],
    brightness,
    ...RANGE
  }
})

// 'R' is the color dial, 'L' the brightness dial; both control light.x.
function setup(state, settings = {}, { only } = {}) {
  let current = state
  const dialSettings = {
    R: { dialStyle: 'color', rotationTickMultiplier: 2, minSendIntervalMs: 300, ...settings },
    L: { dialStyle: 'brightness', rotationTickMultiplier: 5, minSendIntervalMs: 300, ...settings }
  }
  const deps = {
    getSettings: (context) => dialSettings[context],
    getEntityId: () => 'light.x',
    getContexts: () => only ?? ['L', 'R'],
    getState: () => current,
    send: vi.fn(async () => true),
    render: vi.fn()
  }
  const dial = new LinkedDials(deps)
  return {
    dial,
    deps,
    dialSettings,
    setState: (s) => (current = s),
    lastView: (context = 'R') =>
      deps.render.mock.calls.filter((call) => call[0] === context).at(-1)[1]
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('movePosition', () => {
  it('wraps the color bar in both directions', () => {
    expect(movePosition(MODE_COLOR, 0.99, 0.02)).toBeCloseTo(0.01)
    expect(movePosition(MODE_COLOR, 0.01, -0.02)).toBeCloseTo(0.99)
  })

  it('stops the white bar at each end', () => {
    expect(movePosition(MODE_WHITE, 0.99, 0.02)).toBe(1)
    expect(movePosition(MODE_WHITE, 0.01, -0.02)).toBe(0)
  })
})

describe('reading state and colors', () => {
  it('gives pure colors around the wheel', () => {
    expect(hueToRgb(0)).toEqual([255, 0, 0])
    expect(hueToRgb(120)).toEqual([0, 255, 0])
    expect(hueToRgb(240)).toEqual([0, 0, 255])
    expect(hueToRgb(360)).toEqual([255, 0, 0])
  })

  it('makes warm white redder than cool white', () => {
    const warm = kelvinToRgb(2000)
    const cool = kelvinToRgb(6500)
    expect(warm[2]).toBeLessThan(cool[2])
    expect(warm.every((v) => v >= 0 && v <= 255)).toBe(true)
  })

  it('falls back to a default kelvin range', () => {
    expect(kelvinRange({ attributes: {} })).toEqual({ min: 2000, max: 6500 })
  })

  it('reads mode and brightness from the state', () => {
    expect(readLightState(whiteState(3000)).mode).toBe(MODE_WHITE)
    expect(readLightState(colorState(90, 51))).toMatchObject({
      mode: MODE_COLOR,
      hue: 90,
      brightness: 0.2
    })
  })

  it('treats an off light as zero brightness with no mode', () => {
    expect(readLightState({ state: 'off', attributes: {} })).toMatchObject({
      mode: null,
      brightness: 0
    })
  })
})

describe('hueName', () => {
  it('names each table hue as itself', () => {
    for (const [hue, name] of HUE_NAMES) expect(hueName(hue)).toBe(name)
  })

  it('picks the nearest named hue between entries', () => {
    expect(hueName(0)).toBe('Red')
    expect(hueName(180)).toBe('Cyan')
    expect(hueName(60.4)).toBe(hueName(59.5))
  })

  it('wraps around red in both directions', () => {
    expect(hueName(-1)).toBe(hueName(359))
    expect(hueName(361)).toBe(hueName(1))
    expect(hueName(357)).toBe('Bright Red')
    expect(hueName(359)).toBe('Red')
    expect(hueName(1)).toBe('Red')
  })

  it('has about one distinct name per 3.6 degrees, sorted, all short enough to fit', () => {
    expect(HUE_NAMES.length).toBeGreaterThanOrEqual(90)
    expect(new Set(HUE_NAMES.map((entry) => entry[1])).size).toBe(HUE_NAMES.length)
    const hues = HUE_NAMES.map((entry) => entry[0])
    expect(hues).toEqual([...hues].sort((a, b) => a - b))
    expect(Math.max(...HUE_NAMES.map((entry) => entry[1].length))).toBeLessThanOrEqual(15)
    // no gap on the wheel larger than 12 degrees, so every tick of the default speed gets a new name
    for (let i = 0; i < hues.length; i++) {
      const next = i + 1 < hues.length ? hues[i + 1] : hues[0] + 360
      expect(next - hues[i]).toBeLessThanOrEqual(12)
    }
  })

  it('shows a different name on neighboring ticks at the default speed', () => {
    let changes = 0
    for (let tick = 0; tick < 50; tick++) {
      if (hueName(tick * 7.2) !== hueName((tick + 1) * 7.2)) changes++
    }
    expect(changes).toBe(50)
  })
})

describe('cornersFor and strip corners', () => {
  it('rounds the requested sides', () => {
    expect(cornersFor(undefined)).toEqual({ left: true, right: true })
    expect(cornersFor('both')).toEqual({ left: true, right: true })
    expect(cornersFor('left')).toEqual({ left: true, right: false })
    expect(cornersFor('right')).toEqual({ left: false, right: true })
    expect(cornersFor('none')).toEqual({ left: false, right: false })
  })

  function drawn(corners) {
    const radii = []
    const rects = []
    const ctx = {
      fillStyle: null,
      fillRect: () => {},
      beginPath: () => {},
      roundRect: (x, y, w, h, r) => rects.push({ x, y, w, h, r }),
      fill: () => {},
      createLinearGradient: () => ({ addColorStop() {} }),
      fillText: () => {},
      strokeText: () => {},
      measureText: () => ({ width: 10 })
    }
    const view = viewFor(
      ROLE_COLOR,
      { mode: MODE_COLOR, colorPosition: 0.5, whitePosition: 0.5, brightness: 1 },
      { min: 2000, max: 6000 }
    )
    drawStrip(ctx, { ...view, corners })
    return { block: rects[0], radii }
  }

  it('runs flush on a square side and keeps a margin on a rounded one', () => {
    const left = drawn('left').block
    expect(left.x).toBeGreaterThan(0)
    expect(left.x + left.w).toBe(STRIP.width)
    expect(left.r).toEqual([CORNER, 0, 0, CORNER])
    const right = drawn('right').block
    expect(right.x).toBe(0)
    expect(right.x + right.w).toBeLessThan(STRIP.width)
    expect(right.r).toEqual([0, CORNER, CORNER, 0])
    const none = drawn('none').block
    expect(none.x).toBe(0)
    expect(none.x + none.w).toBe(STRIP.width)
    expect(none.r).toEqual([0, 0, 0, 0])
  })

  it('a dial passes its corner setting to its strip', () => {
    const { dial, lastView } = setup(colorState(120), { stripCorners: 'left' })
    dial.syncFromState('R', colorState(120))
    expect(lastView().corners).toBe('left')
  })
})

describe('viewFor and drawStrip', () => {
  const light = {
    mode: MODE_COLOR,
    colorPosition: 0.5,
    whitePosition: 0.75,
    brightness: 0.5
  }
  const range = { min: 2000, max: 6000 }

  function fakeCtx() {
    const rects = []
    const texts = []
    const strokes = []
    const fills = []
    let path = null
    const ctx = {
      fillStyle: null,
      globalAlpha: 1,
      fillRect: (x, y, w, h) => rects.push({ x, y, w, h, fill: ctx.fillStyle }),
      beginPath: () => (path = null),
      roundRect: (x, y, w, h) => (path = { x, y, w, h }),
      fill: () => rects.push({ ...path, fill: ctx.fillStyle }),
      createLinearGradient: () => ({
        stops: [],
        addColorStop(o, c) {
          this.stops.push([o, c])
        }
      }),
      strokeText: (text) => strokes.push({ text, color: ctx.strokeStyle, width: ctx.lineWidth }),
      fillText: (text) => {
        texts.push(text)
        fills.push({ text, color: ctx.fillStyle })
      },
      measureText: (text) => ({ width: text.length * 10 })
    }
    return { ctx, rects, texts, strokes, fills }
  }

  it('dims the same background for both roles', () => {
    const color = viewFor(ROLE_COLOR, light, range)
    const brightness = viewFor(ROLE_BRIGHTNESS, light, range)
    expect(color.background).toEqual(brightness.background)
    expect(color.background).toEqual([0, 128, 128])
  })

  it('keeps a trace of the color at zero brightness', () => {
    const view = viewFor(ROLE_COLOR, { ...light, brightness: 0 }, range)
    expect(view.background).toEqual([0, 31, 31])
  })

  it('paints background, black border, bar, then a black marker', () => {
    const { ctx, rects } = fakeCtx()
    drawStrip(ctx, viewFor(ROLE_COLOR, light, range))
    expect(rects.map((r) => r.fill)).toEqual([
      '#000',
      expect.stringMatching(/^rgb/),
      '#000',
      expect.anything(),
      '#fff',
      '#000'
    ])
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: STRIP.width, h: STRIP.height })
    const marker = rects.at(-1)
    expect(marker.x + marker.w / 2).toBeCloseTo(BAR.x + BAR.width / 2)
    expect(rects[2].w).toBe(BAR.width + BAR.border * 2)
  })

  it('shows only the value as text, with no labels', () => {
    const color = fakeCtx()
    drawStrip(color.ctx, viewFor(ROLE_COLOR, light, range))
    expect(color.texts).toEqual(['Cyan'])
    const level = fakeCtx()
    drawStrip(level.ctx, viewFor(ROLE_BRIGHTNESS, light, range))
    expect(level.texts).toEqual(['50%'])
    const white = fakeCtx()
    drawStrip(white.ctx, viewFor(ROLE_COLOR, { ...light, mode: MODE_WHITE }, range))
    expect(white.texts).toEqual(['3000 K'])
  })

  it('draws white text with a black outline on every color and brightness', () => {
    for (const hue of [0, 60, 120, 240]) {
      for (const brightness of [0.1, 0.5, 1]) {
        const { ctx, strokes, fills } = fakeCtx()
        drawStrip(ctx, {
          ...viewFor(ROLE_COLOR, { ...light, colorPosition: hue / 360, brightness }, range)
        })
        expect(fills.at(-1).color).toBe('#ffffff')
        expect(strokes.at(-1).color).toBe('#000000')
      }
    }
  })

  it('outlines the value before filling it, so the fill stays on top', () => {
    const order = []
    const { ctx } = fakeCtx()
    const stroke = ctx.strokeText
    const fill = ctx.fillText
    ctx.strokeText = (...a) => (order.push('stroke'), stroke(...a))
    ctx.fillText = (...a) => (order.push('fill'), fill(...a))
    drawStrip(ctx, viewFor(ROLE_COLOR, light, range))
    expect(order).toEqual(['stroke', 'fill'])
  })

  it('uses the configured text and outline colors', () => {
    const { ctx, strokes, fills } = fakeCtx()
    drawStrip(ctx, {
      ...viewFor(ROLE_COLOR, light, range),
      textColor: '#000000',
      outlineColor: '#ffffff'
    })
    expect(fills.at(-1).color).toBe('#000000')
    expect(strokes.at(-1).color).toBe('#ffffff')
  })

  it('a dial passes its text colors to its strip, ignoring invalid ones', () => {
    const custom = setup(colorState(120), { textColor: '#102030', outlineColor: '#aabbcc' })
    custom.dial.syncFromState('R', colorState(120))
    expect(custom.lastView()).toMatchObject({ textColor: '#102030', outlineColor: '#aabbcc' })
    const bad = setup(colorState(120), { textColor: 'red', outlineColor: 42 })
    bad.dial.syncFromState('R', colorState(120))
    expect(bad.lastView()).toMatchObject({ textColor: '#ffffff', outlineColor: '#000000' })
  })

  it('keeps the marker visible at both ends', () => {
    for (const position of [0, 1]) {
      const { ctx, rects } = fakeCtx()
      drawStrip(ctx, viewFor(ROLE_BRIGHTNESS, { ...light, brightness: position }, range))
      const marker = rects.at(-1)
      expect(marker.x).toBeGreaterThanOrEqual(BAR.x - BAR.border)
      expect(marker.x + marker.w).toBeLessThanOrEqual(BAR.x + BAR.width + BAR.border)
    }
  })
})

describe('LinkedDials', () => {
  it('renders on every tick and starts from the real hue', () => {
    const { dial, lastView } = setup(colorState(180))
    dial.rotate('R', 5)
    expect(lastView().position).toBeCloseTo(0.6)
    dial.rotate('R', 5)
    expect(lastView().position).toBeCloseTo(0.7)
  })

  it('changing color updates the brightness dial background', () => {
    const { dial, lastView } = setup(colorState(0, 255))
    dial.rotate('R', 25)
    expect(lastView('L').background).toEqual(hueToRgb(180))
    expect(lastView('L').background).toEqual(lastView('R').background)
    expect(lastView('L').position).toBeCloseTo(1)
  })

  it('changing brightness dims the color dial background', () => {
    const { dial, lastView } = setup(colorState(120, 255))
    dial.rotate('L', -10)
    expect(lastView('L').position).toBeCloseTo(0.5)
    expect(lastView('R').background).toEqual([0, 128, 0])
    expect(lastView('R').position).toBeCloseTo(1 / 3)
  })

  it('sends brightness as a percentage', async () => {
    const { dial, deps } = setup(colorState(0, 255))
    dial.rotate('L', -10)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.send.mock.calls[0]).toEqual(['light.x', { brightness_pct: 50 }, 'L'])
  })

  it('stops brightness at each end', () => {
    const { dial, lastView } = setup(colorState(0, 128))
    dial.rotate('L', 100)
    expect(lastView('L').position).toBe(1)
    dial.rotate('L', -100)
    expect(lastView('L').position).toBe(0)
  })

  it('a push during a color turn still updates brightness, and vice versa', () => {
    const { dial, lastView } = setup(colorState(0, 255))
    dial.rotate('R', 25)
    dial.syncFromState('R', colorState(10, 51))
    expect(lastView('R').position).toBeCloseTo(0.5)
    expect(lastView('R').background).toEqual(hueToRgb(180).map((v) => Math.round(v * 0.2)))
  })

  it('live mode: sends while turning, one call at a time, with the newest value', async () => {
    const { dial, deps } = setup(colorState(0))
    dial.rotate('R', 5)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(deps.send.mock.calls[0][1].rgb_color).toEqual(hueToRgb(36))
    dial.rotate('R', 5)
    dial.rotate('R', 5)
    await vi.advanceTimersByTimeAsync(299)
    expect(deps.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.send).toHaveBeenCalledTimes(2)
    expect(deps.send.mock.calls[1][1].rgb_color).toEqual(hueToRgb(108))
  })

  it('idle mode: sends once after the dial stops', async () => {
    const { dial, deps } = setup(colorState(0), { sendMode: 'idle' })
    dial.rotate('R', 5)
    await vi.advanceTimersByTimeAsync(400)
    dial.rotate('R', 5)
    await vi.advanceTimersByTimeAsync(400)
    expect(deps.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(deps.send.mock.calls[0][1].rgb_color).toEqual(hueToRgb(72))
  })

  it('idle mode: a turn during a call sends again after the dial stops', async () => {
    let release
    const { dial, deps } = setup(colorState(0), { sendMode: 'idle' })
    deps.send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    dial.rotate('R', 5)
    await vi.advanceTimersByTimeAsync(500)
    dial.rotate('R', 5)
    release(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(deps.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.send).toHaveBeenCalledTimes(2)
  })

  it('a press switches modes and applies the warm default', async () => {
    const { dial, deps, lastView } = setup(colorState(0))
    dial.toggleMode('R')
    expect(lastView().bar).toBe('white')
    expect(lastView('L').bar).toBe('level')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.send.mock.calls[0][1]).toEqual({ color_temp_kelvin: 3000 })
  })

  it('a press from white goes back to the remembered color', async () => {
    const { dial, deps, lastView } = setup(colorState(120))
    dial.toggleMode('R')
    await vi.advanceTimersByTimeAsync(400)
    dial.toggleMode('R')
    expect(lastView().bar).toBe('hue')
    expect(lastView().position).toBeCloseTo(1 / 3)
    await vi.advanceTimersByTimeAsync(400)
    expect(deps.send.mock.calls[1][1].rgb_color).toEqual(hueToRgb(120))
  })

  it('white runs cool on the left to warm on the right, and stops at each end', async () => {
    const { dial, deps, lastView } = setup(whiteState(5900))
    dial.rotate('R', -50)
    expect(lastView().position).toBe(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.send.mock.calls[0][1]).toEqual({ color_temp_kelvin: 6000 })
    dial.rotate('R', 200)
    expect(lastView().position).toBe(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(deps.send.mock.calls[1][1]).toEqual({ color_temp_kelvin: 2000 })
  })

  it('keeps the current mode when an off light reports none', () => {
    const { dial, lastView } = setup(whiteState(3000))
    dial.syncFromState('R', whiteState(3000))
    dial.syncFromState('R', { state: 'off', attributes: {} })
    expect(lastView().bar).toBe('white')
    expect(lastView('R').background).toEqual(
      viewFor(
        ROLE_COLOR,
        { mode: MODE_WHITE, whitePosition: 0.75, brightness: 0 },
        {
          min: 2000,
          max: 6000
        }
      ).background
    )
  })

  it('ignores color pushes during a turn, then corrects after settling', async () => {
    const { dial, setState, lastView } = setup(colorState(0))
    dial.rotate('R', 25)
    await vi.advanceTimersByTimeAsync(0)
    setState(colorState(10))
    dial.syncFromState('R', colorState(10))
    expect(lastView().position).toBeCloseTo(0.5)
    expect(dial.isPending('R')).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(dial.isPending('R')).toBe(false)
    expect(lastView().position).toBeCloseTo(10 / 360)
  })

  it('does not drag the marker back while a slow light is still reporting', async () => {
    const { dial, setState, lastView } = setup(whiteState(6000))
    dial.rotate('R', 50)
    await vi.advanceTimersByTimeAsync(0)
    expect(lastView().position).toBe(1)
    await vi.advanceTimersByTimeAsync(2500)
    setState(whiteState(3000))
    dial.syncFromState('R', whiteState(3000))
    await vi.advanceTimersByTimeAsync(600)
    expect(dial.isPending('R')).toBe(true)
    expect(lastView().position).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    setState(whiteState(2000))
    dial.syncFromState('R', whiteState(2000))
    await vi.advanceTimersByTimeAsync(3000)
    expect(dial.isPending('R')).toBe(false)
    expect(lastView().position).toBe(1)
  })

  it('stops waiting for a light that never goes quiet', async () => {
    const { dial, setState, lastView } = setup(whiteState(6000))
    dial.rotate('R', 50)
    await vi.advanceTimersByTimeAsync(0)
    for (let t = 0; t < 24; t++) {
      setState(whiteState(3000))
      dial.syncFromState('R', whiteState(3000))
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(dial.isPending('R')).toBe(false)
    expect(lastView().position).toBeCloseTo(0.75)
  })

  it('keeps the marker when the light reports nearly the same hue', async () => {
    const { dial, setState, lastView } = setup(colorState(0))
    dial.rotate('R', 25)
    setState(colorState(183))
    await vi.advanceTimersByTimeAsync(3000)
    expect(lastView().position).toBeCloseTo(0.5)
  })

  it('treats hues either side of red as close', () => {
    const { dial, lastView } = setup(colorState(358))
    dial.syncFromState('R', colorState(358))
    dial.syncFromState('R', colorState(2))
    expect(lastView().position).toBeCloseTo(358 / 360)
  })

  it('a failed call corrects from the real state at once', async () => {
    const { dial, deps, lastView } = setup(colorState(0))
    deps.send.mockResolvedValue(false)
    dial.rotate('R', 25)
    await vi.advanceTimersByTimeAsync(5)
    expect(dial.isPending('R')).toBe(false)
    expect(lastView().position).toBeCloseTo(0)
  })

  it('still sends a turn when its dial has left the screen', async () => {
    const { dial, deps, dialSettings } = setup(colorState(0))
    dial.rotate('R', 5)
    delete dialSettings.R
    await vi.advanceTimersByTimeAsync(5)
    expect(deps.send).toHaveBeenCalledTimes(1)
  })
})
