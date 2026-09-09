# Upstream Sync Memo

## Upstream: MrCreativ3001/moonlight-web-stream
- Remote name: `upstream`
- Last commit checked: `09848de` (upstream/master) — "chore: bump version to 3.0.0-prerelease.2"
- Date of sync review: 2026-08-15
- Previous sync point: `9e2fed0` (2025-07-09)
- Merge base: `653558efddb7958419a129f06b6fc1965b1d2d9d`
- New commits in this review: 173 (`git log 9e2fed0..upstream/master`)

## Structure Difference
Upstream restructured paths in v2:
- `moonlight-web/web-server/web/` → `web/`
- `moonlight-web/streamer/` → `streamer/`
- `moonlight-web/web-server/src/` → `src/`

Our fork keeps the old path structure.

### v3 rewrite (2026-08) — the big one
Upstream merged `feat/stream-rework` at `6cda105` and is now on `3.0.0-prerelease.2`.
This is a **second** architectural rewrite on top of v2:
- `moonlight-common-rust` compiled to WASM via uniffi and run **in the browser**
- webpack build pipeline (replaces plain `tsc`)
- WHEP-based streaming, reworked control stream over enet
- rustls replaces OpenSSL — **and upstream deleted their custom cross images as
  no longer needed** (`65dbab3`). Relevant to our build pain, but a large change.
- reworked config system, i18n, multi-user roles/permissions

**Consequence for future syncs:** of the 173 new commits, only 10 were on the
pre-v3 master line; the other 163 are written against an architecture we don't
share. Filter with `git merge-base --is-ancestor <commit> 6cda105^1` to tell a
v2-line commit from a v3 one. Post-v3 upstream commits are generally **not**
cherry-pickable — they must be re-implemented, if they apply at all.

## Commits Ported

