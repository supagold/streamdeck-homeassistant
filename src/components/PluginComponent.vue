<template>
  <span>Nothing to see here!</span>
</template>

<script setup>
import { GlobalSettings, Settings, DEFAULT_LABEL_FONT_SIZE } from '@/modules/common/settings'
import { StreamDeck } from '@/modules/common/streamdeck'
import { LruCache } from '@/modules/common/lruCache'
import { Homeassistant } from '@/modules/homeassistant/homeassistant'
import { EntityConfigFactory } from '@/modules/plugin/entityConfigFactoryNg'
import { DialRotation } from '@/modules/plugin/dialRotation'
import { createWorkerTimers } from '@/modules/common/workerTimers'
import { applyPercent, percentFromState } from '@/modules/plugin/dialModel'
import { SvgUtils, WIDTH, HEIGHT } from '@/modules/plugin/svgUtils'
import { fetchRemoteYaml } from '@/modules/common/remoteConfig'
import nunjucksEnv from '../modules/common/nunjucksEnv.js'
import { onMounted, ref, shallowRef } from 'vue'
import defaultActiveStates from '../../public/config/active-states.yml'

let entityConfigFactory
const svgUtils = new SvgUtils()

const imageCache = new LruCache(30)

async function fetchEntityPictureAsDataUri(entityPictureUrl, serverUrl) {
  const fullUrl = entityPictureUrl.startsWith('http')
    ? entityPictureUrl
    : serverUrl.replace(/\/$/, '') + entityPictureUrl

  const cached = imageCache.get(fullUrl)
  if (cached) return cached

  try {
    const response = await fetch(fullUrl)
    if (!response.ok) return null
    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(blobUrl)
        const canvas = document.createElement('canvas')
        canvas.width = WIDTH
        canvas.height = HEIGHT
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, WIDTH, HEIGHT)
        const scale = Math.max(WIDTH / img.width, HEIGHT / img.height)
        const w = img.width * scale
        const h = img.height * scale
        ctx.drawImage(img, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h)
        const dataUri = canvas.toDataURL('image/jpeg', 0.2)
        imageCache.set(fullUrl, dataUri)
        resolve(dataUri)
      }
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl)
        resolve(null)
      }
      img.src = blobUrl
    })
  } catch {
    return null
  }
}

// shallowRef: a deep ref would wrap the instances in reactive proxies,
// which breaks classes with private (#) members — private-field brand
// checks fail when `this` is the proxy instead of the raw instance.
const $SD = shallowRef(null)
const $HA = shallowRef(null)
let reconnectTimeout = null
const globalSettings = ref({})
const actionSettings = ref({})
const buttonLongpressTimeouts = new Map()
let haEntitySubscription = null
let subscriptionGeneration = 0
// Tracks the latest render started per context so stale async renders
// (slow entity picture fetch, SVG rasterization) never overwrite newer ones.
const renderGeneration = new Map()

const activeStates = ref(defaultActiveStates)

// Latest known (enriched) state per entity, kept even while a dial is mid-turn.
const lastStates = new Map()

const entityDomain = (entityId) => entityId.split('.')[0]
const displayEntityId = (context) => actionSettings.value[context]?.display.entityId

const dialTimers = createWorkerTimers()

// Dial turns: optimistic display -> batched service call -> read-back.
// See src/modules/plugin/dialRotation.js
const dials = new DialRotation({
  getSettings: (context) => actionSettings.value[context],
  getInitialPercent: knownPercent,
  send: sendRotation,
  render: renderOptimistic,
  readback: readbackState,
  settle: settleDial,
  peekPercent: knownPercent,
  // Hidden plugin pages clamp setTimeout to ~1 s; worker timers keep their precision.
  timers: dialTimers,
  log: (context, message) => $SD.value?.log(`dial ${context.slice(0, 6)}: ${message}`)
})

