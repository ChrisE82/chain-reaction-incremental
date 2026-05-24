// src/armedHold.js — tap-once + press-and-hold repeat purchasing
// Applied to color bucket upgrade buttons and the quick-buy BUY button.
//
// State machine:
//   IDLE
//     → pointerdown (affordable) → PENDING_FIRST
//   PENDING_FIRST
//     → pointerup → performBuy() → ARMED  (1200 ms window starts)
//   ARMED  (same key still)
//     → pointerdown → HOLDING  (250 ms hold timer starts)
//   HOLDING
//     → pointerup before 250 ms → performBuy() → ARMED  (window resets)
//     → 250 ms elapsed          → performBuy() → REPEATING
//   REPEATING  (accelerating: 240 ms → 90 ms min, ×0.88 per fire)
//     → pointerup / cancel / blur → IDLE
//   ARMED
//     → 1200 ms elapsed → IDLE
//   ARMED + pointerdown different key → IDLE (new key goes to PENDING_FIRST)

const ARMED_WINDOW_MS  = 1200
const HOLD_DELAY_MS    = 250
const INITIAL_INTERVAL = 240
const MIN_INTERVAL     = 90
const ACCELERATION     = 0.88

// ── Module-level state (survives buildShop() DOM rebuilds) ─────────────────
let _armedKey       = null   // key in armed window, or null
let _armedTimer     = null   // setTimeout — expires armed window
let _pendingKey     = null   // key pressed down on first (unarmed) press
let _holdKey        = null   // key held down on second (armed) press
let _holdTimer      = null   // setTimeout — fires after HOLD_DELAY_MS
let _repeatKey      = null   // key currently firing repeat purchases
let _repeatTimer    = null   // setTimeout — next repeat fire
let _repeatInterval = INITIAL_INTERVAL
const _callbacks    = {}     // key → { performBuy, canBuy }
let _winAttached    = false

// ── Internal helpers ───────────────────────────────────────────────────────

function _el(key) {
  return document.querySelector(`[data-upg-key="${key}"]`)
}

function _cls(key, cls, on) {
  const el = _el(key)
  if (el) el.classList.toggle(cls, on)
}

function _clearArmed() {
  if (_armedTimer) { clearTimeout(_armedTimer); _armedTimer = null }
  if (_armedKey)   { _cls(_armedKey, 'upg-armed', false); _armedKey = null }
}

function _clearHold() {
  if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null }
  if (_holdKey)   { _cls(_holdKey, 'upg-holding', false); _holdKey = null }
}

function _clearRepeat() {
  if (_repeatTimer) { clearTimeout(_repeatTimer); _repeatTimer = null }
  if (_repeatKey)   { _cls(_repeatKey, 'upg-repeating', false); _repeatKey = null }
  _repeatInterval = INITIAL_INTERVAL
}

function _arm(key) {
  _clearArmed()
  _armedKey = key
  _cls(key, 'upg-armed', true)
  _armedTimer = setTimeout(() => {
    _cls(key, 'upg-armed', false)
    _armedKey = null
    _armedTimer = null
  }, ARMED_WINDOW_MS)
}

// Pop animation — called AFTER performBuy() so the element is fresh from buildShop().
function _pop(key) {
  const el = _el(key)
  if (!el) return
  el.classList.add('upg-pop')
  el.addEventListener('animationend', () => el.classList.remove('upg-pop'), { once: true })
}

function _startRepeat(key) {
  _clearHold()
  const cb = _callbacks[key]
  if (!cb?.canBuy()) { _clearArmed(); _detachWin(); return }

  _repeatKey = key
  _cls(key, 'upg-repeating', true)
  _repeatInterval = INITIAL_INTERVAL

  function _fire() {
    const liveCb = _callbacks[key]   // always fresh — buildShop() updates _callbacks[key]
    if (!liveCb?.canBuy()) {
      _clearRepeat(); _clearArmed(); _detachWin()
      return
    }
    liveCb.performBuy()   // may trigger buildShop() — element rebuilt after this line
    _pop(key)
    _repeatInterval = Math.max(MIN_INTERVAL, _repeatInterval * ACCELERATION)
    _repeatTimer = setTimeout(_fire, _repeatInterval)
  }

  // First repeat fire
  cb.performBuy()
  _pop(key)
  _repeatInterval = Math.max(MIN_INTERVAL, _repeatInterval * ACCELERATION)
  _repeatTimer = setTimeout(_fire, _repeatInterval)
}

