// store.js — Chain Reaction: Idle  (state, config, persistence)

const STORAGE_KEY = 'cr_v3'
const LEGACY_KEY  = 'cr_v2'   // read once on first launch for migration

// ─── Color system ─────────────────────────────────────────────────────────
//
// COLOR_ORDER is the rigid purchase sequence. Players buy balls in this order,
// cycling back to Violet after Red. Prestige / relic systems may override this
// later — all purchase logic goes through getNextPurchaseColor() so nothing
// else needs to change.

export const COLOR_ORDER = ['violet', 'blue', 'green', 'yellow', 'orange', 'red']

export const COLOR_HEX = {
  violet: '#a78bfa',
  blue:   '#42d4ff',
  green:  '#4fffb0',
  yellow: '#ffe566',
  orange: '#ff8c42',
  red:    '#ff4f6a',
}

// ─── Config ───────────────────────────────────────────────────────────────

export const GameConfig = {
  ballRadius:     2.4,
  growDuration:   140,   // ms — expand to full radius (fixed)
  holdDuration:    80,   // ms — Lv0 base; piecewise curve applied via holdMs()
  shrinkDuration: 120,   // ms — collapse back (fixed)
}

export const EconomyConfig = {
  baseCoinValue:  10,
  softCapDivisor: 120,   // reserved; not active yet
}

// ─── Chain multiplier table ───────────────────────────────────────────────
// chainBonus = chainBaseValue × getChainMultiplier(chainLength)
// chainBaseValue = sum of each triggered ball's (value × chainPowerMult).
//
// Tune the table here. CHAIN_LATE_RATE controls 11+ chains.
const CHAIN_MULT_TABLE = [
  0,     //  1-chain: no bonus
  0.5,   //  2-chain
  1.25,  //  3-chain
  2.5,   //  4-chain
  5,     //  5-chain
  9,     //  6-chain
  15,    //  7-chain
  24,    //  8-chain
  36,    //  9-chain
  52,    // 10-chain
]
const CHAIN_LATE_RATE = 1.38   // growth per extra link beyond 10

export function getChainMultiplier(chainLength) {
  if (chainLength <= 1) return 0
  const idx = chainLength - 1
  if (idx < CHAIN_MULT_TABLE.length) return CHAIN_MULT_TABLE[idx]
  return Math.floor(
    CHAIN_MULT_TABLE[CHAIN_MULT_TABLE.length - 1]
    * Math.pow(CHAIN_LATE_RATE, chainLength - CHAIN_MULT_TABLE.length)
  )
}

export function chainEndBonus(chainLength, chainBaseValue) {
  const mult = getChainMultiplier(chainLength)
  if (mult <= 0) return 0
  return Math.floor(chainBaseValue * mult)
}

// ─── Color-bucket upgrade costs ──────────────────────────────────────────
// Upgrades apply to ALL balls of that color — present and future.
// Five types: value, speed, diameter, duration, chainPower.
// Each has a front-loaded early table then a geometric tail.

const UPGRADE_COST_CONFIG = {
  value:      { early: [18, 42, 95, 210, 460],   tail: 1.34 },
  speed:      { early: [20, 45, 100, 220, 480],  tail: 1.32 },
  diameter:   { early: [20, 45, 100, 225, 500],  tail: 1.35 },
  duration:   { early: [15, 35, 80,  180, 400],  tail: 1.35 },
  chainPower: { early: [40, 90, 200, 440, 960],  tail: 1.38 },
}

export function colorUpgradeCost(upgradeType, level) {
  const cfg = UPGRADE_COST_CONFIG[upgradeType]
  if (!cfg) return Infinity
  if (level < cfg.early.length) return cfg.early[level]
  return Math.floor(
    cfg.early[cfg.early.length - 1]
    * Math.pow(cfg.tail, level - cfg.early.length + 1)
  )
}

// ─── Ball purchase costs ──────────────────────────────────────────────────
// Key = state.totalBallsPurchased (balls already owned before the purchase).