onMounted(async () => {
  window.connectElgatoStreamDeckSocket = (inPort, inPluginUUID, inRegisterEvent, inInfo) => {
    $SD.value = new StreamDeck(inPort, inPluginUUID, inRegisterEvent, inInfo, '{}')

    $SD.value.on('globalsettings', (inGlobalSettings) => {
      $SD.value.log('Got global settings.')
      $SD.value.log(`dial timers: ${dialTimers.kind}`)
      const originalJson = JSON.stringify(inGlobalSettings)
      const migratedSettings = GlobalSettings.migrate(inGlobalSettings)
      if (JSON.stringify(migratedSettings) !== originalJson) {
        $SD.value.saveGlobalSettings(migratedSettings)
      }
      globalSettings.value = migratedSettings
      const configUrl =
        migratedSettings.displayConfiguration?.urlOverride ||
        migratedSettings.displayConfiguration?.url
      entityConfigFactory = new EntityConfigFactory(
        configUrl ? () => fetchRemoteYaml(configUrl) : null
      )
      reconnectDelayMs = RECONNECT_BASE_DELAY_MS
      connectHomeAssistant()
    })

    $SD.value.on('connected', () => {
      $SD.value.requestGlobalSettings()
    })

    $SD.value.on('keyDown', (message) => {
      buttonDown(message.context)
    })

    $SD.value.on('keyUp', (message) => {
      buttonUp(message.context)
    })

    $SD.value.on('willAppear', (message) => {
      let context = message.context
      actionSettings.value[context] = Settings.parse(message.payload.settings)
      if ($HA.value) {
        $HA.value.getStatesDebounced(entityStatesChanged)
        resubscribeEntities()
      }
    })

    $SD.value.on('willDisappear', (message) => {
      let context = message.context
      delete actionSettings.value[context]
      renderGeneration.delete(context)
      dials.dispose(context)
      resubscribeEntities()
    })

    $SD.value.on('dialRotate', (message) => {
      dials.rotate(message.context, message.payload.ticks)
    })

    $SD.value.on('dialDown', (message) => {
      buttonDown(message.context)
    })

    $SD.value.on('dialUp', (message) => {
      buttonUp(message.context)
    })

    $SD.value.on('touchTap', (message) => {
      let context = message.context
      let settings = actionSettings.value[context]
      if (!settings) return
      callService(context, settings.button.serviceTap)
    })

    $SD.value.on('didReceiveSettings', (message) => {
      let context = message.context
      actionSettings.value[context] = Settings.parse(message.payload.settings)
      if ($HA.value) {
        $HA.value.getStatesDebounced(entityStatesChanged)
        resubscribeEntities()
      }
    })
  }

  await fetchActiveStates()
})

async function fetchActiveStates() {
  try {
    activeStates.value = await fetchRemoteYaml(
      'https://cdn.jsdelivr.net/gh/cgiesche/streamdeck-homeassistant@master/public/config/active-states.yml'
    )
  } catch (error) {
    console.log(`Failed to download updated active-states.yml: ${error}`)
  }
}

function connectHomeAssistant() {
  console.log('Connecting to Home Assistant')
  if (globalSettings.value.serverUrl && globalSettings.value.accessToken) {
    if ($HA.value) {
      $HA.value.close()
    }
    console.log('Connecting to Home Assistant ' + globalSettings.value.serverUrl)
    $HA.value = new Homeassistant(
      globalSettings.value.serverUrl,
      globalSettings.value.accessToken,
      onHAConnected,
      onHAError,
      onHAClosed
    )
  }
}

const RECONNECT_BASE_DELAY_MS = 5000
const RECONNECT_MAX_DELAY_MS = 60000
let reconnectDelayMs = RECONNECT_BASE_DELAY_MS

const onHAConnected = () => {
  reconnectDelayMs = RECONNECT_BASE_DELAY_MS
  $HA.value.getStatesDebounced(entityStatesChanged)
  resubscribeEntities()
}

