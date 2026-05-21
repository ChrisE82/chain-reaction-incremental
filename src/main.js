// main.js — Chain Reaction: Idle  (game loop, input, rendering)

import {
  getState, addCoins, recordChainEnd, recordKickstart,
  tryUpgrade, tryUnlockSlot,
  ballStats, ballUpgradeCost, slotCost,
  clickStats, tapUpgradeCost, tryUpgradeClick,
  chainReward, chainEndBonus, EconomyConfig,
  setAutoUpgrade,
  setIntroComplete, devResetIntro, setFirstBallCueShown,
  devAddCoins, devAddPrestige, devReset,
} from './store.js'

// ─── DOM refs ─────────────────────────────────────────────────────────────
const canvas     = document.getElementById('c')
const ctx        = canvas.getContext('2d')
const hudCoins   = document.getElementById('hud-coins')
const hudChain   = document.getElementById('hud-chain')
const shopPanel  = document.getElementById('shop-panel')
const shopBody   = document.getElementById('shop-body')
const shopClose  = document.getElementById('shop-close')
const shopToggle = document.getElementById('shop-toggle')
const devPanel   = document.getElementById('dev-panel')
const devToggle  = document.getElementById('dev-toggle')
const devClose   = document.getElementById('dev-close')
const devAddCoinsBtn  = document.getElementById('dev-add-coins')
const devResetBtn     = document.getElementById('dev-reset')
const devPrestigeBtn  = document.getElementById('dev-prestige')
const debugOverlay    = document.getElementById('debug-overlay')

// ── Intro ──
const devResetIntroBtn = document.getElementById('dev-reset-intro')

// ── Quick-buy bar ──
const qbBar         = document.getElementById('quick-buy-bar')
const qbBallBtn     = document.getElementById('qb-ball')
const qbBallCostEl  = document.getElementById('qb-ball-cost')
const qbCheapBtn     = document.getElementById('qb-cheap')
const qbCheapTarget  = document.getElementById('qb-cheap-target')
const qbCheapCost    = document.getElementById('qb-cheap-cost')
const qbSuggestBtn   = document.getElementById('qb-suggest')
const qbSuggestTarget = document.getElementById('qb-suggest-target')
const qbSuggestReason = document.getElementById('qb-suggest-reason')
const qbStoreBtn    = document.getElementById('qb-store')
const qbStoreArrow  = document.getElementById('qb-store-arrow')

// ─── Virtual resolution ───────────────────────────────────────────────────
const VIRTUAL_W = 100
const VIRTUAL_H = 178   // 9:16 portrait

// ─── Canvas / scale ───────────────────────────────────────────────────────
let W, H, gameScale, gameOffsetX, gameOffsetY
// Effective play-area height in virtual units. Shrunk from VIRTUAL_H so that
// balls bounce above the quick-buy bar instead of sliding behind it.
let gamePlayH = VIRTUAL_H

function calcUnits() {
  W = window.innerWidth
  H = window.innerHeight
  canvas.width  = W
  canvas.height = H
  gameScale   = Math.min(W / VIRTUAL_W, H / VIRTUAL_H)
  gameOffsetX = (W - VIRTUAL_W * gameScale) / 2
  gameOffsetY = (H - VIRTUAL_H * gameScale) / 2
  // qbBar.offsetHeight forces a synchronous layout read; it returns 0 when the
  // bar is hidden (intro mode), so only update gamePlayH when it's visible.
  const barPx = qbBar.offsetHeight
  if (barPx > 0) gamePlayH = VIRTUAL_H - barPx / gameScale
}
calcUnits()

// Prevent browser scroll / zoom gestures on the canvas
canvas.style.touchAction = 'none'

// ─── Physics constants ────────────────────────────────────────────────────
const BALL_RADIUS = 2.4    // virtual units
// Expansion phase durations live on each ball object (growMs / holdMs / shrinkMs)
// and are derived from GameConfig + upgrade level in ballStats(). No global
// EXPAND_DURATION / SHRINK_DURATION constants — those have been removed.
const WIGGLE_FREQ = 0.016  // rad/ms
const WIGGLE_DUR  = 380    // ms

const BALL_COLORS = [
  '#ff4f6a', '#ff8c42', '#ffe566', '#4fffb0',
  '#42d4ff', '#a78bfa', '#f472b6', '#34ebc6',
]

// ─── Game state ───────────────────────────────────────────────────────────
let balls       = []
let nextBallId  = 1     // monotonic ID assigned to each ball on creation
let lastTime    = 0
let debugVisible = false

// ─── Board-clear cycle ────────────────────────────────────────────────────
// When the board fully empties we award an efficiency-based clear bonus, then
// immediately refill every owned ball so the next cycle can start at once.
//
// wasBoardActiveSinceLastKickstart: true once any ball has been triggered this
// cycle; prevents the clear from re-firing every frame while the board is empty.
let wasBoardActiveSinceLastKickstart = false

// Per-cycle stats — reset to 0 after each clear fires.
let cyclePlayerStarts       = 0   // valid player taps (not UI, not auto, not refill)
let cycleTriggerOccurrences = 0   // every ball pop, including re-triggers after respawn
let cycleBaseEarned         = 0   // coins from chainReward() only (no chain-end bonuses)

// ─── Intro mode ───────────────────────────────────────────────────────────
// Separate from real-game state. Intro balls, intro coins, and intro chains
// never touch the persistent save. introComplete is the only flag that saves.

const INTRO_BALL_COUNT      = 20
const INTRO_RUMBLE_DURATION = 900    // ms — balls glow/shake before pulling inward
const INTRO_SUCK_DURATION   = 2400   // ms — balls spiral into bright central attractor
const INTRO_BIRTH_DURATION  = 2200   // ms — proto-sphere settles into the real ball

// Slow, readable expansion so players can clearly watch every chain reaction.
// Active cycle = growMs + holdMs + shrinkMs = 520+1300+320 = 2140 ms.
// respawnMs 3200 >> 2140, so no ball can re-enter while another still holds.
const INTRO_STATS = {
  speed:     0.44,   // vs base 0.30 — noticeably faster but not frantic
  maxRadius: 18,     // vs base 15 — bigger expansion area
  growMs:    520,    // slow, visible grow
  holdMs:    1300,   // very long hold — the expansion is the whole show
  shrinkMs:  320,    // slow shrink too
  respawnMs: 3200,   // safely > active cycle to prevent infinite chains
}

let introMode            = false  // true while power-preview is active
let introCoins           = 0      // visual-only coin counter; discarded on finish
let introReadyToComplete = false  // a chain of 5+ was achieved
let introCompleting      = false  // transition animation is running
let introTransTimer      = 0      // ms elapsed in transition
let introTransScale      = 1      // [1→0] scales all ball radii during animation

// ─── Auto-upgrade ─────────────────────────────────────────────────────────
// Only active when prestigeCount > 0 AND autoUpgradeEnabled === true.
// Finds the cheapest affordable ball upgrade once per interval and buys it.
// Never starts chains, never spawns tap circles, never triggers balls.

const AUTO_UPGRADE_INTERVAL = 1000   // ms between upgrade attempts
let   autoUpgradeTimer      = 0

function runAutoUpgrade(dt) {
  const st = getState()
  if (st.prestigeCount <= 0 || !st.autoUpgradeEnabled) return

  autoUpgradeTimer += dt
  if (autoUpgradeTimer < AUTO_UPGRADE_INTERVAL) return
  autoUpgradeTimer = 0

  // Find the cheapest affordable upgrade across all owned standard balls
  let bestCost    = Infinity
  let bestBallIdx = -1
  let bestStat    = null

  for (let i = 0; i < st.unlockedSlots; i++) {
    const ball = st.balls[i]
    for (const stat of ['speed', 'radius', 'duration', 'respawn']) {
      const cost = ballUpgradeCost(stat, ball[stat + 'Level'], i)
      if (cost <= st.coins && cost < bestCost) {
        bestCost    = cost
        bestBallIdx = i
        bestStat    = stat
      }
    }
  }

  if (bestBallIdx >= 0 && tryUpgrade(bestBallIdx, bestStat)) {
    syncBallStats(bestBallIdx)
    if (!shopPanel.classList.contains('hidden')) buildShop()
    updateHUD()
  }
}

// ─── Chain tracking ───────────────────────────────────────────────────────
// currentChain is null when no chain is active.
// triggered: Set of "ballId:spawnGen" strings — prevents the same spawn
//   from being counted twice, while still allowing a respawned ball (new
//   spawnGen) to be caught by a still-active expansion.
let currentChain = null
let nextChainId  = 1

// ─── First-ball attention cue ─────────────────────────────────────────────
// Fires once (per fresh save) after coins first reach Ball 2's cost (10).
// Guides the eye from the playfield down to the +BALL quick-buy button.
// All canvas drawing happens in screen-space after ctx.restore().
let fbCueState     = 'idle'          // idle | waiting | active | done
let fbCueTimer     = 0
let fbCuePhase     = 0               // 0=ring, 1=coins+trail, 2=trail-fade, 3=persist
let fbCuePhaseT    = 0
let fbLastPopVX    = VIRTUAL_W / 2   // virtual coords of last triggered ball
let fbLastPopVY    = VIRTUAL_H * 0.4
let fbCueParticles = []              // screen-space coin particles

const FB_WAIT_MS  = 250
const FB_PULSE_MS = 500
const FB_FLY_MS   = 900
const FB_TRAIL_MS = 2200

function startChain() {
  wasBoardActiveSinceLastKickstart = true
  currentChain = {
    id:        nextChainId++,
    index:     0,       // number of balls triggered so far
    coins:     0,       // coins earned this chain
    triggered: new Set(),
  }
}

function endChain() {
  if (!currentChain) return
  // Intro: skip saving chain stats and tutorial hooks
  if (!introMode) {
    const bonus = chainEndBonus(currentChain.index, currentChain.coins)
    if (bonus > 0) {
      addCoins(bonus)
      spawnChainBonusLabel(bonus)
    }
    recordChainEnd(currentChain.index, currentChain.coins + bonus)
  }
  currentChain = null
  if (!introMode) checkFirstBallCue()

  // Intro: start the black-hole transition once the qualifying chain is done
  if (introMode && introReadyToComplete && !introCompleting) {
    startIntroTransition()
  }
}

// ─── Tap circles ──────────────────────────────────────────────────────────
// Tap circles behave like ball expansions: they expand, hold, then shrink.
// Any idle ball touched during expand or hold is triggered into the chain.

const tapCircles = []

// Raise MAX_TAP_CLICKS via relic unlock — don't change manually
const MAX_TAP_CLICKS = 1