const BALL_BUY_EARLY = { 1: 10, 2: 25, 3: 60, 4: 140, 5: 325, 6: 800, 7: 2000 }
const BALL_BUY_LATE_BASE  = 2000
const BALL_BUY_LATE_MULT  = 1.9
const BALL_BUY_LATE_START = 7

export function nextBallCost(state) {
  const n = state.totalBallsPurchased
  if (BALL_BUY_EARLY[n] !== undefined) return BALL_BUY_EARLY[n]
  return Math.floor(BALL_BUY_LATE_BASE * Math.pow(BALL_BUY_LATE_MULT, n - BALL_BUY_LATE_START))
}

// ─── Click / tap upgrade (player-level, separate from color buckets) ──────

const TAP_UPGRADE_CONFIG = {
  radius:   { baseCost: 300, costMult: 1.20 },
  duration: { baseCost: 250, costMult: 1.22 },
}

export function tapUpgradeCost(stat, level) {
  const { baseCost, costMult } = TAP_UPGRADE_CONFIG[stat] ?? { baseCost: 300, costMult: 1.20 }
  return Math.floor(baseCost * Math.pow(costMult, level))
}

export function clickStats(cl) {
  return {
    tapRadius:   9.6 * Math.pow(1.05, cl.radiusLevel   ?? 0),
    tapDuration: 220 * Math.pow(1.18, cl.durationLevel ?? 0),  // ms — hold window
  }
}

// ─── Derived stat formulas (pure) ────────────────────────────────────────

// Piecewise hold-time curve.
//   Lv0 → 80 ms   Lv5 → 680 ms   Lv15 → 1 180 ms   Lv20 → 1 305 ms
function holdMs(durationLevel) {
  if (durationLevel <= 0)  return 80
  if (durationLevel <= 5)  return 80  + durationLevel * 120
  if (durationLevel <= 15) return 680 + (durationLevel - 5)  * 50
  return                          1180 + (durationLevel - 15) * 25
}

function speedMult(level) {
  // Diminishing-returns: maxBonus=2.0, curve=8 → ceiling ≈ ×3
  return 1 + 2.0 * (1 - Math.exp(-level / 8))
}

const BASE_EXPANSION_RADIUS = 6.5
const MAX_EXPANSION_RADIUS  = 18
const DIAMETER_CURVE        = 12
function getExpansionRadius(level) {
  const t = 1 - Math.exp(-level / DIAMETER_CURVE)
  return BASE_EXPANSION_RADIUS + (MAX_EXPANSION_RADIUS - BASE_EXPANSION_RADIUS) * t
}

// Per-pop coin value — scales ×1.35 per level.
//   Lv0 → 10   Lv1 → 13   Lv2 → 18   Lv3 → 24   Lv5 → 44
function getBallValue(level) {
  return Math.floor(EconomyConfig.baseCoinValue * Math.pow(1.35, level))
}

// Chain contribution multiplier — each level adds 30% to this ball's
// weight in the chain bonus base value (does not affect per-pop rewards).
//   Lv0 → ×1.0   Lv3 → ×1.9   Lv5 → ×2.5
function getChainPowerMult(level) {
  return 1 + level * 0.30
}

// Compute stats from a raw bucket object (no state reference needed).
// Exported for use in suggested-upgrade calculations in main.js.
export function statsFromBucket(bkt) {
  return {
    speed:          0.30 * speedMult(bkt.speedLevel      ?? 0),
    maxRadius:      getExpansionRadius(bkt.diameterLevel  ?? 0),
    growMs:         GameConfig.growDuration,
    holdMs:         holdMs(bkt.durationLevel              ?? 0),
    shrinkMs:       GameConfig.shrinkDuration,
    respawnMs:      999999999,   // board-clear refill handles respawn
    value:          getBallValue(bkt.valueLevel           ?? 0),
    chainPowerMult: getChainPowerMult(bkt.chainPowerLevel ?? 0),
  }
}

export function getDerivedBallStats(state, colorKey) {
  return statsFromBucket(getColorBucket(state, colorKey))
}

// ─── Color-bucket helpers ─────────────────────────────────────────────────

function newColorBucket() {
  return {
    ballsOwned:      0,
    valueLevel:      0,
    speedLevel:      0,
    diameterLevel:   0,
    durationLevel:   0,
    chainPowerLevel: 0,
  }
}