| Commit | Description | Notes |
|--------|-------------|-------|
| 8c86da6 | Improve touch pointer interactions | touchGestureSuppressClick, touch cleanup |
| 9652280 | Suppress touch clicks after pointer movement | Part of touch fix series |
| 9539f31 | Prevent touch gestures from producing stray clicks | Part of touch fix series |
| 55e5ebf | Accumulated scrolling for mouse+touch, sendText buffer fix | Mouse wheel + touch scroll accumulation, buffer.reset() in sendText |
| 75f9d0a | Controller channel buffering check | Added readyState check in onGamepadConnect |
| 9e2fed0 | Screen keyboard rewrite | textarea, sentinel, compositionend, floating button |
| 1a4f093 | Modal abort race condition fix | Use local abortController ref |
| 6a3c406 | AbortController polyfill | New polyfill files for Tesla browser compatibility |
| 44b95ba | Paste text to host | Ctrl+V passthrough + onPaste handler (minus raiseAllKeys which doesn't exist) |
| 882eafa | F11 fullscreen passthrough | Allow browser-native F11 |
| 2197926 | Mouse buttons X1/X2 | Extended StreamMouseButton + BUTTON_MAPPINGS |
| 716042a | More keyboard keys | Enabled PageUp, Delete, End, PageDown, NumpadDivide, Home, Insert |
| 50fe9af | navigator.keyboard.lock in iframe | requestKeyboardLock helper for iframe environments |

### 2026-08-15 review (9e2fed0 → 09848de)

| Commit | Description | Notes |
|--------|-------------|-------|
| a7631c3 | Keyboard viewport adjustment (#138) | Adapted: `KeyboardModeWillChangeEvent` in screen_keyboard.ts + viewport offset in stream.ts. CSS folded into our single `styles.css`. |
| ed51100 | Keyboard viewport adjustment, non-local-cursor mode | Only this branch of the logic applies — we have no local-cursor mode, so upstream's cursor-tracking path was dropped. |
| 55391a9 | Launch-time stream settings via query params | Adapted to our `StreamSettings`: `bitrate`, `fps`, `videoSize`, `videoSizeCustom.width/height`. No `hdr`/`dataTransport`/`language` in our fork. Added numeric validation upstream lacks. |

Deviations worth remembering:
- Upstream drives the viewport update from a **permanent rAF loop**; we drive it
  from `visualViewport` resize/scroll events instead — our `onTouchUpdate` only
  runs while touch/gamepad polling is active, and a always-on rAF is exactly the
  kind of cost this fork avoids.
- Our `getStreamRect()` **caches**. The offset moves the element without
  resizing it, so neither the resize listener nor the ResizeObserver fires —
  `setStreamVideoOffset()` clears `cachedStreamRect` by hand. Without that,
  touch/mouse coordinates stay mapped to the old position.
- The floating keyboard button needed `margin:0` — the global `button { margin: 8px }`
  was shifting it, because `top`/`right` on a fixed element offset the *margin* edge.
- **The video offset is a no-op on our default config** (`canvasRenderer: true` +
  `stretchToFit: true` = full-viewport canvas, so there is no slack to lift into).
  It becomes active for the `<video>` element path and letterboxed canvas.
- **And it is inert on the Tesla entirely**: the Tesla on-screen keyboard opens
  *over* the page without resizing the viewport, so `visualViewport` never
  shrinks and the whole adjustment never engages. The port is carried for other
  browsers (phone/tablet against the same server), not for the car.
- Because of that, the shrink test (`KEYBOARD_VIEWPORT_SHRINK_MIN_PX`) gates the
  floating **button** as well as the video. Without that gate a visualViewport
  resize from an unrelated cause (rotation, window resize) would park the
  hide-keyboard button at the bottom of the screen — directly underneath an
  overlay keyboard, where it can't be tapped.

## Commits Skipped (with reasons)

### Not applicable to our architecture
- **WebSocket transport commits** (ac37db5 etc.): We use WebRTC only
- **libopenh264/libopus WASM decoders**: Tesla has native codec support
- **Multi-user auth/roles/admin** (d98793f-3c61a9f): We use single-user TOTP auth
- **i18n system** (multiple): Not needed for single-user Tesla use
- **Docker/CI commits** (bb73052, ea6be14, etc.): Infrastructure-specific
- **Rust streamer changes** (7611bdf, bbde312, etc.): Our streamer layer is different
- **v2 migration** (c4af773 onwards): Complete rewrite of server architecture

### Already applied or not needed
- 772a41c (video size for stream rect): Uses VideoElementRenderer class not in our fork
- 0a9d16c (WebRTC signaling race): Rust transport layer completely different
- 240ed9a (document-level event listeners): Already in our code
- 73b57ae (video min-width/min-height 100vmin): Already applied
- 8e1bf00 (mouse move based on screen size): Already have sendMouseMoveClientCoordinates
- 229365d (smooth touch scrolling): Superseded by accumulated scroll approach
- f4391f6 (touch relative mode scroll fix): Already applied
- 3a8c738 (keys in fullscreen/pointer lock): Already have document listeners + input div
- 2e73f39 (stopPropagationOn helper): Already have it
- 81ee2e5 (sidebar touch fix): Already applied
- db30f6c (gamepad vibration Safari fix): Already have collectActuators
- 51367f4 (key events sent twice): Already have stopPropagation in all handlers
- 0218191 (fullscreen support check): Already handled
- 81b1393 (unadjusted movement): Already have it
- ce3a7ea (text field overflow fix): Already in styles.css
- c352f60 (window.errors displayed): Already have error/rejection handlers
- 23bce22 (screen keyboard backspace): Superseded by full rewrite (9e2fed0)

### Not relevant for Tesla browser
- 98c86c4 (iOS right-click polyfill): Safari-only, uses navigator.vendor check
- adb8256 (PWA/add to homescreen): Not useful on Tesla
- 4f44c03 (fullscreen-triggered remote input): v2 architecture feature
- a62764f (auto fullscreen on first remote input): v2 feature addition
- cb171ab (stacked action buttons fix): v2 CSS structure

### Cosmetic/README/Docs
- 0140714, b269a43, 6f58578, 0cd6961, 9e1c3a1, etc.

## Commits Skipped — 2026-08-15 review

### v2-line, not applicable
- `752d8bd` (fix bad header length in websocket): we are WebRTC-only
- `301ad07` (fix pairing timeout): **already present** in our `web/api.ts` —
  we have `noTimeout` plus a dangling-timer cleanup upstream lacks

### v3-line, checked and rejected
- `8f3c49d` (clamp negative frame durations): looked high-value — u32 µs timestamp
  wraps every ~71 min and the negative delta throws in `EncodedVideoChunk` — but
  **N/A**: we have no manual depacketize path. Video arrives on a native WebRTC
  transceiver and the browser stack handles it. No `EncodedVideoChunk` in our tree.
- `3079171` (VideoDecoder codec-string level vs stream dimensions): only touches
  our *capability probe* (`VideoDecoder.isConfigSupported`), not a decode path.
  Worth noting though: our probe string is `avc1.4d400c` = **level 1.2** while we
  run 1080p60, so the probe asks an optimistic question. Latent, not a bug.
- `e5ea7e3`/`d10b9b9` (sidebar hide-until-hover): needs i18n + `styles/standard.css`
- `843ae22`, `d1a431d`, `1f9fad1`: v3 `stream.ts`/`input.ts` internals
- `ffc1659` (forwarded header ignore case): server-side, our `src/` layer differs.
  Could matter behind a reverse proxy — revisit if that ever bites.
- `4ed7242`: removed client batching "because it caused mouse stuttering" —
  independent corroboration of our own pass-3 batching revert. Nothing to port.

## How to Repeat This Process

1. `git fetch upstream`
2. New commits since last review: `git log <last-checked>..upstream/master --oneline --reverse`
   (record the hash in the header above rather than a commit *count* — counts go
   stale the moment upstream force-pushes or merges a branch)
3. Split v2-line from v3-line: `git merge-base --is-ancestor <commit> 6cda105^1`
   — exit 0 means pre-v3 and plausibly cherry-pickable
4. For each candidate, check what it touches: `git show <hash> --stat`
5. If relevant, get diff: `git show <hash> -- moonlight-web/web-server/web/ web/`
6. Adapt path from upstream's `web/` to our `moonlight-web/web-server/web/`
7. **Check the ported code against our divergences** before trusting it: cached
   `getStreamRect()`, no local-cursor mode, single `styles.css`, canvas renderer
   default, no i18n, WebRTC-only transport
8. After porting, run `npm run build-light` in `moonlight-web/web-server/`
9. Update this memo with new commits ported/skipped