function onHAError(msg, { isAuthError = false } = {}) {
  console.log(`Home Assistant connection error: ${msg}`)
  if (isAuthError) {
    // Retrying cannot fix an invalid token; wait for new global settings.
    haEntitySubscription = null
    showAlert()
    window.clearTimeout(reconnectTimeout)
    return
  }
  scheduleReconnect()
}

function onHAClosed(msg) {
  console.log(`Home Assistant connection closed, trying to reopen connection: ${msg}`)
  scheduleReconnect()
}

function scheduleReconnect() {
  haEntitySubscription = null
  showAlert()
  window.clearTimeout(reconnectTimeout)
  reconnectTimeout = window.setTimeout(connectHomeAssistant, reconnectDelayMs)
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS)
}

function getConfiguredEntityIds() {
  return [
    ...new Set(
      Object.values(actionSettings.value)
        .map((s) => s.display.entityId)
        .filter(Boolean)
    )
  ]
}

async function resubscribeEntities() {
  if (!$HA.value) return
  const generation = ++subscriptionGeneration

  if (haEntitySubscription) {
    const unsubscribe = haEntitySubscription
    haEntitySubscription = null
    try {
      await unsubscribe()
    } catch {
      // connection may already be gone
    }
  }

  const entityIds = getConfiguredEntityIds()
  if (entityIds.length === 0) return

  let subscription = null
  try {
    subscription = await $HA.value.subscribeEntitiesChanged(entityIds, entityStateChanged)
  } catch (e) {
    console.log(`Failed to subscribe to entity changes: ${e}`)
    return
  }

  if (generation !== subscriptionGeneration) {
    // A newer resubscribe started while we were awaiting; discard this one.
    try {
      await subscription?.()
    } catch {
      // ignore
    }
    return
  }
  haEntitySubscription = subscription
}

function showAlert() {
  Object.keys(actionSettings.value).forEach((key) => $SD.value.showAlert(key))
}

function entityStatesChanged(event) {
  event.forEach(updateState)
}

function entityStateChanged(event) {
  const newState = event?.variables?.trigger?.to_state
  if (newState) {
    updateState(newState)
  }
}

function updateState(stateMessage) {
  if (!stateMessage.entity_id) {
    console.log(`Missing entity_id in updated state: ${JSON.stringify(stateMessage)}`)
    return
  }

  const domain = entityDomain(stateMessage.entity_id)
  const changedContexts = Object.keys(actionSettings.value).filter(
    (key) => actionSettings.value[key].display.entityId === stateMessage.entity_id
  )
  const enrichedState = cacheState(stateMessage)

  changedContexts.forEach((context) => {
    // A dial that is mid-turn keeps showing the value it is being turned to;
    // the read-back repaints it from the cached state when things have settled.
    if (dials.isPending(context)) return
    renderState(context, domain, enrichedState)
    dials.syncFromState(context, percentFromState(domain, enrichedState))
  })
}

function enrichState(stateMessage) {
  const enrichedState = {
    ...stateMessage,
    attributes: { ...stateMessage.attributes }
  }
  if (enrichedState.last_updated != null)
    enrichedState.attributes['last_updated'] = new Date(enrichedState.last_updated).toLocaleTimeString()
  if (enrichedState.last_changed != null)
    enrichedState.attributes['last_changed'] = new Date(enrichedState.last_changed).toLocaleTimeString()
  return enrichedState
}

function cacheState(stateMessage) {
  const enrichedState = enrichState(stateMessage)
  lastStates.set(enrichedState.entity_id, enrichedState)
  return enrichedState
}

// Starts a render and makes it the newest for the context; older async renders
// that finish later are discarded by the generation check in updateContextState.
function renderState(context, domain, state) {
  const generation = (renderGeneration.get(context) ?? 0) + 1
  renderGeneration.set(context, generation)
  return updateContextState(context, domain, state, generation).catch((e) => {
    console.error(e)
    $SD.value.setImage(context, null)
    $SD.value.showAlert(context)
  })
}

// ── Dial support (see DialRotation) ──────────────────────────────────────────

