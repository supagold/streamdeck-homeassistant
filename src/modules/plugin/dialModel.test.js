import { describe, expect, it } from 'vitest'
import { applyPercent, percentFromState, supportsDial } from './dialModel.js'

const light = (state, attributes = {}) => ({ entity_id: 'light.x', state, attributes })

describe('supportsDial', () => {
  it('knows the supported domains', () => {
    for (const d of ['light', 'media_player', 'cover', 'fan', 'number', 'input_number']) {
      expect(supportsDial(d)).toBe(true)
    }
    expect(supportsDial('switch')).toBe(false)
    expect(supportsDial('sensor')).toBe(false)
    expect(supportsDial('toString')).toBe(false)
  })
})

describe('light', () => {
  it('reads brightness as a percentage', () => {
    expect(percentFromState('light', light('on', { brightness: 255 }))).toBe(100)
    expect(percentFromState('light', light('on', { brightness: 128 }))).toBeCloseTo(50.2, 1)
  })

  it('is 0 when off and 100 when on without a brightness attribute', () => {
    expect(percentFromState('light', light('off'))).toBe(0)
    expect(percentFromState('light', light('on'))).toBe(100)
  })

  it('is unknown for unavailable lights', () => {
    expect(percentFromState('light', light('unavailable'))).toBeNull()
    expect(applyPercent('light', light('unavailable'), 50)).toBeNull()
  })

  it('applies a percentage without mutating the input', () => {
    const before = light('on', { brightness: 10, friendly_name: 'Desk' })
    const copy = JSON.parse(JSON.stringify(before))
    const after = applyPercent('light', before, 50)
    expect(after.state).toBe('on')
    expect(after.attributes.brightness).toBe(128)
    expect(after.attributes.friendly_name).toBe('Desk')
    expect(before).toEqual(copy)
  })

  it('turns off at 0% and drops the brightness attribute', () => {
    const after = applyPercent('light', light('on', { brightness: 40 }), 0)
    expect(after.state).toBe('off')
    expect('brightness' in after.attributes).toBe(false)
  })

  it('turns an off light on when the percentage rises, never below brightness 1', () => {
    const after = applyPercent('light', light('off'), 0.1)
    expect(after.state).toBe('on')
    expect(after.attributes.brightness).toBe(1)
  })

  it('clamps out-of-range percentages', () => {
    expect(applyPercent('light', light('on', { brightness: 1 }), 250).attributes.brightness).toBe(
      255
    )
    expect(applyPercent('light', light('on', { brightness: 1 }), -5).state).toBe('off')
  })

  it('round-trips within a point', () => {
    for (let p = 5; p <= 100; p += 5) {
      const back = percentFromState(
        'light',
        applyPercent('light', light('on', { brightness: 1 }), p)
      )
      expect(Math.abs(back - p)).toBeLessThan(1)
    }
  })
})

describe('other domains', () => {
  it('media_player volume', () => {
    const s = { state: 'playing', attributes: { volume_level: 0.4 } }
    expect(percentFromState('media_player', s)).toBe(40)
    expect(applyPercent('media_player', s, 75).attributes.volume_level).toBe(0.75)
    expect(percentFromState('media_player', { state: 'off', attributes: {} })).toBeNull()
  })

  it('cover position', () => {
    const s = { state: 'open', attributes: { current_position: 30 } }
    expect(percentFromState('cover', s)).toBe(30)
    const after = applyPercent('cover', s, 0)
    expect(after.state).toBe('closed')
    expect(after.attributes.current_position).toBe(0)
  })

  it('fan percentage', () => {
    expect(percentFromState('fan', { state: 'off', attributes: {} })).toBe(0)
    const s = { state: 'on', attributes: { percentage: 66 } }
    expect(percentFromState('fan', s)).toBe(66)
    expect(applyPercent('fan', s, 0).state).toBe('off')
  })

  it('number honours min, max and step', () => {
    const s = { state: '10', attributes: { min: 0, max: 20, step: 5 } }
    expect(percentFromState('input_number', s)).toBe(50)
    expect(applyPercent('input_number', s, 80).state).toBe('15')
    expect(applyPercent('input_number', s, 100).state).toBe('20')
  })

  it('number without a usable range is unknown', () => {
    expect(percentFromState('number', { state: '5', attributes: {} })).toBeNull()
    expect(
      percentFromState('number', { state: 'unknown', attributes: { min: 0, max: 10 } })
    ).toBeNull()
  })

  it('unsupported domains are unknown', () => {
    expect(percentFromState('switch', { state: 'on', attributes: {} })).toBeNull()
    expect(applyPercent('switch', { state: 'on', attributes: {} }, 10)).toBeNull()
  })
})
