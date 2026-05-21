// store.js — Chain Reaction: Idle  (state, config, persistence)

const STORAGE_KEY = 'cr_v2'

// ─── Config (edit these for balance tuning) ───────────────────────────────

export const GameConfig = {
  ballRadius:     2.4,   // virtual units
  // Expansion timing split into three phases (all ms).
  // growDuration and shrinkDuration are fixed regardless of upgrades.
  // holdDuration is computed per-ball via ballStats() using a piecewise curve.
  growDuration:   140,   // ms — expand to full radius (fixed, never scales)
  holdDuration:    80,   // ms — hold at max radius   (Lv0 base; see ballStats)
  shrinkDuration: 120,   // ms — collapse back (fixed, never scales)
}

export const EconomyConfig = {
  baseCoinValue:   10,
  chainMultiplier: 1.05,
  softCapDivisor:  120,   // effectiveIndex = rawIndex / (1 + rawIndex / softCapDivisor)
}

export const UpgradeConfig = {
  ball: {
    speed:    { baseCost: 200,  costMult: 1.14 },
    radius:   { baseCost: 250,  costMult: 1.17 },
    duration: { baseCost: 300,  costMult: 1.19 },
    respawn:  { baseCost: 500,  costMult: 1.26 },
  },
  // Each successive ball's upgrades cost this much more (zero-based index exponent).
  // Ball 1 = ×1.0, Ball 2 = ×1.12, Ball 3 = ×1.2544, …
  ballIndexCostMult: 1.12,
  tap: {
    radius: { baseCost: 300, costMult: 1.20 },
  },
  // New-ball slot cost — front-loaded so the player reaches 4–6 balls fast,
  // then hits a hard ramp so later balls require real investment.
  // Key = ownedBallCount (balls owned before buying the next one).
  newBall: {
    earlyCosts: {
      1:    10,   // buy Ball 2  (almost instant)
      2:    25,   // buy Ball 3
      3:    60,   // buy Ball 4
      4:   140,   // buy Ball 5
      5:   325,   // buy Ball 6
      6:   800,   // buy Ball 7
      7:  2000,   // buy Ball 8
    },
    // Beyond the lookup table: 2000 × 1.9^(ownedCount − 7)
    lateBase:  2000,
    lateMult:  1.9,
    lateStart: 7,
  },
}

// BallTypeConfig: data-driven to allow future special ball types.
// behaviorHooks: null = standard bounce physics.
// Future types supply hook functions here without touching core logic.
export const BallTypeConfig = [
  {
    id:                 'standard',
    name:               'Ball',
    baseCostMultiplier: 1.0,
    maxOwned:           Infinity,
    baseStats: {
      speed:     0.30,   // virtual units / frame tick
      maxRadius: 15,     // virtual units at expansion peak
      respawnMs: 6000,   // ms before re-entering play (hard floor: 650ms)
      // Expansion timing is defined in GameConfig, not here, so that all
      // balls share one source of truth for the phase durations.
    },
    behaviorHooks: null,
  },
]

// ─── Derived stat formulas (pure, no side-effects) ────────────────────────

// Piecewise hold-time curve: front-loaded so early levels feel dramatic,
// tapering off at higher levels so the upgrade never becomes broken.
//   Lv0  →  80 ms   (fast, punchy)
//   Lv1  → 200 ms   (+120)
//   Lv3  → 440 ms
//   Lv5  → 680 ms
//   Lv10 → 930 ms
//   Lv15 → 1 180 ms
//   Lv20 → 1 305 ms
function holdMs(durationLevel) {
  if (durationLevel <= 0)  return 80
  if (durationLevel <= 5)  return 80  + durationLevel * 120
  if (durationLevel <= 15) return 680 + (durationLevel - 5)  * 50
  return                          1180 + (durationLevel - 15) * 25
}