export function getColorBucket(state, color) {
  return state.colorBuckets?.[color] ?? newColorBucket()
}

export function getColorUpgradeLevel(state, color, upgradeType) {
  return getColorBucket(state, color)[upgradeType + 'Level'] ?? 0
}

// Returns the color that will be purchased next.
// Hook for future relic overrides: change this function only.
export function getNextPurchaseColor(state) {
  return COLOR_ORDER[state.totalBallsPurchased % COLOR_ORDER.length]
}

// Returns progress through the current 7-color cycle.
// ownedInCycle: Set of colors already bought this cycle (positions < position).
export function getColorOrderProgress(state) {
  const total         = state.totalBallsPurchased
  const cycle         = Math.floor(total / COLOR_ORDER.length)
  const position      = total % COLOR_ORDER.length
  const nextColor     = COLOR_ORDER[position]
  const ownedInCycle  = new Set(COLOR_ORDER.slice(0, position))
  return { cycle, position, nextColor, ownedInCycle }
}

// ─── Stats helpers ────────────────────────────────────────────────────────

function defaultCurrentStats() {
  return {
    totalEarned:        0,
    ballsPopped:        0,
    manualClicks:       0,
    chainsTriggered:    0,
    biggestChain:       0,
    bestChainPayout:    0,
    chainPointsEarned:  0,
    manualPointsEarned: 0,
    ballsPurchased:     0,
    upgradesPurchased:  0,
    startedAt:          Date.now(),
  }
}

function defaultAllTimeStats() {
  return {
    totalEarned:        0,
    ballsPopped:        0,
    manualClicks:       0,
    chainsTriggered:    0,
    biggestChain:       0,
    bestChainPayout:    0,
    chainPointsEarned:  0,
    manualPointsEarned: 0,
    ballsPurchased:     0,
    upgradesPurchased:  0,
    totalPrestiges:     0,
    highestCurrency:    0,
  }
}

function defaultColorStats() {
  return { ballsPopped: 0, ballsPurchased: 0, upgradesPurchased: 0, totalEarned: 0 }
}

// Ensures all nested stats fields exist on a loaded/merged state.
// Safe to call on any state object — only adds missing keys, never overwrites.
function ensureStatsFields(st) {
  const s = st.stats
  if (!s.current)        s.current        = defaultCurrentStats()
  if (!s.allTime)        s.allTime        = defaultAllTimeStats()
  if (!s.byColor)        s.byColor        = {}
  if (!s.chainsByLength) s.chainsByLength = {}
  // Merge missing keys into existing nested objects
  s.current = { ...defaultCurrentStats(),  ...s.current }
  s.allTime  = { ...defaultAllTimeStats(),  ...s.allTime  }
  for (const c of COLOR_ORDER)
    s.byColor[c] = { ...defaultColorStats(), ...(s.byColor[c] ?? {}) }
}

// ─── State ────────────────────────────────────────────────────────────────

function defaultState() {
  const colorBuckets = {}
  for (const c of COLOR_ORDER) colorBuckets[c] = newColorBucket()
  colorBuckets.violet.ballsOwned = 1   // first ball given at game start

  return {
    coins:               0,
    totalCoins:          0,
    colorBuckets,
    totalBallsPurchased: 1,   // violet is already owned
    clicks:              { radiusLevel: 0, durationLevel: 0 },
    prestigeCount:       0,
    autoUpgradeEnabled:  false,
    introComplete:       false,
    firstBallCueShown:   false,
    stats: {
      // Legacy flat fields (kept for backward compat + debug overlay)
      bestChainLength:    0,
      lastChainLength:    0,
      lastChainCoins:     0,
      totalChains:        0,
      lastKickstartBonus: 0,
      // Nested tracking (new)
      current:        defaultCurrentStats(),
      allTime:        defaultAllTimeStats(),
      byColor:        Object.fromEntries(COLOR_ORDER.map(c => [c, defaultColorStats()])),
      chainsByLength: {},
    },
  }
}