const TAP_GROW_MS   = 180   // ms — matches ball base grow time
const TAP_HOLD_MS   = 220   // ms — hold window where balls can still be caught
const TAP_SHRINK_MS = 140   // ms — visual-only, same as ball shrink

function isTapActive(tc) {
  return tc.state === 'expanding' || tc.state === 'holding'
}

function updateTapCircles(dt) {
  for (let i = tapCircles.length - 1; i >= 0; i--) {
    const tc = tapCircles[i]
    tc.expTimer += dt

    if (tc.state === 'expanding') {
      const t = Math.min(tc.expTimer / TAP_GROW_MS, 1)
      tc.curRadius = (1 - Math.pow(1 - t, 3)) * tc.maxRadius
      if (t >= 1) { tc.state = 'holding'; tc.expTimer = 0 }
    } else if (tc.state === 'holding') {
      tc.curRadius = tc.maxRadius
      if (tc.expTimer >= TAP_HOLD_MS) { tc.state = 'shrinking'; tc.expTimer = 0 }
    } else if (tc.state === 'shrinking') {
      const t = Math.min(tc.expTimer / TAP_SHRINK_MS, 1)
      tc.curRadius = tc.maxRadius * (1 - t * t * t)
      if (t >= 1) { tapCircles.splice(i, 1); continue }
    }

    // Collision — trigger any idle ball whose edge overlaps the active circle
    if (isTapActive(tc)) {
      for (const b of balls) {
        if (b.state !== 'idle') continue
        const dx = b.x - tc.x, dy = b.y - tc.y
        if (Math.sqrt(dx * dx + dy * dy) < tc.curRadius + b.baseRadius) {
          triggerBall(b, { x: tc.x, y: tc.y })
        }
      }
    }
  }
}

function drawTapCircles() {
  for (const tc of tapCircles) {
    if (tc.curRadius <= 0) continue
    const shrinkT  = tc.state === 'shrinking' ? tc.expTimer / TAP_SHRINK_MS : 0
    const alpha    = 1 - shrinkT * shrinkT   // snappy fade on shrink

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.shadowColor = 'rgba(255,255,255,0.8)'
    ctx.shadowBlur  = 4 * gameScale

    const grad = ctx.createRadialGradient(
      tc.x - tc.curRadius * 0.3, tc.y - tc.curRadius * 0.3, 0,
      tc.x, tc.y, tc.curRadius)
    grad.addColorStop(0, 'rgba(255,255,255,0.55)')
    grad.addColorStop(1, 'rgba(180,230,255,0.20)')

    ctx.beginPath(); ctx.arc(tc.x, tc.y, tc.curRadius, 0, Math.PI * 2)
    ctx.fillStyle = grad; ctx.fill()

    // Crisp ring at the edge
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth   = 0.6
    ctx.stroke()

    ctx.restore()
  }
}

// ─── Radius upgrade ghost rings ───────────────────────────────────────────
// Brief visual feedback on radius purchase: old circle fades out (dashed),
// new circle pulses in (cyan glow), so the size jump is immediately obvious.
const radiusGhosts     = []
const RADIUS_GHOST_DUR = 750  // ms

function spawnRadiusGhost(ballIdx, oldMaxR) {
  const b = balls[ballIdx]
  if (!b) return
  const newMaxR = ballStats(getState().balls[ballIdx]).maxRadius
  radiusGhosts.push({ x: b.x, y: b.y, oldR: oldMaxR, newR: newMaxR, timer: 0 })
}

function updateRadiusGhosts(dt) {
  for (let i = radiusGhosts.length - 1; i >= 0; i--) {
    radiusGhosts[i].timer += dt
    if (radiusGhosts[i].timer >= RADIUS_GHOST_DUR) radiusGhosts.splice(i, 1)
  }
}

function drawRadiusGhosts() {
  for (const g of radiusGhosts) {
    const t = g.timer / RADIUS_GHOST_DUR   // 0→1

    // Old radius — dashed white ring fades out quickly
    const oldAlpha = Math.max(0, 1 - t * 2.8) * 0.55
    if (oldAlpha > 0.01) {
      ctx.save()
      ctx.globalAlpha = oldAlpha
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.lineWidth   = 0.4
      ctx.setLineDash([2, 2])
      ctx.beginPath(); ctx.arc(g.x, g.y, g.oldR, 0, Math.PI * 2); ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    }

    // New radius — cyan ring expands slightly then fades
    const tIn    = Math.min(t * 4, 1)
    const tOut   = Math.max(0, (t - 0.20) / 0.80)
    const newAlpha = tIn * (1 - tOut * tOut) * 0.90
    const expand   = 1 + Math.max(0, 1 - tOut * 2) * 0.10   // brief outward pulse
    if (newAlpha > 0.01) {
      ctx.save()
      ctx.globalAlpha  = newAlpha
      ctx.strokeStyle  = 'rgba(66, 212, 255, 0.95)'
      ctx.lineWidth    = 0.7
      ctx.shadowColor  = 'rgba(66, 212, 255, 0.7)'
      ctx.shadowBlur   = 4 * gameScale
      ctx.beginPath(); ctx.arc(g.x, g.y, g.newR * expand, 0, Math.PI * 2); ctx.stroke()
      ctx.restore()
    }
  }
}

// ─── Particles ────────────────────────────────────────────────────────────
const particles     = []
const MAX_PARTICLES = 500

function spawnParticles(x, y, color, count, maxR) {
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

function updateParticles(dt) {
  const dtSec = dt / 1000
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.life -= p.decay * dtSec
    if (p.life <= 0) { particles.splice(i, 1); continue }
    p.x  += p.vx
    p.y  += p.vy
    p.vx *= 0.90
    p.vy *= 0.90
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life)
    ctx.fillStyle   = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(0.05, p.r * p.life), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// ─── Audio ────────────────────────────────────────────────────────────────
let audioCtx = null

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

// Small lookahead offset (seconds) applied to all scheduled audio events.
// audioCtx.resume() is async — without this, sounds scheduled at ac.currentTime
// while the context is still starting up arrive late.
const AUDIO_AHEAD = 0.025

function playTrigger(n) {
  try {
    const ac   = getAudio()
    const now  = ac.currentTime + AUDIO_AHEAD
    const osc  = ac.createOscillator()
    const gain = ac.createGain()
    osc.connect(gain); gain.connect(ac.destination)
    osc.type = 'sine'
    const freq = 300 * Math.pow(1.07, Math.min(n, 24))
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.07)
    gain.gain.setValueAtTime(0.18, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)
    osc.start(now); osc.stop(now + 0.22)
  } catch (_) {}
}

// Rising pitch-sweep played during the intro rumble + suck phases.
// Reads as a "charging up" that resolves when the birth explosion hits.
function playIntroBuildup() {
  try {
    const ac  = getAudio()
    const now = ac.currentTime + AUDIO_AHEAD
    const dur = (INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION) / 1000  // ~3.3 s

    // Primary sweep — sine tone rising from 110 Hz to 1400 Hz
    const osc1  = ac.createOscillator()
    const gain1 = ac.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(110, now)
    osc1.frequency.exponentialRampToValueAtTime(1400, now + dur * 0.92)
    gain1.gain.setValueAtTime(0, now)
    gain1.gain.linearRampToValueAtTime(0.13, now + 0.9)
    gain1.gain.setValueAtTime(0.13, now + dur * 0.88)
    gain1.gain.linearRampToValueAtTime(0, now + dur)
    osc1.connect(gain1); gain1.connect(ac.destination)
    osc1.start(now); osc1.stop(now + dur)

    // Harmonic layer — a fifth above, slightly delayed entry, adds body
    const osc2  = ac.createOscillator()
    const gain2 = ac.createGain()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(165, now)
    osc2.frequency.exponentialRampToValueAtTime(2100, now + dur * 0.92)
    gain2.gain.setValueAtTime(0, now)
    gain2.gain.linearRampToValueAtTime(0.06, now + 1.4)
    gain2.gain.setValueAtTime(0.06, now + dur * 0.88)
    gain2.gain.linearRampToValueAtTime(0, now + dur)
    osc2.connect(gain2); gain2.connect(ac.destination)
    osc2.start(now); osc2.stop(now + dur)
  } catch (_) {}
}

function playRumble() {
  try {
    const ac  = getAudio()
    const now = ac.currentTime + AUDIO_AHEAD
    const dur = (INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION) / 1000  // ~3.3 s

    // White-noise buffer the length of rumble + suck phases
    const frames = Math.ceil(ac.sampleRate * dur)
    const buf    = ac.createBuffer(1, frames, ac.sampleRate)
    const data   = buf.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1

    const src  = ac.createBufferSource()
    src.buffer = buf

    // Low-pass filter gives it a deep "room shake" character
    const filter = ac.createBiquadFilter()
    filter.type  = 'lowpass'
    filter.frequency.setValueAtTime(120, now)
    filter.frequency.linearRampToValueAtTime(55, now + dur)

    const gain = ac.createGain()
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.linearRampToValueAtTime(0.28, now + 0.6)   // build up
    gain.gain.setValueAtTime(0.28, now + dur - 0.9)
    gain.gain.linearRampToValueAtTime(0.001, now + dur)   // fade out before birth

    src.connect(filter)
    filter.connect(gain)
    gain.connect(ac.destination)
    src.start(now); src.stop(now + dur)
  } catch (_) {}
}

// ─── Color utils ─────────────────────────────────────────────────────────
function lighten(hex) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 80)
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 80)
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 80)
  return `rgb(${r},${g},${b})`
}

// ─── Ball factory ─────────────────────────────────────────────────────────
function makeBall(storeData, idx) {
  const stats = ballStats(storeData)
  const r     = BALL_RADIUS
  const angle = Math.random() * Math.PI * 2
  return {
    id:       nextBallId++,
    spawnGen: 1,           // increments each time ball respawns
    x:        r + Math.random() * (VIRTUAL_W  - r * 2),
    y:        r + Math.random() * (gamePlayH  - r * 2),
    vx:       Math.cos(angle) * stats.speed,
    vy:       Math.sin(angle) * stats.speed,
    color:    BALL_COLORS[idx % BALL_COLORS.length],
    state:    'idle',
    expTimer:  0,
    curRadius: 0,
    baseRadius: r,
    flash: 0, sqx: 1, sqy: 1,
    wigAmp: 0, wigTimer: 0, wigAngle: 0,
    storeIdx:     idx,
    maxRadius:    stats.maxRadius,
    growMs:       stats.growMs,
    holdMs:       stats.holdMs,
    shrinkMs:     stats.shrinkMs,
    respawnMs:    stats.respawnMs,
    respawnTimer: 0,
  }
}

