// Chain Reaction: Idle — game loop

import {
  getState, addCoins, tryUpgrade, tryUnlockSlot,
  ballStats, upgradeCost, slotCost, UPGRADE_BASES,
  devAddCoins, devReset,
} from './store.js'

// ─── DOM refs ──────────────────────────────────────────────────
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
const devAddCoinsBtn = document.getElementById('dev-add-coins')
const devResetBtn    = document.getElementById('dev-reset')

// ─── Virtual resolution ────────────────────────────────────────
const VIRTUAL_W = 100
const VIRTUAL_H = 178   // 9∶16 portrait

// ─── Canvas / scale ────────────────────────────────────────────
let W, H, gameScale, gameOffsetX, gameOffsetY

function calcUnits() {
  W = window.innerWidth
  H = window.innerHeight
  canvas.width  = W
  canvas.height = H
  gameScale   = Math.min(W / VIRTUAL_W, H / VIRTUAL_H)
  gameOffsetX = (W - VIRTUAL_W * gameScale) / 2
  gameOffsetY = (H - VIRTUAL_H * gameScale) / 2
}

calcUnits()

// ─── Physics constants ─────────────────────────────────────────
const BALL_RADIUS     = 2.4   // virtual units
const EXPAND_DURATION = 900   // ms — idle→expand
const SHRINK_DURATION = 600   // ms — hold→shrink
const WIGGLE_FREQ     = 0.016 // rad/ms
const WIGGLE_DUR      = 380   // ms

const BALL_COLORS = [
  '#ff4f6a', '#ff8c42', '#ffe566', '#4fffb0',
  '#42d4ff', '#a78bfa', '#f472b6', '#34ebc6',
]

// ─── Game state ────────────────────────────────────────────────
let balls       = []
let chainLength = 0   // balls triggered in the current unbroken chain
let lastTime    = 0

// ─── Particles ─────────────────────────────────────────────────
const particles    = []
const MAX_PARTICLES = 500

// ─── Audio ─────────────────────────────────────────────────────
let audioCtx = null

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

function playTrigger(n) {
  try {
    const ac  = getAudio()
    const now = ac.currentTime
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

// ─── Color utils ───────────────────────────────────────────────
function lighten(hex) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 80)
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 80)
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 80)
  return `rgb(${r},${g},${b})`
}

// ─── Particles ─────────────────────────────────────────────────
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

// ─── Ball factory ──────────────────────────────────────────────
function makeBall(storeData, idx) {
  const stats = ballStats(storeData)
  const r     = BALL_RADIUS
  const angle = Math.random() * Math.PI * 2
  return {
    x:     r + Math.random() * (VIRTUAL_W - r * 2),
    y:     r + Math.random() * (VIRTUAL_H - r * 2),
    vx:    Math.cos(angle) * stats.speed,
    vy:    Math.sin(angle) * stats.speed,
    color: BALL_COLORS[idx % BALL_COLORS.length],
    state:     'idle',
    expTimer:  0,
    curRadius: 0,
    baseRadius: r,
    flash: 0, sqx: 1, sqy: 1,
    wigAmp: 0, wigTimer: 0, wigAngle: 0,
    // Per-ball live stats (synced from store on spawn / upgrade)
    storeIdx:     idx,
    maxRadius:    stats.maxRadius,
    holdMs:       stats.holdMs,
    respawnMs:    stats.respawnMs,
    respawnTimer: 0,
  }
}

// ─── Wiggle ────────────────────────────────────────────────────
function applyWiggle(obj, angle, amp) {
  obj.wigAmp   = amp
  obj.wigTimer = 0
  obj.wigAngle = angle
}

// ─── Expansion state machine ───────────────────────────────────
function updateExpansion(obj, dt) {
  obj.expTimer += dt
  if (obj.state === 'expanding') {
    const t = Math.min(obj.expTimer / EXPAND_DURATION, 1)
    obj.curRadius = (1 - Math.pow(1 - t, 3)) * obj.maxRadius   // cubic ease-out
    if (t >= 1) { obj.state = 'holding'; obj.expTimer = 0 }
  } else if (obj.state === 'holding') {
    if (obj.expTimer >= obj.holdMs) { obj.state = 'shrinking'; obj.expTimer = 0 }
  } else if (obj.state === 'shrinking') {
    const t = Math.min(obj.expTimer / SHRINK_DURATION, 1)
    obj.curRadius = obj.maxRadius * (1 - t * t * t)            // cubic ease-in
    if (t >= 1) { obj.state = 'done'; obj.curRadius = 0 }
  }
}

