// store.js — Chain Reaction: Idle  (state, config, persistence)

import { EconomyConstants, GameConfig, RoundConfig, getRoundGoal, isBossRound } from './balance/config.js'
export { EconomyConstants, GameConfig, RoundConfig, getRoundGoal, isBossRound }

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
//
// GameConfig and EconomyConstants are loaded from src/balance/balance.live.json
// via src/balance/config.js and re-exported above.  Edit the JSON to tune
// balance — do NOT add hardcoded values back here.
//
// Design mantra: "Logarithmic growth, exponential cost."
//   - All player-power stats use plateau (diminishing-return) formulas.
//   - All costs grow exponentially, creating a natural prestige wall.
//
// Plateau formula: multiplier = 1 + maxBonus * (1 - exp(-level / curve))
//   At lv0 → 1.0 (no bonus)
//   At lv≈curve → ~63% of maxBonus added
//   At lv→∞ → approaches 1 + maxBonus (hard ceiling)

// Legacy alias — kept so any code importing EconomyConfig still works.
export const EconomyConfig = {
  baseCoinValue:  EconomyConstants.baseCoinValue,
  softCapDivisor: 120,
}

// ─── Chain multiplier ─────────────────────────────────────────────────────

const { table: _CHAIN_TABLE, lateRate: _CHAIN_LATE } = EconomyConstants.chain

export function getChainMultiplier(chainLength) {
  if (chainLength <= 1) return 0
  const idx = chainLength - 1
  if (idx < _CHAIN_TABLE.length) return _CHAIN_TABLE[idx]
  return Math.floor(
    _CHAIN_TABLE[_CHAIN_TABLE.length - 1]
    * Math.pow(_CHAIN_LATE, chainLength - _CHAIN_TABLE.length)
  )
}

export function chainEndBonus(chainLength, chainBaseValue) {
  // Static bonus — scales with chain length via the fixed table.
  // The multiplier is NOT upgradeable in the base game; that requires the
  // Chain Breaker prestige relic (which will multiply the table values).
  const mult = getChainMultiplier(chainLength)
  if (mult <= 0) return 0
  return Math.floor(chainBaseValue * mult)
}

// ─── Upgrade costs ────────────────────────────────────────────────────────
// Pure exponential: cost = ceil(baseCost × growthRate^level × cycleMult^cycle)
// cycle = completed color cycles (0 on first run, 1 after going through all 6, …)

export function colorUpgradeCost(upgradeType, level, cycle = 0) {
  const cfg = EconomyConstants.upgradeCost[upgradeType]
  if (!cfg || cfg.baseCost === undefined) return Infinity
  return Math.ceil(
    cfg.baseCost
    * Math.pow(cfg.growthRate, level)
    * Math.pow(EconomyConstants.upgradeCost.cycleMult, cycle)
  )
}

// ─── Ball purchase costs ──────────────────────────────────────────────────

export function nextBallCost(state) {
  const n    = state.totalBallsPurchased
  const ball = EconomyConstants.ball
  if (ball.earlyTable[n] !== undefined) return ball.earlyTable[n]
  const cycle = Math.floor(n / COLOR_ORDER.length)
  return Math.ceil(
    ball.lateBase
    * Math.pow(ball.lateMult,  n - ball.lateStart)
    * Math.pow(ball.cycleMult, Math.max(0, cycle - 1))
  )
}

// ─── Tap upgrade costs ────────────────────────────────────────────────────

export function tapUpgradeCost(stat, level) {
  const key = stat === 'radius' ? 'tapRadius' : 'tapDuration'
  const cfg  = EconomyConstants.upgradeCost[key]
  if (!cfg) return Infinity
  return Math.ceil(cfg.baseCost * Math.pow(cfg.growthRate, level))
}

// ─── Derived stat formulas (plateau / diminishing-return) ─────────────────
//
// All player-power stats use the same plateau pattern:
//   multiplier = 1 + maxBonus * (1 - exp(-level / curve))
// This gives fast early gains that slow to a near-ceiling at high levels,
// matching the "logarithmic growth" design mantra.