// ─── Intro ball factory ───────────────────────────────────────────────────
function makeIntroBall(i) {
  const r     = BALL_RADIUS
  const angle = Math.random() * Math.PI * 2
  return {
    id:          nextBallId++,
    spawnGen:    1,
    x:           r + Math.random() * (VIRTUAL_W - r * 2),
    y:           r + Math.random() * (VIRTUAL_H - r * 2),
    vx:          Math.cos(angle) * INTRO_STATS.speed,
    vy:          Math.sin(angle) * INTRO_STATS.speed,
    color:       BALL_COLORS[i % BALL_COLORS.length],
    state:       'idle',
    expTimer:    0,
    curRadius:   0,
    baseRadius:  r,
    flash: 0, sqx: 1, sqy: 1,
    wigAmp: 0, wigTimer: 0, wigAngle: 0,
    storeIdx:    0,
    maxRadius:   INTRO_STATS.maxRadius,
    growMs:      INTRO_STATS.growMs,
    holdMs:      INTRO_STATS.holdMs,
    shrinkMs:    INTRO_STATS.shrinkMs,
    respawnMs:   INTRO_STATS.respawnMs,
    respawnTimer: 0,
    isIntro:     true,
  }
}

// ─── Wiggle ───────────────────────────────────────────────────────────────
function applyWiggle(obj, angle, amp) {
  obj.wigAmp   = amp
  obj.wigTimer = 0
  obj.wigAngle = angle
}

// ─── Expansion state machine ──────────────────────────────────────────────
function updateExpansion(obj, dt) {
  obj.expTimer += dt
  if (obj.state === 'expanding') {
    const t = Math.min(obj.expTimer / obj.growMs, 1)
    obj.curRadius = (1 - Math.pow(1 - t, 3)) * obj.maxRadius
    if (t >= 1) { obj.state = 'holding'; obj.expTimer = 0 }
  } else if (obj.state === 'holding') {
    if (obj.expTimer >= obj.holdMs) { obj.state = 'shrinking'; obj.expTimer = 0 }
  } else if (obj.state === 'shrinking') {
    const t = Math.min(obj.expTimer / obj.shrinkMs, 1)
    obj.curRadius = obj.maxRadius * (1 - t * t * t)
    if (t >= 1) { obj.state = 'done'; obj.curRadius = 0 }
  }
}

// Expanding + holding + shrinking: used for animation ticks, chain-end detection,
// and the click gate (player can't tap while any ball is still animated).
function isExplosivelyActive(obj) {
  return obj.state === 'expanding' || obj.state === 'holding' || obj.state === 'shrinking'
}

// Expanding + holding only: the window in which a ball can trigger idle neighbours.
// Shrink is visual-only — it no longer spreads the chain.
function canTrigger(obj) {
  return obj.state === 'expanding' || obj.state === 'holding'
}

// ─── Trigger a ball ───────────────────────────────────────────────────────
function triggerBall(b, src) {
  if (b.state !== 'idle') return

  // Prevent the same spawn generation being triggered twice in one chain.
  // A respawned ball (incremented spawnGen) is a fresh target and can be caught again.
  if (currentChain) {
    const key = `${b.id}:${b.spawnGen}`
    if (currentChain.triggered.has(key)) return
    currentChain.triggered.add(key)
  }

  wasBoardActiveSinceLastKickstart = true
  if (!introMode) { fbLastPopVX = b.x; fbLastPopVY = b.y }
  b.state     = 'expanding'
  b.expTimer  = 0
  b.curRadius = 0
  b.vx = 0; b.vy = 0
  b.flash = 1.0

  const chainIndex = currentChain ? currentChain.index : 0
  const coins = chainReward()
  if (currentChain) {
    currentChain.index++
    currentChain.coins += coins
    // Intro: flag ready-to-complete once any chain reaches length 5
    if (introMode && !introReadyToComplete && currentChain.index >= 5) {
      introReadyToComplete = true
    }
  }
  // Intro: show visual coin labels but don't write to save
  if (introMode) {
    introCoins += coins
  } else {
    addCoins(coins)
    cycleTriggerOccurrences++   // every pop counts, including re-triggers after respawn
    cycleBaseEarned += coins    // raw earn before chain-end bonuses
  }
  spawnCoinLabel(b.x, b.y, coins)
  spawnParticles(b.x, b.y, b.color, 22, b.maxRadius)
  playTrigger(chainIndex + 1)

  if (src) {
    const a = Math.atan2(b.y - src.y, b.x - src.x)
    applyWiggle(b,   a,           1.8)
    applyWiggle(src, a + Math.PI, 0.9)
  }
}

// ─── Player tap ───────────────────────────────────────────────────────────
function triggerAtPoint(vx, vy) {
  const r = BALL_RADIUS
  vx = Math.max(r, Math.min(VIRTUAL_W  - r, vx))
  vy = Math.max(r, Math.min(gamePlayH  - r, vy))

  if (!introMode) cyclePlayerStarts++  // pointerdown guard ensures this only runs when no chain is active
  startChain()

  const maxRadius = clickStats(getState().clicks).tapRadius
  tapCircles.push({ x: vx, y: vy, maxRadius, curRadius: 0,
                    state: 'expanding', expTimer: 0 })
  spawnParticles(vx, vy, '#ffffff', 14, maxRadius * 1.4)
  playTrigger(0)
}

// ─── Sync live ball stats after upgrade ───────────────────────────────────
function syncBallStats(ballIdx) {
  const b = balls[ballIdx]
  if (!b) return
  const stats = ballStats(getState().balls[ballIdx])
  b.maxRadius = stats.maxRadius
  b.growMs    = stats.growMs
  b.holdMs    = stats.holdMs
  b.shrinkMs  = stats.shrinkMs
  b.respawnMs = stats.respawnMs
  const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
  if (spd > 0) {
    const ratio = stats.speed / spd
    b.vx *= ratio; b.vy *= ratio
  } else {
    const a = Math.random() * Math.PI * 2
    b.vx = Math.cos(a) * stats.speed
    b.vy = Math.sin(a) * stats.speed
  }
}

function addBall() {
  const st  = getState()
  const idx = balls.length
  balls.push(makeBall(st.balls[idx], idx))
}

// ─── Main loop ────────────────────────────────────────────────────────────
function loop(ts) {
  const dt = Math.min(ts - lastTime, 50)
  lastTime = ts

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#050810'
  ctx.fillRect(gameOffsetX, gameOffsetY, VIRTUAL_W * gameScale, VIRTUAL_H * gameScale)

  ctx.save()
  ctx.translate(gameOffsetX, gameOffsetY)
  ctx.scale(gameScale, gameScale)
  ctx.beginPath(); ctx.rect(0, 0, VIRTUAL_W, VIRTUAL_H); ctx.clip()

  drawGrid()
  update(dt)
  drawAll()
  drawRadiusGhosts()
  drawTapCircles()
  drawParticles()
  if (introCompleting) drawIntroTransition()

  ctx.restore()

  ctx.shadowColor = 'rgba(66,212,255,0.55)'
  ctx.shadowBlur  = 12
  ctx.strokeStyle = 'rgba(66,212,255,0.32)'
  ctx.lineWidth   = 1
  ctx.strokeRect(gameOffsetX + 0.5, gameOffsetY + 0.5,
                 VIRTUAL_W * gameScale - 1, VIRTUAL_H * gameScale - 1)
  ctx.shadowBlur = 0
  drawFirstBallCue()

  runAutoUpgrade(dt)
  updateHUD()
  requestAnimationFrame(loop)
}

// ─── Background grid ──────────────────────────────────────────────────────
function drawGrid() {
  ctx.strokeStyle = 'rgba(255,255,255,0.03)'
  ctx.lineWidth   = 1 / gameScale
  const step = 8
  for (let x = 0; x <= VIRTUAL_W; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, VIRTUAL_H); ctx.stroke()
  }
  for (let y = 0; y <= VIRTUAL_H; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(VIRTUAL_W, y); ctx.stroke()
  }
}

// ─── Board-clear refill ───────────────────────────────────────────────────
// Reset EVERY owned ball slot to idle with a fresh random position/velocity.
// Always iterates the full balls array so no ball is ever missed, regardless
// of its current state (respawning, done, or any unexpected intermediate state).
function refillAllOwnedBalls() {
  const st = getState()
  const r  = BALL_RADIUS
  console.log(`[board-clear] refill: owned=${balls.length}  states-before=[${balls.map(b => b.state).join(', ')}]`)
  for (const b of balls) {
    const stats = ballStats(st.balls[b.storeIdx])
    const angle = Math.random() * Math.PI * 2
    b.x = r + Math.random() * (VIRTUAL_W - r * 2)
    b.y = r + Math.random() * (gamePlayH - r * 2)
    b.vx = Math.cos(angle) * stats.speed
    b.vy = Math.sin(angle) * stats.speed
    b.maxRadius    = stats.maxRadius
    b.holdMs       = stats.holdMs
    b.respawnMs    = stats.respawnMs
    b.respawnTimer = 0
    b.curRadius    = 0
    b.sqx = 1; b.sqy = 1
    b.spawnGen++
    b.state = 'idle'
  }
  console.log(`[board-clear] refill done: states-after=[${balls.map(b => b.state).join(', ')}]`)
}

