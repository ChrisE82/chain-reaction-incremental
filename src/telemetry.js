// src/telemetry.js — gameplay telemetry (dev local-session) + PostHog analytics
//
// Dev telemetry enable (any one works):
//   • Add ?telemetry to the URL                         (e.g. localhost:5173/?telemetry)
//   • localStorage.setItem('cr_telemetry', '1')
//
// Dev data is local-only. PostHog events are always sent.
//
// Export from the browser console:
//   window.__crTelemetry.download()   → triggers JSON file download
//   window.__crTelemetry.export()     → prints JSON to console and returns it
//   window.__crTelemetry.summary()    → console.table of key metrics
//
// Or use the "Export Telemetry" button in the dev panel.

import posthog from 'posthog-js'

posthog.init('phc_BnK9pbs6ZZ4T34aToKKg5mSk64zDSKsbtdePMeXc5mEA', {
  api_host:        'https://us.i.posthog.com',  // official PostHog ingest endpoint
  defaults:        '2026-01-30',                // pins PostHog default behaviours to this snapshot
  person_profiles: 'identified_only',
  capture_pageleave: true,                       // enables bounce rate + session duration
})

// ── Activation ─────────────────────────────────────────────────────────────

const _params = typeof location !== 'undefined'
  ? new URLSearchParams(location.search) : null

export const isEnabled =
  (_params?.has('telemetry') ?? false) ||
  (typeof localStorage !== 'undefined' && localStorage.getItem('cr_telemetry') === '1')

// ── Session state ──────────────────────────────────────────────────────────

const _startMs = typeof performance !== 'undefined' ? performance.now() : 0

const _session = {
  version:    '1.0.0',
  startedAt:  new Date().toISOString(),
  taps:       [],   // completed tap records
  purchases:  [],   // purchase records
  milestones: {},   // { '2': elapsedMs, '3': elapsedMs, ... }
  _pending:   null, // tap started but chain not yet resolved
}

function _elapsedMs() {
  return Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - _startMs)
}

// ── Recording API ──────────────────────────────────────────────────────────

/**
 * Call at the start of each player tap (before the tap circle is created).
 * @param {number} vx      virtual x coordinate
 * @param {number} vy      virtual y coordinate
 * @param {number} ballsOwned  current ball count
 */
export function onTapStart(vx, vy, ballsOwned) {
  if (!isEnabled) return
  _session._pending = {
    elapsedMs:    _elapsedMs(),
    vx:           Math.round(vx * 10) / 10,
    vy:           Math.round(vy * 10) / 10,
    ballsOwned,
    // filled by onChainEnd:
    hit:          false,
    chainSize:    0,
    coinsFromTap: 0,
    totalCoins:   null,
  }
}

/**
 * Call when a chain finishes (only in real gameplay, not intro).
 * @param {number} chainSize     number of balls triggered
 * @param {number} coinsFromTap  total coins earned this chain (per-pop + chain bonus)
 * @param {number} totalCoins    player's running coin total after adding chain coins
 * @param {number} ballsOwned    ball count at chain end
 */
export function onChainEnd(chainSize, coinsFromTap, totalCoins, ballsOwned) {
  posthog.capture('chain_ended', {
    chain_size:      chainSize,
    coins_from_tap:  Math.round(coinsFromTap),
    total_coins:     Math.round(totalCoins),
    balls_owned:     ballsOwned,
  })
  if (!isEnabled) return
  const rec = _session._pending
  if (!rec) return   // chain not started by a tracked tap (e.g. edge case)
  rec.hit          = chainSize > 0
  rec.chainSize    = chainSize
  rec.coinsFromTap = Math.round(coinsFromTap)
  rec.totalCoins   = Math.round(totalCoins)
  rec.ballsOwned   = ballsOwned
  _session.taps.push(rec)
  _session._pending = null
}

/**
 * Call after a ball is successfully purchased.
 * @param {number} newTotalBallsPurchased  state.totalBallsPurchased after purchase
 * @param {number} newBallCount            balls.length after addBallForColor()
 * @param {number} totalCoins              coins remaining after purchase
 */
export function onBallPurchased(newTotalBallsPurchased, newBallCount, totalCoins) {
  posthog.capture('ball_purchased', {
    total_balls_purchased: newTotalBallsPurchased,
    ball_count:            newBallCount,
    total_coins:           Math.round(totalCoins),
  })
  if (!isEnabled) return
  const ms = _elapsedMs()
  _session.purchases.push({
    elapsedMs:  ms,
    type:       'ball',
    label:      `ball #${newTotalBallsPurchased}`,
    ballsOwned: newBallCount,
    totalCoins: Math.round(totalCoins),
  })
  // Record ball-count milestone (first time reaching this count)
  const key = String(newBallCount)
  if (!_session.milestones[key]) {
    _session.milestones[key] = ms
  }
}

/**
 * Call after a color upgrade is successfully purchased.
 * @param {string} colorKey  e.g. 'violet'
 * @param {string} type      e.g. 'diameter'
 * @param {number} newLevel  the level after the upgrade
 * @param {number} ballsOwned
 * @param {number} totalCoins
 */