function isExplosivelyActive(obj) {
  return obj.state === 'expanding' || obj.state === 'holding' || obj.state === 'shrinking'
}

// ─── Trigger a ball (chain reaction step) ─────────────────────
function triggerBall(b, src) {
  if (b.state !== 'idle') return
  b.state    = 'expanding'
  b.expTimer = 0
  b.curRadius = 0
  b.vx = 0; b.vy = 0
  b.flash = 1.0

  // Coins scale with chain depth: floor(10 × 1.05^chainPos)
  const coins = Math.floor(10 * Math.pow(1.05, chainLength))
  chainLength++
  addCoins(coins)
  spawnCoinLabel(b.x, b.y, coins)

  spawnParticles(b.x, b.y, b.color, 22, b.maxRadius)
  playTrigger(chainLength)

  if (src) {
    const a = Math.atan2(b.y - src.y, b.x - src.x)
    applyWiggle(b,   a,           1.8)
    applyWiggle(src, a + Math.PI, 0.9)
  }
}

// ─── Player tap: trigger balls within a tap radius ─────────────
function triggerAtPoint(vx, vy) {
  // Clamp to game field
  const r = BALL_RADIUS
  vx = Math.max(r, Math.min(VIRTUAL_W - r, vx))
  vy = Math.max(r, Math.min(VIRTUAL_H - r, vy))

  const triggerR = BALL_RADIUS * 4   // 9.6 virt-units tap radius
  let any = false
  for (const b of balls) {
    if (b.state !== 'idle') continue
    const dx = b.x - vx, dy = b.y - vy
    if (Math.sqrt(dx * dx + dy * dy) < triggerR + b.baseRadius) {
      triggerBall(b, { x: vx, y: vy })
      any = true
    }
  }
  // Always show visual feedback at tap point
  spawnParticles(vx, vy, '#ffffff', 14, triggerR * 1.4)
  if (!any) playTrigger(0)
}

// ─── Sync live ball after upgrade ─────────────────────────────
function syncBallStats(ballIdx) {
  const b = balls[ballIdx]
  if (!b) return
  const stats = ballStats(getState().balls[ballIdx])
  b.maxRadius = stats.maxRadius
  b.holdMs    = stats.holdMs
  b.respawnMs = stats.respawnMs
  // Preserve direction but update speed magnitude
  const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
  if (spd > 0) {
    const ratio = stats.speed / spd
    b.vx *= ratio
    b.vy *= ratio
  } else {
    const a = Math.random() * Math.PI * 2
    b.vx = Math.cos(a) * stats.speed
    b.vy = Math.sin(a) * stats.speed
  }
}

// ─── Add ball when a new slot is unlocked ─────────────────────
function addBall() {
  const st  = getState()
  const idx = balls.length
  balls.push(makeBall(st.balls[idx], idx))
}

// ─── Main loop ─────────────────────────────────────────────────
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
  drawParticles()

  ctx.restore()

  // Neon border glow
  ctx.shadowColor = 'rgba(66, 212, 255, 0.55)'
  ctx.shadowBlur  = 12
  ctx.strokeStyle = 'rgba(66, 212, 255, 0.32)'
  ctx.lineWidth   = 1
  ctx.strokeRect(gameOffsetX + 0.5, gameOffsetY + 0.5,
                 VIRTUAL_W * gameScale - 1, VIRTUAL_H * gameScale - 1)
  ctx.shadowBlur = 0

  updateHUD()
  requestAnimationFrame(loop)
}

// ─── Background grid ───────────────────────────────────────────
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