// ─── Update ───────────────────────────────────────────────────────────────
function update(dt) {
  // Black-hole transition overrides normal physics entirely
  if (introCompleting) {
    updateParticles(dt)   // let existing burst particles fade out
    updateIntroTransition(dt)
    return
  }

  const r      = BALL_RADIUS
  const spring = Math.min(1, dt * 0.018)

  for (const b of balls) b.wigTimer = Math.min(b.wigTimer + dt, WIGGLE_DUR)

  // Move idle balls; run respawn countdown
  for (const b of balls) {
    if (b.state === 'respawning') {
      b.respawnTimer -= dt
      if (b.respawnTimer <= 0) {
        const stats = b.isIntro ? INTRO_STATS : ballStats(getState().balls[b.storeIdx])
        const angle = Math.random() * Math.PI * 2
        b.x  = r + Math.random() * (VIRTUAL_W  - r * 2)
        b.y  = r + Math.random() * (gamePlayH  - r * 2)
        b.vx = Math.cos(angle) * stats.speed
        b.vy = Math.sin(angle) * stats.speed
        b.maxRadius = stats.maxRadius
        b.holdMs    = stats.holdMs
        b.respawnMs = stats.respawnMs
        b.sqx = 1; b.sqy = 1
        b.spawnGen++        // new spawn generation — can be caught again in active chain
        b.state = 'idle'
        wasBoardActiveSinceLastKickstart = true
      }
      continue
    }

    if (b.state !== 'idle') continue

    b.x += b.vx; b.y += b.vy

    if (b.x - r < 0)         { b.x = r;             b.vx *= -1; b.sqx = 0.62; b.sqy = 1.38 }
    if (b.x + r > VIRTUAL_W) { b.x = VIRTUAL_W - r; b.vx *= -1; b.sqx = 0.62; b.sqy = 1.38 }
    if (b.y - r < 0)          { b.y = r;              b.vy *= -1; b.sqx = 1.38; b.sqy = 0.62 }
    if (b.y + r > gamePlayH)  { b.y = gamePlayH - r;  b.vy *= -1; b.sqx = 1.38; b.sqy = 0.62 }

    b.sqx += (1 - b.sqx) * spring
    b.sqy += (1 - b.sqy) * spring
    if (Math.abs(b.sqx - 1) < 0.01) b.sqx = 1
    if (Math.abs(b.sqy - 1) < 0.01) b.sqy = 1
    if (b.flash > 0) b.flash = Math.max(0, b.flash - dt / 150)
  }

  // Advance expansions; done → respawning
  for (const b of balls) {
    if (!isExplosivelyActive(b)) continue
    updateExpansion(b, dt)
    if (b.state === 'done') {
      b.state        = 'respawning'
      b.respawnTimer = b.respawnMs
      b.curRadius    = 0
    }
  }

  // Chain-reaction collision: expanding/holding balls trigger idle neighbours.
  // Shrinking balls are visual-only and cannot start new triggers.
  for (const src of balls) {
    if (!canTrigger(src)) continue
    for (const b of balls) {
      if (b === src || b.state !== 'idle') continue
      const dx = b.x - src.x, dy = b.y - src.y
      if (Math.sqrt(dx * dx + dy * dy) < src.curRadius + b.baseRadius) {
        triggerBall(b, src)
      }
    }
  }

  // Tap circles expand, check ball collisions, and run their own state machine.
  updateTapCircles(dt)

  // End chain only when no balls AND no tap circles are still active.
  // Tap circles in 'shrinking' are visual-only and don't extend the chain.
  if (currentChain && !balls.some(isExplosivelyActive) && !tapCircles.some(isTapActive)) {
    endChain()
  }

  // Board-empty check: no idle or actively exploding balls remain
  if (balls.length > 0 && !balls.some(b => b.state === 'idle' || isExplosivelyActive(b))) {
    // Include 'done' (brief shrink→respawn gap) alongside 'respawning' so the
    // check is robust against any single-frame timing edge cases.
    const inactive = balls.filter(b => b.state === 'respawning' || b.state === 'done')

    if (inactive.length > 0) {
      if (wasBoardActiveSinceLastKickstart && !introMode) {
        // ── Board-clear bonus + full refill ────────────────────────────────
        // We do NOT gate on !currentChain here. The tap circle that started the
        // chain may still be in its hold/shrink phase (400 ms active window) long
        // after all balls have already finished expanding and gone to 'respawning'
        // (≈340 ms cycle). Requiring !currentChain would cause the safety valve to
        // fire instead, waking only one ball — this was the "board cleared but not
        // all balls return" bug. Chain-end coins are still awarded correctly because
        // endChain() fires on the next frame when the tap circle finishes.
        //
        // Efficiency bonus: rewards high pops-per-tap, not raw spam.
        //   popsPerTap 1 → log₂=0 → ×0 bonus
        //   popsPerTap 2 → log₂=1 → ×0.5 bonus
        //   popsPerTap 4 → log₂=2 → ×1.0 bonus
        //   popsPerTap 8 → log₂=3 → ×1.5 bonus
        //   cap at ×2.5 (popsPerTap ≈ 32+)
        wasBoardActiveSinceLastKickstart = false

        const popsPerTap = cycleTriggerOccurrences / Math.max(1, cyclePlayerStarts)
        const effMult    = Math.min(2.5, Math.max(0, Math.log2(popsPerTap)) * 0.5)
        const clearBonus = Math.floor(cycleBaseEarned * effMult)

        console.log(`[board-clear] pops=${cycleTriggerOccurrences} taps=${cyclePlayerStarts} popsPerTap=${popsPerTap.toFixed(2)} effMult=${effMult.toFixed(2)} base=${cycleBaseEarned} bonus=${clearBonus}`)

        if (clearBonus > 0) {
          addCoins(clearBonus)
          recordKickstart(clearBonus)
          spawnClearLabel(clearBonus)
        }

        // Reset counters for the next cycle
        cyclePlayerStarts       = 0
        cycleTriggerOccurrences = 0
        cycleBaseEarned         = 0

        // Immediately put every owned ball back on the board.
        // Uses refillAllOwnedBalls() which iterates the full balls array —
        // NOT just the respawning subset — so every slot is guaranteed to return.
        refillAllOwnedBalls()
      } else {
        // Safety valve: board emptied before any player interaction this cycle
        // (e.g. very first cycle after intro). Wake the soonest ball so the
        // board never stays permanently empty.
        const soonest = inactive
          .filter(b => b.state === 'respawning')
          .sort((a, b) => a.respawnTimer - b.respawnTimer)[0]
          ?? inactive[0]
        soonest.respawnTimer = 0
        if (soonest.state === 'done') soonest.state = 'respawning'
      }
    }
  }

  updateParticles(dt)
  updateRadiusGhosts(dt)
  updateFirstBallCue(dt)
}

// ─── Draw ─────────────────────────────────────────────────────────────────
function drawAll() {
  for (const b of balls) {
    if (b.state !== 'respawning') drawBall(b)
  }
}

function drawBall(b) {
  const isActive = isExplosivelyActive(b)
  const r        = (isActive ? b.curRadius : b.baseRadius) * introTransScale
  if (r <= 0) return

  ctx.save()

  if (b.wigAmp > 0 && b.wigTimer < WIGGLE_DUR) {
    const t   = b.wigTimer / WIGGLE_DUR
    const off = b.wigAmp * Math.sin(WIGGLE_FREQ * b.wigTimer) * (1 - t * t)
    ctx.translate(Math.cos(b.wigAngle) * off, Math.sin(b.wigAngle) * off)
  }

  if (!isActive && (b.sqx !== 1 || b.sqy !== 1)) {
    ctx.translate(b.x, b.y)
    ctx.scale(b.sqx, b.sqy)
    ctx.translate(-b.x, -b.y)
  }

  if (isActive) { ctx.shadowColor = b.color; ctx.shadowBlur = 3 * gameScale }

  const grad = ctx.createRadialGradient(b.x - r * 0.3, b.y - r * 0.3, 0, b.x, b.y, r)
  grad.addColorStop(0, lighten(b.color))
  grad.addColorStop(1, b.color)
  ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
  ctx.fillStyle = grad; ctx.fill()

  if (b.flash > 0) {
    ctx.globalAlpha = b.flash * 0.7
    ctx.fillStyle   = '#ffffff'
    ctx.fill()
    ctx.globalAlpha = 1
  }

  ctx.restore()
}

// ─── HUD ──────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.floor(n).toString()
}

function updateHUD() {
  const st = getState()
  // During intro show temporary visual coins (discarded on completion)
  hudCoins.textContent = fmt(introMode ? introCoins : st.coins)

  const chainIndex = currentChain ? currentChain.index : 0
  const mult = Math.pow(EconomyConfig.chainMultiplier, chainIndex)
  hudChain.textContent = '×' + mult.toFixed(2)

  if (!introMode) updateQuickBuy()
  if (debugVisible) updateDebug(st)
}

function updateDebug(st) {
  const active     = balls.filter(b => b.state !== 'respawning').length
  const expanding  = balls.filter(isExplosivelyActive).length
  const chainIndex = currentChain ? currentChain.index : 0
  debugOverlay.innerHTML =
    `<b>── DEBUG ──</b><br>` +
    `Balls: ${active} active / ${balls.length} total  |  Expanding: ${expanding}<br>` +
    `Chain now: ${chainIndex} balls<br>` +
    `Last chain: ${st.stats.lastChainLength} balls / ◆${fmt(st.stats.lastChainCoins)}<br>` +
    `Best chain: ${st.stats.bestChainLength} balls<br>` +
    `Total chains: ${st.stats.totalChains}<br>` +
    `Coins: ${fmt(st.coins)}  |  Total earned: ${fmt(st.totalCoins)}<br>` +
    `Last kickstart: +${st.stats.lastKickstartBonus}`
}

