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

// ── PhysicsConfig ─────────────────────────────────────────────────────────────
// New — consumed by main.js to replace its inline physics constants.
export const PhysicsConfig = {
  ballRadius:              BALANCE.physics.ballRadius,
  ballCollisionRadiusMult: BALANCE.physics.ballCollisionRadiusMult,
  arenaScale:              BALANCE.physics.arenaScale,
}

// ── TimingConfig ──────────────────────────────────────────────────────────────
// New — consumed by main.js to replace its inline timing constants.
export const TimingConfig = { ...BALANCE.timing }

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
