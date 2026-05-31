// src/balance/config.js — load, validate, and re-export the live balance config.
//
// This is the single source of truth for all balance constants at runtime.
// Vite handles the JSON import natively; no runtime fetch needed.
//
// Other modules import the named exports (EconomyConstants, GameConfig, etc.)
// — shape is identical to the old inline objects so no call sites need changes.

import raw from './balance.live.json'
import { assertBalance } from './validate.js'

// Validated once on import. If the JSON is malformed or violates constraints,
// this throws immediately and the game refuses to start — better than silent
// bad values silently breaking gameplay.
export const BALANCE = assertBalance(raw)

// ── EconomyConstants ──────────────────────────────────────────────────────────
// Same shape as the old inline object in store.js; store.js re-exports this.
export const EconomyConstants = {
  baseCoinValue: BALANCE.economy.baseCoinValue,
  value:         BALANCE.economy.value,
  // speed.base and duration.baseMs are sourced from ballBase (single feel-tuning block)
  // so they are mutable at runtime via the dev-panel sliders without touching the JSON.
  speed:    { ...BALANCE.economy.speed,    base:   BALANCE.ballBase.baseSpeed    },
  diameter:      BALANCE.economy.diameter,
  duration: { ...BALANCE.economy.duration, baseMs: BALANCE.ballBase.holdDuration },
  tap:           BALANCE.economy.tap,
  upgradeCost:   BALANCE.economy.upgradeCost,
  ball:          BALANCE.economy.ball,
  chain:         BALANCE.economy.chain,
}

// ── GameConfig ────────────────────────────────────────────────────────────────
// Same shape as the old inline object in store.js; store.js re-exports this.
export const GameConfig = {
  ballRadius:     BALANCE.physics.ballRadius,
  growDuration:   BALANCE.ballBase.growDuration,
  holdDuration:   BALANCE.ballBase.holdDuration,
  shrinkDuration: BALANCE.ballBase.shrinkDuration,
  baseSpeed:      BALANCE.ballBase.baseSpeed,
}

// ── RoundConfig ───────────────────────────────────────────────────────────────
// Roguelite round progression constants.
export const RoundConfig = {
  clicksPerRound:    BALANCE.roundResources.clicksPerRound,
  refreshesPerRound: BALANCE.roundResources.refreshesPerRound,
  bossRoundInterval: BALANCE.roundResources.bossRoundInterval,
  goalTable:         BALANCE.roundGoals.table,
  unlimitedGrowth:   BALANCE.roundGoals.unlimitedGrowth,
}

/** Return the coin goal for a given 1-indexed round number. */
export function getRoundGoal(roundNumber) {
  const { goalTable, unlimitedGrowth } = RoundConfig
  const idx = roundNumber - 1
  if (idx < goalTable.length) return goalTable[idx]
  const extra = idx - goalTable.length + 1
  return Math.round(goalTable[goalTable.length - 1] * Math.pow(unlimitedGrowth, extra))
}

/** Return true if the given 1-indexed round number is a boss round. */
export function isBossRound(roundNumber) {
  return roundNumber % RoundConfig.bossRoundInterval === 0
}

// ── Store / relic system ──────────────────────────────────────────────────────

/** Lookup maps for store items */
export const SpecialBallDefs = Object.fromEntries(BALANCE.store.specialBalls.map(b => [b.id, b]))
export const RelicDefs       = Object.fromEntries(BALANCE.store.relics.map(r => [r.id, r]))
export const StoreConfig     = {
  burnBallBase:   BALANCE.store.burnBallBase,
  burnBallMult:   BALANCE.store.burnBallMult,
  ampPerPurchase: BALANCE.store.ampPerPurchase,
}

/** Scaled cost of burning a ball given how many burns have already occurred this run. */
export function burnBallCost(n) {
  return Math.ceil(StoreConfig.burnBallBase * Math.pow(StoreConfig.burnBallMult, n))
}

/**
 * Compute all active relic multipliers from the player's relic array.
 * Amplifiers stack additively (not multiplicatively).
 */
export function getRelicEffects(relics = []) {
  const count = id => relics.filter(r => r === id).length
  const amp   = StoreConfig.ampPerPurchase
  return {
    coinMult:      1 + count('amp_value')    * amp,
    speedMult:     1 + count('amp_speed')    * amp,
    radiusMult:    1 + count('amp_radius')   * amp,
    durationMult:  1 + count('amp_duration') * amp,
    chainCatalyst: count('chain_catalyst'),   // applied as ×(1 + 0.5n) to chain mult
    clearSurge:    count('clear_surge'),      // each adds +1 to effMult base and cap
    hasWarmFusion: count('warm_fusion') > 0,
    hasCoolFusion: count('cool_fusion') > 0,
  }
}

/** Color groups for Warm/Cool Fusion relics */
export const WARM_COLORS = ['red', 'orange', 'yellow']
export const COOL_COLORS = ['violet', 'blue', 'green']

/**
 * Return a color bucket with upgrade levels potentially boosted by fusion relics.
 * If Warm/Cool Fusion is active for this color's group, each *Level is replaced
 * by the maximum level across the entire group.
 */
export function resolvedBucket(state, colorKey, relicEffects) {
  const bkt   = state.colorBuckets[colorKey] ?? {}
  const group = WARM_COLORS.includes(colorKey) ? WARM_COLORS
              : COOL_COLORS.includes(colorKey) ? COOL_COLORS : null
  const fusionActive = group &&
    ((WARM_COLORS.includes(colorKey) && relicEffects.hasWarmFusion) ||
     (COOL_COLORS.includes(colorKey) && relicEffects.hasCoolFusion))
  if (!fusionActive) return bkt
  const maxLv = type => Math.max(...group.map(c => state.colorBuckets[c]?.[type] ?? 0))
  return {
    ...bkt,
    valueLevel:    maxLv('valueLevel'),
    speedLevel:    maxLv('speedLevel'),
    diameterLevel: maxLv('diameterLevel'),
    durationLevel: maxLv('durationLevel'),
  }
}
