// src/gfxCache.js — pre-rendered neon ball sprite cache.

let _ballRes = 12   // px per virtual unit; updated by setSpriteRes()

const _cache = new Map()
let   _count = 0

function _makeCanvas(w, h) {
  const cw = Math.max(1, Math.ceil(w))
  const ch = Math.max(1, Math.ceil(h))
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(cw, ch)
  const c = document.createElement('canvas')
  c.width = cw; c.height = ch
  return c
}

/** Parse a 6-digit hex colour string to [r, g, b] integers. */
function _hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

/**
 * Call from calcUnits() as setSpriteRes(gameScale * _dpr).
 * Clears stale sprites when screen density or scale changes.
 */
export function setSpriteRes(res) {
  const r = Math.max(8, Math.ceil(res))
  if (r === _ballRes) return
  _ballRes = r
  _cache.clear()
  _count = 0
}

/**
 * Returns a cached offscreen canvas with a neon ball rendered on it.
 *
 * @param {string} color       hex colour string, e.g. '#cc00ff'
 * @param {string} lightColor  lightened rgb string, e.g. 'rgb(255,80,255)'
 * @param {number} r           ball radius in virtual units
 */
export function getBallSprite(color, lightColor, r) {
  const rB  = Math.round(r * 4) / 4                   // 0.25-vunit precision
  const key = `${color}|${rB}|${_ballRes}`

  let e = _cache.get(key)
  if (e) return e

  const pad    = 2.5
  const halfV  = rB + pad
  const sizePx = halfV * 2 * _ballRes

  const c   = _makeCanvas(sizePx, sizePx)
  const cx  = c.getContext('2d')
  const ctr = halfV * _ballRes    // pixel centre of the canvas
  const rPx = rB   * _ballRes    // ball radius in pixels

  const [cr, cg, cb] = _hexToRgb(color)

  cx.imageSmoothingEnabled = true
  cx.imageSmoothingQuality = 'high'

  // ── Layer 1: Outer glow ring ───────────────────────────────────────────
  // Transparent inside the ball, peaks at full color right at the ball edge,
  // fades to transparent at the canvas edge.
  const edgeStop = rPx / ctr

  const glowGrad = cx.createRadialGradient(ctr, ctr, 0, ctr, ctr, ctr)
  glowGrad.addColorStop(0,        `rgba(${cr},${cg},${cb},0.00)`)
  glowGrad.addColorStop(edgeStop, `rgba(${cr},${cg},${cb},1.00)`)
  glowGrad.addColorStop(1,        `rgba(${cr},${cg},${cb},0.00)`)

  cx.fillStyle = glowGrad
  cx.fillRect(0, 0, sizePx, sizePx)

  // ── Layer 2: Ball body — flat lightColor fill ──────────────────────────
  cx.save()
  cx.beginPath()
  cx.arc(ctr, ctr, rPx, 0, Math.PI * 2)
  cx.clip()

  cx.fillStyle = lightColor
  cx.fillRect(0, 0, sizePx, sizePx)

  // Color border ring at ball edge
  cx.strokeStyle = color
  cx.lineWidth   = rPx * 0.05
  cx.beginPath()
  cx.arc(ctr, ctr, rPx - cx.lineWidth / 2, 0, Math.PI * 2)
  cx.stroke()

  cx.restore()

  e = { canvas: c, halfSize: halfV }
  _cache.set(key, e)
  _count++
  return e
}

/** Number of sprites currently cached (dev/debug use). */
export function getSpriteCount() { return _count }