// Merge a saved cr_v3 object with defaults (handles partial / future saves).
function mergeState(saved) {
  const def = defaultState()
  const merged = { ...def, ...saved }
  merged.clicks = { ...def.clicks, ...(saved.clicks ?? {}) }
  merged.stats  = { ...def.stats,  ...(saved.stats  ?? {}) }
  const mergedBuckets = {}
  for (const c of COLOR_ORDER)
    mergedBuckets[c] = { ...newColorBucket(), ...(saved.colorBuckets?.[c] ?? {}) }
  merged.colorBuckets = mergedBuckets
  // Ensure all nested stat fields exist (handles saves from before nested stats)
  ensureStatsFields(merged)
  return merged
}

// Migrate a cr_v2 save (individual-ball model) into the new color-bucket model.
// Coins, prestige, and stats are preserved.
// Old balls are distributed into COLOR_ORDER by position and their upgrade levels
// are converted to the nearest color-bucket equivalent.
function migrateV2State(old) {
  const st          = defaultState()
  st.coins          = old.coins          ?? 0
  st.totalCoins     = old.totalCoins     ?? 0
  st.prestigeCount  = old.prestigeCount  ?? 0
  st.autoUpgradeEnabled = old.autoUpgradeEnabled ?? false
  st.introComplete  = old.introComplete  ?? false
  st.firstBallCueShown  = old.firstBallCueShown  ?? false
  st.stats          = { ...st.stats, ...(old.stats ?? {}) }

  const oldCount = old.unlockedSlots ?? 1
  const oldBalls = old.balls ?? []
  st.totalBallsPurchased = oldCount

  // Reset buckets, then distribute owned balls across COLOR_ORDER.
  for (const c of COLOR_ORDER) st.colorBuckets[c] = newColorBucket()
  for (let i = 0; i < oldCount; i++) {
    const colorKey = COLOR_ORDER[i % COLOR_ORDER.length]
    st.colorBuckets[colorKey].ballsOwned++
  }

  // Convert old per-ball upgrade levels to color bucket levels.
  // For each color, take the max across all old balls that mapped to that slot.
  for (let i = 0; i < oldBalls.length; i++) {
    const ob  = oldBalls[i]
    if (!ob) continue
    const key = COLOR_ORDER[i % COLOR_ORDER.length]
    const bkt = st.colorBuckets[key]
    bkt.speedLevel    = Math.max(bkt.speedLevel,    ob.speedLevel    ?? 0)
    bkt.diameterLevel = Math.max(bkt.diameterLevel, ob.radiusLevel   ?? 0)
    bkt.durationLevel = Math.max(bkt.durationLevel, ob.durationLevel ?? 0)
    // respawnLevel dropped — no equivalent in new model
    // valueLevel / chainPowerLevel start at 0 (no old equivalent)
  }

  return st
}

function loadState() {
  try {
    // Try the current version key first
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return mergeState(JSON.parse(raw))

    // Fall back to cr_v2 for migration
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const migrated = migrateV2State(JSON.parse(legacyRaw))
      saveState(migrated)   // write to cr_v3 immediately
      return migrated
    }
  } catch (_) {}
  return defaultState()
}

function saveState(st) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(st))
}

let state = loadState()
export function getState() { return state }

// ─── Mutations ────────────────────────────────────────────────────────────

// trackStats=false for dev cheats so they don't inflate earned totals.
export function addCoins(n, trackStats = true) {
  state.coins      += n
  state.totalCoins += n
  if (trackStats) {
    state.stats.current.totalEarned += n
    state.stats.allTime.totalEarned += n
  }
  if (state.coins > state.stats.allTime.highestCurrency)
    state.stats.allTime.highestCurrency = state.coins
  saveState(state)
}

export function recordKickstart(bonus) {
  state.stats.lastKickstartBonus = bonus
  saveState(state)
}

