// main.js — Chain Reaction: Idle  (game loop, input, rendering)

import {
  getState, addCoins, recordChainEnd, recordKickstart,
  recordBallPopped, recordManualClick, resetCurrentStatsForPrestige,
  tryPurchaseNextBall, tryPurchaseColorUpgrade,
  getDerivedBallStats, statsFromBucket, colorUpgradeCost, nextBallCost,
  COLOR_ORDER, COLOR_HEX, EconomyConfig,
  clickStats, tapUpgradeCost, tryUpgradeClick,
  chainEndBonus, getChainMultiplier,
  getNextPurchaseColor, getColorOrderProgress, getColorBucket,
  setAutoUpgrade,
  setIntroComplete, devResetIntro, setFirstBallCueShown,
  devAddCoins, devAddPrestige, devReset,
  devFreeColorUpgrade, devFreeUpgradeClick, devFreeUnlockNextBall,
} from './store.js'

// ─── DOM refs ─────────────────────────────────────────────────────────────
const canvas     = document.getElementById('c')
const ctx        = canvas.getContext('2d')
const hudCoins   = document.getElementById('hud-coins')
const hudChain   = document.getElementById('hud-chain')
const hudCoinsBtn     = document.getElementById('hud-coins-btn')
const hudExpandArrow  = document.getElementById('hud-expand-arrow')
const statsMini       = document.getElementById('stats-mini')
const smtPopped       = document.getElementById('smt-popped')
const smtChain        = document.getElementById('smt-chain')
const smtPayout       = document.getElementById('smt-payout')
const smtEarned       = document.getElementById('smt-earned')
const statsFullBtn    = document.getElementById('stats-full-btn')
const statsScreen     = document.getElementById('stats-screen')
const statsScreenClose = document.getElementById('stats-screen-close')
const statsTabBody    = document.getElementById('stats-tab-body')
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
const devResetIntroBtn    = document.getElementById('dev-reset-intro')
const devFreeUpgradesBtn  = document.getElementById('dev-free-upgrades')

// ── Dev free-upgrades flag ──
let devFreeUpgradesEnabled = false

// ── Stats mini panel state ──
let statsMiniOpen  = false
let statsActiveTab = 'run'

// ── Shop currency animation ──
// Tracks the coin count the last time buildShop() rendered, so we can
// detect purchases and trigger the bump/flash animation.
let shopLastCoins = -1

// ── Shop collapsed sections — persists while shop stays open ──
// Keys: 'tap' | colorKey string
const shopCollapsed = new Set()

// ── Chain escalation ──────────────────────────────────────────────────────
// Set to a positive value on each ball trigger; decays to 0 within a few frames.
// Applied as a random world-space translate each frame for a physical "thump" feel.
let chainShakeAmt = 0

// ── Quick-buy bar ──
const qbBar         = document.getElementById('quick-buy-bar')
const qbBallBtn     = document.getElementById('qb-ball')
const qbBallIconEl  = document.getElementById('qb-ball-icon')
const qbBallLabelEl = document.getElementById('qb-ball-label')
const qbBallCostEl  = document.getElementById('qb-ball-cost')
const qbBuyBtn        = document.getElementById('qb-buy')
const qbBuyBallIconEl = document.getElementById('qb-buy-ball-icon')
const qbBuyIconEl     = document.getElementById('qb-buy-icon')
const qbBuyLabelEl    = document.getElementById('qb-buy-label')
const qbBuyCostEl     = document.getElementById('qb-buy-cost')
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
  // qbBar.offsetHeight returns 0 when the bar is hidden (intro mode).
  const barPx  = qbBar.offsetHeight
  const availH = barPx > 0 ? H - barPx : H
  // Scale so the virtual field fits inside the available height (above the bar).
  gameScale   = Math.min(W / VIRTUAL_W, availH / VIRTUAL_H)
  gameOffsetX = (W - VIRTUAL_W * gameScale) / 2
  // Center the play field in the available space above the quick-buy bar.
  gameOffsetY = Math.max(0, (availH - VIRTUAL_H * gameScale) / 2)
  // Full virtual height fits above the bar — no virtual-unit reduction needed.
  gamePlayH = VIRTUAL_H
}
calcUnits()

// Prevent browser scroll / zoom gestures on the canvas
canvas.style.touchAction = 'none'

// ─── Physics constants ────────────────────────────────────────────────────
const BALL_RADIUS = 2.4    // virtual units — visual size and wall-bounce boundary
// Collision/trigger radius is slightly larger than visual for fair-feeling chains.
// Using center-to-center distance: trigger fires when dist < expansionR + BALL_COLLISION_RADIUS,
// i.e. the edge of the expansion visually overlaps the edge of the target ball.
const BALL_COLLISION_RADIUS = BALL_RADIUS * 1.15   // = 2.76 u

const REFILL_START_DELAY    = 150   // ms before any ball pops in after board clear
const SPAWN_STAGGER_MAX     = 250   // ms of additional spread across the wave
const SPAWN_GROW_DURATION   = 220   // ms: scale 0 → 1.15 (overshoot)
const SPAWN_SETTLE_DURATION = 160   // ms: scale 1.15 → 1.0

// ─── Dynamic arena ────────────────────────────────────────────────────────
// World size scales with owned ball count so 1–2 balls get a tight arena
// (chains are easy to discover) while 9+ balls gradually expand the space.
function getArenaScale(n) {
  if (n <= 3)  return 0.55
  if (n <= 6)  return 0.70
  if (n <= 9)  return 0.85
  if (n <= 12) return 1.00
  return Math.min(1.20, 1.0 + Math.log1p(n - 13) * 0.07)
}

let currentArenaScale = 1   // lerps toward target each frame; snapped on init & intro-end
let arenaW = VIRTUAL_W      // world width in virtual units  (updated every frame)
let arenaH = VIRTUAL_H      // world height in virtual units (updated every frame)

// Expansion phase durations live on each ball object (growMs / holdMs / shrinkMs)
// and are derived from GameConfig + upgrade level in getDerivedBallStats(). No global
// EXPAND_DURATION / SHRINK_DURATION constants — those have been removed.
const WIGGLE_FREQ = 0.016  // rad/ms
const WIGGLE_DUR  = 380    // ms

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
let cycleBaseEarned         = 0   // coins from b.value only (no chain-end bonuses)

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
let introTweening        = false  // post-intro zoom tween: ball pinned to world centre
let introTransTimer      = 0      // ms elapsed in transition
let introTransScale      = 1      // [1→0] scales all ball radii during animation
let introBirthPopPlayed  = false  // ensures the collapse-pop fires exactly once

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

  // Find the cheapest affordable upgrade across all color buckets that own balls
  let bestCost  = Infinity
  let bestColor = null
  let bestType  = null

  for (const colorKey of COLOR_ORDER) {
    const bkt = st.colorBuckets[colorKey]
    if (!bkt || bkt.ballsOwned === 0) continue
    for (const upgradeType of ['value', 'speed', 'diameter', 'duration', 'chainPower']) {
      const level = bkt[upgradeType + 'Level'] ?? 0
      const cost  = colorUpgradeCost(upgradeType, level)
      if (cost <= st.coins && cost < bestCost) {
        bestCost  = cost
        bestColor = colorKey
        bestType  = upgradeType
      }
    }
  }

  if (bestColor && tryPurchaseColorUpgrade(bestColor, bestType)) {
    syncColorBalls(bestColor)
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
    id:           nextChainId++,
    index:        0,       // number of balls triggered so far
    coins:        0,       // per-pop coins earned this chain
    chainContrib: 0,       // sum of (b.value * b.chainPowerMult) — base for chain bonus
    triggered:    new Set(),
  }
}

