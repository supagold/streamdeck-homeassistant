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

Existing actions keep whatever bucket size they saved; the new settings default when missing, so no settings
migration is needed.

## Other changes

- The rotation service now targets the dial's display entity when it has no entity of its own and the
  service is in the same domain (for example `light.turn_on` on a light). Previously a rotation call with no
  entity reached Home Assistant with no target.
- The dial position is initialised from the real entity state. Before, `rotationPercent` counted up from 0
  regardless of the light's actual brightness.

## Code map

- `src/modules/plugin/dialModel.js`: pure state to percent and back, per domain.
- `src/modules/plugin/dialRotation.js`: the controller (timers, coalesced rendering, read-back). No DOM or
  Home Assistant dependencies; everything is injected.
- `src/modules/homeassistant/homeassistant.js`: `getState(entityId)` for the read-back.
- `src/components/PluginComponent.vue`: wires the controller to rendering and service calls.
- Tests: `dialModel.test.js`, `dialRotation.test.js` (`npm test`).