// ─── Update ────────────────────────────────────────────────────
function update(dt) {
  const r      = BALL_RADIUS
  const spring = Math.min(1, dt * 0.018)

  // Wiggle timers
  for (const b of balls) b.wigTimer = Math.min(b.wigTimer + dt, WIGGLE_DUR)

  // Move idle balls + squash/stretch + respawn countdown
  for (const b of balls) {
    if (b.state === 'respawning') {
      b.respawnTimer -= dt
      if (b.respawnTimer <= 0) {
        // Respawn at a fresh random position with current upgrade stats
        const stats = ballStats(getState().balls[b.storeIdx])
        const angle = Math.random() * Math.PI * 2
        b.x  = r + Math.random() * (VIRTUAL_W - r * 2)
        b.y  = r + Math.random() * (VIRTUAL_H - r * 2)
        b.vx = Math.cos(angle) * stats.speed
        b.vy = Math.sin(angle) * stats.speed
        b.maxRadius = stats.maxRadius
        b.holdMs    = stats.holdMs
        b.respawnMs = stats.respawnMs
        b.sqx = 1; b.sqy = 1
        b.state = 'idle'
      }
      continue
    }

    if (b.state !== 'idle') continue

    b.x += b.vx; b.y += b.vy

    if (b.x - r < 0)         { b.x = r;             b.vx *= -1; b.sqx = 0.62; b.sqy = 1.38 }
    if (b.x + r > VIRTUAL_W) { b.x = VIRTUAL_W - r; b.vx *= -1; b.sqx = 0.62; b.sqy = 1.38 }
    if (b.y - r < 0)         { b.y = r;             b.vy *= -1; b.sqx = 1.38; b.sqy = 0.62 }
    if (b.y + r > VIRTUAL_H) { b.y = VIRTUAL_H - r; b.vy *= -1; b.sqx = 1.38; b.sqy = 0.62 }

    b.sqx += (1 - b.sqx) * spring
    b.sqy += (1 - b.sqy) * spring
    if (Math.abs(b.sqx - 1) < 0.01) b.sqx = 1
    if (Math.abs(b.sqy - 1) < 0.01) b.sqy = 1

    if (b.flash > 0) b.flash = Math.max(0, b.flash - dt / 150)
  }

  // Advance expansions; transition done→respawning
  for (const b of balls) {
    if (!isExplosivelyActive(b)) continue
    updateExpansion(b, dt)
    if (b.state === 'done') {
      b.state        = 'respawning'
      b.respawnTimer = b.respawnMs
      b.curRadius    = 0
    }
  }

  // Collision: any active ball can trigger idle neighbours
  for (const src of balls) {
    if (!isExplosivelyActive(src)) continue
    for (const b of balls) {
      if (b === src || b.state !== 'idle') continue
      const dx = b.x - src.x, dy = b.y - src.y
      if (Math.sqrt(dx * dx + dy * dy) < src.curRadius + b.baseRadius) {
        triggerBall(b, src)
      }
    }
  }

  updateParticles(dt)

  // Reset chain when all expansions have finished
  if (chainLength > 0 && !balls.some(isExplosivelyActive)) {
    chainLength = 0
  }
}

// ─── Draw ──────────────────────────────────────────────────────
function drawAll() {
  for (const b of balls) {
    if (b.state !== 'respawning') drawBall(b)
  }
}

function drawBall(b) {
  const isActive = isExplosivelyActive(b)
  const r        = isActive ? b.curRadius : b.baseRadius
  if (r <= 0) return

  ctx.save()

  // Directional wiggle offset
  if (b.wigAmp > 0 && b.wigTimer < WIGGLE_DUR) {
    const t   = b.wigTimer / WIGGLE_DUR
    const off = b.wigAmp * Math.sin(WIGGLE_FREQ * b.wigTimer) * (1 - t * t)
    ctx.translate(Math.cos(b.wigAngle) * off, Math.sin(b.wigAngle) * off)
  }

  // Squash/stretch (idle balls only)
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

// ─── HUD ───────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.floor(n).toString()
}

function updateHUD() {
  const st = getState()
  hudCoins.textContent = fmt(st.coins)
  // Chain multiplier = earning multiplier of the *next* ball to fire
  const mult = Math.pow(1.05, chainLength)
  hudChain.textContent = '×' + mult.toFixed(2)
}

// ─── Floating coin label ───────────────────────────────────────
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

// ─── Shop UI ───────────────────────────────────────────────────
const UPGRADE_DEFS = [
  { stat: 'speed',    label: 'Speed',    desc: 'Moves faster'    },
  { stat: 'radius',   label: 'Radius',   desc: 'Bigger explosion' },
  { stat: 'duration', label: 'Duration', desc: 'Holds longer'    },
  { stat: 'respawn',  label: 'Respawn',  desc: 'Returns faster'  },
]