// ─── Floating coin label ──────────────────────────────────────────────────
function spawnCoinLabel(vx, vy, coins) {
  const sx = Math.round(vx * gameScale + gameOffsetX)
  const sy = Math.round(vy * gameScale + gameOffsetY)
  const el = document.createElement('div')
  el.className   = 'coin-float'
  el.textContent = `+${coins}`
  el.style.left  = `${sx}px`
  el.style.top   = `${sy}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

function spawnChainBonusLabel(bonus) {
  const el = document.createElement('div')
  el.className   = 'coin-float kickstart-float'
  el.textContent = `CHAIN BONUS +${fmt(bonus)}`
  el.style.left  = `${Math.round(W / 2)}px`
  el.style.top   = `${Math.round(H * 0.42)}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

function spawnKickstartLabel(vx, vy, bonus) {
  const sx = Math.round(vx * gameScale + gameOffsetX)
  const sy = Math.round(vy * gameScale + gameOffsetY)
  const el = document.createElement('div')
  el.className   = 'coin-float kickstart-float'
  el.textContent = `KICKSTART +${bonus}`
  el.style.left  = `${sx}px`
  el.style.top   = `${sy}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

function spawnClearLabel(bonus) {
  const el = document.createElement('div')
  el.className   = 'coin-float clear-float'
  el.textContent = `CLEAR  ◆+${fmt(bonus)}`
  el.style.left  = `${Math.round(W / 2)}px`
  el.style.top   = `${Math.round(H * 0.38)}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

// ─── Intro transition ─────────────────────────────────────────────────────

function startIntroTransition() {
  introCompleting = true
  introTransTimer = 0
  introTransScale = 1

  const r = BALL_RADIUS
  for (const b of balls) {
    // Bring any respawning/done balls back as idle so all 20 are visible to shake
    if (b.state === 'respawning' || b.state === 'done') {
      b.state = 'idle'
      b.x = r + Math.random() * (VIRTUAL_W - r * 2)
      b.y = r + Math.random() * (VIRTUAL_H - r * 2)
      b.curRadius = 0; b.expTimer = 0
    } else if (isExplosivelyActive(b)) {
      b.state = 'idle'; b.curRadius = 0; b.expTimer = 0
    }
    // Store the shake origin so Phase 0 can oscillate balls around it
    b.rumbleX = b.x
    b.rumbleY = b.y
  }

  currentChain = null
  document.body.classList.add('intro-completing')
  playRumble()
  playIntroBuildup()
}

function updateIntroTransition(dt) {
  introTransTimer += dt
  const cx = VIRTUAL_W / 2, cy = VIRTUAL_H / 2

  if (introTransTimer < INTRO_RUMBLE_DURATION) {
    // ── Phase 0: Rumble — balls shake around their stored origins ──────────
    introTransScale = 1
    const t        = introTransTimer / INTRO_RUMBLE_DURATION
    const shakeAmp = 0.6 + t * 2.2   // grows from subtle to noticeable
    for (const b of balls) {
      const ox = b.rumbleX ?? b.x
      const oy = b.rumbleY ?? b.y
      b.x = ox + Math.sin(introTransTimer * 0.023 + b.id * 1.73) * shakeAmp
      b.y = oy + Math.cos(introTransTimer * 0.019 + b.id * 2.31) * shakeAmp
      b.x = Math.max(BALL_RADIUS, Math.min(VIRTUAL_W - BALL_RADIUS, b.x))
      b.y = Math.max(BALL_RADIUS, Math.min(VIRTUAL_H - BALL_RADIUS, b.y))
    }

  } else if (introTransTimer < INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION) {
    // ── Phase 1: Suck — balls spiral into a growing bright attractor ───────
    // introTransScale stays 1; the attractor drawn on top hides them visually
    introTransScale = 1
    const t = (introTransTimer - INTRO_RUMBLE_DURATION) / INTRO_SUCK_DURATION

    for (const b of balls) {
      b.state = 'idle'; b.curRadius = 0; b.expTimer = 0

      const dx   = cx - b.x
      const dy   = cy - b.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
      const nx   = dx / dist, ny = dy / dist

      const pull  = (0.06 + t * 0.28) * Math.min(dt, 50) / 16
      const swirl = 0.04  * (1 - t * 0.9) * Math.min(dt, 50) / 16

      b.x += nx * pull * dist + (-ny) * swirl * dist
      b.y += ny * pull * dist +  (nx) * swirl * dist
      b.x = Math.max(0, Math.min(VIRTUAL_W, b.x))
      b.y = Math.max(0, Math.min(VIRTUAL_H, b.y))
    }

  } else {
    // ── Phase 2: Birth — intro balls hidden; proto-sphere materialises ─────
    introTransScale = 0
    const end = INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION + INTRO_BIRTH_DURATION
    if (introTransTimer >= end) finishIntro()
  }
}

// Called in virtual-coord space (inside ctx.save / ctx.scale block).
// Three phases: rumble (glow auras + shake), suck (bright attractor absorbs balls),
// birth (proto-sphere contracts → dot shakes → burst → ball forms).
function drawIntroTransition() {
  const cx = VIRTUAL_W / 2, cy = VIRTUAL_H / 2

  if (introTransTimer < INTRO_RUMBLE_DURATION) {
    // ── Phase 0: Rumble ────────────────────────────────────────────────────
    // White glow aura behind each ball; subtle edge vignette builds up.
    const t = introTransTimer / INTRO_RUMBLE_DURATION

    for (const b of balls) {
      const glowR = b.baseRadius * 4.5
      const alpha = 0.15 + t * 0.55
      const gGrad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, glowR)
      gGrad.addColorStop(0,    `rgba(255,255,255,${alpha})`)
      gGrad.addColorStop(0.45, `rgba(200,225,255,${alpha * 0.35})`)
      gGrad.addColorStop(1,    'rgba(255,255,255,0)')
      ctx.save()
      ctx.beginPath(); ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2)
      ctx.fillStyle = gGrad; ctx.fill()
      ctx.restore()
    }

    // Edge vignette builds slowly — keeps focus on the shaking field
    const vGrad = ctx.createRadialGradient(cx, cy, VIRTUAL_W * 0.28, cx, cy, VIRTUAL_W * 0.9)
    vGrad.addColorStop(0, 'rgba(0,0,0,0)')
    vGrad.addColorStop(1, `rgba(0,0,0,${t * 0.35})`)
    ctx.fillStyle = vGrad
    ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

  } else if (introTransTimer < INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION) {
    // ── Phase 1: Suck ──────────────────────────────────────────────────────
    // Bright white attractor at centre grows from r=2 → r=15, drawn ON TOP of
    // balls so they visually "disappear into the light" rather than just shrinking.
    const t = (introTransTimer - INTRO_RUMBLE_DURATION) / INTRO_SUCK_DURATION

    const attractorR = 2 + t * 13          // 2 → 15 virtual units
    const glowR      = attractorR * 3.8

    // Outer soft radial glow
    const aGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR)
    aGrad.addColorStop(0,    'rgba(255,255,255,1)')
    aGrad.addColorStop(0.18, `rgba(255,255,255,${0.92 - t * 0.25})`)
    aGrad.addColorStop(0.55, `rgba(200,230,255,${0.48 - t * 0.15})`)
    aGrad.addColorStop(1,    'rgba(66,212,255,0)')
    ctx.save()
    ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, Math.PI * 2)
    ctx.fillStyle = aGrad; ctx.fill()

    // Solid bright core disc — hard edge that covers ball positions
    ctx.shadowColor = 'rgba(255,255,255,1)'
    ctx.shadowBlur  = 9 * gameScale
    ctx.beginPath(); ctx.arc(cx, cy, attractorR, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.restore()

    // Edge vignette — keeps the eye on the centre without obscuring ball motion
    const vGrad = ctx.createRadialGradient(cx, cy, VIRTUAL_W * 0.30, cx, cy, VIRTUAL_W * 0.88)
    vGrad.addColorStop(0, 'rgba(0,0,0,0)')
    vGrad.addColorStop(1, `rgba(0,0,0,${0.22 + t * 0.52})`)
    ctx.fillStyle = vGrad
    ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

  } else {
    // ── Phase 2: Birth ─────────────────────────────────────────────────────
    // introTransScale is 0 → intro balls are already invisible.
    // Proto-sphere starts at the attractor's final radius (15), contracts into a
    // tiny shaking dot, then bursts and the real ball grows in its place.
    const elapsed = introTransTimer - INTRO_RUMBLE_DURATION - INTRO_SUCK_DURATION
    const t       = Math.min(elapsed / INTRO_BIRTH_DURATION, 1)

    // Opaque background covers the now-gone intro balls
    ctx.fillStyle = 'rgba(0,0,0,0.96)'
    ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

    // Sub-phase thresholds (t ∈ 0–1)
    const T_CONTRACT = 0.18   // 0 → 0.18 : attractor (r=15) contracts to r=2.2
    const T_SHAKE    = 0.52   // 0.18 → 0.52 : tiny dot shakes & glows white
    const T_BURST    = 0.68   // 0.52 → 0.68 : explosion ring
                              // 0.68 → 1.0  : ball forms in colour

    if (t < T_CONTRACT) {
      // Sub-phase A: bright disc compresses — reads as "mass collapsing inward"
      const phase  = t / T_CONTRACT
      const eased  = 1 - Math.pow(1 - phase, 2)
      const protoR = 15 - eased * 12.8    // 15 → 2.2

      ctx.save()
      const gGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, protoR * 4.5)
      gGrad.addColorStop(0,    'rgba(255,255,255,1)')
      gGrad.addColorStop(0.28, 'rgba(255,255,255,0.75)')
      gGrad.addColorStop(0.62, 'rgba(180,230,255,0.30)')
      gGrad.addColorStop(1,    'rgba(66,212,255,0)')
      ctx.beginPath(); ctx.arc(cx, cy, protoR * 4.5, 0, Math.PI * 2)
      ctx.fillStyle = gGrad; ctx.fill()

      ctx.shadowColor = 'rgba(255,255,255,1)'
      ctx.shadowBlur  = 11 * gameScale
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.5, protoR), 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'; ctx.fill()
      ctx.restore()

    } else if (t < T_SHAKE) {
      // Sub-phase B: tiny glowing dot shakes violently before the burst
      const phase    = (t - T_CONTRACT) / (T_SHAKE - T_CONTRACT)
      const pulseR   = 2.0 + Math.sin(elapsed * 0.078) * 0.85
      const shakeAmp = 1.2 + phase * 3.0
      const sx = cx + Math.sin(elapsed * 0.063) * shakeAmp
                    + Math.sin(elapsed * 0.111) * shakeAmp * 0.6
      const sy = cy + Math.cos(elapsed * 0.079) * shakeAmp
                    + Math.cos(elapsed * 0.137) * shakeAmp * 0.6

      ctx.save()
      // Outer soft aura
      const gGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, pulseR * 7)
      gGrad.addColorStop(0,    'rgba(255,255,255,0.95)')
      gGrad.addColorStop(0.35, 'rgba(200,230,255,0.45)')
      gGrad.addColorStop(1,    'rgba(66,212,255,0)')
      ctx.beginPath(); ctx.arc(sx, sy, pulseR * 7, 0, Math.PI * 2)
      ctx.fillStyle = gGrad; ctx.fill()

      // Hard bright core
      ctx.shadowColor = 'rgba(255,255,255,1)'
      ctx.shadowBlur  = 9 * gameScale
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(0.4, pulseR), 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'; ctx.fill()
      ctx.restore()

    } else if (t < T_BURST) {
      // Sub-phase C: explosion ring radiates outward
      const phase = (t - T_SHAKE) / (T_BURST - T_SHAKE)
      const ringR = phase * 38
      const alpha = 1 - phase

      ctx.save()
      // Central flash fades
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.5})`
      ctx.beginPath(); ctx.arc(cx, cy, ringR * 0.42, 0, Math.PI * 2)
      ctx.fill()
      // Expanding ring
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`
      ctx.lineWidth   = (1 - phase) * 4
      ctx.shadowColor = `rgba(255,255,255,${alpha})`
      ctx.shadowBlur  = 8 * gameScale
      ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

    } else {
      // Sub-phase D: the real ball grows in at the centre
      const phase = (t - T_BURST) / (1 - T_BURST)
      const eased = 1 - Math.pow(1 - phase, 2)   // ease-out
      const color = BALL_COLORS[0]
      const ballR = BALL_RADIUS * eased

      if (ballR > 0) {
        ctx.save()
        ctx.globalAlpha = Math.min(1, phase * 2)
        ctx.shadowColor = color
        ctx.shadowBlur  = 6 * gameScale
        const bGrad = ctx.createRadialGradient(
          cx - ballR * 0.3, cy - ballR * 0.3, 0, cx, cy, ballR)
        bGrad.addColorStop(0, lighten(color))
        bGrad.addColorStop(1, color)
        ctx.beginPath(); ctx.arc(cx, cy, ballR, 0, Math.PI * 2)
        ctx.fillStyle = bGrad; ctx.fill()
        ctx.restore()
      }
    }
  }
}