// Where the entity really is, 0-100, or null when unknown / not a supported domain.
function knownPercent(context) {
  const entityId = displayEntityId(context)
  const state = entityId && lastStates.get(entityId)
  return state ? percentFromState(entityDomain(entityId), state) : null
}

// Draw the entity as it would look at `percent`, ahead of Home Assistant.
function renderOptimistic(context, percent) {
  const entityId = displayEntityId(context)
  const base = entityId && lastStates.get(entityId)
  if (!base) return
  const domain = entityDomain(entityId)
  const state = applyPercent(domain, base, percent)
  if (!state) return
  return renderState(context, domain, state)
}

// Ask Home Assistant what the entity really is now; caches it (no repaint).
async function readbackState(context) {
  const entityId = displayEntityId(context)
  if (!entityId || !$HA.value) return null
  const state = await $HA.value.getState(entityId)
  if (!state) return null
  return percentFromState(entityDomain(entityId), cacheState(state))
}

// The dial is no longer pending: paint the real, cached state.
function settleDial(context) {
  const entityId = displayEntityId(context)
  const state = entityId && lastStates.get(entityId)
  if (!state) return
  const domain = entityDomain(entityId)
  renderState(context, domain, state)
  dials.syncFromState(context, percentFromState(domain, state))
}

function sendRotation(context, variables) {
  const settings = actionSettings.value[context]
  if (!settings) return Promise.resolve(false)
  return callService(context, settings.button.serviceRotation, variables, settings.display.entityId)
}

function isEncoder(contextSettings) {
  return contextSettings.controllerType === 'Encoder'
}

async function updateContextState(currentContext, domain, stateObject, generation) {
  const isStale = () => renderGeneration.get(currentContext) !== generation
  let contextSettings = actionSettings.value[currentContext]
  if (!contextSettings) return
  let renderingConfig = entityConfigFactory.determineConfig(
    domain,
    stateObject,
    contextSettings.display
  )

  const showIndicators = contextSettings.display.enableServiceIndicator
  renderingConfig.isAction = contextSettings.button.serviceShortPress.serviceId && showIndicators
  renderingConfig.isMultiAction =
    contextSettings.button.serviceLongPress.serviceId && showIndicators
  renderingConfig.labelFontSize = contextSettings.display.labelFontSize ?? DEFAULT_LABEL_FONT_SIZE

  if (contextSettings.display.useCustomTitle) {
    let state = stateObject.state
    let stateAttributes = stateObject.attributes
    renderingConfig.customTitle = nunjucksEnv.renderString(contextSettings.display.buttonTitle, {
      state,
      ...stateAttributes
    })
  }

  if (contextSettings.display.useCustomButtonLabels) {
    renderingConfig.labelTemplates = contextSettings.display.buttonLabels.split('\n')
  }

  if (!renderingConfig.color) {
    renderingConfig.color =
      activeStates.value.includes(stateObject.state)
        ? entityConfigFactory.colors.active
        : entityConfigFactory.colors.neutral
  }

  const entityPicture = stateObject.attributes?.entity_picture
  if (entityPicture && globalSettings.value?.serverUrl) {
    renderingConfig.backgroundImage = await fetchEntityPictureAsDataUri(
      entityPicture,
      globalSettings.value.serverUrl
    )
  }
  if (isStale()) return

  if (isEncoder(contextSettings)) {
    if (!renderingConfig.feedbackLayout) {
      renderingConfig.feedbackLayout = '$A1'
    }
    $SD.value.setFeedbackLayout(currentContext, { layout: renderingConfig.feedbackLayout })

    if (!renderingConfig.feedback) {
      renderingConfig.feedback = {}
    }
    renderingConfig.feedback.title = renderingConfig.customTitle ?? ''
    if (renderingConfig.feedback.value === undefined) {
      renderingConfig.feedback.value = svgUtils
        .renderTemplates(renderingConfig.labelTemplates, {
          ...stateObject.attributes,
          state: stateObject.state
        })
        .join(' ')
    }
    renderingConfig.feedback.icon = await svgUtils.svgToImageDataUri(
      svgUtils.renderButtonSVG({ ...renderingConfig, labelTemplates: [] }, stateObject),
      !renderingConfig.backgroundColor && !renderingConfig.backgroundImage
    )
    if (isStale()) return
    $SD.value.setFeedback(currentContext, renderingConfig.feedback)
  } else if (contextSettings.display.useStateImagesForOnOffStates) {
    if (renderingConfig.customTitle) {
      $SD.value.setTitle(currentContext, renderingConfig.customTitle)
    }
    if (activeStates.value.includes(stateObject.state)) {
      console.log('Setting state of ' + currentContext + ' to 1')
      $SD.value.setState(currentContext, 1)
    } else {
      console.log('Setting state of ' + currentContext + ' to 0')
      $SD.value.setState(currentContext, 0)
    }
  } else {
    if (renderingConfig.customTitle) {
      $SD.value.setTitle(currentContext, renderingConfig.customTitle)
    }
    const image = await svgUtils.svgToImageDataUri(
      svgUtils.renderButtonSVG(renderingConfig, stateObject),
      !renderingConfig.backgroundColor && !renderingConfig.backgroundImage
    )
    if (isStale()) return
    $SD.value.setImage(currentContext, image)
  }
}

