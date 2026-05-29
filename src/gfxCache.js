// src/gfxCache.js — pre-rendered neon ball sprite cache.
//
// Each ball sprite has two painted layers:
//
//   1. Atmospheric glow haze
//      A soft, foggy bloom of the ball's colour that extends `pad` virtual
//      units beyond the ball's radius.  Peaks at the ball edge, fades to
//      transparent at the canvas edge.  This gives idle balls an ambient
//      neon glow without any per-frame shadow work on the main ctx.
//
//   2. Ball body — neon tube gradient
//      Clipped to the ball circle so it never bleeds into the haze zone.
//      white-hot core → bright colour ring → full neon colour → darker rim.
//      Mimics a real neon-gas tube: the inner plasma is almost white, the
//      glass wall is the saturated colour, the outer edge is slightly cooler.
//
// shadowBlur for active/popping balls is still applied on the main ctx —
// it accumulates on top of the sprite's built-in haze for extra pop.

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
 * The canvas is intentionally larger than the ball by `pad` virtual units on
 * every side so the atmospheric glow haze can bleed beyond the ball boundary.
 * Draw it centred on the ball:
 *
 *   ctx.drawImage(sp.canvas,
 *     b.x - sp.halfSize, b.y - sp.halfSize,
 *     sp.halfSize * 2,   sp.halfSize * 2)
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

  // Canvas dimensions — extra `pad` vunits on each side for the glow haze.
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

  // ── Layer 1: Atmospheric glow haze ────────────────────────────────────
  //
  // The gradient runs from the canvas centre to its corner (= ctr px).
  // edgeStop marks where the ball boundary sits as a fraction of that range.
  // The haze peaks at the ball edge and fades to nothing at the canvas edge.
  // The body layer drawn next covers everything inside the ball circle.
  const edgeStop = rPx / ctr   // e.g. ≈0.667 for a typical ball

  const glowGrad = cx.createRadialGradient(ctr, ctr, 0, ctr, ctr, ctr)
  glowGrad.addColorStop(0,                              `rgba(${cr},${cg},${cb},0.08)`)
  glowGrad.addColorStop(edgeStop * 0.75,                `rgba(${cr},${cg},${cb},0.45)`)
  glowGrad.addColorStop(edgeStop,                       `rgba(${cr},${cg},${cb},0.65)`)
  glowGrad.addColorStop(Math.min(0.98, edgeStop + 0.10),`rgba(${cr},${cg},${cb},0.30)`)
  glowGrad.addColorStop(1,                              `rgba(${cr},${cg},${cb},0.00)`)

  cx.fillStyle = glowGrad
  cx.fillRect(0, 0, sizePx, sizePx)

  // ── Layer 2: Ball body — neon tube gradient ────────────────────────────
  //
  // Clipped to the ball arc so the body never bleeds into the haze zone.
  //   centre  → #ffffff     : white-hot plasma core
  //   20%     → lightColor  : bright saturated colour ring
  //   58%     → color       : main neon colour
  //   100%    → darkened    : slightly cooler glass-wall rim
  cx.save()
  cx.beginPath()
  cx.arc(ctr, ctr, rPx, 0, Math.PI * 2)
  cx.clip()

  const darkR = Math.max(0, cr - 45)
  const darkG = Math.max(0, cg - 45)
  const darkB = Math.max(0, cb - 45)

  const bodyGrad = cx.createRadialGradient(ctr, ctr, 0, ctr, ctr, rPx)
  bodyGrad.addColorStop(0,    '#ffffff')
  bodyGrad.addColorStop(0.20, lightColor)
  bodyGrad.addColorStop(0.58, color)
  bodyGrad.addColorStop(1,    `rgb(${darkR},${darkG},${darkB})`)

  cx.fillStyle = bodyGrad
  cx.fillRect(0, 0, sizePx, sizePx)

  cx.restore()

  e = { canvas: c, halfSize: halfV }
  _cache.set(key, e)
  _count++
  return e
}

/** Number of sprites currently cached (dev/debug use). */
export function getSpriteCount() { return _count }
