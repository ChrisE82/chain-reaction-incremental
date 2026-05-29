// src/engine/particles.js — particles, pop-rings, and floating coin/chain/clear labels.

import { rs } from './renderState.js'
import { fmt, fmtMult, fmtBonus } from '../ui/fmt.js'

// ─── Pop-ring shockwaves ───────────────────────────────────────────────────
// A fast outward ring fires the instant any ball is triggered, giving an
// immediate visual "punch" before the slow expansion bloom even starts.
// This makes even a single pop feel satisfying.

export const popRings = []

export function spawnPopRing(x, y, color, startR, endR, depth, pct) {
  // intensity: chain depth adds drama, percentage-cleared amplifies it so
  // popping 3/3 feels as big as popping 30/30.
  const intensity = Math.min(1.0 + depth * 0.15 + pct * 1.4, 3.2)
  // duration: snappy at 0% cleared, lingers up to 420 ms when board is wiped
  const duration  = 0.28 + pct * 0.14
  popRings.push({ x, y, color, startR, endR, intensity, duration, life: 1.0 })
}

export function updatePopRings(dt) {
  const dtSec = dt / 1000
  for (let i = popRings.length - 1; i >= 0; i--) {
    popRings[i].life -= dtSec / popRings[i].duration
    if (popRings[i].life <= 0) {
      popRings[i] = popRings[popRings.length - 1]
      popRings.pop()
    }
  }
}

export function drawPopRings() {
  const ctx = rs.ctx
  for (const rng of popRings) {
    const t     = 1 - rng.life                        // 0 → 1 as ring expands
    const ringR = rng.startR + (rng.endR - rng.startR) * t
    const alpha = rng.life * rng.life * 0.85           // quadratic fade
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = rng.color
    ctx.shadowColor = rng.color
    ctx.shadowBlur  = 5 * rs.gameScale * rng.intensity
    ctx.lineWidth   = Math.max(0.5, (1 - t) * 2.5)    // thick at impact, tapers off
    ctx.beginPath(); ctx.arc(rng.x, rng.y, ringR, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }
}

// ─── Particles ────────────────────────────────────────────────────────────
export const particles     = []
const MAX_PARTICLES = 500

export function spawnParticles(x, y, color, count, maxR) {
  for (let i = 0; i < count; i++) {
    if (particles.length >= MAX_PARTICLES) break
    const angle = Math.random() * Math.PI * 2
    const speed = maxR * 0.08 * (0.5 + Math.random())
    particles.push({
      x, y,
      vx:    Math.cos(angle) * speed,
      vy:    Math.sin(angle) * speed,
      life:  1.0,
      decay: 1.5 + Math.random(),
      r:     maxR * 0.05 * (0.5 + Math.random()),
      color,
    })
  }
}

export function updateParticles(dt) {
  const dtSec  = dt / 1000
  const dtNorm = dt / (1000 / 60)   // 1.0 at 60 fps
  const drag   = 0.90 ** dtNorm     // correct per-frame drag regardless of frame rate
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.life -= p.decay * dtSec
    if (p.life <= 0) {
      // O(1) swap-remove: copy last element over dead slot, then pop.
      particles[i] = particles[particles.length - 1]
      particles.pop()
      continue
    }
    p.x  += p.vx * dtNorm
    p.y  += p.vy * dtNorm
    p.vx *= drag
    p.vy *= drag
  }
}

export function drawParticles() {
  const ctx = rs.ctx
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life)
    ctx.fillStyle   = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(0.05, p.r * p.life), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// ─── Floating coin label ──────────────────────────────────────────────────
export function spawnCoinLabel(vx, vy, coins, chainIdx = 0) {
  const sx = Math.round((vx / rs.currentArenaScale) * rs.gameScale + rs.gameOffsetX)
  const sy = Math.round((vy / rs.currentArenaScale) * rs.gameScale + rs.gameOffsetY)
  const el = document.createElement('div')
  el.className   = 'coin-float'
  el.textContent = `+${coins}`
  el.style.left  = `${sx}px`
  el.style.top   = `${sy}px`
  // Scale font size and brightness with chain position (caps at 2× to stay readable)
  if (chainIdx > 0) {
    const scale = Math.min(1 + chainIdx * 0.10, 2.0)
    el.style.fontSize = `${scale}rem`
    if (chainIdx >= 8) {
      el.style.color      = '#ffffff'
      el.style.textShadow = '0 0 12px rgba(255,255,255,0.95), 0 0 28px rgba(255,229,102,0.75)'
    } else if (chainIdx >= 4) {
      el.style.textShadow = '0 0 14px rgba(255,229,102,1.0), 0 0 28px rgba(255,229,102,0.60)'
    }
  }
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

// Shows "6 CHAIN ×9  +1,250" — length, multiplier, and bonus coins.
// Size scales up for big chains: 5–9 = big, 10+ = epic.
export function spawnChainBonusLabel(chainLen, mult, bonus) {
  const el = document.createElement('div')
  const sizeClass = chainLen >= 10 ? ' chain-float--epic'
                  : chainLen >= 5  ? ' chain-float--big'
                  : ''
  el.className   = 'coin-float chain-float' + sizeClass
  el.textContent = `${chainLen} CHAIN  ×${fmtMult(mult)}  +${fmtBonus(bonus)}`
  el.style.left  = `${Math.round(rs.W / 2)}px`
  el.style.top   = `${Math.round(rs.H * 0.30)}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

export function spawnClearLabel(bonus) {
  const el = document.createElement('div')
  el.className   = 'coin-float clear-float'
  el.textContent = `CLEAR  ◆+${fmt(bonus)}`
  el.style.left  = `${Math.round(rs.W / 2)}px`
  el.style.top   = `${Math.round(rs.H * 0.57)}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}