// chainCoins = per-pop coins earned during chain; chainBonus = chain-end multiplier bonus.
export function recordChainEnd(chainLength, chainCoins, chainBonus = 0) {
  if (chainLength === 0) return
  const total = chainCoins + chainBonus
  state.stats.lastChainLength = chainLength
  state.stats.lastChainCoins  = total
  state.stats.totalChains++
  if (chainLength > state.stats.bestChainLength)
    state.stats.bestChainLength = chainLength

  const s = state.stats
  s.current.chainsTriggered++
  s.allTime.chainsTriggered++
  if (chainLength > s.current.biggestChain)  s.current.biggestChain  = chainLength
  if (chainLength > s.allTime.biggestChain)   s.allTime.biggestChain  = chainLength
  if (total > s.current.bestChainPayout)     s.current.bestChainPayout = total
  if (total > s.allTime.bestChainPayout)      s.allTime.bestChainPayout = total
  // Chain-end bonus is a chain-category earning (per-pop coins tracked in recordBallPopped)
  if (chainBonus > 0) {
    s.current.chainPointsEarned += chainBonus
    s.allTime.chainPointsEarned += chainBonus
  }
  const key = String(chainLength)
  s.chainsByLength[key] = (s.chainsByLength[key] ?? 0) + 1

  saveState(state)
}

export function recordBallPopped(colorKey, coins, isManual) {
  const s = state.stats
  s.current.ballsPopped++
  s.allTime.ballsPopped++
  const cs = s.byColor[colorKey]
  if (cs) { cs.ballsPopped++; cs.totalEarned += coins }
  if (isManual) {
    s.current.manualPointsEarned += coins
    s.allTime.manualPointsEarned += coins
  } else {
    s.current.chainPointsEarned += coins
    s.allTime.chainPointsEarned += coins
  }
  saveState(state)
}

export function recordManualClick() {
  state.stats.current.manualClicks++
  state.stats.allTime.manualClicks++
  saveState(state)
}

export function resetCurrentStatsForPrestige() {
  state.stats.current = defaultCurrentStats()
  state.stats.allTime.totalPrestiges++
  saveState(state)
}

// Returns the purchased colorKey on success, or null on failure.
export function tryPurchaseNextBall() {
  const cost = nextBallCost(state)
  if (state.coins < cost) return null
  state.coins -= cost
  const colorKey = getNextPurchaseColor(state)
  state.colorBuckets[colorKey].ballsOwned++
  state.totalBallsPurchased++
  state.stats.current.ballsPurchased++
  state.stats.allTime.ballsPurchased++
  const cs = state.stats.byColor[colorKey]
  if (cs) cs.ballsPurchased++
  saveState(state)
  return colorKey
}

// Returns true if the upgrade was purchased.
export function tryPurchaseColorUpgrade(color, upgradeType) {
  const bkt = state.colorBuckets[color]
  if (!bkt) return false
  const level = bkt[upgradeType + 'Level'] ?? 0
  const cost  = colorUpgradeCost(upgradeType, level)
  if (state.coins < cost) return false
  state.coins -= cost
  bkt[upgradeType + 'Level']++
  state.stats.current.upgradesPurchased++
  state.stats.allTime.upgradesPurchased++
  const cs = state.stats.byColor[color]
  if (cs) cs.upgradesPurchased++
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

export function setAutoUpgrade(enabled) {
  state.autoUpgradeEnabled = state.prestigeCount > 0 ? enabled : false
  saveState(state)
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

export function setFirstBallCueShown() {
  state.firstBallCueShown = true
  saveState(state)
}

export function devAddCoins(n) { addCoins(n, false) }

// Dev: free color upgrade (bypasses cost).
export function devFreeColorUpgrade(color, upgradeType) {
  const bkt = state.colorBuckets[color]
  if (!bkt) return false
  bkt[upgradeType + 'Level'] = (bkt[upgradeType + 'Level'] ?? 0) + 1
  saveState(state)
  return true
}

export function devFreeUpgradeClick(stat) {
  state.clicks[stat + 'Level']++
  saveState(state)
  return true
}

// Dev: free next ball purchase.
export function devFreeUnlockNextBall() {
  const colorKey = getNextPurchaseColor(state)
  state.colorBuckets[colorKey].ballsOwned++
  state.totalBallsPurchased++
  saveState(state)
  return colorKey
}

export function devReset() {
  state = defaultState()
  saveState(state)
  return state
}