function plateau(level, maxBonus, curve) {
  return 1 + maxBonus * (1 - Math.exp(-level / curve))
}

function holdMs(level) {
  const { baseMs, maxBonus, curve } = EconomyConstants.duration
  return Math.round(baseMs * plateau(level, maxBonus, curve))
}
// lv0→200 ms  lv1→237  lv5→363  lv10→437  lv20→480  max→600 ms

function speedMult(level) {
  const { maxBonus, curve } = EconomyConstants.speed
  return plateau(level, maxBonus, curve)
}
// speed u/ms: lv0→0.45  lv1→0.61  lv5→0.90  lv10→1.10  lv20→1.28  max→1.35

function getExpansionRadius(level) {
  const { baseR, maxR, curve } = EconomyConstants.diameter
  return baseR + (maxR - baseR) * (1 - Math.exp(-level / curve))
}
// lv0→6.5  lv1→9.0  lv2→11.0  lv5→14.7  lv10→17.1  lv20→17.9  max→18

function getBallValue(level) {
  const { maxBonus, curve } = EconomyConstants.value
  return Math.round(EconomyConstants.baseCoinValue * plateau(level, maxBonus, curve))
}
// lv0→10  lv1→40  lv2→65  lv5→126  lv10→188  lv20→240  max→260

export function clickStats(cl) {
  const rt = EconomyConstants.tap.radius
  const dt = EconomyConstants.tap.duration
  return {
    tapRadius:   rt.baseR   * plateau(cl.radiusLevel   ?? 0, rt.maxBonus, rt.curve),
    tapDuration: dt.baseMs  * plateau(cl.durationLevel ?? 0, dt.maxBonus, dt.curve),
  }
}
// tapRadius:   lv0→9.6  lv5→13.5  lv10→16.5  max→19.2
// tapDuration: lv0→220  lv5→413   lv10→491   max→550 ms

// Compute stats from a raw bucket object (no state reference needed).
// Exported for use in suggested-upgrade calculations in main.js.
export function statsFromBucket(bkt) {
  return {
    speed:     EconomyConstants.speed.base * speedMult(bkt.speedLevel    ?? 0),
    maxRadius: getExpansionRadius(bkt.diameterLevel                       ?? 0),
    growMs:    GameConfig.growDuration,
    holdMs:    holdMs(bkt.durationLevel                                   ?? 0),
    shrinkMs:  GameConfig.shrinkDuration,
    respawnMs: 999999999,   // board-clear refill handles respawn
    value:     getBallValue(bkt.valueLevel                                ?? 0),
    // chainPowerMult removed — chain bonus is a prestige relic, not a base stat
  }
}

export function getDerivedBallStats(state, colorKey) {
  return statsFromBucket(getColorBucket(state, colorKey))
}

// ─── Color-bucket helpers ─────────────────────────────────────────────────