// Generic diminishing-returns multiplier.
// Approaches (1 + maxBonus) asymptotically; curve controls how fast it gets there.
// formula: 1 + maxBonus * (1 − e^(−level / curve))
function diminishingUpgrade(level, maxBonus, curve) {
  return 1 + maxBonus * (1 - Math.exp(-level / curve))
}

// Speed: maxBonus=2.0, curve=8 → big early gains, soft ceiling near ×3.
//   Lv0  → ×1.00   Lv1  → ×1.24   Lv2  → ×1.44   Lv3  → ×1.63
//   Lv5  → ×1.93   Lv10 → ×2.43   Lv20 → ×2.84
function speedMult(level) {
  return diminishingUpgrade(level, 2.0, 8)
}

export function ballStats(ball) {
  const base = BallTypeConfig[0].baseStats
  return {
    speed:     base.speed     * speedMult(ball.speedLevel),
    maxRadius: base.maxRadius * (1 + ball.radiusLevel * 0.035),
    growMs:    GameConfig.growDuration,          // fixed — stays snappy at all levels
    holdMs:    holdMs(ball.durationLevel),        // piecewise — main upgrade lever
    shrinkMs:  GameConfig.shrinkDuration,        // fixed — visual-only collapse
    respawnMs: Math.max(650,
               base.respawnMs * Math.pow(0.93, ball.respawnLevel)),
  }
}

export function clickStats(cl) {
  return {
    tapRadius: 9.6 * Math.pow(1.05, cl.radiusLevel),
  }
}

// ─── Cost formulas ────────────────────────────────────────────────────────

// Front-loaded cost tables — all entries are before the per-ball index multiplier.
//
// Duration:  Lv0→15  Lv1→35  Lv2→80  Lv3→180  Lv4→400  then ×1.35/level
// Speed:     Lv0→20  Lv1→45  Lv2→100 Lv3→220  Lv4→480  then ×1.32/level
const EARLY_DURATION_COSTS = [15, 35, 80, 180, 400]
const EARLY_SPEED_COSTS    = [20, 45, 100, 220, 480]

// ballIndex is zero-based: first ball = 0, second = 1, …
// Passing no index (or 0) gives the original cost for Ball 1.
export function ballUpgradeCost(stat, level, ballIndex = 0) {
  const indexMult = Math.pow(UpgradeConfig.ballIndexCostMult, ballIndex)

  if (stat === 'duration') {
    const base = level < EARLY_DURATION_COSTS.length
      ? EARLY_DURATION_COSTS[level]
      : Math.floor(400 * Math.pow(1.35, level - 4))
    return Math.floor(base * indexMult)
  }

  if (stat === 'speed') {
    const base = level < EARLY_SPEED_COSTS.length
      ? EARLY_SPEED_COSTS[level]
      : Math.floor(480 * Math.pow(1.32, level - 4))
    return Math.floor(base * indexMult)
  }

  const { baseCost, costMult } = UpgradeConfig.ball[stat]
  return Math.floor(baseCost * indexMult * Math.pow(costMult, level))
}

export function tapUpgradeCost(stat, level) {
  const { baseCost, costMult } = UpgradeConfig.tap[stat]
  return Math.floor(baseCost * Math.pow(costMult, level))
}

// ownedCount = number of balls already owned before buying the next one.
export function slotCost(ownedCount) {
  const { earlyCosts, lateBase, lateMult, lateStart } = UpgradeConfig.newBall
  if (earlyCosts[ownedCount] !== undefined) return earlyCosts[ownedCount]
  return Math.floor(lateBase * Math.pow(lateMult, ownedCount - lateStart))
}

// ─── Economy ──────────────────────────────────────────────────────────────

// Flat reward per ball triggered — every ball in the chain earns the same amount.
// The multiplier bonus is applied once at chain end via chainEndBonus().
export function chainReward() {
  return EconomyConfig.baseCoinValue
}