// ── Window-level release handler ───────────────────────────────────────────

function _onWinUp(e) {
  if (!e.isPrimary) return

  if (_repeatKey) {
    _clearRepeat(); _clearArmed(); _detachWin()
    return
  }

  if (_holdKey) {
    // Released before hold threshold — second single purchase, re-arm.
    // Arm BEFORE performBuy() so _armedKey is already set when buildShop() runs
    // inside performBuy() — the freshly-created DOM element then immediately
    // receives the correct upg-armed class and the second press can't race past
    // an unset _armedKey even if the user's finger is already coming back down.
    const key = _holdKey
    _clearHold()
    _arm(key)
    const cb = _callbacks[key]
    if (cb?.canBuy()) { cb.performBuy(); _pop(key) }
    _detachWin()
    return
  }

  if (_pendingKey) {
    // First tap complete — single purchase, then arm.
    // Arm BEFORE performBuy() for the same reason: _armedKey must be set before
    // any DOM rebuild so the rebuilt element is immediately treated as armed.
    const key = _pendingKey
    _pendingKey = null
    _arm(key)
    const cb = _callbacks[key]
    if (cb?.canBuy()) { cb.performBuy(); _pop(key) }
    _detachWin()
    return
  }

  _detachWin()
}

function _onWinBlur() {
  _clearRepeat(); _clearHold(); _clearArmed()
  _pendingKey = null
  _detachWin()
}

function _attachWin() {
  if (_winAttached) return
  _winAttached = true
  window.addEventListener('pointerup',     _onWinUp,   { passive: true })
  window.addEventListener('pointercancel', _onWinUp,   { passive: true })
  window.addEventListener('blur',          _onWinBlur, { passive: true })
}

function _detachWin() {
  if (!_winAttached) return
  _winAttached = false
  window.removeEventListener('pointerup',     _onWinUp)
  window.removeEventListener('pointercancel', _onWinUp)
  window.removeEventListener('blur',          _onWinBlur)
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Attach tap-once + press-and-hold repeat behavior to an upgrade button.
 * Safe to call on every buildShop() rebuild — state persists in module vars.
 *
 * @param {HTMLElement} el          The button element
 * @param {string}      key         Unique key, e.g. "violet-speed" or "qb-buy"
 * @param {Function}    performBuy  Called on each purchase; may call buildShop()
 * @param {Function}    canBuy      Returns true when the purchase is affordable
 */
export function attachArmedHold(el, key, performBuy, canBuy) {
  el.setAttribute('data-upg-key', key)
  _callbacks[key] = { performBuy, canBuy }

  // Restore visual state after DOM rebuild
  el.classList.toggle('upg-armed',     _armedKey  === key)
  el.classList.toggle('upg-holding',   _holdKey   === key)
  el.classList.toggle('upg-repeating', _repeatKey === key)

  el.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return
    e.stopPropagation()

    if (_armedKey === key) {
      // Second press on armed button → start hold phase
      _clearArmed()
      _holdKey = key
      _cls(key, 'upg-holding', true)
      _holdTimer = setTimeout(() => _startRepeat(key), HOLD_DELAY_MS)
      _attachWin()
    } else {
      // First press — only track if affordable (don't steal arm from another key)
      const cb = _callbacks[key]
      if (cb?.canBuy()) {
        _clearArmed()
        _pendingKey = key
        _attachWin()
      }
    }
  }, { passive: true })
}

/**
 * Cancel all state immediately.
 * Call on pagehide, window blur, and when the shop closes.
 */
export function cancelAll() {
  _clearRepeat(); _clearHold(); _clearArmed()
  _pendingKey = null
  _detachWin()
}