function newColorBucket() {
  return {
    ballsOwned:    0,
    valueLevel:    0,
    speedLevel:    0,
    diameterLevel: 0,
    durationLevel: 0,
    // chainPowerLevel intentionally omitted — prestige relic unlock only
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
    bestRunCoins:       0,   // highest totalEarned in any single prestige cycle
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

// ─── Round state ──────────────────────────────────────────────────────────

function defaultRound() {
  return {
    number:        1,
    actNumber:     1,
    isBoss:        isBossRound(1),
    clicksLeft:    RoundConfig.clicksPerRound,
    refreshesLeft: RoundConfig.refreshesPerRound,
    goal:          getRoundGoal(1),
    runOver:       false,
  }
}

// ─── State ────────────────────────────────────────────────────────────────

function defaultRunColorBuckets() {
  const colorBuckets = {}
  for (const c of COLOR_ORDER) {
    colorBuckets[c] = { ...newColorBucket(), ballsOwned: 1 }
  }
  return colorBuckets
}

function defaultState() {
  return {
    coins:               0,
    totalCoins:          0,
    colorBuckets:        defaultRunColorBuckets(),
    totalBallsPurchased: 6,   // all 6 basic balls given at run start
    clicks:              { radiusLevel: 0, durationLevel: 0 },
    prestigeCount:       0,
    autoUpgradeEnabled:  false,
    introComplete:       false,
    firstBallCueShown:   false,
    round:               defaultRound(),
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
  merged.round  = { ...def.round,  ...(saved.round  ?? {}) }
  merged.stats  = { ...def.stats,  ...(saved.stats  ?? {}) }

  if (!saved.round) {
    // Pre-roguelite save: reset run state to a clean round-1 start.
    // Preserve introComplete / firstBallCueShown so the intro isn't shown again.
    merged.coins               = 0
    merged.totalCoins          = 0
    merged.colorBuckets        = defaultRunColorBuckets()
    merged.totalBallsPurchased = 6
    merged.clicks              = { radiusLevel: 0, durationLevel: 0 }
    merged.round               = defaultRound()
  } else {
    const mergedBuckets = {}
    for (const c of COLOR_ORDER)
      mergedBuckets[c] = { ...newColorBucket(), ...(saved.colorBuckets?.[c] ?? {}) }
    merged.colorBuckets = mergedBuckets
  }

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

// ─── Save throttling ─────────────────────────────────────────────────────
// Synchronous localStorage writes block the main thread.  Coin gains and
// stat tracking are debounced (write happens 4 s after the last dirty mark).
// Purchases and structural mutations (prestige, intro flags, etc.) flush
// immediately so nothing important is lost on a crash or forced close.

let _saveDirty = false
let _saveTimer = null
const SAVE_DEBOUNCE_MS = 4000

// Optional hook called after every immediate (purchase-level) local save.
// Register via setCloudSaveHook(fn) from main.js after PlayFab login.
// Receives the current state object — fire-and-forget async is fine.
let _cloudSaveHook = null
export function setCloudSaveHook(fn) { _cloudSaveHook = fn }

function _flushNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null }
  if (!_saveDirty) return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  _saveDirty = false
}

// immediate=false → debounced (coins, stats)
// immediate=true  → flush right away (purchases, prestige) + cloud sync
function saveState(st, immediate = false) {   // eslint-disable-line no-unused-vars
  _saveDirty = true
  if (immediate) {
    _flushNow()
    if (_cloudSaveHook) _cloudSaveHook(state)
    return
  }
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(_flushNow, SAVE_DEBOUNCE_MS)
}

// Exported so main.js can flush on pagehide / blur.
export function flushSave() { _flushNow() }

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
    if (state.stats.current.totalEarned > state.stats.allTime.bestRunCoins)
      state.stats.allTime.bestRunCoins = state.stats.current.totalEarned
  }
  if (state.coins > state.stats.allTime.highestCurrency)
    state.stats.allTime.highestCurrency = state.coins
  saveState(state)            // debounced — safe to call every pop
}

export function recordKickstart(bonus) {
  state.stats.lastKickstartBonus = bonus
  saveState(state)            // debounced
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
  if (chainBonus > 0) {
    s.current.chainPointsEarned += chainBonus
    s.allTime.chainPointsEarned += chainBonus
  }
  const key = String(chainLength)
  s.chainsByLength[key] = (s.chainsByLength[key] ?? 0) + 1
  saveState(state)            // debounced
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
  // No saveState here — addCoins() already debounced the write
}

export function recordManualClick() {
  state.stats.current.manualClicks++
  state.stats.allTime.manualClicks++
  // debounced via next addCoins call
}

export function resetCurrentStatsForPrestige() {
  state.stats.current = defaultCurrentStats()
  state.stats.allTime.totalPrestiges++
  saveState(state, true)      // immediate — structural change
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
  saveState(state, true)      // immediate — purchase must persist
  return colorKey
}

// Returns true if the upgrade was purchased.
export function tryPurchaseColorUpgrade(color, upgradeType) {
  const bkt = state.colorBuckets[color]
  if (!bkt) return false
  const level = bkt[upgradeType + 'Level'] ?? 0
  const cycle = Math.floor(state.totalBallsPurchased / COLOR_ORDER.length)
  const cost  = colorUpgradeCost(upgradeType, level, cycle)
  if (state.coins < cost) return false
  state.coins -= cost
  bkt[upgradeType + 'Level']++
  state.stats.current.upgradesPurchased++
  state.stats.allTime.upgradesPurchased++
  const cs = state.stats.byColor[color]
  if (cs) cs.upgradesPurchased++
  saveState(state, true)      // immediate — purchase must persist
  return true
}