function buttonDown(context) {
  const timeout = setTimeout(buttonLongPress, 300, context)
  buttonLongpressTimeouts.set(context, timeout)
}

function buttonUp(context) {
  // If "long press timeout" is still present, we perform a normal press
  const lpTimeout = buttonLongpressTimeouts.get(context)
  if (lpTimeout) {
    clearTimeout(lpTimeout)
    buttonLongpressTimeouts.delete(context)
    buttonShortPress(context)
  }
}

function buttonShortPress(context) {
  let settings = actionSettings.value[context]
  if (!settings) return
  callService(context, settings.button.serviceShortPress)
}

function buttonLongPress(context) {
  buttonLongpressTimeouts.delete(context)
  let settings = actionSettings.value[context]
  if (!settings) return
  if (settings.button.serviceLongPress.serviceId) {
    callService(context, settings.button.serviceLongPress)
  } else {
    callService(context, settings.button.serviceShortPress)
  }
}

// Resolves true when the call was made and accepted, false otherwise (an alert is
// shown on failure). Callers that don't care can ignore the result.
// `fallbackEntityId`: used as the target when the call has none of its own and the
// service is in the same domain as that entity (rotation has no entity field in the UI).
function callService(context, serviceToCall, serviceDataAttributes = {}, fallbackEntityId = '') {
  if (!serviceToCall['serviceId']) return Promise.resolve(false)

  try {
    let serviceData = null
    if (serviceToCall.serviceData) {
      let renderedServiceData = nunjucksEnv.renderString(
        serviceToCall.serviceData,
        serviceDataAttributes
      )
      serviceData = JSON.parse(renderedServiceData)
    }

    if (serviceToCall.serviceId === 'streamdeck.open_url') {
      const url = serviceData?.url
      if (url) {
        $SD.value.openUrl(url)
        return Promise.resolve(true)
      }
      $SD.value.showAlert(context)
      return Promise.resolve(false)
    }

    const serviceIdParts = serviceToCall.serviceId.split('.')
    const entityId =
      serviceToCall.entityId ||
      (fallbackEntityId && entityDomain(fallbackEntityId) === serviceIdParts[0] ? fallbackEntityId : '')
    if (!$HA.value) return Promise.resolve(false)
    return $HA.value
      .callService(serviceIdParts[0], serviceIdParts[1], entityId, serviceData)
      .then(() => true)
      .catch((e) => {
        console.error(e)
        $SD.value.showAlert(context)
        return false
      })
  } catch (e) {
    console.error(e)
    $SD.value.showAlert(context)
    return Promise.resolve(false)
  }
}
</script>