function finishIntro() {
  // Lock out any double-call
  if (!introMode && !introCompleting) return

  introMode            = false
  introReadyToComplete = false
  introCompleting      = false
  introTransTimer      = 0
  introTransScale      = 1
  introCoins           = 0

  // Persist the completion flag so the intro never replays
  setIntroComplete()

  // Rebuild the playfield from the real saved state (1 ball, normal stats).
  // Place the first ball at the centre so it appears to emerge from the spiral.
  const st = getState()
  balls = []
  for (let i = 0; i < st.unlockedSlots; i++) {
    const b = makeBall(st.balls[i], i)
    if (i === 0) { b.x = VIRTUAL_W / 2; b.y = gamePlayH / 2 }
    balls.push(b)
  }
  currentChain = null
  wasBoardActiveSinceLastKickstart = false
  particles.length  = 0
  tapCircles.length = 0

  // Restore UI — removing intro-active makes the quick-buy bar visible again,
  // so recalculate gamePlayH now that offsetHeight returns the real bar height.
  document.body.classList.remove('intro-active', 'intro-completing')
  calcUnits()

  updateHUD()
}

// ─── First-ball cue: logic ────────────────────────────────────────────────

function checkFirstBallCue() {
  if (fbCueState !== 'idle') return
  if (introMode) return
  if (!shopPanel.classList.contains('hidden')) return  // don't fire while store is open
  const st = getState()
  if (st.firstBallCueShown) return
  if (st.unlockedSlots !== 1) return         // only for the very first extra ball
  if (st.coins < 100) return                  // full animation fires only at 100+ coins
  fbCueState = 'waiting'
  fbCueTimer = 0
}

function cancelFirstBallCue() {
  if (fbCueState === 'idle' || fbCueState === 'done') return
  fbCueState     = 'done'
  fbCueParticles = []
  qbBallBtn.classList.remove('qb-btn-cue-pulse')
  setFirstBallCueShown()
}

function resetFirstBallCue() {
  // Dev-reset only — clears state without marking firstBallCueShown
  fbCueState     = 'idle'
  fbCueTimer     = 0
  fbCuePhase     = 0
  fbCuePhaseT    = 0
  fbCueParticles = []
  qbBallBtn.classList.remove('qb-btn-cue-pulse')
}

function updateFirstBallCue(dt) {
  if (fbCueState === 'idle' || fbCueState === 'done') return
  fbCueTimer += dt

  if (fbCueState === 'waiting') {
    if (fbCueTimer >= FB_WAIT_MS) {
      fbCueState  = 'active'
      fbCuePhase  = 0
      fbCuePhaseT = 0
      fbCueTimer  = 0
    }
    return
  }

  // ── Active: advance phase timer ───────────────────────────────────────
  fbCuePhaseT += dt
  const dtS = dt / 1000

  // Advance particles
  for (let i = fbCueParticles.length - 1; i >= 0; i--) {
    const p = fbCueParticles[i]
    p.life -= p.decay * dtS
    if (p.life <= 0) { fbCueParticles.splice(i, 1); continue }
    if (p.type === 'coin') {
      // Magnetic pull toward the +BALL button center
      const rect = qbBallBtn.getBoundingClientRect()
      const tx   = rect.left + rect.width  * 0.5
      const ty   = rect.top  + rect.height * 0.5
      const dx   = tx - p.x, dy = ty - p.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const pull = 0.18 + (1 - p.life) * 0.35
      p.vx += (dx / dist) * pull
      p.vy += (dy / dist) * pull
      p.vx *= 0.93; p.vy *= 0.93
    } else {
      p.vx *= 0.88; p.vy *= 0.88
    }
    p.x += p.vx; p.y += p.vy
  }

  // Phase 0 → 1: spawn coin particles from playfield center toward button
  if (fbCuePhase === 0 && fbCuePhaseT >= FB_PULSE_MS) {
    fbCuePhase  = 1
    fbCuePhaseT = 0
    const cx   = gameOffsetX + VIRTUAL_W * 0.5 * gameScale
    const cy   = gameOffsetY + gamePlayH  * 0.5 * gameScale
    const rect = qbBallBtn.getBoundingClientRect()
    const tx   = rect.left + rect.width  * 0.5
    const ty   = rect.top  + rect.height * 0.5
    const bdx  = tx - cx, bdy = ty - cy
    const bd   = Math.sqrt(bdx * bdx + bdy * bdy) || 1
    const px   = -bdy / bd, py = bdx / bd   // perpendicular unit vector
    for (let i = 0; i < 8; i++) {
      const scatter = (i - 3.5) * 7
      const spd     = 2.0 + Math.random() * 0.8
      fbCueParticles.push({
        x:     cx + px * scatter * 0.3 + (Math.random() - 0.5) * 10,
        y:     cy + py * scatter * 0.3 + (Math.random() - 0.5) * 10,
        vx:    bdx / bd * spd + px * scatter * 0.04,
        vy:    bdy / bd * spd + py * scatter * 0.04,
        life:  1.0,
        decay: 0.20 + Math.random() * 0.10,
        r:     3.5 + Math.random() * 1.5,
        type:  'coin',
      })
    }
    qbBallBtn.classList.add('qb-btn-cue-pulse')
  }

  // Phase 1 → 2
  if (fbCuePhase === 1 && fbCuePhaseT >= FB_FLY_MS) {
    fbCuePhase  = 2
    fbCuePhaseT = 0
  }

  // Phase 2 → 3: canvas drawing done, leave only button CSS pulse
  if (fbCuePhase === 2 && fbCuePhaseT >= FB_TRAIL_MS) {
    fbCuePhase     = 3
    fbCuePhaseT    = 0
    fbCueParticles = []
  }
}

// ─── First-ball cue: drawing (screen-space, after ctx.restore()) ──────────

function fbRoundRect(x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y,     x + w, y + r,     r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x,     y + h, x,     y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x,     y,     x + r, y,         r)
  ctx.closePath()
}