export function onColorUpgrade(colorKey, type, newLevel, ballsOwned, totalCoins) {
  posthog.capture('color_upgrade_purchased', {
    color_key:   colorKey,
    upgrade_type: type,
    new_level:   newLevel,
    balls_owned: ballsOwned,
    total_coins: Math.round(totalCoins),
  })
  if (!isEnabled) return
  _session.purchases.push({
    elapsedMs:  _elapsedMs(),
    type:       'colorUpgrade',
    label:      `${colorKey}-${type} lv${newLevel - 1}→${newLevel}`,
    ballsOwned,
    totalCoins: Math.round(totalCoins),
  })
}

/**
 * Call after a tap upgrade is successfully purchased.
 * @param {string} stat      'radius' | 'duration'
 * @param {number} newLevel
 * @param {number} ballsOwned
 * @param {number} totalCoins
 */
export function onTapUpgrade(stat, newLevel, ballsOwned, totalCoins) {
  posthog.capture('tap_upgrade_purchased', {
    stat:        stat,
    new_level:   newLevel,
    balls_owned: ballsOwned,
    total_coins: Math.round(totalCoins),
  })
  if (!isEnabled) return
  _session.purchases.push({
    elapsedMs:  _elapsedMs(),
    type:       'tapUpgrade',
    label:      `tap-${stat} lv${newLevel - 1}→${newLevel}`,
    ballsOwned,
    totalCoins: Math.round(totalCoins),
  })
}

// ── Export ─────────────────────────────────────────────────────────────────

function _computeExport() {
  const completedTaps = _session.taps   // only completed (chainEnd fired) taps
  const hitTaps       = completedTaps.filter(t => t.hit)
  const chains        = hitTaps.map(t => t.chainSize)
  const sortedChains  = [...chains].sort((a, b) => a - b)

  const totalCoinsFromTaps = hitTaps.reduce((s, t) => s + t.coinsFromTap, 0)
  const elapsedMs          = _elapsedMs()
  const elapsedMin         = elapsedMs / 60_000

  const median = sortedChains.length > 0
    ? sortedChains[Math.floor(sortedChains.length / 2)] : 0
  const p90 = sortedChains.length > 0
    ? sortedChains[Math.floor(sortedChains.length * 0.9)] : 0

  return {
    version:    _session.version,
    startedAt:  _session.startedAt,
    elapsedMs,

    // Tap-level stats
    totalTaps:           completedTaps.length,
    hitTaps:             hitTaps.length,
    hitRate:             completedTaps.length > 0
      ? hitTaps.length / completedTaps.length : 0,
    averageCoinsPerTap:  hitTaps.length > 0
      ? totalCoinsFromTaps / hitTaps.length : 0,
    averageChainSize:    chains.length > 0
      ? chains.reduce((a, b) => a + b, 0) / chains.length : 0,
    medianChainSize:     median,
    p90ChainSize:        p90,

    // Rate stats
    coinsPerMinute:      elapsedMin > 0 ? totalCoinsFromTaps / elapsedMin : 0,
    tapsPerMinute:       elapsedMin > 0 ? completedTaps.length / elapsedMin : 0,
    purchasesPerMinute:  elapsedMin > 0 ? _session.purchases.length / elapsedMin : 0,

    // Milestones
    ballMilestones: _session.milestones,

    // Raw event logs (for deeper analysis)
    taps:      _session.taps,
    purchases: _session.purchases,
  }
}

export function exportTelemetry() {
  return JSON.stringify(_computeExport(), null, 2)
}

// ── Browser globals ────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.__crTelemetry = {
    isEnabled,

    export() {
      const json = exportTelemetry()
      console.log(json)
      return json
    },

    download() {
      const json  = exportTelemetry()
      const blob  = new Blob([json], { type: 'application/json' })
      const a     = document.createElement('a')
      a.href      = URL.createObjectURL(blob)
      a.download  = `cr-telemetry-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)
    },

    summary() {
      const d = _computeExport()
      console.log(`[telemetry] ${Math.round(d.elapsedMs / 1000)} s recorded`)
      console.table({
        'Taps':           d.totalTaps,
        'Hit rate':       `${(d.hitRate * 100).toFixed(1)}%`,
        'Avg coins/tap':  d.averageCoinsPerTap.toFixed(1),
        'Avg chain':      d.averageChainSize.toFixed(2),
        'Median chain':   d.medianChainSize,
        'p90 chain':      d.p90ChainSize,
        'Coins/min':      d.coinsPerMinute.toFixed(0),
        'Ball 8 at':      d.ballMilestones['8']
          ? `${(d.ballMilestones['8'] / 1000).toFixed(1)} s` : 'not reached',
      })
    },
  }

  if (isEnabled) {
    console.log(
      '[cr-telemetry] Recording. Run window.__crTelemetry.download() to save, ' +
      '.summary() for live stats, or use the "Export Telemetry" dev panel button.'
    )
  }
}
