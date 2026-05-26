// src/gfxCache.js — pre-rendered ball sprite cache.
//
// Eliminates ctx.createRadialGradient on every frame for every ball.
// Each unique (color, lightColor, radiusBucket, resolution) is rendered once
// to an offscreen canvas; subsequent frames call drawImage instead.
//
// shadowBlur for active balls is left on the main ctx — it applies to drawImage
// just like any other draw call, so the existing glow behaviour is unchanged.

let _ballRes = 12   // px per virtual unit; set by setSpriteRes() from calcUnits()

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

/**
 * Call from calcUnits() as setSpriteRes(gameScale * _dpr).
 * Clears stale sprites when the screen density changes.
 */
export function setSpriteRes(res) {
  const r = Math.max(8, Math.ceil(res))
  if (r === _ballRes) return
  _ballRes = r
  _cache.clear()
  _count = 0
}

/**
 * Returns a cached offscreen canvas containing the ball's gradient fill.
 * Draw it centred on the ball: ctx.drawImage(sp.canvas, b.x - sp.halfSize, b.y - sp.halfSize, sp.halfSize*2, sp.halfSize*2)
 *
 * @param {string} color
 * @param {string} lightColor
 * @param {number} r  ball radius in virtual units
 */
export function getBallSprite(color, lightColor, r) {
  const rB  = Math.round(r * 4) / 4                 // 0.25 vunit precision
  const key = `${color}|${lightColor}|${rB}|${_ballRes}`

  let e = _cache.get(key)
  if (e) return e

  const pad    = 1                                   // transparent 1-vunit border
  const halfV  = rB + pad
  const sizePx = halfV * 2 * _ballRes

  const c   = _makeCanvas(sizePx, sizePx)
  const cx  = c.getContext('2d')
  const ctr = halfV * _ballRes
  const rPx = rB   * _ballRes
  const off = rPx  * 0.3                            // highlight offset (upper-left)

  cx.imageSmoothingEnabled = true
  cx.imageSmoothingQuality = 'high'

  const grad = cx.createRadialGradient(ctr - off, ctr - off, 0, ctr, ctr, rPx)
  grad.addColorStop(0, lightColor)
  grad.addColorStop(1, color)

  cx.beginPath()
  cx.arc(ctr, ctr, rPx, 0, Math.PI * 2)
  cx.fillStyle = grad
  cx.fill()

  e = { canvas: c, halfSize: halfV }
  _cache.set(key, e)
  _count++
  return e
}

/** Number of sprites currently cached. */
export function getSpriteCount() { return _count }

/** Clear all cached sprites (e.g. on full reset). */
export function clearSpriteCache() { _cache.clear(); _count = 0 }
