# Instant dial feedback (optimistic display and read-back)

Turning a dial used to feel laggy: the plugin batched ticks for 300 ms, called Home Assistant, and only
repainted the strip when Home Assistant pushed the new state back, which for many lights is a second or
more. Now, for each turn:

1. **Render**: the new position is drawn on the strip immediately, as the entity would look at that value.
2. **Send**: ticks are batched for a short window (default 100 ms) and sent as one service call.
3. **Read back**: after the last send, the plugin waits (default 800 ms), asks Home Assistant what the
   entity really is, and repaints from that. If the value is still catching up (a fading light), it looks
   again a few times, then accepts whatever Home Assistant reports.

While a turn is outstanding the dial ignores state pushes, so the display does not flicker back to older
values. A failed service call triggers the read-back at once.

## Supported entities

`light` (brightness), `media_player` (volume), `cover` (position), `fan` (percentage), `number` and
`input_number` (percent of min..max). Other domains behave as before: no instant display, but the dial still
benefits from the shorter batching window and the entity fallback below.

## Settings (Rotation tab)

| Setting | Default | Notes |
|---|---|---|
| Tick bucket size | 100 ms | `0` now really means one call per tick (it used to be treated as 300) |
| Instant feedback | on | `optimisticDisplay` |
| Read-back delay | 800 ms | `readbackDelayMs` |
| Minimum send interval | 250 ms | `minSendIntervalMs` |
| Device wait timeout | 3000 ms | `deviceTimeoutMs`: wait for the device to reach the last target before the next call; `0` turns this off |

Existing actions keep whatever bucket size they saved; the new settings default when missing, so no settings
migration is needed.

## Other changes

- The rotation service now targets the dial's display entity when it has no entity of its own and the
  service is in the same domain (for example `light.turn_on` on a light). Previously a rotation call with no
  entity reached Home Assistant with no target.
- The dial position is initialised from the real entity state. Before, `rotationPercent` counted up from 0
  regardless of the light's actual brightness.
- Timers run in a Web Worker (`workerTimers.js`), because Chromium clamps timers in the hidden plugin page to
  about once per second.
- Only one service call is in flight per dial, and the next waits for the minimum interval and the device.

## Light dials: color and brightness (`dialStyle`)

Two extra dial styles for lights, set in the Rotation tab. They draw their own strip (a caption, a
large value and a slim black-bordered bar with a marker) and share one model per light, so dials on the
same light always agree.

- **Color and white bar** (`color`): a hue bar that wraps at the ends, or a white temperature bar (cool on
  the left, warm on the right) that stops at the ends. A press switches between them.
- **Brightness bar** (`brightness`): a dark-to-color bar with the percentage.
- Every strip's background is the selected color dimmed to the selected brightness, and turning either
  dial repaints both at once.
- Color and brightness are separate channels: while one has a turn outstanding, state pushes do not move
  its marker, and it settles only after the light's reports have gone quiet (a slow light can report old
  values for seconds). Code: `src/modules/plugin/colorDial.js`.

### Sending (all dial styles)

| Setting | Default | Notes |
|---|---|---|
| Update the light (`sendMode`) | While turning | `idle` sends one call after the dial stops, for slow lights that lag or jump |
| Wait after stopping (`idleSendMs`) | 500 ms | `idle` mode only |
| Update speed (`minSendIntervalMs`) | 250-300 ms | live mode only: minimum time between updates |

The strip always updates at once; only the call to the light waits.

## Known limitation: slow lights

With the same build and settings, a Yeelight lamp and a Lutron Caseta dimmer showed no visible jumping and
reached their targets on the first read-back. A Govee H6056 light bar controlled through MQTT still visibly
jumps back during a turn. Its reported brightness also fell during one turn while the calls sent were all rising.
The cause on the Govee path has not been established, and the behaviour was accepted rather than fixed.

## Code map

- `src/modules/plugin/dialModel.js`: pure state to percent and back, per domain.
- `src/modules/plugin/dialRotation.js`: the controller (timers, coalesced rendering, read-back). No DOM or
  Home Assistant dependencies; everything is injected.
- `src/modules/homeassistant/homeassistant.js`: `getState(entityId)` for the read-back.
- `src/components/PluginComponent.vue`: wires the controller to rendering and service calls.
- `src/modules/plugin/colorDial.js`: the linked color and brightness dials and their strip drawing.
- `src/modules/common/workerTimers.js`: timers that are not clamped in the hidden page.
- Tests: `dialModel.test.js`, `dialRotation.test.js`, `workerTimers.test.js`, `colorDial.test.js` (`npm test`).