export function tryUpgradeClick(stat) {
  const key  = stat + 'Level'
  const cost = tapUpgradeCost(stat, state.clicks[key])
  if (state.coins < cost) return false
  state.coins -= cost
  state.clicks[key]++
  saveState(state, true)      // immediate — purchase must persist
  return true
}

export function setAutoUpgrade(enabled) {
  state.autoUpgradeEnabled = state.prestigeCount > 0 ? enabled : false
  saveState(state, true)
}

export function setIntroComplete() {
  state.introComplete = true
  saveState(state, true)
}

export function devResetIntro() {
  state.introComplete = false
  saveState(state, true)
}

export function devAddPrestige() {
  state.prestigeCount++
  saveState(state, true)
}

export function setFirstBallCueShown() {
  state.firstBallCueShown = true
  saveState(state, true)
}

export function devAddCoins(n) { addCoins(n, false) }

// ─── Round / run mutations ────────────────────────────────────────────────

export function getRoundState() { return state.round }

export function setRoundState(partial) {
  state.round = { ...state.round, ...partial }
  saveState(state, true)   // immediate — round state must survive page reload
}

/**
 * Advance to the next round after paying the goal.
 * Sets coins to the carry-over amount and resets per-round resources.
 */
export function advanceRound(coinsCarried) {
  const nextNum  = state.round.number + 1
  const nextGoal = getRoundGoal(nextNum)
  const nextAct  = Math.ceil(nextNum / RoundConfig.bossRoundInterval)
  state.coins        = coinsCarried
  state.round = {
    number:        nextNum,
    actNumber:     nextAct,
    isBoss:        isBossRound(nextNum),
    clicksLeft:    RoundConfig.clicksPerRound,
    refreshesLeft: RoundConfig.refreshesPerRound,
    goal:          nextGoal,
    runOver:       false,
  }
  saveState(state, true)
}

/**
 * Reset everything for a fresh roguelite run.
 * Upgrade levels and ball counts all go back to zero/1.
 */
export function startNewRun() {
  const hadFirstBallCue = state.firstBallCueShown === true
  const freshBuckets = defaultRunColorBuckets()
  state.coins               = 0
  state.totalCoins          = 0
  state.colorBuckets        = freshBuckets
  state.totalBallsPurchased = 6
  state.clicks              = { radiusLevel: 0, durationLevel: 0 }
  state.prestigeCount       = 0
  state.autoUpgradeEnabled  = false
  state.round               = defaultRound()
  state.stats               = {
    bestChainLength:    0,
    lastChainLength:    0,
    lastChainCoins:     0,
    totalChains:        0,
    lastKickstartBonus: 0,
    current:        defaultCurrentStats(),
    allTime:        defaultAllTimeStats(),
    byColor:        Object.fromEntries(COLOR_ORDER.map(c => [c, defaultColorStats()])),
    chainsByLength: {},
  }
  if (hadFirstBallCue) state.firstBallCueShown = true
  saveState(state, true)
}

export function devFreeColorUpgrade(color, upgradeType) {
  const bkt = state.colorBuckets[color]
  if (!bkt) return false
  bkt[upgradeType + 'Level'] = (bkt[upgradeType + 'Level'] ?? 0) + 1
  saveState(state, true)
  return true
}

export function devFreeUpgradeClick(stat) {
  state.clicks[stat + 'Level']++
  saveState(state, true)
  return true
}

export function devFreeUnlockNextBall() {
  const colorKey = getNextPurchaseColor(state)
  state.colorBuckets[colorKey].ballsOwned++
  state.totalBallsPurchased++
  saveState(state, true)
  return colorKey
}

export function devReset() {
  state = defaultState()
  saveState(state, true)
  return state
}