function drawFirstBallCue() {
  if (fbCueState !== 'active') return
  const now = performance.now()

  // ── Phase 0: expanding gold ring at last pop position ─────────────────
  if (fbCuePhase === 0) {
    const t  = Math.min(fbCuePhaseT / FB_PULSE_MS, 1)
    const sx = fbLastPopVX * gameScale + gameOffsetX
    const sy = fbLastPopVY * gameScale + gameOffsetY
    for (let ring = 0; ring < 2; ring++) {
      const rt    = ring === 0 ? t : Math.max(0, t - 0.18)
      const ringR = rt * 52
      const alpha = (1 - rt) * (ring === 0 ? 0.88 : 0.50)
      if (ringR <= 0 || alpha <= 0) continue
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = '#ffe566'
      ctx.lineWidth   = (1 - rt) * 4 + 0.5
      ctx.shadowColor = 'rgba(255,229,102,0.95)'
      ctx.shadowBlur  = 22
      ctx.beginPath()
      ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  // ── Coin ◆ particles (phases 1 and 2) ────────────────────────────────
  for (const p of fbCueParticles) {
    const a = Math.max(0, p.life)
    const r = Math.max(0.5, p.r * (0.4 + p.life * 0.6))
    ctx.save()
    ctx.globalAlpha = a
    ctx.fillStyle   = '#ffe566'
    ctx.shadowColor = 'rgba(255,229,102,0.95)'
    ctx.shadowBlur  = r * 3
    ctx.beginPath()
    ctx.moveTo(p.x,         p.y - r * 1.5)
    ctx.lineTo(p.x + r,     p.y)
    ctx.lineTo(p.x,         p.y + r * 1.5)
    ctx.lineTo(p.x - r,     p.y)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  // ── Callout ghost + dashed trail (phases 1 and 2) ─────────────────────
  if (fbCuePhase === 1 || fbCuePhase === 2) {
    const tIn   = fbCuePhase === 1 ? Math.min(1, fbCuePhaseT / 350) : 1
    const tOut  = fbCuePhase === 2 ? fbCuePhaseT / FB_TRAIL_MS : 0
    const alpha = tIn * (1 - tOut * 0.8)
    if (alpha <= 0.01) return

    const rect = qbBallBtn.getBoundingClientRect()
    const tx   = rect.left + rect.width  * 0.5
    const ty   = rect.top  + rect.height * 0.5
    // Callout appears in the lower-middle of the playfield
    const cx   = gameOffsetX + VIRTUAL_W * 0.5  * gameScale
    const cy   = gameOffsetY + gamePlayH  * 0.58 * gameScale
    const pw   = 90, ph = 38, pr = 10

    // ── Callout pill ───────────────────────────────────────────────────
    const pulse = 1 + Math.sin(now * 0.005) * 0.055
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(cx, cy)
    ctx.scale(pulse, pulse)
    ctx.translate(-cx, -cy)
    ctx.shadowColor = 'rgba(255,229,102,0.95)'
    ctx.shadowBlur  = 24
    ctx.fillStyle   = 'rgba(12, 10, 2, 0.92)'
    fbRoundRect(cx - pw * 0.5, cy - ph * 0.5, pw, ph, pr)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,229,102,0.88)'
    ctx.lineWidth   = 1.5
    ctx.stroke()
    ctx.shadowBlur  = 6
    ctx.fillStyle   = '#ffe566'
    ctx.font        = 'bold 12px Orbitron, monospace'
    ctx.textAlign   = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('◆  + BALL', cx, cy)
    ctx.restore()

    // ── Dashed marching trail from callout bottom to button ────────────
    const marchOffset = -(now * 0.08) % 12
    const trailStartY = cy + ph * 0.5 + 6
    // Control point bows the trail inward
    const cpx = cx * 0.6 + tx * 0.4
    const cpy = trailStartY * 0.45 + ty * 0.55

    ctx.save()
    ctx.globalAlpha    = alpha * 0.72
    ctx.strokeStyle    = '#ffe566'
    ctx.lineWidth      = 1.8
    ctx.shadowColor    = 'rgba(255,229,102,0.70)'
    ctx.shadowBlur     = 8
    ctx.setLineDash([7, 5])
    ctx.lineDashOffset = marchOffset
    ctx.beginPath()
    ctx.moveTo(cx, trailStartY)
    ctx.quadraticCurveTo(cpx, cpy, tx, ty - rect.height * 0.5 - 2)
    ctx.stroke()
    ctx.setLineDash([])

    // Arrowhead pointing at button
    const arrAngle = Math.atan2(ty - cpy, tx - cpx)
    ctx.globalAlpha = alpha * 0.92
    ctx.shadowBlur  = 10
    ctx.fillStyle   = '#ffe566'
    ctx.beginPath()
    ctx.moveTo(tx,     ty - rect.height * 0.5 - 2)
    ctx.lineTo(tx - 9 * Math.cos(arrAngle - 0.42), ty - rect.height * 0.5 - 2 - 9 * Math.sin(arrAngle - 0.42))
    ctx.lineTo(tx - 9 * Math.cos(arrAngle + 0.42), ty - rect.height * 0.5 - 2 - 9 * Math.sin(arrAngle + 0.42))
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}

// ─── Quick-buy helpers ────────────────────────────────────────────────────

const QB_STAT_LABEL  = { speed: 'Speed', radius: 'Radius', duration: 'Duration', respawn: 'Respawn' }
const QB_STAT_REASON = { speed: 'Reach circles', radius: 'Catch more', duration: 'Longer chains', respawn: 'More returns' }

// Track last displayed target so we can flash the text when it changes
let prevCheapKey   = ''
let prevSuggestKey = ''

// Returns { ballIdx, stat, cost } for the single cheapest ball upgrade,
// or null if there are no ball slots.
function findCheapestUpgrade(st) {
  let best = null
  for (let i = 0; i < st.unlockedSlots; i++) {
    const ball = st.balls[i]
    for (const stat of ['speed', 'radius', 'duration', 'respawn']) {
      const cost = ballUpgradeCost(stat, ball[stat + 'Level'], i)
      if (!best || cost < best.cost) best = { ballIdx: i, stat, cost }
    }
  }
  return best
}

// ── Suggested upgrade scoring ─────────────────────────────────────────────
// score = adjustedWeight / sqrt(cost)
// Higher score = better recommendation.  When scores tie we fall back to
// stat preference order (duration > radius > respawn > speed) then lower cost.

const SUG_BASE_WEIGHT  = { duration: 6.0, speed: 5.0, radius: 4.0, respawn: 2.0 }
const SUG_TIE_ORDER    = ['duration', 'speed', 'radius', 'respawn']

function sugWeight(stat, ball, ownedCount) {
  let w = SUG_BASE_WEIGHT[stat]

  if (stat === 'duration') {
    // Front-loaded bonus — Duration is the biggest early chain unlock.
    if (ball.durationLevel < 2) w *= 3.0
    else if (ball.durationLevel < 5) w *= 2.0
  }

  if (stat === 'speed') {
    // Early Speed bonus — balls need to move fast enough to reach active expansions.
    if (ball.speedLevel < 2) w *= 2.5
  }

  if (stat === 'radius') {
    // Modest priority that falls away quickly — radius is only worth recommending
    // when the circle is still very small. Duration and Speed remain the main levers.
    if      (ball.radiusLevel === 0) { /* normal — no multiplier */ }
    else if (ball.radiusLevel === 1) w *= 0.80
    else if (ball.radiusLevel === 2) w *= 0.60
    else if (ball.radiusLevel >= 5)  w *= 0.15
    else                              w *= 0.35  // level 3–4
    // Dependency: bigger circle helps less without decent duration/speed.
    if (ball.durationLevel < 2) w *= 0.75
    if (ball.speedLevel < 2)    w *= 0.85
  }

  if (stat === 'respawn') {
    // Respawn only matters once chains are plausible (enough balls on the board).
    if (ownedCount < 4) w *= 0.5
  }

  return w
}

function sugIsBetter(a, b) {
  if (Math.abs(a.score - b.score) > 1e-9) return a.score > b.score
  const ai = SUG_TIE_ORDER.indexOf(a.stat)
  const bi = SUG_TIE_ORDER.indexOf(b.stat)
  if (ai !== bi) return ai < bi
  return a.cost < b.cost
}

// Returns { ballIdx, stat, cost } for the best-scoring affordable upgrade.
// Falls back to showing the best-scoring upgrade overall (button disabled) if broke.
function findSuggestedUpgrade(st) {
  const ownedCount = st.unlockedSlots
  let bestAffordable = null
  let bestAny        = null

  for (const stat of SUG_TIE_ORDER) {
    for (let i = 0; i < ownedCount; i++) {
      const ball  = st.balls[i]
      const level = ball[stat + 'Level']
      const cost  = ballUpgradeCost(stat, level, i)
      const score = sugWeight(stat, ball, ownedCount) / Math.sqrt(cost)
      const cand  = { ballIdx: i, stat, cost, score }

      if (cost <= st.coins) {
        if (!bestAffordable || sugIsBetter(cand, bestAffordable)) bestAffordable = cand
      }
      if (!bestAny || sugIsBetter(cand, bestAny)) bestAny = cand
    }
  }

  return bestAffordable ?? bestAny
}

// Spawns a small toast just above the quick-buy bar.
function spawnQbToast(text) {
  const rect = qbBar.getBoundingClientRect()
  const el   = document.createElement('div')
  el.className   = 'qb-toast'
  el.textContent = text
  el.style.left  = `${Math.round(rect.left + rect.width / 2)}px`
  el.style.top   = `${Math.round(rect.top - 4)}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

// Refreshes labels, costs, and disabled states on the quick-buy bar.
// Called from updateHUD() every frame — only updates text/disabled, no DOM rebuild.
function updateQuickBuy() {
  const st = getState()

  // ── + Ball ──
  const ballCost = slotCost(st.unlockedSlots)
  qbBallCostEl.textContent = `◆ ${fmt(ballCost)}`
  qbBallBtn.disabled = st.coins < ballCost
  // Glow as soon as Ball 2 is affordable; the full canvas cue fires separately at 100 coins.
  // cancelFirstBallCue() removes the class (and sets firstBallCueShown) on purchase.
  qbBallBtn.classList.toggle('qb-btn-cue-pulse',
    st.unlockedSlots === 1 && st.coins >= ballCost && !st.firstBallCueShown)

  // ── Lowest Cost upgrade ──
  const cheap = findCheapestUpgrade(st)
  if (cheap) {
    const cheapKey = `${cheap.ballIdx}-${cheap.stat}`
    if (cheapKey !== prevCheapKey && prevCheapKey !== '') {
      qbCheapTarget.classList.remove('qb-target-changed')
      void qbCheapTarget.offsetWidth   // force reflow so animation restarts
      qbCheapTarget.classList.add('qb-target-changed')
    }
    prevCheapKey              = cheapKey
    qbCheapTarget.textContent = `B${cheap.ballIdx + 1} ${QB_STAT_LABEL[cheap.stat]}`
    qbCheapCost.textContent   = `◆ ${fmt(cheap.cost)}`
    qbCheapBtn.disabled       = st.coins < cheap.cost
  } else {
    prevCheapKey              = ''
    qbCheapTarget.textContent = '—'
    qbCheapCost.textContent   = '—'
    qbCheapBtn.disabled       = true
  }

  // ── Best Next upgrade ──
  const sug = findSuggestedUpgrade(st)
  if (sug) {
    const sugKey     = `${sug.ballIdx}-${sug.stat}`
    const affordable = st.coins >= sug.cost
    if (sugKey !== prevSuggestKey && prevSuggestKey !== '') {
      qbSuggestTarget.classList.remove('qb-target-changed')
      void qbSuggestTarget.offsetWidth
      qbSuggestTarget.classList.add('qb-target-changed')
    }
    prevSuggestKey              = sugKey
    qbSuggestTarget.textContent = `B${sug.ballIdx + 1} ${QB_STAT_LABEL[sug.stat]}`
    qbSuggestReason.textContent = affordable
      ? `${QB_STAT_REASON[sug.stat]} · ◆${fmt(sug.cost)}`
      : `Need ◆${fmt(sug.cost)}`
    qbSuggestBtn.disabled = !affordable
  } else {
    prevSuggestKey              = ''
    qbSuggestTarget.textContent = '—'
    qbSuggestReason.textContent = '—'
    qbSuggestBtn.disabled       = true
  }

  // ── Store arrow — flips when panel is open ──
  qbStoreArrow.textContent = shopPanel.classList.contains('hidden') ? '▲' : '▼'
}

// ─── Shop UI ──────────────────────────────────────────────────────────────
const BALL_UPGRADE_DEFS = [
  {
    stat: 'speed',
    label: 'Speed',
    icon: '▶',
    statLabel: (ball) => {
      const s = ballStats(ball)
      return `${s.speed.toFixed(3)} u/t`
    },
  },
  {
    stat: 'radius',
    label: 'Radius',
    icon: '◉',
    statLabel: (ball) => {
      const s = ballStats(ball)
      return `${s.maxRadius.toFixed(1)} u`
    },
  },
  {
    stat: 'duration',
    label: 'Duration',
    icon: '⏱',
    statLabel: (ball) => {
      const s = ballStats(ball)
      // Show active window = grow + hold (the window that can trigger neighbours)
      return `${((s.growMs + s.holdMs) / 1000).toFixed(2)}s`
    },
  },
  {
    stat: 'respawn',
    label: 'Respawn',
    icon: '↺',
    statLabel: (ball) => {
      const s = ballStats(ball)
      return `${(s.respawnMs / 1000).toFixed(2)}s`
    },
  },
]

const TAP_UPGRADE_DEFS = [
  {
    stat: 'radius',
    label: 'Tap Radius',
    icon: '✦',
    statLabel: (cl) => `${clickStats(cl).tapRadius.toFixed(1)} u`,
  },
]

function makeUpgradeBtn(icon, label, level, statText, costText, canAfford, onClick) {
  const btn = document.createElement('button')
  btn.className = 'upgrade-btn'
  btn.disabled  = !canAfford

  // Left: icon box
  const iconEl = document.createElement('span')
  iconEl.className   = 'upgrade-btn-icon'
  iconEl.textContent = icon

  // Middle: name + level badge + stat
  const infoEl = document.createElement('div')
  infoEl.className = 'upgrade-btn-info'

  const nameRow = document.createElement('div')
  nameRow.className = 'upgrade-btn-name-row'

  const nameEl = document.createElement('span')
  nameEl.className   = 'upgrade-btn-name'
  nameEl.textContent = label

  const levelEl = document.createElement('span')
  levelEl.className   = 'upgrade-btn-level'
  levelEl.textContent = `Lv ${level}`

  nameRow.appendChild(nameEl)
  nameRow.appendChild(levelEl)

  const statEl = document.createElement('span')
  statEl.className   = 'upgrade-btn-stat'
  statEl.textContent = statText

  infoEl.appendChild(nameRow)
  infoEl.appendChild(statEl)

  // Right: cost
  const costEl = document.createElement('span')
  costEl.className   = 'upgrade-btn-cost'
  costEl.textContent = costText

  btn.appendChild(iconEl)
  btn.appendChild(infoEl)
  btn.appendChild(costEl)
  btn.addEventListener('click', onClick)
  return btn
}

// Circled number icons for up to 8 balls; fallback to plain number after that.
const BALL_SECTION_ICONS = ['①','②','③','④','⑤','⑥','⑦','⑧']

function makeSectionTitle(icon, text) {
  const wrap = document.createElement('div')
  wrap.className = 'upgrade-card-title'

  const iconEl = document.createElement('span')
  iconEl.className   = 'card-title-icon'
  iconEl.textContent = icon

  const textEl = document.createElement('span')
  textEl.className   = 'card-title-text'
  textEl.textContent = text

  const dotEl = document.createElement('span')
  dotEl.className = 'card-title-dot'

  wrap.appendChild(iconEl)
  wrap.appendChild(textEl)
  wrap.appendChild(dotEl)
  return wrap
}

function buildShop() {
  shopBody.innerHTML = ''
  const st = getState()

  // ── Clicks card ──────────────────────────────────────────────
  {
    const card = document.createElement('div')
    card.className = 'upgrade-card'
    card.appendChild(makeSectionTitle('✋', 'Clicks'))

    const grid = document.createElement('div')
    grid.className = 'upgrade-btns'
    for (const { stat, label, icon, statLabel } of TAP_UPGRADE_DEFS) {
      const level = st.clicks[stat + 'Level']
      const cost  = tapUpgradeCost(stat, level)
      grid.appendChild(makeUpgradeBtn(
        icon,
        label,
        level,
        statLabel(st.clicks),
        `◆ ${fmt(cost)}`,
        st.coins >= cost,
        () => { if (tryUpgradeClick(stat)) { buildShop(); updateHUD() } }
      ))
    }
    card.appendChild(grid)
    shopBody.appendChild(card)
  }

  // ── Ball cards ───────────────────────────────────────────────
  for (let i = 0; i < st.unlockedSlots; i++) {
    const ball = st.balls[i]
    const card = document.createElement('div')
    card.className = 'upgrade-card'

    card.appendChild(makeSectionTitle(BALL_SECTION_ICONS[i] ?? String(i + 1), `Ball ${i + 1}`))

    const grid = document.createElement('div')
    grid.className = 'upgrade-btns'

    for (const { stat, label, icon, statLabel } of BALL_UPGRADE_DEFS) {
      const level = ball[stat + 'Level']
      const cost  = ballUpgradeCost(stat, level, i)   // pass ball index for per-ball multiplier
      grid.appendChild(makeUpgradeBtn(
        icon,
        label,
        level,
        statLabel(ball),
        `◆ ${fmt(cost)}`,
        st.coins >= cost,
        () => {
          const oldR = stat === 'radius' ? ballStats(getState().balls[i]).maxRadius : 0
          if (tryUpgrade(i, stat)) {
            syncBallStats(i)
            if (stat === 'radius') spawnRadiusGhost(i, oldR)
            buildShop(); updateHUD()
          }
        }
      ))
    }
    card.appendChild(grid)
    shopBody.appendChild(card)
  }

  // ── Unlock next ball ─────────────────────────────────────────
  const n    = st.unlockedSlots
  const cost = slotCost(n)
  const unlockBtn = document.createElement('button')
  unlockBtn.className   = 'unlock-slot-btn'
  unlockBtn.disabled    = st.coins < cost
  unlockBtn.textContent = `Unlock Ball ${n + 1}  ◆ ${fmt(cost)}`
  unlockBtn.addEventListener('click', () => {
    if (tryUnlockSlot()) { addBall(); buildShop(); updateHUD() }
  })
  shopBody.appendChild(unlockBtn)
}

// ─── Input ────────────────────────────────────────────────────────────────
function screenToVirtual(sx, sy) {
  return [(sx - gameOffsetX) / gameScale, (sy - gameOffsetY) / gameScale]
}

canvas.addEventListener('pointerdown', e => {
  if (!e.isPrimary) return    // ignore secondary touch points (pinch, etc.)
  e.preventDefault()
  if (introCompleting) return // no input while transition animation runs

  // Block while a tap circle is active, any ball is still animated, or a chain
  // is open. The currentChain check catches the brief window between the last
  // shrink finishing and endChain() running — prevents a queued tap from
  // counting as a fresh shot before the chain is fully resolved.
  if (tapCircles.length >= MAX_TAP_CLICKS || balls.some(isExplosivelyActive) || currentChain) return
  try { getAudio() } catch (_) {}
  const [vx, vy] = screenToVirtual(e.clientX, e.clientY)
  triggerAtPoint(vx, vy)
})

// ─── Shop / Dev panel events ──────────────────────────────────────────────

function toggleShop() {
  if (introMode) return   // shop is hidden during intro
  const opening = shopPanel.classList.contains('hidden')
  shopPanel.classList.toggle('hidden')
  if (opening) buildShop()
  updateQuickBuy()   // flip the store arrow immediately
}

shopToggle.addEventListener('click', toggleShop)   // legacy button (hidden)
shopClose.addEventListener('click',  () => { shopPanel.classList.add('hidden'); updateQuickBuy() })

// ── Quick-buy bar ──────────────────────────────────────────────────────────

// Prevent all qb touches/clicks from reaching the canvas pointerdown handler.
qbBar.addEventListener('pointerdown', e => e.stopPropagation())

qbBallBtn.addEventListener('click', e => {
  e.stopPropagation()
  if (tryUnlockSlot()) {
    addBall()
    cancelFirstBallCue()
    updateHUD()
    if (!shopPanel.classList.contains('hidden')) buildShop()
    spawnQbToast(`Ball ${getState().unlockedSlots} Unlocked!`)
  }
})

qbCheapBtn.addEventListener('click', e => {
  e.stopPropagation()
  const up = findCheapestUpgrade(getState())
  if (!up) return
  const oldR = up.stat === 'radius' ? ballStats(getState().balls[up.ballIdx]).maxRadius : 0
  if (tryUpgrade(up.ballIdx, up.stat)) {
    syncBallStats(up.ballIdx)
    if (up.stat === 'radius') spawnRadiusGhost(up.ballIdx, oldR)
    updateHUD()
    if (!shopPanel.classList.contains('hidden')) buildShop()
    spawnQbToast(`${QB_STAT_LABEL[up.stat]} B${up.ballIdx + 1} upgraded!`)
  }
})

qbSuggestBtn.addEventListener('click', e => {
  e.stopPropagation()
  const up = findSuggestedUpgrade(getState())
  if (!up) return
  const oldR = up.stat === 'radius' ? ballStats(getState().balls[up.ballIdx]).maxRadius : 0
  if (tryUpgrade(up.ballIdx, up.stat)) {
    syncBallStats(up.ballIdx)
    if (up.stat === 'radius') spawnRadiusGhost(up.ballIdx, oldR)
    updateHUD()
    if (!shopPanel.classList.contains('hidden')) buildShop()
    spawnQbToast(`${QB_STAT_LABEL[up.stat]} B${up.ballIdx + 1} upgraded!`)
  }
})

qbStoreBtn.addEventListener('click', e => {
  e.stopPropagation()
  toggleShop()
})

devToggle.addEventListener('click', () => devPanel.classList.toggle('hidden'))
devClose.addEventListener('click',  () => devPanel.classList.add('hidden'))

devAddCoinsBtn.addEventListener('click', () => {
  devAddCoins(1000)
  updateHUD()
  if (!shopPanel.classList.contains('hidden')) buildShop()
})

devPrestigeBtn.addEventListener('click', () => {
  devAddPrestige()
  updateHUD()
  if (!shopPanel.classList.contains('hidden')) buildShop()
})

devResetBtn.addEventListener('click', () => {
  const st = devReset()
  balls = []
  currentChain  = null
  autoUpgradeTimer = 0
  wasBoardActiveSinceLastKickstart = false
  particles.length  = 0
  tapCircles.length = 0
  resetFirstBallCue()

  // Full reset always restores intro mode (introComplete is false in default state)
  introMode            = !st.introComplete
  introCoins           = 0
  introReadyToComplete = false
  introCompleting      = false
  introTransTimer      = 0
  introTransScale      = 1

  if (introMode) {
    for (let i = 0; i < INTRO_BALL_COUNT; i++) balls.push(makeIntroBall(i))
    document.body.classList.add('intro-active')
    shopPanel.classList.add('hidden')
  } else {
    for (let i = 0; i < st.unlockedSlots; i++) balls.push(makeBall(st.balls[i], i))
    document.body.classList.remove('intro-active')
    if (!shopPanel.classList.contains('hidden')) buildShop()
  }

  devPanel.classList.add('hidden')
  updateHUD()
})

devResetIntroBtn.addEventListener('click', () => {
  devResetIntro()   // sets introComplete = false in save; real game state unchanged
  balls = []
  currentChain = null
  wasBoardActiveSinceLastKickstart = false
  particles.length  = 0
  tapCircles.length = 0
  introMode            = true
  introCoins           = 0
  introReadyToComplete = false
  introCompleting      = false
  introTransTimer      = 0
  introTransScale      = 1
  for (let i = 0; i < INTRO_BALL_COUNT; i++) balls.push(makeIntroBall(i))
  document.body.classList.add('intro-active')
  shopPanel.classList.add('hidden')
  devPanel.classList.add('hidden')
  updateHUD()
})

// ─── Keyboard shortcuts (dev) ─────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (e.target !== document.body && e.target !== canvas) return
  switch (e.key.toLowerCase()) {
    case 'd':                               // toggle debug overlay
      debugVisible = !debugVisible
      debugOverlay.classList.toggle('hidden', !debugVisible)
      break
    case ']':                               // add coins
      devAddCoins(500)
      updateHUD()
      if (!shopPanel.classList.contains('hidden')) buildShop()
      break
  }
})

// ─── Resize ───────────────────────────────────────────────────────────────
window.addEventListener('resize', () => calcUnits())

// ─── Boot ─────────────────────────────────────────────────────────────────
function init() {
  const st = getState()
  introMode = !st.introComplete

  balls = []
  if (introMode) {
    // Power-preview: 20 fast balls, store hidden, no real-state mutation
    for (let i = 0; i < INTRO_BALL_COUNT; i++) balls.push(makeIntroBall(i))
    document.body.classList.add('intro-active')
  } else {
    for (let i = 0; i < st.unlockedSlots; i++) balls.push(makeBall(st.balls[i], i))
  }

  updateHUD()
  lastTime = performance.now()
  requestAnimationFrame(loop)
}

init()
