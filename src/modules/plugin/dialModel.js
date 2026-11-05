// Pure helpers that map a Home Assistant entity state to a 0-100 dial position
// and back. They let a dial show the value you are turning it to *before*
// Home Assistant (and the device) have caught up.
//
// Only domains with an obvious single "level" are supported. For any other
// domain `percentFromState` returns null and the dial keeps its classic
// behaviour (no optimistic display).

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Each model: percentFromState(state) -> 0..100 | null,
//             patchForPercent(state, percent) -> { state?, attributes? } (undefined attribute = delete)
const MODELS = {
  light: {
    percentFromState(s) {
      if (s.state === 'off') return 0
      const brightness = numberOrNull(s.attributes?.brightness)
      if (brightness !== null) return clamp((brightness / 255) * 100, 0, 100)
      return s.state === 'on' ? 100 : null
    },
    patchForPercent(s, percent) {
      if (percent <= 0) return { state: 'off', attributes: { brightness: undefined } }
      // (percent / 100) * 255, not percent * 2.55: the latter gives 127.49999 at 50%.
      return {
        state: 'on',
        attributes: { brightness: Math.max(1, Math.round((percent / 100) * 255)) }
      }
    }
  },

  media_player: {
    percentFromState(s) {
      const volume = numberOrNull(s.attributes?.volume_level)
      return volume === null ? null : clamp(volume * 100, 0, 100)
    },
    patchForPercent(s, percent) {
      return { attributes: { volume_level: Math.round(percent) / 100 } }
    }
  },

  cover: {
    percentFromState(s) {
      const position = numberOrNull(s.attributes?.current_position)
      return position === null ? null : clamp(position, 0, 100)
    },
    patchForPercent(s, percent) {
      return {
        state: percent > 0 ? 'open' : 'closed',
        attributes: { current_position: Math.round(percent) }
      }
    }
  },

  fan: {
    percentFromState(s) {
      if (s.state === 'off') return 0
      const percentage = numberOrNull(s.attributes?.percentage)
      return percentage === null ? null : clamp(percentage, 0, 100)
    },
    patchForPercent(s, percent) {
      return {
        state: percent > 0 ? 'on' : 'off',
        attributes: { percentage: Math.round(percent) }
      }
    }
  }
}

// number / input_number: percent of the min..max range.
const rangeModel = {
  percentFromState(s) {
    const value = numberOrNull(s.state)
    const min = numberOrNull(s.attributes?.min)
    const max = numberOrNull(s.attributes?.max)
    if (value === null || min === null || max === null || max <= min) return null
    return clamp(((value - min) / (max - min)) * 100, 0, 100)
  },
  patchForPercent(s, percent) {
    const min = numberOrNull(s.attributes?.min)
    const max = numberOrNull(s.attributes?.max)
    const step = numberOrNull(s.attributes?.step)
    let value = min + (percent / 100) * (max - min)
    if (step && step > 0) value = min + Math.round((value - min) / step) * step
    value = clamp(value, min, max)
    // Trim float noise such as 0.30000000000000004
    return { state: String(Math.round(value * 1e6) / 1e6) }
  }
}
MODELS.number = rangeModel
MODELS.input_number = rangeModel

export function supportsDial(domain) {
  return Object.hasOwn(MODELS, domain)
}

/** Current dial position (0-100) for a state, or null when unknown/unsupported. */
export function percentFromState(domain, state) {
  if (!state || !supportsDial(domain)) return null
  return MODELS[domain].percentFromState(state)
}

/**
 * A copy of `state` as it would look at `percent`. Never mutates the input.
 * Returns null for unsupported domains or states that can't be modelled.
 */
export function applyPercent(domain, state, percent) {
  if (!state || !supportsDial(domain) || !Number.isFinite(percent)) return null
  const p = clamp(percent, 0, 100)
  if (MODELS[domain].percentFromState(state) === null) return null
  const patch = MODELS[domain].patchForPercent(state, p)
  const attributes = { ...state.attributes }
  for (const [key, value] of Object.entries(patch.attributes ?? {})) {
    if (value === undefined) delete attributes[key]
    else attributes[key] = value
  }
  return { ...state, state: patch.state ?? state.state, attributes }
}
