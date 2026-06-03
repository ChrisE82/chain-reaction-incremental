/**
 * gamepad.js — Xbox-standard gamepad navigation for Chain Reaction: Idle
 *
 * Navigation zones:
 *   'canvas'  — default; left stick moves aim cursor, A taps, Y ends round
 *   'sidebar' — D-pad navigates [data-nav] items in #shop-panel, A confirms, B returns
 *   'topbar'  — D-pad left/right cycles [data-nav] items in #top-bar, B returns
 *   'overlay' — focus trapped inside an overlay container; B closes
 *
 * Mouse movement hides the aim cursor and suppresses .gp-focused.
 * Gamepad stick movement shows the cursor and re-enables .gp-focused.
 */

// ── Button indices (Xbox / standard mapping) ──────────────────────────────
const BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  LS: 10, RS: 11,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
}

const DEADZONE          = 0.18
const CURSOR_SPEED      = 40    // virtual units per second
const REPEAT_INITIAL_MS = 400   // delay before held D-pad starts repeating
const REPEAT_INTERVAL_MS = 120  // interval between repeats once started

// ── Internal state ────────────────────────────────────────────────────────
let _zone          = 'canvas'   // current navigation zone
let _overlayEl     = null       // element to trap focus in when zone === 'overlay'
let _focusedEl     = null       // currently .gp-focused element
let _navIdx        = 0          // index within current zone's navItems

let _cursorX       = 50         // virtual world coords (0–VIRTUAL_W)
let _cursorY       = 75         // virtual world coords (0–VIRTUAL_H)
let _cursorActive  = false      // true when gamepad stick is in use

let _gpMode        = false      // true once a gamepad has been seen
let _mouseSuppressed = false    // true while gamepad is driving input

// Per-button hold-repeat state
const _btnState = {}

// Callbacks wired by main.js
let _onTap        = null   // (x, y) → trigger ball at cursor
let _onEndRound   = null   // () → endRoundEarly()
let _onTogglePanel = null  // () → toggle left panel
let _onCloseOverlay = null // () → close active overlay (B button)

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Call once at startup. Wires the gamepadconnected event and callback hooks.
 * @param {{ onTap, onEndRound, onTogglePanel, onCloseOverlay, virtualW, virtualH }} opts
 */
export function initGamepad(opts = {}) {
  _onTap          = opts.onTap          ?? null
  _onEndRound     = opts.onEndRound     ?? null
  _onTogglePanel  = opts.onTogglePanel  ?? null
  _onCloseOverlay = opts.onCloseOverlay ?? null
  _VIRTUAL_W      = opts.virtualW       ?? 100
  _VIRTUAL_H      = opts.virtualH       ?? 150
  _cursorX = _VIRTUAL_W / 2
  _cursorY = _VIRTUAL_H / 2

  window.addEventListener('gamepadconnected', e => {
    _gpMode = true
    console.log('[gamepad] connected:', e.gamepad.id)
  })
  window.addEventListener('gamepaddisconnected', () => {
    if (navigator.getGamepads().every(g => !g)) {
      _gpMode = false
      _cursorActive = false
      clearFocus()
    }
  })

  // Mouse movement: suppress gamepad cursor
  window.addEventListener('mousemove', () => {
    if (_cursorActive) {
      _cursorActive = false
      clearFocus()
    }
    document.body.classList.remove('gp-active')
  }, { passive: true })
}

let _VIRTUAL_W = 100
let _VIRTUAL_H = 150

/**
 * Call every frame from the main loop.
 * @param {number} dt  Delta-time in milliseconds
 */
export function updateGamepad(dt) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : []
  let gp = null
  for (const p of pads) { if (p) { gp = p; break } }
  if (!gp) return

  _gpMode = true

  // ── Read buttons ─────────────────────────────────────────────────────
  const prev = {}
  for (const [name, idx] of Object.entries(BTN)) {
    const s   = _btnState[idx] ?? { pressed: false, heldMs: 0, fired: false }
    const now = gp.buttons[idx]?.pressed ?? false
    prev[idx] = s.pressed
    if (now && !s.pressed) {
      // Fresh press
      s.pressed = true; s.heldMs = 0; s.fired = false
      _handleBtn(name, idx, 'press', dt)
    } else if (now && s.pressed) {
      // Held
      s.heldMs += dt
      if (s.heldMs >= REPEAT_INITIAL_MS && !s.fired) {
        s.fired = true
        _handleBtn(name, idx, 'repeat', dt)
      } else if (s.fired && s.heldMs >= REPEAT_INITIAL_MS + REPEAT_INTERVAL_MS) {
        s.heldMs = REPEAT_INITIAL_MS
        _handleBtn(name, idx, 'repeat', dt)
      }
    } else {
      s.pressed = false; s.heldMs = 0; s.fired = false
    }
    _btnState[idx] = s
  }

  // ── Left stick: move cursor (canvas zone only) ────────────────────────
  const ax = applyDeadzone(gp.axes[0] ?? 0)
  const ay = applyDeadzone(gp.axes[1] ?? 0)
  if (_zone === 'canvas' && (ax !== 0 || ay !== 0)) {
    _cursorActive = true
    document.body.classList.add('gp-active')
    const speed = CURSOR_SPEED * (dt / 1000)
    _cursorX = Math.max(0, Math.min(_VIRTUAL_W, _cursorX + ax * speed))
    _cursorY = Math.max(0, Math.min(_VIRTUAL_H, _cursorY + ay * speed))
  }
}