function endChain() {
  if (!currentChain) return
  // Intro: skip saving chain stats and tutorial hooks
  if (!introMode) {
    const chainLen   = currentChain.index
    const chainCoins = currentChain.coins
    const chainBase  = currentChain.chainContrib   // weighted sum for bonus calc
    const mult       = getChainMultiplier(chainLen)
    const bonus      = chainEndBonus(chainLen, chainBase)
    if (bonus > 0) {
      addCoins(bonus)
      spawnChainBonusLabel(chainLen, mult, bonus)
    }
    recordChainEnd(chainLen, chainCoins, bonus)
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
      if (tc.expTimer >= (tc.holdMs ?? TAP_HOLD_MS)) { tc.state = 'shrinking'; tc.expTimer = 0 }
    } else if (tc.state === 'shrinking') {
      const t = Math.min(tc.expTimer / TAP_SHRINK_MS, 1)
      tc.curRadius = tc.maxRadius * (1 - t * t * t)
      if (t >= 1) { tapCircles.splice(i, 1); continue }
    }

    // Collision — trigger any idle ball whose edge overlaps the active circle
    if (isTapActive(tc)) {
      for (const b of balls) {
        if (b.state !== 'idle' || getSpawnScale(b) < 0.8) continue
        const dx = b.x - tc.x, dy = b.y - tc.y
        if (Math.sqrt(dx * dx + dy * dy) < tc.curRadius + b.collisionRadius) {
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

// Spawns diameter-change ghost on every ball of that color.
function spawnRadiusGhost(colorKey, oldMaxR) {
  const newMaxR = getDerivedBallStats(getState(), colorKey).maxRadius
  for (const b of balls) {
    if (b.colorKey === colorKey)
      radiusGhosts.push({ x: b.x, y: b.y, oldR: oldMaxR, newR: newMaxR, timer: 0 })
  }
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

// Single sharp "collapse" pop played at the moment the shaking singularity
// implodes just before the explosion ring fires.
// Layers: sub-bass thump (impact body) + noise crack (transient snap) + high click (attack edge).
function playBirthPop() {
  try {
    const ac  = getAudio()
    const now = ac.currentTime + AUDIO_AHEAD

    // Sub-bass thump — sine sweeping down from 90 → 28 Hz, punchy and physical
    const osc1  = ac.createOscillator()
    const gain1 = ac.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(90, now)
    osc1.frequency.exponentialRampToValueAtTime(28, now + 0.18)
    gain1.gain.setValueAtTime(0, now)
    gain1.gain.linearRampToValueAtTime(0.85, now + 0.004)   // near-instant attack
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.40)
    osc1.connect(gain1); gain1.connect(ac.destination)
    osc1.start(now); osc1.stop(now + 0.40)

    // Noise crack — band-passed white noise for the "snap" texture
    const frames = Math.ceil(ac.sampleRate * 0.20)
    const buf    = ac.createBuffer(1, frames, ac.sampleRate)
    const data   = buf.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
    const src    = ac.createBufferSource()
    src.buffer   = buf
    const filt   = ac.createBiquadFilter()
    filt.type    = 'bandpass'
    filt.frequency.setValueAtTime(1200, now)
    filt.Q.setValueAtTime(0.7, now)
    const gain2  = ac.createGain()
    gain2.gain.setValueAtTime(0.45, now)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.20)
    src.connect(filt); filt.connect(gain2); gain2.connect(ac.destination)
    src.start(now); src.stop(now + 0.20)

    // High-frequency click — very brief bright transient that sells the "point" moment
    const osc2  = ac.createOscillator()
    const gain3 = ac.createGain()
    osc2.type = 'triangle'
    osc2.frequency.setValueAtTime(3200, now)
    gain3.gain.setValueAtTime(0.30, now)
    gain3.gain.exponentialRampToValueAtTime(0.001, now + 0.06)
    osc2.connect(gain3); gain3.connect(ac.destination)
    osc2.start(now); osc2.stop(now + 0.06)
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
function makeBall(colorKey) {
  const stats = getDerivedBallStats(getState(), colorKey)
  const r     = BALL_RADIUS
  const angle = Math.random() * Math.PI * 2
  return {
    id:       nextBallId++,
    spawnGen: 1,           // increments each time ball respawns
    x:        r + Math.random() * (arenaW - r * 2),
    y:        r + Math.random() * (arenaH - r * 2),
    vx:       Math.cos(angle) * stats.speed,
    vy:       Math.sin(angle) * stats.speed,
    color:    COLOR_HEX[colorKey],
    colorKey,
    state:    'idle',
    expTimer:  0,
    curRadius: 0,
    baseRadius:      r,
    collisionRadius: BALL_COLLISION_RADIUS,
    flash: 0, sqx: 1, sqy: 1,
    wigAmp: 0, wigTimer: 0, wigAngle: 0,
    spawnInTimer: -1, spawnInDelay: 0,
    value:          stats.value,
    chainPowerMult: stats.chainPowerMult,
    maxRadius:      stats.maxRadius,
    growMs:         stats.growMs,
    holdMs:         stats.holdMs,
    shrinkMs:       stats.shrinkMs,
    respawnMs:      stats.respawnMs,
    respawnTimer:   0,
  }
}

// ─── Intro ball factory ───────────────────────────────────────────────────
function makeIntroBall(i) {
  const colorKey = COLOR_ORDER[i % COLOR_ORDER.length]
  const r        = BALL_RADIUS
  const angle    = Math.random() * Math.PI * 2
  return {
    id:          nextBallId++,
    spawnGen:    1,
    x:           r + Math.random() * (arenaW - r * 2),
    y:           r + Math.random() * (arenaH - r * 2),
    vx:          Math.cos(angle) * INTRO_STATS.speed,
    vy:          Math.sin(angle) * INTRO_STATS.speed,
    color:       COLOR_HEX[colorKey],
    colorKey,
    state:       'idle',
    expTimer:    0,
    curRadius:   0,
    baseRadius:      r,
    collisionRadius: BALL_COLLISION_RADIUS,
    flash: 0, sqx: 1, sqy: 1,
    wigAmp: 0, wigTimer: 0, wigAngle: 0,
    spawnInTimer: -1, spawnInDelay: 0,
    value:          EconomyConfig.baseCoinValue,
    chainPowerMult: 1,
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
  b.chainTriggerIdx = chainIndex   // stored so drawBall can scale the glow
  const coins = b.value
  if (currentChain) {
    currentChain.index++
    currentChain.coins        += coins
    currentChain.chainContrib += b.value * b.chainPowerMult
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
    recordBallPopped(b.colorKey, coins, /* isManual: */ !src?.colorKey)
    cycleTriggerOccurrences++   // every pop counts, including re-triggers after respawn
    cycleBaseEarned += coins    // raw earn before chain-end bonuses
    // Screen shake — scales with chain depth, capped so it never feels nauseating
    chainShakeAmt = Math.max(chainShakeAmt, Math.min(chainIndex * 0.08, 1.0))
    // HUD chain number pulse
    hudChain.classList.remove('chain-hud-pulse')
    void hudChain.offsetWidth   // force reflow so animation restarts
    hudChain.classList.add('chain-hud-pulse')
  }
  spawnCoinLabel(b.x, b.y, coins, chainIndex)
  // Particle count and spread scale with chain depth
  const pCount = Math.min(22 + chainIndex * 2, 55)
  const pMaxR  = b.maxRadius * (1 + chainIndex * 0.04)
  spawnParticles(b.x, b.y, b.color, pCount, pMaxR)
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
  vx = Math.max(r, Math.min(arenaW - r, vx))
  vy = Math.max(r, Math.min(arenaH - r, vy))

  if (!introMode) { cyclePlayerStarts++; recordManualClick() }
  startChain()

  const cs = clickStats(getState().clicks)
  tapCircles.push({ x: vx, y: vy, maxRadius: cs.tapRadius, curRadius: 0,
                    holdMs: cs.tapDuration,
                    state: 'expanding', expTimer: 0 })
  spawnParticles(vx, vy, '#ffffff', 14, maxRadius * 1.4)
  playTrigger(0)
}

// ─── Sync live ball stats after upgrade ───────────────────────────────────
// Updates all balls of a given color from their bucket (used after any upgrade).
function syncColorBalls(colorKey) {
  const stats = getDerivedBallStats(getState(), colorKey)
  for (const b of balls) {
    if (b.colorKey !== colorKey) continue
    b.maxRadius     = stats.maxRadius
    b.growMs        = stats.growMs
    b.holdMs        = stats.holdMs
    b.shrinkMs      = stats.shrinkMs
    b.respawnMs     = stats.respawnMs
    b.value         = stats.value
    b.chainPowerMult = stats.chainPowerMult
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
}

function addBallForColor(colorKey) {
  balls.push(makeBall(colorKey))
}

// ─── Main loop ────────────────────────────────────────────────────────────
function loop(ts) {
  const dt = Math.min(ts - lastTime, 50)
  lastTime = ts

  // Lerp arena scale toward target (ball-count driven; intro uses INTRO_BALL_COUNT).
  {
    const target = getArenaScale(introMode ? INTRO_BALL_COUNT : getState().totalBallsPurchased)
    currentArenaScale += (target - currentArenaScale) * Math.min(1, dt * 0.004)
    if (introTweening && Math.abs(currentArenaScale - target) < 0.008) introTweening = false
  }
  arenaW = VIRTUAL_W * currentArenaScale
  arenaH = gamePlayH * currentArenaScale

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#050810'
  ctx.fillRect(gameOffsetX, gameOffsetY, VIRTUAL_W * gameScale, VIRTUAL_H * gameScale)

  ctx.save()
  ctx.translate(gameOffsetX, gameOffsetY)
  ctx.scale(gameScale, gameScale)
  ctx.beginPath(); ctx.rect(0, 0, VIRTUAL_W, VIRTUAL_H); ctx.clip()

  update(dt)

  // During the intro-to-game zoom tween, pin the first ball to the current world
  // centre. The camera already maps (arenaW/2, arenaH/2) to screen centre, so this
  // makes the zoom look like pure scale — no lateral drift of the ball.
  if (introTweening && balls.length > 0) {
    balls[0].x = arenaW / 2
    balls[0].y = arenaH / 2
    // vx/vy are left untouched so the ball moves naturally once the tween ends
  }

  // Camera: maps world space (0..arenaW × 0..arenaH) into virtual space (0..VIRTUAL_W × 0..gamePlayH).
  // When arenaScale < 1 the camera zooms in, making the tighter world fill the same canvas.
  const cameraS = 1.0 / currentArenaScale
  ctx.save()
  ctx.scale(cameraS, cameraS)
  // Screen shake — random offset in world space, decays within a few frames
  if (chainShakeAmt > 0 && !introCompleting) {
    ctx.translate(
      (Math.random() - 0.5) * 2 * chainShakeAmt,
      (Math.random() - 0.5) * 2 * chainShakeAmt
    )
  }
  drawGrid()

  // Board-clear refill ripple — single ring expanding from arena centre
  if (refillRippleTimer >= 0) {
    const t      = refillRippleTimer / REFILL_RIPPLE_MS
    const rippleR = Math.min(arenaW, arenaH) * 0.52 * t
    ctx.save()
    ctx.globalAlpha = (1 - t) * 0.15
    ctx.lineWidth   = 1.2
    ctx.strokeStyle = 'rgba(66,212,255,1)'
    ctx.beginPath(); ctx.arc(arenaW / 2, arenaH / 2, rippleR, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }

  drawAll()
  drawRadiusGhosts()
  drawTapCircles()
  drawParticles()
  if (introCompleting) drawIntroTransition()

  ctx.restore()   // camera

  ctx.restore()   // virtual

  // Field border — now that the play area is bottom-aligned above the bar,
  // the full virtual height is correct and no clamping is needed.
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
  for (let x = 0; x <= arenaW; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, arenaH); ctx.stroke()
  }
  for (let y = 0; y <= arenaH; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(arenaW, y); ctx.stroke()
  }
}

// ─── Spawn-in animation ───────────────────────────────────────────────────

// Returns the visual scale multiplier for a ball's spawn-in pop.
// < 0 timer  → inactive (scale = 1).
// delay phase → 0 (invisible until pop).
// grow phase  → 0 → 1.12 (overshoot).
// settle phase→ 1.12 → 1.0.
function getSpawnScale(b) {
  if (b.spawnInTimer < 0) return 1
  const t = b.spawnInTimer - b.spawnInDelay
  if (t < 0) return 0
  if (t < SPAWN_GROW_DURATION)
    return (t / SPAWN_GROW_DURATION) * 1.15
  if (t < SPAWN_GROW_DURATION + SPAWN_SETTLE_DURATION)
    return 1.15 - ((t - SPAWN_GROW_DURATION) / SPAWN_SETTLE_DURATION) * 0.15
  return 1
}

let refillRippleTimer = -1   // < 0 inactive; 0+ ms elapsed
const REFILL_RIPPLE_MS = 450
let refillInputLock = 0      // ms remaining; blocks player taps during refill wave

// ─── Board-clear refill ───────────────────────────────────────────────────
// Reset EVERY owned ball slot to idle with a fresh random position/velocity.
// Always iterates the full balls array so no ball is ever missed, regardless
// of its current state (respawning, done, or any unexpected intermediate state).
function refillAllOwnedBalls() {
  const st = getState()
  const r  = BALL_RADIUS
  const cx = arenaW / 2
  const cy = arenaH / 2

  // Sort by current distance from arena centre — nearest pops first so the
  // wave reads as expanding outward from the middle.
  const sorted = [...balls].sort((a, b) => {
    const da = Math.hypot(a.x - cx, a.y - cy)
    const db = Math.hypot(b.x - cx, b.y - cy)
    return da - db
  })

  sorted.forEach((b, i) => {
    const stats = b.isIntro ? INTRO_STATS : getDerivedBallStats(st, b.colorKey)
    const angle = Math.random() * Math.PI * 2
    b.x = r + Math.random() * (arenaW - r * 2)
    b.y = r + Math.random() * (arenaH - r * 2)
    b.vx = Math.cos(angle) * stats.speed
    b.vy = Math.sin(angle) * stats.speed
    b.maxRadius     = stats.maxRadius
    b.holdMs        = stats.holdMs
    b.respawnMs     = stats.respawnMs
    b.value         = stats.value         ?? b.value
    b.chainPowerMult = stats.chainPowerMult ?? b.chainPowerMult
    b.respawnTimer = 0
    b.curRadius    = 0
    b.sqx = 1; b.sqy = 1
    b.spawnGen++
    b.state = 'idle'
    // Wave stagger: nearest ball at REFILL_START_DELAY, furthest at +SPAWN_STAGGER_MAX.
    // Small noise (±15 ms) breaks up clusters of same-distance balls.
    const waveFrac = sorted.length > 1 ? i / (sorted.length - 1) : 0
    const noise    = (Math.random() - 0.5) * 30
    b.spawnInTimer = 0
    b.spawnInDelay = Math.max(0, REFILL_START_DELAY + waveFrac * SPAWN_STAGGER_MAX + noise)
  })

  refillRippleTimer = 0
  // Keep input locked for the full wave + grow window so the player can't tap
  // into a half-popped board by accident.
  refillInputLock = REFILL_START_DELAY + SPAWN_STAGGER_MAX + SPAWN_GROW_DURATION + 80
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
        const stats = b.isIntro ? INTRO_STATS : getDerivedBallStats(getState(), b.colorKey)
        const angle = Math.random() * Math.PI * 2
        b.x  = r + Math.random() * (arenaW - r * 2)
        b.y  = r + Math.random() * (arenaH - r * 2)
        b.vx = Math.cos(angle) * stats.speed
        b.vy = Math.sin(angle) * stats.speed
        b.maxRadius     = stats.maxRadius
        b.holdMs        = stats.holdMs
        b.respawnMs     = stats.respawnMs
        b.value         = stats.value         ?? b.value
        b.chainPowerMult = stats.chainPowerMult ?? b.chainPowerMult
        b.sqx = 1; b.sqy = 1
        b.spawnGen++        // new spawn generation — can be caught again in active chain
        b.state = 'idle'
        wasBoardActiveSinceLastKickstart = true
      }
      continue
    }

    if (b.state !== 'idle') continue

    // Advance spawn-in animation; clear when fully settled
    if (b.spawnInTimer >= 0) {
      b.spawnInTimer += dt
      if (b.spawnInTimer >= b.spawnInDelay + SPAWN_GROW_DURATION + SPAWN_SETTLE_DURATION)
        b.spawnInTimer = -1
    }

    b.x += b.vx; b.y += b.vy

    if (b.x - r < 0)        { b.x = r;            b.vx *= -1; b.sqx = 0.62; b.sqy = 1.38 }
    if (b.x + r > arenaW)   { b.x = arenaW - r;   b.vx *= -1; b.sqx = 0.62; b.sqy = 1.38 }
    if (b.y - r < 0)         { b.y = r;             b.vy *= -1; b.sqx = 1.38; b.sqy = 0.62 }
    if (b.y + r > arenaH)    { b.y = arenaH - r;    b.vy *= -1; b.sqx = 1.38; b.sqy = 0.62 }

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
      if (b === src || b.state !== 'idle' || getSpawnScale(b) < 0.8) continue
      const dx = b.x - src.x, dy = b.y - src.y
      if (Math.sqrt(dx * dx + dy * dy) < src.curRadius + b.collisionRadius) {
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

  if (refillRippleTimer >= 0) {
    refillRippleTimer += dt
    if (refillRippleTimer > REFILL_RIPPLE_MS) refillRippleTimer = -1
  }
  if (refillInputLock > 0) refillInputLock = Math.max(0, refillInputLock - dt)

  // Decay screen shake — fast falloff creates a sharp "thump" rather than sustained rattle
  if (chainShakeAmt > 0) {
    chainShakeAmt *= 0.65
    if (chainShakeAmt < 0.01) chainShakeAmt = 0
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
  const isActive  = isExplosivelyActive(b)
  const spawnSc   = getSpawnScale(b)

  // Spawn-in effects — drawn before the r-gate so they fire even on first visible frame.
  if (b.spawnInTimer >= 0) {
    const elapsed = b.spawnInTimer - b.spawnInDelay

    // Pre-pop glint: tiny bright dot visible in the last 100 ms of the delay phase,
    // hinting where the ball will appear just before it pops.
    if (elapsed >= -100 && elapsed < 0) {
      const glintT = (elapsed + 100) / 100   // 0 → 1
      ctx.save()
      ctx.globalAlpha = glintT * 0.70
      ctx.fillStyle   = '#ffffff'
      ctx.shadowColor = b.color
      ctx.shadowBlur  = 5 * gameScale
      ctx.beginPath(); ctx.arc(b.x, b.y, 0.7, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
    }

    // Pop ring: ball-colored ring expands from baseRadius and fades over SPAWN_GROW_DURATION.
    if (elapsed >= 0 && elapsed < SPAWN_GROW_DURATION) {
      const ringT = elapsed / SPAWN_GROW_DURATION
      const ringR = b.baseRadius * (1 + ringT * 2.6)
      ctx.save()
      ctx.globalAlpha = (1 - ringT) * 0.55
      ctx.lineWidth   = 0.85
      ctx.strokeStyle = b.color
      ctx.shadowColor = b.color
      ctx.shadowBlur  = 3 * gameScale
      ctx.beginPath(); ctx.arc(b.x, b.y, ringR, 0, Math.PI * 2); ctx.stroke()
      ctx.restore()
    }
  }

  const r = (isActive ? b.curRadius : b.baseRadius) * introTransScale * spawnSc
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

  // Glow when actively expanding, or during the spawn-in grow window.
  const inSpawnGrow = b.spawnInTimer >= 0
    && (b.spawnInTimer - b.spawnInDelay) >= 0
    && (b.spawnInTimer - b.spawnInDelay) < SPAWN_GROW_DURATION
  if (isActive || inSpawnGrow) {
    ctx.shadowColor = b.color
    // Glow intensifies with chain depth — more dramatic the deeper into a chain
    const glowMult = 1 + Math.min((b.chainTriggerIdx ?? 0) * 0.14, 1.8)
    ctx.shadowBlur  = 3 * gameScale * glowMult
  }

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

// Formats a chain multiplier for display ("0", "0.5", "1.25", "9", "52").
function fmtMult(m) {
  if (m === 0) return '0'
  if (Number.isInteger(m)) return m.toString()
  return m % 1 === 0.5 || m < 2 ? m.toFixed(2).replace(/\.?0+$/, '') : m.toFixed(1).replace(/\.?0+$/, '')
}

// Formats a bonus amount with commas for values under 10 000, then falls back to fmt.
// "1250" → "1,250"   "12500" → "12.5K"
function fmtBonus(n) {
  n = Math.floor(n)
  if (n >= 10000) return fmt(n)
  if (n >= 1000)  return Math.floor(n / 1000) + ',' + String(n % 1000).padStart(3, '0')
  return n.toString()
}

function updateHUD() {
  const st = getState()
  // During intro show temporary visual coins (discarded on completion)
  hudCoins.textContent = fmt(introMode ? introCoins : st.coins)

  const chainIndex = currentChain ? currentChain.index : 0
  const mult = getChainMultiplier(chainIndex)
  hudChain.textContent = '×' + fmtMult(Math.max(1, mult))

  if (!introMode) updateQuickBuy()
  if (statsMiniOpen) updateStatsMini()
  if (debugVisible) updateDebug(st)
}

function updateDebug(st) {
  const active     = balls.filter(b => b.state !== 'respawning').length
  const expanding  = balls.filter(isExplosivelyActive).length
  const chainIndex = currentChain ? currentChain.index : 0
  debugOverlay.innerHTML =
    `<b>── DEBUG ──</b><br>` +
    `Balls: ${active} active / ${balls.length} total (${st.totalBallsPurchased} purchased)  |  Expanding: ${expanding}<br>` +
    `Chain now: ${chainIndex} balls<br>` +
    `Last chain: ${st.stats.lastChainLength} balls / ◆${fmt(st.stats.lastChainCoins)}<br>` +
    `Best chain: ${st.stats.bestChainLength} balls<br>` +
    `Total chains: ${st.stats.totalChains}<br>` +
    `Coins: ${fmt(st.coins)}  |  Total earned: ${fmt(st.totalCoins)}<br>` +
    `Last kickstart: +${st.stats.lastKickstartBonus}<br>` +
    `<span style="color:#4fffb0">Ball visual r: ${BALL_RADIUS}  ` +
    `collision r: ${BALL_COLLISION_RADIUS.toFixed(2)}  ` +
    `Lv0 expansion: 6.5 u  trigger dist: ${(6.5 + BALL_COLLISION_RADIUS).toFixed(1)} u</span>`
}


// ─── Floating coin label ──────────────────────────────────────────────────
function spawnCoinLabel(vx, vy, coins, chainIdx = 0) {
  const sx = Math.round((vx / currentArenaScale) * gameScale + gameOffsetX)
  const sy = Math.round((vy / currentArenaScale) * gameScale + gameOffsetY)
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
function spawnChainBonusLabel(chainLen, mult, bonus) {
  const el = document.createElement('div')
  const sizeClass = chainLen >= 10 ? ' chain-float--epic'
                  : chainLen >= 5  ? ' chain-float--big'
                  : ''
  el.className   = 'coin-float chain-float' + sizeClass
  el.textContent = `${chainLen} CHAIN  ×${fmtMult(mult)}  +${fmtBonus(bonus)}`
  el.style.left  = `${Math.round(W / 2)}px`
  el.style.top   = `${Math.round(H * 0.30)}px`
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
}

function spawnKickstartLabel(vx, vy, bonus) {
  const sx = Math.round((vx / currentArenaScale) * gameScale + gameOffsetX)
  const sy = Math.round((vy / currentArenaScale) * gameScale + gameOffsetY)
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
  el.style.top   = `${Math.round(H * 0.57)}px`
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

  currentChain        = null
  introBirthPopPlayed = false
  document.body.classList.add('intro-completing')
  playRumble()
  playIntroBuildup()
}

function updateIntroTransition(dt) {
  introTransTimer += dt
  const cx = arenaW / 2, cy = arenaH / 2

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
      b.x = Math.max(BALL_RADIUS, Math.min(arenaW - BALL_RADIUS, b.x))
      b.y = Math.max(BALL_RADIUS, Math.min(arenaH - BALL_RADIUS, b.y))
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
      b.x = Math.max(0, Math.min(arenaW, b.x))
      b.y = Math.max(0, Math.min(arenaH, b.y))
    }

  } else {
    // ── Phase 2: Birth — intro balls hidden; proto-sphere materialises ─────
    introTransScale = 0
    const elapsed = introTransTimer - INTRO_RUMBLE_DURATION - INTRO_SUCK_DURATION
    // T_SHAKE = 0.52 matches the threshold in drawIntroTransition() where the
    // shaking dot collapses and the explosion ring begins.
    if (!introBirthPopPlayed && elapsed >= 0.52 * INTRO_BIRTH_DURATION) {
      introBirthPopPlayed = true
      playBirthPop()
    }
    const end = INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION + INTRO_BIRTH_DURATION
    if (introTransTimer >= end) finishIntro()
  }
}

// Called in virtual-coord space (inside ctx.save / ctx.scale block).
// Three phases: rumble (glow auras + shake), suck (bright attractor absorbs balls),
// birth (proto-sphere contracts → dot shakes → burst → ball forms).
function drawIntroTransition() {
  const cx = arenaW / 2, cy = arenaH / 2

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
    const vGrad = ctx.createRadialGradient(cx, cy, arenaW * 0.28, cx, cy, arenaW * 0.9)
    vGrad.addColorStop(0, 'rgba(0,0,0,0)')
    vGrad.addColorStop(1, `rgba(0,0,0,${t * 0.35})`)
    ctx.fillStyle = vGrad
    ctx.fillRect(0, 0, arenaW, arenaH)

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
    const vGrad = ctx.createRadialGradient(cx, cy, arenaW * 0.30, cx, cy, arenaW * 0.88)
    vGrad.addColorStop(0, 'rgba(0,0,0,0)')
    vGrad.addColorStop(1, `rgba(0,0,0,${0.22 + t * 0.52})`)
    ctx.fillStyle = vGrad
    ctx.fillRect(0, 0, arenaW, arenaH)

  } else {
    // ── Phase 2: Birth ─────────────────────────────────────────────────────
    // introTransScale is 0 → intro balls are already invisible.
    // Proto-sphere starts at the attractor's final radius (15), contracts into a
    // tiny shaking dot, then bursts and the real ball grows in its place.
    const elapsed = introTransTimer - INTRO_RUMBLE_DURATION - INTRO_SUCK_DURATION
    const t       = Math.min(elapsed / INTRO_BIRTH_DURATION, 1)

    // Opaque background covers the now-gone intro balls
    ctx.fillStyle = 'rgba(0,0,0,0.96)'
    ctx.fillRect(0, 0, arenaW, arenaH)

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
      const color = COLOR_HEX.violet
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
  introTweening        = true   // pin ball to world centre while scale lerps in
  introTransTimer      = 0
  introTransScale      = 1
  introCoins           = 0

  // Persist the completion flag so the intro never replays
  setIntroComplete()

  // Restore UI first — makes the quick-buy bar visible so calcUnits() can
  // read its real height and give us the correct gamePlayH for ball spawning.
  document.body.classList.remove('intro-active', 'intro-completing')
  calcUnits()

  // Let the loop lerp carry currentArenaScale from the intro value down to the
  // game value — no snap so the zoom animates smoothly instead of jumping.
  // Compute the target arena dims so the first ball is placed at the destination
  // centre (safely inside bounds as the world shrinks around it).
  const st = getState()
  const targetScale  = getArenaScale(st.totalBallsPurchased)
  const targetArenaW = VIRTUAL_W * targetScale
  const targetArenaH = gamePlayH * targetScale

  // Rebuild the playfield. Place the first ball at the target centre so it
  // appears to emerge from the spiral and stays in bounds during the tween.
  balls = []
  let isFirstBall = true
  for (const colorKey of COLOR_ORDER) {
    const bkt = st.colorBuckets[colorKey]
    for (let i = 0; i < (bkt?.ballsOwned ?? 0); i++) {
      const b = makeBall(colorKey)
      if (isFirstBall) { b.x = targetArenaW / 2; b.y = targetArenaH / 2; isFirstBall = false }
      balls.push(b)
    }
  }
  currentChain = null
  wasBoardActiveSinceLastKickstart = false
  particles.length  = 0
  tapCircles.length = 0

  updateHUD()
}

// ─── First-ball cue: logic ────────────────────────────────────────────────

function checkFirstBallCue() {
  if (fbCueState !== 'idle') return
  if (introMode) return
  if (!shopPanel.classList.contains('hidden')) return  // don't fire while store is open
  const st = getState()
  if (st.firstBallCueShown) return
  if (st.totalBallsPurchased !== 1) return   // only for the very first extra ball
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
    const sx = (fbLastPopVX / currentArenaScale) * gameScale + gameOffsetX
    const sy = (fbLastPopVY / currentArenaScale) * gameScale + gameOffsetY
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

const COLOR_SHORT = {
  violet: 'Vlt', blue: 'Blu',
  green: 'Grn', yellow: 'Ylw', orange: 'Org', red: 'Red',
}

const UPGRADE_TYPE_LABEL = {
  value: 'Value', speed: 'Speed', diameter: 'Size',
  duration: 'Hold', chainPower: 'Chain',
}

const UPGRADE_TYPE_ICON = {
  value: '✦', speed: '⚡', diameter: '◉', duration: '⏳', chainPower: '⊕',
}

// Per-type accent colors for icon squares — distinct from ball colors
const UPGRADE_TYPE_COLOR = {
  value:      '#ffe566',  // gold   — earns more coins
  speed:      '#38bdf8',  // sky    — fast & energetic
  diameter:   '#c084fc',  // violet — grows bigger
  duration:   '#fb923c',  // orange — burns time
  chainPower: '#4fffb0',  // green  — chain/combo power
}

// Reason label shown on the Suggested button.
function sugReason(upgradeType, marginalGain) {
  if (marginalGain >= 0.20) return 'Big gain'
  return {
    value:      'More coins',
    speed:      'Reach more',
    diameter:   'Wider catch',
    duration:   'Longer chain',
    chainPower: 'Bigger bonus',
  }[upgradeType] ?? 'Upgrade'
}

// Track last BUY target so we can flash when it changes
let prevBuyKey = ''

// Returns { color, upgradeType, cost } for the cheapest upgrade across all
// color buckets that own at least one ball.
function findCheapestColorUpgrade(st) {
  let best = null
  for (const colorKey of COLOR_ORDER) {
    const bkt = st.colorBuckets[colorKey]
    if (!bkt || bkt.ballsOwned === 0) continue
    for (const upgradeType of ['value', 'speed', 'diameter', 'duration', 'chainPower']) {
      const level = bkt[upgradeType + 'Level'] ?? 0
      const cost  = colorUpgradeCost(upgradeType, level)
      if (!best || cost < best.cost) best = { color: colorKey, upgradeType, cost }
    }
  }
  return best
}

// ── Suggested upgrade scoring ─────────────────────────────────────────────
// score = typeWeight * marginalGain / cost^0.65

const UPGRADE_TYPE_WEIGHT = { value: 1.20, chainPower: 1.15, duration: 1.10, speed: 1.05, diameter: 1.00 }
const UPGRADE_TYPE_ORDER  = ['value', 'chainPower', 'duration', 'speed', 'diameter']

function getUpgradeStatValue(upgradeType, bkt) {
  const stats = statsFromBucket(bkt)
  switch (upgradeType) {
    case 'value':      return stats.value
    case 'speed':      return stats.speed
    case 'diameter':   return stats.maxRadius
    case 'duration':   return stats.growMs + stats.holdMs
    case 'chainPower': return stats.chainPowerMult
    default:           return 1
  }
}

// Returns { color, upgradeType, cost, score, marginalGain } for the best upgrade.
// Falls back to best-scoring overall (button disabled) when broke.
function findSuggestedColorUpgrade(st) {
  let bestAffordable = null
  let bestAny        = null

  for (const colorKey of COLOR_ORDER) {
    const bkt = st.colorBuckets[colorKey]
    if (!bkt || bkt.ballsOwned === 0) continue

    for (const upgradeType of UPGRADE_TYPE_ORDER) {
      const level    = bkt[upgradeType + 'Level'] ?? 0
      const cost     = colorUpgradeCost(upgradeType, level)
      const curVal   = getUpgradeStatValue(upgradeType, bkt)
      const nextBkt  = { ...bkt, [upgradeType + 'Level']: level + 1 }
      const nextVal  = getUpgradeStatValue(upgradeType, nextBkt)
      if (curVal <= 0) continue
      const marginalGain = (nextVal - curVal) / curVal
      const score        = UPGRADE_TYPE_WEIGHT[upgradeType] * marginalGain / Math.pow(cost, 0.65)
      const cand         = { color: colorKey, upgradeType, cost, score, marginalGain }
      if (cost <= st.coins) {
        if (!bestAffordable || score > bestAffordable.score) bestAffordable = cand
      }
      if (!bestAny || score > bestAny.score) bestAny = cand
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
  const st        = getState()
  const nextColor = getNextPurchaseColor(st)
  const ballCost  = nextBallCost(st)

  // ── BALL button — colored ball circle + color name ──
  qbBallBtn.style.setProperty('--qb-color', COLOR_HEX[nextColor])
  qbBallIconEl.textContent  = '●'
  qbBallIconEl.style.color  = COLOR_HEX[nextColor]
  qbBallIconEl.style.filter = `drop-shadow(0 0 5px ${COLOR_HEX[nextColor]})`
  qbBallLabelEl.textContent = nextColor.toUpperCase()
  qbBallCostEl.textContent  = devFreeUpgradesEnabled ? 'FREE' : `◆ ${fmt(ballCost)}`
  qbBallBtn.disabled = !devFreeUpgradesEnabled && st.coins < ballCost
  qbBallBtn.classList.toggle('qb-btn-cue-pulse',
    st.totalBallsPurchased === 1 && st.coins >= ballCost && !st.firstBallCueShown)

  // ── BUY button — best suggested upgrade ──
  const sug = findSuggestedColorUpgrade(st)
  if (sug) {
    const sugKey = `${sug.color}-${sug.upgradeType}`
    if (sugKey !== prevBuyKey && prevBuyKey !== '') {
      qbBuyLabelEl.classList.remove('qb-target-changed')
      void qbBuyLabelEl.offsetWidth
      qbBuyLabelEl.classList.add('qb-target-changed')
    }
    prevBuyKey = sugKey
    qbBuyBtn.style.setProperty('--qb-color', COLOR_HEX[sug.color])
    qbBuyBallIconEl.textContent  = '●'
    qbBuyBallIconEl.style.color  = COLOR_HEX[sug.color]
    qbBuyBallIconEl.style.filter = `drop-shadow(0 0 5px ${COLOR_HEX[sug.color]})`
    const utColor = UPGRADE_TYPE_COLOR[sug.upgradeType] ?? 'rgba(255,255,255,0.75)'
    qbBuyIconEl.textContent  = UPGRADE_TYPE_ICON[sug.upgradeType] ?? '⚡'
    qbBuyIconEl.style.color  = utColor
    qbBuyIconEl.style.filter = `drop-shadow(0 0 5px ${utColor})`
    qbBuyLabelEl.textContent = (UPGRADE_TYPE_LABEL[sug.upgradeType] ?? 'BUY').toUpperCase()
    qbBuyCostEl.textContent  = devFreeUpgradesEnabled ? 'FREE' : `◆ ${fmt(sug.cost)}`
    qbBuyBtn.disabled = !devFreeUpgradesEnabled && st.coins < sug.cost
  } else {
    prevBuyKey = ''
    qbBuyBtn.style.setProperty('--qb-color', '#42d4ff')
    qbBuyBallIconEl.textContent  = '●'
    qbBuyBallIconEl.style.color  = 'rgba(255,255,255,0.30)'
    qbBuyBallIconEl.style.filter = 'none'
    qbBuyIconEl.textContent  = '⚡'
    qbBuyIconEl.style.color  = 'rgba(255,255,255,0.30)'
    qbBuyIconEl.style.filter = 'none'
    qbBuyLabelEl.textContent = 'BUY'
    qbBuyCostEl.textContent  = '—'
    qbBuyBtn.disabled = !devFreeUpgradesEnabled
  }

  // ── Store arrow — flips when panel is open ──
  qbStoreArrow.textContent = shopPanel.classList.contains('hidden') ? '▲' : '▼'
}

// ─── Stats mini panel ─────────────────────────────────────────────────────

function closeStatsMini() {
  if (!statsMiniOpen) return
  statsMiniOpen = false
  statsMini.classList.add('hidden')
  hudExpandArrow.textContent = '▸'
}

function toggleStatsMini() {
  if (introMode) return
  statsMiniOpen = !statsMiniOpen
  statsMini.classList.toggle('hidden', !statsMiniOpen)
  hudExpandArrow.textContent = statsMiniOpen ? '▾' : '▸'
  if (statsMiniOpen) updateStatsMini()
}

function updateStatsMini() {
  const cur = getState().stats.current
  smtPopped.textContent = fmt(cur.ballsPopped)
  smtPopped.style.color = '#42d4ff'
  smtChain.textContent  = cur.biggestChain || '–'
  smtChain.style.color  = cur.biggestChain ? '#4fffb0' : 'rgba(255,255,255,0.65)'
  smtPayout.textContent = cur.bestChainPayout > 0 ? `◆${fmt(cur.bestChainPayout)}` : '–'
  smtPayout.style.color = cur.bestChainPayout > 0 ? '#ffe566' : 'rgba(255,255,255,0.65)'
  smtEarned.textContent = fmt(cur.totalEarned)
  smtEarned.style.color = '#ffe566'
}

// ─── Full stats screen ────────────────────────────────────────────────────

function openStatsScreen(tab) {
  statsActiveTab = tab ?? statsActiveTab
  statsScreen.classList.remove('hidden')
  closeStatsMini()
  // Close shop if open
  if (!shopPanel.classList.contains('hidden')) {
    shopPanel.classList.add('hidden')
    updateQuickBuy()
  }
  buildStatsScreen()
}

function buildStatsScreen() {
  // Update tab button states
  statsScreen.querySelectorAll('.stats-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === statsActiveTab))
  statsTabBody.innerHTML = ''
  const st = getState()
  if      (statsActiveTab === 'run')     buildStatsRunTab(st)
  else if (statsActiveTab === 'alltime') buildStatsAllTimeTab(st)
  else if (statsActiveTab === 'bycolor') buildStatsByColorTab(st)
}

function makeStatRow(label, value, cls = '') {
  const row  = document.createElement('div')
  row.className = 'stats-row'
  const lbl  = document.createElement('span')
  lbl.className = 'stats-row-lbl'; lbl.textContent = label
  const val  = document.createElement('span')
  val.className = 'stats-row-val' + (cls ? ` ${cls}` : ''); val.textContent = value
  row.appendChild(lbl); row.appendChild(val)
  return row
}

function makeStatsSection(title) {
  const sec   = document.createElement('div')
  sec.className = 'stats-section'

  const body  = document.createElement('div')
  body.className = 'stats-section-body'
  const inner = document.createElement('div')
  inner.className = 'stats-section-inner'
  body.appendChild(inner)

  if (title) {
    const hdr      = document.createElement('button')
    hdr.className  = 'stats-section-hdr'
    const titleEl  = document.createElement('span')
    titleEl.className = 'stats-section-title-text'
    titleEl.textContent = title
    const chevron  = document.createElement('span')
    chevron.className = 'stats-section-chevron'
    chevron.textContent = '▾'
    hdr.appendChild(titleEl)
    hdr.appendChild(chevron)
    hdr.addEventListener('click', () => {
      const collapsed = body.classList.toggle('stats-collapsed')
      chevron.style.transform = collapsed ? 'rotate(-90deg)' : ''
    })
    sec.appendChild(hdr)
  }

  sec.appendChild(body)
  // Proxy: rows appended to sec go into inner, not sec itself.
  // (statsTabBody.appendChild(sec) calls statsTabBody's method — unaffected.)
  sec.appendChild = (child) => inner.appendChild(child)
  return sec
}

function makeColorSection(colorKey) {
  const sec   = document.createElement('div')
  sec.className = 'stats-section'
  const hex   = COLOR_HEX[colorKey]
  const name  = colorKey.charAt(0).toUpperCase() + colorKey.slice(1)

  const body  = document.createElement('div')
  body.className = 'stats-section-body'
  const inner = document.createElement('div')
  inner.className = 'stats-section-inner'
  body.appendChild(inner)

  const hdr = document.createElement('button')
  hdr.className = 'stats-section-hdr stats-color-hdr'
  hdr.style.setProperty('--bc', hex)

  const orb = document.createElement('span')
  orb.className   = 'stats-color-orb'
  orb.style.cssText = `background:${hex};box-shadow:0 0 7px ${hex}`

  const nameEl = document.createElement('span')
  nameEl.className  = 'stats-color-name'
  nameEl.textContent = name
  nameEl.style.color = hex

  const chevron = document.createElement('span')
  chevron.className = 'stats-section-chevron'
  chevron.textContent = '▾'

  hdr.appendChild(orb)
  hdr.appendChild(nameEl)
  hdr.appendChild(chevron)
  hdr.addEventListener('click', () => {
    const collapsed = body.classList.toggle('stats-collapsed')
    chevron.style.transform = collapsed ? 'rotate(-90deg)' : ''
  })

  sec.appendChild(hdr)
  sec.appendChild(body)
  sec.appendChild = (child) => inner.appendChild(child)
  return sec
}

function buildStatsRunTab(st) {
  const cur     = st.stats.current
  const elapsed = Date.now() - (cur.startedAt ?? Date.now())
  const mins    = Math.floor(elapsed / 60000)
  const secs    = Math.floor((elapsed % 60000) / 1000)
  const timeStr = `${mins}m ${String(secs).padStart(2, '0')}s`

  const sec1 = makeStatsSection('This Run')
  sec1.appendChild(makeStatRow('Time',          timeStr))
  sec1.appendChild(makeStatRow('Coins Earned',  `◆ ${fmt(cur.totalEarned)}`,  'stats-val-gold'))
  sec1.appendChild(makeStatRow('Balls Popped',  fmt(cur.ballsPopped),          'stats-val-cyan'))
  sec1.appendChild(makeStatRow('Manual Clicks', fmt(cur.manualClicks),         'stats-val-cyan'))
  sec1.appendChild(makeStatRow('Chains',        fmt(cur.chainsTriggered),      'stats-val-cyan'))
  statsTabBody.appendChild(sec1)

  const sec2 = makeStatsSection('Chain Records')
  sec2.appendChild(makeStatRow('Biggest Chain', cur.biggestChain || '–',
                               cur.biggestChain ? 'stats-val-green' : ''))
  sec2.appendChild(makeStatRow('Best Payout',
                               cur.bestChainPayout > 0 ? `◆ ${fmt(cur.bestChainPayout)}` : '–',
                               cur.bestChainPayout > 0 ? 'stats-val-gold' : ''))
  statsTabBody.appendChild(sec2)

  const sec3 = makeStatsSection('Income Split')
  const total      = cur.totalEarned || 1
  const manualPct  = Math.round(cur.manualPointsEarned  / total * 100)
  const chainPct   = Math.round(cur.chainPointsEarned   / total * 100)
  sec3.appendChild(makeStatRow('Manual Points', `◆ ${fmt(cur.manualPointsEarned)} (${manualPct}%)`, 'stats-val-gold'))
  sec3.appendChild(makeStatRow('Chain Points',  `◆ ${fmt(cur.chainPointsEarned)} (${chainPct}%)`,   'stats-val-gold'))
  statsTabBody.appendChild(sec3)

  const sec4 = makeStatsSection('Purchases')
  sec4.appendChild(makeStatRow('Balls Bought',    fmt(cur.ballsPurchased),    'stats-val-cyan'))
  sec4.appendChild(makeStatRow('Upgrades Bought', fmt(cur.upgradesPurchased), 'stats-val-cyan'))
  statsTabBody.appendChild(sec4)
}

function buildStatsAllTimeTab(st) {
  const at = st.stats.allTime

  const sec1 = makeStatsSection('All-Time')
  sec1.appendChild(makeStatRow('Total Earned',  `◆ ${fmt(at.totalEarned)}`,    'stats-val-gold'))
  sec1.appendChild(makeStatRow('Peak Wallet',   `◆ ${fmt(at.highestCurrency)}`, 'stats-val-gold'))
  sec1.appendChild(makeStatRow('Balls Popped',  fmt(at.ballsPopped),            'stats-val-cyan'))
  sec1.appendChild(makeStatRow('Manual Clicks', fmt(at.manualClicks),           'stats-val-cyan'))
  sec1.appendChild(makeStatRow('Chains',        fmt(at.chainsTriggered),        'stats-val-cyan'))
  statsTabBody.appendChild(sec1)

  const sec2 = makeStatsSection('Records')
  sec2.appendChild(makeStatRow('Longest Chain',
                               at.biggestChain || '–',
                               at.biggestChain ? 'stats-val-green' : ''))
  sec2.appendChild(makeStatRow('Best Chain Payout',
                               at.bestChainPayout > 0 ? `◆ ${fmt(at.bestChainPayout)}` : '–',
                               at.bestChainPayout > 0 ? 'stats-val-gold' : ''))
  statsTabBody.appendChild(sec2)

  const sec3 = makeStatsSection('Career')
  sec3.appendChild(makeStatRow('Prestiges',          fmt(at.totalPrestiges),    'stats-val-green'))
  sec3.appendChild(makeStatRow('Balls Purchased',    fmt(at.ballsPurchased),    'stats-val-cyan'))
  sec3.appendChild(makeStatRow('Upgrades Purchased', fmt(at.upgradesPurchased), 'stats-val-cyan'))
  statsTabBody.appendChild(sec3)

  // Chain-length histogram — top entries sorted by length descending
  const byLen   = st.stats.chainsByLength ?? {}
  const entries = Object.entries(byLen)
    .map(([k, v]) => ({ len: parseInt(k), count: v }))
    .filter(e => e.len >= 2)
    .sort((a, b) => b.len - a.len)
    .slice(0, 8)
  if (entries.length > 0) {
    const sec4 = makeStatsSection('Chain Lengths')
    for (const { len, count } of entries)
      sec4.appendChild(makeStatRow(`${len}-chain`, `× ${fmt(count)}`, 'stats-val-green'))
    statsTabBody.appendChild(sec4)
  }
}

function buildStatsByColorTab(st) {
  const byColor = st.stats.byColor ?? {}
  let hadContent = false
  for (const colorKey of COLOR_ORDER) {
    const bkt = st.colorBuckets[colorKey]
    if (!bkt || bkt.ballsOwned === 0) continue
    hadContent = true
    const cs = { ...{ ballsPopped: 0, ballsPurchased: 0, upgradesPurchased: 0, totalEarned: 0 }, ...(byColor[colorKey] ?? {}) }

    const sec = makeColorSection(colorKey)
    sec.appendChild(makeStatRow('Balls Popped',    fmt(cs.ballsPopped),        'stats-val-cyan'))
    sec.appendChild(makeStatRow('Earned',          `◆ ${fmt(cs.totalEarned)}`, 'stats-val-gold'))
    sec.appendChild(makeStatRow('Balls Bought',    fmt(cs.ballsPurchased),     'stats-val-cyan'))
    sec.appendChild(makeStatRow('Upgrades Bought', fmt(cs.upgradesPurchased),  'stats-val-cyan'))
    statsTabBody.appendChild(sec)
  }
  if (!hadContent) {
    const msg = document.createElement('p')
    msg.className = 'stats-empty-msg'
    msg.textContent = 'No color data yet.'
    statsTabBody.appendChild(msg)
  }
}

// ─── Shop UI ──────────────────────────────────────────────────────────────
function makeUpgradeBtn(icon, label, level, statText, costText, canAfford, onClick) {
  const btn = document.createElement('button')
  btn.className = 'upgrade-btn'
  btn.disabled  = !canAfford

  const iconEl = document.createElement('span')
  iconEl.className   = 'upgrade-btn-icon'
  iconEl.textContent = icon

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

  const costEl = document.createElement('span')
  costEl.className   = 'upgrade-btn-cost'
  costEl.textContent = costText

  btn.appendChild(iconEl)
  btn.appendChild(infoEl)
  btn.appendChild(costEl)
  btn.addEventListener('click', onClick)
  return btn
}

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

// Per-type icon and label for upgrade tiles in the reactor panel.
// Icons follow the CHROMATIC VOID spec: ✦ ⚡ ◉ ⏳ ⊕
const UPGRADE_TYPE_DEFS = [
  { type: 'value',      icon: '✦', label: 'Value'  },
  { type: 'speed',      icon: '⚡', label: 'Speed'  },
  { type: 'diameter',   icon: '◉', label: 'Size'   },
  { type: 'duration',   icon: '⏳', label: 'Hold'   },
  { type: 'chainPower', icon: '⊕', label: 'Chain'  },
]

// Compact square chip used in collapsed card view (icon + cost only).
// Clicking it still buys the upgrade; stopPropagation prevents header toggle.
function makeUpgChip(icon, utColor, bc, costText, canAfford, onClick) {
  const chip = document.createElement('button')
  chip.className = 'upg-chip' + (canAfford ? ' upg-chip--can' : '')
  chip.disabled  = !canAfford
  chip.style.setProperty('--bc', bc)
  if (utColor) chip.style.setProperty('--ut-color', utColor)
  const iconEl = document.createElement('span')
  iconEl.className = 'upg-chip-icon'; iconEl.textContent = icon
  const costEl = document.createElement('span')
  costEl.className = 'upg-chip-cost'; costEl.textContent = costText
  chip.appendChild(iconEl); chip.appendChild(costEl)
  chip.addEventListener('click', e => { e.stopPropagation(); onClick() })
  return chip
}

function buildShop() {
  shopBody.innerHTML = ''
  const st       = getState()
  const progress = getColorOrderProgress(st)

  // -- Currency header
  {
    const hdr = document.createElement('div')
    hdr.className = 'reactor-header'
    const icon = document.createElement('span')
    icon.className = 'reactor-coin-icon'; icon.textContent = '◆'
    const val = document.createElement('span')
    val.className = 'reactor-coin-val'; val.textContent = fmt(st.coins)
    // Trigger bump animation when coins changed since last render
    if (shopLastCoins >= 0 && st.coins !== shopLastCoins) {
      const cls = st.coins > shopLastCoins ? 'cv-bump' : 'cv-flash'
      val.classList.add(cls)
      val.addEventListener('animationend', () => val.classList.remove(cls), { once: true })
    }
    shopLastCoins = st.coins

    // Compact-mode toggle — collapses / expands all cards at once
    const allKeys    = ['tap', ...COLOR_ORDER.filter(ck => {
      const b = st.colorBuckets[ck]; return b && b.ballsOwned > 0
    })]
    const anyExpanded = allKeys.some(k => !shopCollapsed.has(k))
    const compactBtn = document.createElement('button')
    compactBtn.className   = 'shop-compact-btn'
    compactBtn.textContent = anyExpanded ? '⊟' : '⊞'
    compactBtn.title       = anyExpanded ? 'Collapse all' : 'Expand all'
    compactBtn.addEventListener('click', () => {
      if (anyExpanded) allKeys.forEach(k => shopCollapsed.add(k))
      else             shopCollapsed.clear()
      buildShop()
    })

    hdr.appendChild(icon); hdr.appendChild(val); hdr.appendChild(compactBtn)
    shopBody.appendChild(hdr)
  }

  // -- Spectrum track (7 orbs)
  {
    const track = document.createElement('div')
    track.className = 'spectrum-track'
    for (let i = 0; i < COLOR_ORDER.length; i++) {
      const ck  = COLOR_ORDER[i]
      const orb = document.createElement('div')
      orb.className = 'spec-orb'
      if      (i < progress.position)  orb.classList.add('spec-orb--owned')
      else if (i === progress.position) orb.classList.add('spec-orb--next')
      else                              orb.classList.add('spec-orb--future')
      orb.style.setProperty('--oc', COLOR_HEX[ck])
      track.appendChild(orb)
    }
    shopBody.appendChild(track)
  }

  // -- Next ball card
  {
    const nextColor  = COLOR_ORDER[progress.position]
    const ballCost   = nextBallCost(st)
    const colorLabel = nextColor.charAt(0).toUpperCase() + nextColor.slice(1)
    const canBuy     = devFreeUpgradesEnabled || st.coins >= ballCost

    const card = document.createElement('button')
    card.className = 'next-ball-card'
    card.disabled  = !canBuy

    // Left zone: feature orb
    const orbEl = document.createElement('div')
    orbEl.className = 'nbc-orb'
    orbEl.style.background = COLOR_HEX[nextColor]
    orbEl.style.boxShadow  = `0 0 16px ${COLOR_HEX[nextColor]}, 0 0 32px ${COLOR_HEX[nextColor]}`

    // Center zone: label + name + cost
    const infoEl = document.createElement('div')
    infoEl.className = 'nbc-info'
    const lblEl = document.createElement('span')
    lblEl.className = 'nbc-label'; lblEl.textContent = 'NEXT BALL'
    const nameEl = document.createElement('span')
    nameEl.className = 'nbc-name'
    nameEl.textContent = colorLabel.toUpperCase()
    nameEl.style.color = COLOR_HEX[nextColor]
    const costTextEl = document.createElement('span')
    costTextEl.className = 'nbc-cost-text'
    costTextEl.textContent = devFreeUpgradesEnabled ? 'FREE' : `◆ ${fmt(ballCost)}`
    infoEl.appendChild(lblEl); infoEl.appendChild(nameEl); infoEl.appendChild(costTextEl)

    // Right zone: buy pill (visual only, pointer-events: none in CSS)
    const buyPill = document.createElement('div')
    buyPill.className = 'nbc-buy-pill'
    buyPill.textContent = 'BUY'
    buyPill.style.borderColor = canBuy ? `${COLOR_HEX[nextColor]}88` : 'rgba(255,255,255,0.10)'
    buyPill.style.color = canBuy ? COLOR_HEX[nextColor] : 'rgba(255,255,255,0.22)'

    card.appendChild(orbEl); card.appendChild(infoEl); card.appendChild(buyPill)
    card.addEventListener('click', () => {
      const colorKey = devFreeUpgradesEnabled ? devFreeUnlockNextBall() : tryPurchaseNextBall()
      if (colorKey) {
        addBallForColor(colorKey)
        cancelFirstBallCue()
        buildShop(); updateHUD()
        spawnQbToast(`${colorKey.charAt(0).toUpperCase() + colorKey.slice(1)} ball unlocked!`)
      }
    })
    shopBody.appendChild(card)
  }

  // -- Tap upgrades (radius + duration) — collapsible
  {
    const TAP_ROW_DEFS = [
      { stat: 'radius',   icon: '◎', label: 'TAP RADIUS',   color: '#42d4ff' },
      { stat: 'duration', icon: '⏳', label: 'TAP DURATION', color: '#fb923c' },
    ]
    const cardKey     = 'tap'
    const isCollapsed = shopCollapsed.has(cardKey)
    const bc          = 'rgb(66,212,255)'

    const card = document.createElement('div')
    card.className = 'bucket-card tap-card'
    card.style.setProperty('--bc', bc)

    const top = document.createElement('button')
    top.className = 'bucket-card-top'
    const orbEl = document.createElement('div')
    orbEl.className = 'bucket-orb tap-orb'; orbEl.textContent = '✶'
    const right = document.createElement('div')
    right.className = 'bucket-top-right'
    const nameEl = document.createElement('span')
    nameEl.className = 'bucket-name tap-name'; nameEl.textContent = 'TAP'
    right.appendChild(nameEl)
    top.appendChild(orbEl); top.appendChild(right)
    const chevron = document.createElement('span')
    chevron.className = 'bucket-chevron'; chevron.textContent = isCollapsed ? '▸' : '▾'
    top.appendChild(chevron)
    top.addEventListener('click', () => {
      shopCollapsed.has(cardKey) ? shopCollapsed.delete(cardKey) : shopCollapsed.add(cardKey)
      buildShop()
    })
    card.appendChild(top)

    if (!isCollapsed) {
      const grid = document.createElement('div')
      grid.className = 'bucket-upgrades'
      for (const { stat, icon, label, color } of TAP_ROW_DEFS) {
        const level     = st.clicks[stat + 'Level'] ?? 0
        const cost      = tapUpgradeCost(stat, level)
        const canAfford = devFreeUpgradesEnabled || st.coins >= cost
        const row = document.createElement('button')
        row.className = 'upg-row' + (canAfford ? ' upg-row--can' : '')
        row.disabled  = !canAfford
        const iconEl = document.createElement('span')
        iconEl.className = 'upg-row-icon'; iconEl.textContent = icon
        iconEl.style.setProperty('--ut-color', color)
        const infoEl = document.createElement('span')
        infoEl.className = 'upg-row-info'
        const labelLine = document.createElement('span')
        labelLine.className = 'upg-row-label-line'
        const labelEl = document.createElement('span')
        labelEl.className = 'upg-row-label'; labelEl.textContent = label
        const lvEl = document.createElement('span')
        lvEl.className = 'upg-row-lv'; lvEl.textContent = `Lv ${level}`
        labelLine.appendChild(labelEl); labelLine.appendChild(lvEl)
        infoEl.appendChild(labelLine)
        const costEl = document.createElement('span')
        costEl.className = 'upg-row-cost'
        costEl.textContent = devFreeUpgradesEnabled ? 'FREE' : `◆ ${fmt(cost)}`
        row.appendChild(iconEl); row.appendChild(infoEl); row.appendChild(costEl)
        row.addEventListener('click', () => {
          const ok = devFreeUpgradesEnabled ? devFreeUpgradeClick(stat) : tryUpgradeClick(stat)
          if (ok) { buildShop(); updateHUD() }
        })
        grid.appendChild(row)
      }
      card.appendChild(grid)
    } else {
      const chips = document.createElement('div')
      chips.className = 'bucket-collapsed-row'
      for (const { stat, icon, color } of TAP_ROW_DEFS) {
        const level     = st.clicks[stat + 'Level'] ?? 0
        const cost      = tapUpgradeCost(stat, level)
        const canAfford = devFreeUpgradesEnabled || st.coins >= cost
        chips.appendChild(makeUpgChip(icon, color, bc,
          devFreeUpgradesEnabled ? 'FREE' : `◆ ${fmt(cost)}`, canAfford, () => {
            const ok = devFreeUpgradesEnabled ? devFreeUpgradeClick(stat) : tryUpgradeClick(stat)
            if (ok) { buildShop(); updateHUD() }
          }))
      }
      card.appendChild(chips)
    }
    shopBody.appendChild(card)
  }

  // -- Color bucket cards
  for (const colorKey of COLOR_ORDER) {
    const bkt = st.colorBuckets[colorKey]
    if (!bkt || bkt.ballsOwned === 0) continue

    const cardKey     = colorKey
    const isCollapsed = shopCollapsed.has(cardKey)
    const bc          = COLOR_HEX[colorKey]

    const card = document.createElement('div')
    card.className = 'bucket-card'
    card.style.setProperty('--bc', bc)

    const top = document.createElement('button')
    top.className = 'bucket-card-top'

    const orbEl = document.createElement('div')
    orbEl.className = 'bucket-orb'
    orbEl.style.background = bc
    orbEl.style.boxShadow  = `0 0 16px ${bc}`

    const right = document.createElement('div')
    right.className = 'bucket-top-right'

    const nameEl = document.createElement('span')
    nameEl.className   = 'bucket-name'
    nameEl.textContent = colorKey.toUpperCase()

    const pips = document.createElement('div')
    pips.className = 'bucket-pips'
    const pipCount = Math.min(bkt.ballsOwned, 9)
    for (let i = 0; i < pipCount; i++) {
      const pip = document.createElement('span')
      pip.className = 'bucket-pip'
      pip.style.background = bc
      pip.style.boxShadow  = `0 0 4px ${bc}`
      pips.appendChild(pip)
    }
    if (bkt.ballsOwned > 9) {
      const more = document.createElement('span')
      more.className = 'bucket-pip-more'
      more.textContent = `+${bkt.ballsOwned - 9}`
      pips.appendChild(more)
    }

    right.appendChild(nameEl); right.appendChild(pips)
    top.appendChild(orbEl); top.appendChild(right)

    const chevron = document.createElement('span')
    chevron.className = 'bucket-chevron'; chevron.textContent = isCollapsed ? '▸' : '▾'
    top.appendChild(chevron)

    top.addEventListener('click', () => {
      shopCollapsed.has(cardKey) ? shopCollapsed.delete(cardKey) : shopCollapsed.add(cardKey)
      buildShop()
    })

    card.appendChild(top)

    if (!isCollapsed) {
      const grid = document.createElement('div')
      grid.className = 'bucket-upgrades'

      for (const { type, icon, label } of UPGRADE_TYPE_DEFS) {
        const level     = bkt[type + 'Level'] ?? 0
        const cost      = colorUpgradeCost(type, level)
        const canAfford = devFreeUpgradesEnabled || st.coins >= cost

        const row = document.createElement('button')
        row.className = 'upg-row' + (canAfford ? ' upg-row--can' : '')
        row.disabled  = !canAfford

        const iconEl = document.createElement('span')
        iconEl.className = 'upg-row-icon'; iconEl.textContent = icon
        const typeColor = UPGRADE_TYPE_COLOR[type]
        if (typeColor) iconEl.style.setProperty('--ut-color', typeColor)

        const infoEl = document.createElement('span')
        infoEl.className = 'upg-row-info'
        const labelLine = document.createElement('span')
        labelLine.className = 'upg-row-label-line'
        const labelEl = document.createElement('span')
        labelEl.className = 'upg-row-label'; labelEl.textContent = label.toUpperCase()
        const lvEl = document.createElement('span')
        lvEl.className = 'upg-row-lv'; lvEl.textContent = `Lv ${level}`
        labelLine.appendChild(labelEl); labelLine.appendChild(lvEl)
        infoEl.appendChild(labelLine)

        const costEl = document.createElement('span')
        costEl.className = 'upg-row-cost'
        costEl.textContent = devFreeUpgradesEnabled ? 'FREE' : `◆ ${fmt(cost)}`

        row.appendChild(iconEl); row.appendChild(infoEl); row.appendChild(costEl)
        row.addEventListener('click', () => {
          const oldR = type === 'diameter' ? getDerivedBallStats(getState(), colorKey).maxRadius : 0
          const ok   = devFreeUpgradesEnabled
            ? devFreeColorUpgrade(colorKey, type)
            : tryPurchaseColorUpgrade(colorKey, type)
          if (ok) {
            syncColorBalls(colorKey)
            if (type === 'diameter') spawnRadiusGhost(colorKey, oldR)
            buildShop(); updateHUD()
          }
        })
        grid.appendChild(row)
      }

      card.appendChild(grid)
    } else {
      const chips = document.createElement('div')
      chips.className = 'bucket-collapsed-row'
      for (const { type, icon } of UPGRADE_TYPE_DEFS) {
        const level     = bkt[type + 'Level'] ?? 0
        const cost      = colorUpgradeCost(type, level)
        const canAfford = devFreeUpgradesEnabled || st.coins >= cost
        const utColor   = UPGRADE_TYPE_COLOR[type]
        chips.appendChild(makeUpgChip(icon, utColor, bc,
          devFreeUpgradesEnabled ? 'FREE' : `◆ ${fmt(cost)}`, canAfford, () => {
            const oldR = type === 'diameter' ? getDerivedBallStats(getState(), colorKey).maxRadius : 0
            const ok   = devFreeUpgradesEnabled
              ? devFreeColorUpgrade(colorKey, type)
              : tryPurchaseColorUpgrade(colorKey, type)
            if (ok) {
              syncColorBalls(colorKey)
              if (type === 'diameter') spawnRadiusGhost(colorKey, oldR)
              buildShop(); updateHUD()
            }
          }))
      }
      card.appendChild(chips)
    }

    shopBody.appendChild(card)
  }

}
// ─── Input ────────────────────────────────────────────────────────────────
function screenToWorld(sx, sy) {
  // screen → virtual → world (virtual = world / arenaScale, so world = virtual * arenaScale)
  return [
    (sx - gameOffsetX) / gameScale * currentArenaScale,
    (sy - gameOffsetY) / gameScale * currentArenaScale,
  ]
}

canvas.addEventListener('pointerdown', e => {
  if (!e.isPrimary) return    // ignore secondary touch points (pinch, etc.)
  e.preventDefault()
  if (introCompleting || introTweening) return // no input during transition or zoom tween

  // Block while a tap circle is active, any ball is still animated, or a chain
  // is open. The currentChain check catches the brief window between the last
  // shrink finishing and endChain() running — prevents a queued tap from
  // counting as a fresh shot before the chain is fully resolved.
  if (tapCircles.length >= MAX_TAP_CLICKS || balls.some(isExplosivelyActive) || currentChain || refillInputLock > 0) return
  try { getAudio() } catch (_) {}
  const [vx, vy] = screenToWorld(e.clientX, e.clientY)
  triggerAtPoint(vx, vy)
})

// ─── Shop / Dev panel events ──────────────────────────────────────────────

function toggleShop() {
  if (introMode) return   // shop is hidden during intro
  const opening = shopPanel.classList.contains('hidden')
  shopPanel.classList.toggle('hidden')
  if (opening) {
    shopLastCoins = -1   // reset so first render doesn't animate
    buildShop()
    // Close stats panels when opening shop
    closeStatsMini()
    statsScreen.classList.add('hidden')
  }
  updateQuickBuy()   // flip the store arrow immediately
}

// ─── Stats panel events ───────────────────────────────────────────────────

hudCoinsBtn.addEventListener('click', () => toggleStatsMini())
statsFullBtn.addEventListener('click', () => openStatsScreen('run'))
statsScreenClose.addEventListener('click', () => statsScreen.classList.add('hidden'))

statsScreen.querySelectorAll('.stats-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    statsActiveTab = tab.dataset.tab
    buildStatsScreen()
  })
})

shopToggle.addEventListener('click', toggleShop)   // legacy button (hidden)
shopClose.addEventListener('click',  () => { shopPanel.classList.add('hidden'); updateQuickBuy() })

// Full-screen panel — no backdrop tap-to-close needed

// ── Quick-buy bar ──────────────────────────────────────────────────────────

// Prevent all qb touches/clicks from reaching the canvas pointerdown handler.
qbBar.addEventListener('pointerdown', e => e.stopPropagation())

qbBallBtn.addEventListener('click', e => {
  e.stopPropagation()
  const colorKey = devFreeUpgradesEnabled ? devFreeUnlockNextBall() : tryPurchaseNextBall()
  if (colorKey) {
    addBallForColor(colorKey)
    cancelFirstBallCue()
    updateHUD()
    if (!shopPanel.classList.contains('hidden')) buildShop()
    const n = colorKey.charAt(0).toUpperCase() + colorKey.slice(1)
    spawnQbToast(`${n} ball unlocked!`)
  }
})

qbBuyBtn.addEventListener('click', e => {
  e.stopPropagation()
  const up = findSuggestedColorUpgrade(getState())
  if (!up) return
  const oldR = up.upgradeType === 'diameter' ? getDerivedBallStats(getState(), up.color).maxRadius : 0
  const ok = devFreeUpgradesEnabled
    ? devFreeColorUpgrade(up.color, up.upgradeType)
    : tryPurchaseColorUpgrade(up.color, up.upgradeType)
  if (ok) {
    syncColorBalls(up.color)
    if (up.upgradeType === 'diameter') spawnRadiusGhost(up.color, oldR)
    updateHUD()
    if (!shopPanel.classList.contains('hidden')) buildShop()
    spawnQbToast(`${COLOR_SHORT[up.color]} ${UPGRADE_TYPE_LABEL[up.upgradeType]} upgraded!`)
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

devFreeUpgradesBtn.addEventListener('click', () => {
  devFreeUpgradesEnabled = !devFreeUpgradesEnabled
  devFreeUpgradesBtn.classList.toggle('dev-btn-active', devFreeUpgradesEnabled)
  devFreeUpgradesBtn.textContent = devFreeUpgradesEnabled
    ? '✦ Free Upgrades ON'
    : '✦ Free Upgrades'
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
  introTweening        = false
  introTransTimer      = 0
  introTransScale      = 1

  currentArenaScale = getArenaScale(introMode ? INTRO_BALL_COUNT : st.totalBallsPurchased)
  arenaW = VIRTUAL_W * currentArenaScale
  arenaH = gamePlayH * currentArenaScale

  if (introMode) {
    for (let i = 0; i < INTRO_BALL_COUNT; i++) balls.push(makeIntroBall(i))
    document.body.classList.add('intro-active')
    shopPanel.classList.add('hidden')
  } else {
    for (const colorKey of COLOR_ORDER) {
      const bkt = st.colorBuckets[colorKey]
      for (let i = 0; i < (bkt?.ballsOwned ?? 0); i++) balls.push(makeBall(colorKey))
    }
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
  introTweening        = false
  introTransTimer      = 0
  introTransScale      = 1
  currentArenaScale = getArenaScale(INTRO_BALL_COUNT)
  arenaW = VIRTUAL_W * currentArenaScale
  arenaH = gamePlayH * currentArenaScale
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

  // Snap arena scale to the correct starting value (no lerp on fresh load)
  currentArenaScale = getArenaScale(introMode ? INTRO_BALL_COUNT : st.totalBallsPurchased)
  arenaW = VIRTUAL_W * currentArenaScale
  arenaH = gamePlayH * currentArenaScale

  balls = []
  if (introMode) {
    // Power-preview: 20 fast balls, store hidden, no real-state mutation
    for (let i = 0; i < INTRO_BALL_COUNT; i++) balls.push(makeIntroBall(i))
    document.body.classList.add('intro-active')
  } else {
    for (const colorKey of COLOR_ORDER) {
      const bkt = st.colorBuckets[colorKey]
      for (let i = 0; i < (bkt?.ballsOwned ?? 0); i++) balls.push(makeBall(colorKey))
    }
  }

  updateHUD()
  lastTime = performance.now()
  requestAnimationFrame(loop)
}

init()