function buildShop() {
  shopBody.innerHTML = ''
  const st = getState()

  for (let i = 0; i < st.unlockedSlots; i++) {
    const ball = st.balls[i]
    const card = document.createElement('div')
    card.className = 'upgrade-card'

    const title = document.createElement('div')
    title.className   = 'upgrade-card-title'
    title.textContent = `Ball ${i + 1}`
    card.appendChild(title)

    const grid = document.createElement('div')
    grid.className = 'upgrade-btns'

    for (const { stat, label } of UPGRADE_DEFS) {
      const level     = ball[stat + 'Level']
      const base      = UPGRADE_BASES[stat]
      const cost      = upgradeCost(base, level)
      const canAfford = st.coins >= cost

      const btn = document.createElement('button')
      btn.className = 'upgrade-btn'
      btn.disabled  = !canAfford

      const nameEl  = document.createElement('span')
      nameEl.className   = 'upgrade-btn-name'
      nameEl.textContent = label

      const costEl  = document.createElement('span')
      costEl.className   = 'upgrade-btn-cost'
      costEl.textContent = `◆ ${fmt(cost)}`

      const levelEl = document.createElement('span')
      levelEl.className   = 'upgrade-btn-level'
      levelEl.textContent = `Lv ${level}`

      btn.appendChild(nameEl)
      btn.appendChild(costEl)
      btn.appendChild(levelEl)

      btn.addEventListener('click', () => {
        if (tryUpgrade(i, stat)) {
          syncBallStats(i)
          buildShop()
          updateHUD()
        }
      })
      grid.appendChild(btn)
    }

    card.appendChild(grid)
    shopBody.appendChild(card)
  }

  // Unlock next ball slot
  const n       = st.unlockedSlots
  const cost    = slotCost(n)
  const unlockBtn = document.createElement('button')
  unlockBtn.className   = 'unlock-slot-btn'
  unlockBtn.disabled    = st.coins < cost
  unlockBtn.textContent = `Unlock Ball ${n + 1}  ◆ ${fmt(cost)}`
  unlockBtn.addEventListener('click', () => {
    if (tryUnlockSlot()) {
      addBall()
      buildShop()
      updateHUD()
    }
  })
  shopBody.appendChild(unlockBtn)
}

// ─── Input ─────────────────────────────────────────────────────
function screenToVirtual(sx, sy) {
  return [(sx - gameOffsetX) / gameScale, (sy - gameOffsetY) / gameScale]
}

canvas.addEventListener('pointerdown', e => {
  e.preventDefault()
  if (!shopPanel.classList.contains('hidden')) return
  try { getAudio() } catch (_) {}
  const [vx, vy] = screenToVirtual(e.clientX, e.clientY)
  triggerAtPoint(vx, vy)
})

// ─── Shop events ───────────────────────────────────────────────
shopToggle.addEventListener('click', () => {
  const opening = shopPanel.classList.contains('hidden')
  shopPanel.classList.toggle('hidden')
  if (opening) buildShop()
})

shopClose.addEventListener('click', () => shopPanel.classList.add('hidden'))

// ─── Dev panel events ──────────────────────────────────────────
devToggle.addEventListener('click', () => devPanel.classList.toggle('hidden'))
devClose.addEventListener('click',  () => devPanel.classList.add('hidden'))

devAddCoinsBtn.addEventListener('click', () => {
  devAddCoins(1000)
  updateHUD()
  if (!shopPanel.classList.contains('hidden')) buildShop()
})

devResetBtn.addEventListener('click', () => {
  const st = devReset()
  balls = []
  chainLength = 0
  particles.length = 0
  for (let i = 0; i < st.unlockedSlots; i++) balls.push(makeBall(st.balls[i], i))
  devPanel.classList.add('hidden')
  if (!shopPanel.classList.contains('hidden')) buildShop()
  updateHUD()
})

// ─── Resize ────────────────────────────────────────────────────
window.addEventListener('resize', () => calcUnits())

// ─── Boot ──────────────────────────────────────────────────────
function init() {
  const st = getState()
  balls = []
  for (let i = 0; i < st.unlockedSlots; i++) balls.push(makeBall(st.balls[i], i))
  updateHUD()
  lastTime = performance.now()
  requestAnimationFrame(loop)
}

init()