/**
 * Returns the current aim cursor state in virtual world coordinates.
 * @returns {{ x: number, y: number, active: boolean }}
 */
export function getAimCursor() {
  return { x: _cursorX, y: _cursorY, active: _cursorActive }
}

/**
 * Programmatically move GP focus to a specific element.
 * @param {Element|null} el
 */
export function gpFocus(el) {
  clearFocus()
  if (!el) return
  _focusedEl = el
  el.classList.add('gp-focused')
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

/**
 * Lock navigation into a specific overlay container (focus trap).
 * Pass null to release.
 * @param {Element|null} container
 */
export function setOverlayZone(container) {
  if (container) {
    _zone      = 'overlay'
    _overlayEl = container
    _navIdx    = 0
    const items = _navItems()
    if (items.length) gpFocus(items[0])
  } else {
    _zone      = 'canvas'
    _overlayEl = null
    clearFocus()
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

function applyDeadzone(v) {
  return Math.abs(v) < DEADZONE ? 0 : v
}

function clearFocus() {
  if (_focusedEl) { _focusedEl.classList.remove('gp-focused'); _focusedEl = null }
  document.querySelectorAll('.gp-focused').forEach(el => el.classList.remove('gp-focused'))
}

/** Return all navigable items in the current zone container. */
function _navItems() {
  let container
  switch (_zone) {
    case 'canvas':  return []
    case 'topbar':  container = document.getElementById('top-bar');    break
    case 'sidebar': container = document.getElementById('shop-panel'); break
    case 'overlay': container = _overlayEl;                            break
    default:        return []
  }
  return container ? [...container.querySelectorAll('[data-nav]')] : []
}

/** Move focus up/down within the current zone. dir: -1 = up, +1 = down */
function _moveFocus(dir) {
  const items = _navItems()
  if (!items.length) return
  _navIdx = Math.max(0, Math.min(items.length - 1, _navIdx + dir))
  gpFocus(items[_navIdx])
}

/** Move focus left/right within the current zone. */
function _moveFocusH(dir) {
  _moveFocus(dir)   // same linear movement for now
}

function _handleBtn(name, idx, kind, dt) {
  switch (_zone) {
    case 'canvas':   _handleCanvas(name, kind); break
    case 'topbar':   _handleTopbar(name, kind); break
    case 'sidebar':  _handleSidebar(name, kind); break
    case 'overlay':  _handleOverlay(name, kind); break
  }
}

function _handleCanvas(name, kind) {
  if (kind !== 'press' && kind !== 'repeat') return
  switch (name) {
    case 'A':
      if (_cursorActive && _onTap) _onTap(_cursorX, _cursorY)
      break
    case 'Y':
      if (_onEndRound) _onEndRound()
      break
    case 'START':
      if (_onTogglePanel) _onTogglePanel()
      break
    case 'LB':
      _zone = 'topbar'; _navIdx = 0
      const tbItems = _navItems()
      if (tbItems.length) gpFocus(tbItems[0])
      break
    case 'RB':
      _zone = 'sidebar'; _navIdx = 0
      const sbItems = _navItems()
      if (sbItems.length) gpFocus(sbItems[0])
      break
  }
}

function _handleTopbar(name, kind) {
  if (kind !== 'press' && kind !== 'repeat') return
  switch (name) {
    case 'DPAD_LEFT':  _moveFocusH(-1); break
    case 'DPAD_RIGHT': _moveFocusH(+1); break
    case 'A':
      if (_focusedEl) _focusedEl.click()
      break
    case 'B':
      clearFocus(); _zone = 'canvas'
      break
    case 'START':
      if (_onTogglePanel) _onTogglePanel()
      break
  }
}

function _handleSidebar(name, kind) {
  if (kind !== 'press' && kind !== 'repeat') return
  switch (name) {
    case 'DPAD_UP':   _moveFocus(-1); break
    case 'DPAD_DOWN': _moveFocus(+1); break
    case 'A':
      if (_focusedEl) _focusedEl.click()
      break
    case 'B':
      clearFocus(); _zone = 'canvas'
      break
    case 'START':
      if (_onTogglePanel) _onTogglePanel()
      break
  }
}

function _handleOverlay(name, kind) {
  if (kind !== 'press' && kind !== 'repeat') return
  switch (name) {
    case 'DPAD_UP':    _moveFocus(-1); break
    case 'DPAD_DOWN':  _moveFocus(+1); break
    case 'DPAD_LEFT':  _moveFocusH(-1); break
    case 'DPAD_RIGHT': _moveFocusH(+1); break
    case 'A':
      if (_focusedEl) _focusedEl.click()
      break
    case 'B':
      if (_onCloseOverlay) _onCloseOverlay()
      clearFocus(); _zone = 'canvas'; _overlayEl = null
      break
  }
}