// Bonus awarded when a chain ends.
// Formula: totalCoins × (multiplier^chainLength − 1)
// A chain of 10 with 1.05 gives a +63% bonus on everything earned.
// A chain of 20 gives +165%. Short chains still feel good; long chains are exciting.
export function chainEndBonus(chainLength, totalCoins) {
  if (chainLength < 2) return 0
  const { chainMultiplier } = EconomyConfig
  return Math.floor(totalCoins * (Math.pow(chainMultiplier, chainLength) - 1))
}

// ─── State helpers ────────────────────────────────────────────────────────

function newBallData() {
  return { speedLevel: 0, radiusLevel: 0, durationLevel: 0, respawnLevel: 0 }
}

function defaultState() {
  return {
    coins:               0,
    totalCoins:          0,
    balls:               [newBallData()],
    unlockedSlots:       1,
    clicks:              { radiusLevel: 0 },
    prestigeCount:       0,      // increments each prestige; gates auto-upgrade
    autoUpgradeEnabled:  false,  // only effective when prestigeCount > 0
    introComplete:       false,  // true after the power-preview intro has run once
    stats: {
      bestChainLength:    0,
      lastChainLength:    0,
      lastChainCoins:     0,
      totalChains:        0,
      lastKickstartBonus: 0,
    },
  }
}

function mergeState(saved) {
  const def = defaultState()
  return {
    ...def,
    ...saved,
    clicks: { ...def.clicks, ...(saved.clicks ?? {}) },
    stats:  { ...def.stats,  ...(saved.stats  ?? {}) },
    // Ensure every ball entry has all keys (handles saves from older versions)
    balls: (saved.balls ?? [newBallData()]).map(b => ({ ...newBallData(), ...b })),
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return mergeState(JSON.parse(raw))
  } catch (_) {}
  return defaultState()
}

function saveState(st) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(st))
}

let state = loadState()
export function getState() { return state }

// ─── Mutations ────────────────────────────────────────────────────────────

export function addCoins(n) {
  state.coins      += n
  state.totalCoins += n
  saveState(state)
}

export function recordKickstart(bonus) {
  state.stats.lastKickstartBonus = bonus
  saveState(state)
}

export function recordChainEnd(chainLength, chainCoins) {
  if (chainLength === 0) return
  state.stats.lastChainLength = chainLength
  state.stats.lastChainCoins  = chainCoins
  state.stats.totalChains++
  if (chainLength > state.stats.bestChainLength)
    state.stats.bestChainLength = chainLength
  saveState(state)
}

export function tryUpgrade(ballIdx, stat) {
  const ball = state.balls[ballIdx]
  if (!ball) return false
  const key  = stat + 'Level'
  const cost = ballUpgradeCost(stat, ball[key], ballIdx)   // pass index for per-ball multiplier
  if (state.coins < cost) return false
  state.coins -= cost
  ball[key]++
  saveState(state)
  return true
}

export function tryUpgradeClick(stat) {
  const key  = stat + 'Level'
  const cost = tapUpgradeCost(stat, state.clicks[key])
  if (state.coins < cost) return false
  state.coins -= cost
  state.clicks[key]++
  saveState(state)
  return true
}

export function tryUnlockSlot() {
  const n    = state.unlockedSlots
  const cost = slotCost(n)
  if (state.coins < cost) return false
  state.coins -= cost
  state.unlockedSlots++
  state.balls.push(newBallData())
  saveState(state)
  return true
}

export function setAutoUpgrade(enabled) {
  // Guard: can only enable if prestige has been earned
  state.autoUpgradeEnabled = state.prestigeCount > 0 ? enabled : false
  saveState(state)
}

export function devAddCoins(n) {
  addCoins(n)
}

export function setIntroComplete() {
  state.introComplete = true
  saveState(state)
}

export function devResetIntro() {
  state.introComplete = false
  saveState(state)
}

export function devAddPrestige() {
  state.prestigeCount++
  saveState(state)
}

export function devReset() {
  state = defaultState()
  saveState(state)
  return state
}
