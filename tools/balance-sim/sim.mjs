#!/usr/bin/env node
// tools/balance-sim/sim.mjs — Balance simulator with 5 player models + telemetry calibration
//
// DISCLAIMER: This simulator uses calibrated statistical models, NOT physics simulation.
// It does not simulate real board positions or collision geometry.
// Chain size estimates are derived from density-based expected-value formulas.
//
// Usage:
//   npm run balance:sim                               # run all 5 player models
//   npm run balance:sim -- --telemetry ./file.json   # compare vs recorded telemetry
//
// To record telemetry in-game: ?telemetry URL param or:
//   localStorage.setItem('cr_telemetry', '1')
// Then export via: window.__crTelemetry.download()

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBalance } from '../../src/balance/validate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
let telemetryPath = null
{
  const ti = args.indexOf('--telemetry')
  if (ti !== -1) {
    telemetryPath = args[ti + 1]
    if (!telemetryPath) {
      console.error('❌ --telemetry requires a file path argument')
      process.exit(1)
    }
  }
}

// ── Load + validate balance config ─────────────────────────────────────────

const cfgPath = join(__dirname, '../../src/balance/balance.live.json')
let cfg
try {
  cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
} catch (e) {
  console.error(`❌ Could not read balance config: ${e.message}`)
  process.exit(1)
}

const { valid, errors } = validateBalance(cfg)
if (!valid) {
  console.error('❌ Invalid balance config:')
  errors.forEach(e => console.error(`   • ${e}`))
  process.exit(1)
}

// ── Load telemetry (optional) ──────────────────────────────────────────────

let humanData = null
if (telemetryPath) {
  try {
    const raw = JSON.parse(readFileSync(telemetryPath, 'utf-8'))
    const ms  = raw.ballMilestones ?? {}
    humanData = {
      timeToBall2S:       ms['2']  != null ? ms['2']  / 1000 : null,
      timeToBall3S:       ms['3']  != null ? ms['3']  / 1000 : null,
      timeToBall4S:       ms['4']  != null ? ms['4']  / 1000 : null,
      timeToBall5S:       ms['5']  != null ? ms['5']  / 1000 : null,
      timeToBall6S:       ms['6']  != null ? ms['6']  / 1000 : null,
      timeToBall7S:       ms['7']  != null ? ms['7']  / 1000 : null,
      timeToBall8S:       ms['8']  != null ? ms['8']  / 1000 : null,
      hitRate:            raw.hitRate             ?? null,
      averageCoinsPerTap: raw.averageCoinsPerTap  ?? null,
      averageChainSize:   raw.averageChainSize     ?? null,
      medianChainSize:    raw.medianChainSize      ?? null,
      p90ChainSize:       raw.p90ChainSize         ?? null,
      coinsPerMinute:     raw.coinsPerMinute       ?? null,
      tapsPerMinute:      raw.tapsPerMinute        ?? null,
      purchasesPerMinute: raw.purchasesPerMinute   ?? null,
      source: telemetryPath,
    }
    console.log(`📊 Telemetry loaded: ${telemetryPath}`)
    if (humanData.timeToBall8S != null)
      console.log(`   Human timeToBall8: ${humanData.timeToBall8S.toFixed(1)} s`)
    console.log()
  } catch (e) {
    console.error(`❌ Could not read telemetry: ${e.message}`)
    process.exit(1)
  }
}

// ── Sim constants ──────────────────────────────────────────────────────────

const SIM_DURATION_S    = 3600          // simulated window (1 hour)
const TICK_S            = 1             // simulation step
const SIG_THRESHOLD     = 0.10         // ≥10% income/min = "significant" upgrade
const COLOR_COUNT       = 6
const MAX_BUYS_PER_TICK = 200
const UPGRADE_TYPES     = ['value', 'speed', 'diameter', 'duration']
const INCOME_SNAP_TIMES = [30, 60, 120, 300, 600, 1200, 1800, 3600]

// Human benchmark for calibration — prefer telemetry when available
const HUMAN_BENCHMARK = humanData?.timeToBall8S != null
  ? { timeToBall8S: humanData.timeToBall8S, source: 'telemetry' }
  : { timeToBall8S: 420, source: 'manual' }   // 7-min benchmark from playtesting

// A model is "calibrated" if its timeToBall8 is within ±30% of the human benchmark
const CALIBRATION_TOLERANCE = 0.30

// ── Player models ──────────────────────────────────────────────────────────
//
// DISCLAIMER: Statistical models only, not physics simulations.
// Each model is a set of expected-value parameters, not a stochastic agent.
//
// hitRate: probability that a tap directly triggers at least one aimed ball.
//   null → random tapper: uses pure tap-circle area / arena area (no aiming).
// clusterBonus: multiplier on expected nearby balls caught by tap circle.
//   > 1 models skill at positioning taps near visible dense clusters.
// purchaseMode: 'cheapest' | 'ballFirst'
//   ballFirst: prefer buying a ball if ballCost ≤ 3× cheapest available upgrade cost.

const PLAYER_MODELS = {
  randomTapper: {
    tapsPerMin:   20,
    hitRate:      null,    // density-only — no aiming
    clusterBonus: 1.0,
    purchaseMode: 'cheapest',
    label: 'Random Tapper — intentionally bad baseline; no aiming, pure density coverage',
  },
  casualAimer: {
    tapsPerMin:   10,
    hitRate:      0.60,
    clusterBonus: 1.0,
    purchaseMode: 'cheapest',
    label: 'Casual Aimer — aims but misses often; slower tap cadence',
  },
  averageAimer: {
    tapsPerMin:   20,
    hitRate:      0.85,
    clusterBonus: 2.0,
    purchaseMode: 'cheapest',
    label: 'Average Aimer — targets best visible cluster; moderate accuracy',
  },
  skilledAimer: {
    tapsPerMin:   18,
    hitRate:      0.95,
    clusterBonus: 4.0,
    purchaseMode: 'cheapest',
    label: 'Skilled Aimer — waits briefly for dense opportunities; high accuracy',
  },
  ballFocusedAverage: {
    tapsPerMin:   20,
    hitRate:      0.85,
    clusterBonus: 2.0,
    purchaseMode: 'ballFirst',
    label: 'Ball-Focused Average — average aim, prioritizes buying balls over upgrades',
  },
}

// ── Economy formulas (ported 1-to-1 from store.js) ────────────────────────

function plateau(level, maxBonus, curve) {
  return 1 + maxBonus * (1 - Math.exp(-level / curve))
}

function getBallValue(level) {
  const { baseCoinValue, value } = cfg.economy
  return baseCoinValue * plateau(level, value.maxBonus, value.curve)
}

function getExpansionRadius(level) {
  const { diameter } = cfg.economy
  return diameter.baseR + (diameter.maxR - diameter.baseR) * (1 - Math.exp(-level / diameter.curve))
}

function getTapRadius(level) {
  const { tap } = cfg.economy
  return tap.radius.baseR * plateau(level, tap.radius.maxBonus, tap.radius.curve)
}

function colorUpgradeCost(type, level, cycle) {
  const conf = cfg.economy.upgradeCost[type]
  if (!conf || conf.baseCost === undefined) return Infinity
  return Math.ceil(
    conf.baseCost
    * Math.pow(conf.growthRate, level)
    * Math.pow(cfg.economy.upgradeCost.cycleMult, cycle)
  )
}

function tapUpgradeCost(key, level) {
  const conf = cfg.economy.upgradeCost[key]
  if (!conf) return Infinity
  return Math.ceil(conf.baseCost * Math.pow(conf.growthRate, level))
}

function nextBallCost(totalPurchased) {
  const ball = cfg.economy.ball
  const n    = totalPurchased
  if (ball.earlyTable[n] !== undefined) return ball.earlyTable[n]
  const cycle = Math.floor(n / COLOR_COUNT)
  return Math.ceil(
    ball.lateBase
    * Math.pow(ball.lateMult,  n - ball.lateStart)
    * Math.pow(ball.cycleMult, Math.max(0, cycle - 1))
  )
}

function getChainMultiplier(chainLength) {
  const { table, lateRate } = cfg.economy.chain
  if (chainLength <= 1) return 0
  const idx = chainLength - 1
  if (idx < table.length) return table[idx]
  return Math.floor(
    table[table.length - 1]
    * Math.pow(lateRate, chainLength - table.length)
  )
}

function getArenaScale(n) {
  const { thresholds, lateMax, lateBase, lateLogMult } = cfg.physics.arenaScale
  for (const { maxBalls, scale } of thresholds) {
    if (n <= maxBalls) return scale
  }
  return Math.min(lateMax, 1.0 + Math.log1p(n - lateBase) * lateLogMult)
}

// ── Income model ───────────────────────────────────────────────────────────
//
// Expected coins per tap given current game state + player model.
//
// For aimed players:
//   1. Player targets a promising ball cluster.
//   2. hitRate × (1 + clusteredNearby) gives expected initial triggers.
//   3. Each triggered ball expands with radius maxR; branching factor B = π·maxR²·density.
//   4. Chain cascade: chainLength = initialHits / (1 − B)  for B < 0.95, else N.
//   5. Income = popCoins + chain-end bonus.
//
// For randomTapper (hitRate: null):
//   Uses pure geometric coverage: initialHits = π·tapR²·density (no aiming).

function computeIncomePerTap(state, model) {
  const N = state.buckets.length
  if (N === 0) return 0

  const avgValueLevel    = state.buckets.reduce((s, b) => s + b.valueLevel,    0) / N
  const avgDiameterLevel = state.buckets.reduce((s, b) => s + b.diameterLevel, 0) / N

  const avgBallValue = getBallValue(avgValueLevel)
  const maxR         = getExpansionRadius(avgDiameterLevel)
  const tapR         = getTapRadius(state.tapRadiusLevel)

  const S         = getArenaScale(N)
  const arenaArea = (100 * S) * (178 * S)
  const density   = N / arenaArea

  let initialHits
  if (model.hitRate === null) {
    // Random tapper: tap-circle coverage on uniformly-distributed balls
    initialHits = Math.min(N, Math.PI * tapR * tapR * density)
  } else {
    // Aimed tapper: targets a ball (hitRate chance) + tap circle catches nearby balls.
    // clusterBonus > 1 reflects that skilled players tap near visible clusters.
    const nearbyPerBall   = (N - 1) * (Math.PI * tapR * tapR) / arenaArea
    const clusteredNearby = nearbyPerBall * model.clusterBonus
    initialHits = Math.min(N, model.hitRate * (1 + clusteredNearby))
  }

  // Chain cascade via geometric branching factor B
  const B           = Math.min(0.9999, Math.PI * maxR * maxR * density)
  const chainLength = B >= 0.95
    ? N   // near-full-chain: all balls trigger
    : Math.min(N, initialHits / (1 - B))

  const popCoins   = chainLength * avgBallValue
  const chainMult  = getChainMultiplier(Math.round(chainLength))
  const chainBonus = chainMult > 0 ? Math.floor(chainLength * avgBallValue * chainMult) : 0

  return popCoins + chainBonus
}

function computeIncomePerMin(state, model) {
  return computeIncomePerTap(state, model) * model.tapsPerMin
}

// ── State ──────────────────────────────────────────────────────────────────

function makeState() {
  return {
    time:                0,
    coins:               0,
    totalCoins:          0,
    totalBallsPurchased: 1,    // first ball is always free
    buckets: [{ valueLevel: 0, speedLevel: 0, diameterLevel: 0, durationLevel: 0 }],
    tapRadiusLevel:      0,
    tapDurationLevel:    0,
  }
}

function getCycle(state) {
  return Math.floor(state.totalBallsPurchased / COLOR_COUNT)
}

// ── Purchase selection ─────────────────────────────────────────────────────

function _findCheapest(state) {
  const cycle = getCycle(state)
  let best    = null

  function consider(candidate) {
    if (candidate.cost > state.coins) return
    if (!best || candidate.cost < best.cost
        || (candidate.cost === best.cost && candidate.kind === 'ball'))
      best = candidate
  }

  // New ball
  consider({
    kind:  'ball',
    cost:  nextBallCost(state.totalBallsPurchased),
    label: `ball #${state.totalBallsPurchased + 1}`,
  })

  // Per-bucket stat upgrades
  for (let i = 0; i < state.buckets.length; i++) {
    for (const type of UPGRADE_TYPES) {
      const level = state.buckets[i][type + 'Level']
      consider({
        kind:      'upgrade',
        bucketIdx: i,
        type,
        level,
        cost:      colorUpgradeCost(type, level, cycle),
        label:     `bucket${i + 1}-${type} lv${level}→${level + 1}`,
      })
    }
  }

  // Tap upgrades (no cycle multiplier)
  const trLv = state.tapRadiusLevel
  consider({ kind: 'tapUpgrade', stat: 'radius',
    cost:  tapUpgradeCost('tapRadius', trLv),
    label: `tap-radius lv${trLv}→${trLv + 1}` })
  const tdLv = state.tapDurationLevel
  consider({ kind: 'tapUpgrade', stat: 'duration',
    cost:  tapUpgradeCost('tapDuration', tdLv),
    label: `tap-duration lv${tdLv}→${tdLv + 1}` })

  return best
}

// Like _findCheapest but ignores balls — used to find cheapest upgrade for ballFirst threshold
function _findCheapestUpgradeOnly(state) {
  const cycle = getCycle(state)
  let best    = null

  function consider(candidate) {
    if (candidate.cost > state.coins) return
    if (!best || candidate.cost < best.cost) best = candidate
  }

  for (let i = 0; i < state.buckets.length; i++) {
    for (const type of UPGRADE_TYPES) {
      const level = state.buckets[i][type + 'Level']
      consider({ kind: 'upgrade', bucketIdx: i, type, level,
        cost: colorUpgradeCost(type, level, cycle),
        label: `bucket${i + 1}-${type} lv${level}→${level + 1}` })
    }
  }
  const trLv = state.tapRadiusLevel
  consider({ kind: 'tapUpgrade', stat: 'radius',
    cost: tapUpgradeCost('tapRadius', trLv), label: `tap-radius lv${trLv}→${trLv + 1}` })
  const tdLv = state.tapDurationLevel
  consider({ kind: 'tapUpgrade', stat: 'duration',
    cost: tapUpgradeCost('tapDuration', tdLv), label: `tap-duration lv${tdLv}→${tdLv + 1}` })

  return best
}

// 'ballFirst': prefer the ball if affordable AND ballCost ≤ 3× cheapest upgrade cost.
// This models a player who believes ball density matters more than marginal stat gains.
function findBestPurchase(state, purchaseMode) {
  if (purchaseMode === 'cheapest') return _findCheapest(state)

  const ballCost = nextBallCost(state.totalBallsPurchased)
  if (state.coins >= ballCost) {
    const cheapestUpg = _findCheapestUpgradeOnly(state)
    const threshold   = cheapestUpg ? cheapestUpg.cost * 3 : Infinity
    if (ballCost <= threshold) {
      return { kind: 'ball', cost: ballCost, label: `ball #${state.totalBallsPurchased + 1}` }
    }
  }
  return _findCheapest(state)
}

function applyPurchase(state, p) {
  state.coins -= p.cost
  if (p.kind === 'ball') {
    state.buckets.push({ valueLevel: 0, speedLevel: 0, diameterLevel: 0, durationLevel: 0 })
    state.totalBallsPurchased++
  } else if (p.kind === 'upgrade') {
    state.buckets[p.bucketIdx][p.type + 'Level']++
  } else if (p.kind === 'tapUpgrade') {
    if (p.stat === 'radius') state.tapRadiusLevel++
    else                     state.tapDurationLevel++
  }
}

// ── Simulate one player model ──────────────────────────────────────────────

function simulateModel(model) {
  const state          = makeState()
  const timeline       = []
  const sigTimes       = []
  const snapshots      = []
  const ballMilestones = { '1': 0 }   // ball #1 is always present at t=0

  let firstUpgradeS = null
  let snapIdx       = 0

  for (let t = 0; t <= SIM_DURATION_S; t += TICK_S) {
    state.time = t

    // Earn coins from taps this tick
    const tapsThisTick = model.tapsPerMin * (TICK_S / 60)
    const earned       = computeIncomePerTap(state, model) * tapsThisTick
    state.coins      += earned
    state.totalCoins += earned

    // Purchase everything affordable this tick
    let buyCount = 0
    while (buyCount++ < MAX_BUYS_PER_TICK) {
      const purchase = findBestPurchase(state, model.purchaseMode)
      if (!purchase) break

      const incomeBefore = computeIncomePerMin(state, model)
      applyPurchase(state, purchase)
      const incomeAfter  = computeIncomePerMin(state, model)
      const isSig        = incomeAfter >= incomeBefore * (1 + SIG_THRESHOLD)

      if (firstUpgradeS === null) firstUpgradeS = t
      if (isSig) sigTimes.push(t)

      // Record ball-count milestones
      if (purchase.kind === 'ball') {
        const key = String(state.buckets.length)
        if (!ballMilestones[key]) ballMilestones[key] = t
      }

      timeline.push({
        timeS:              t,
        label:              purchase.label,
        cost:               purchase.cost,
        incomeBeforePerMin: Math.round(incomeBefore * 10) / 10,
        incomeAfterPerMin:  Math.round(incomeAfter  * 10) / 10,
        significantGain:    isSig,
      })
    }

    // Income snapshots
    while (snapIdx < INCOME_SNAP_TIMES.length && t >= INCOME_SNAP_TIMES[snapIdx]) {
      snapshots.push({
        timeS:       INCOME_SNAP_TIMES[snapIdx],
        coinsPerMin: Math.round(computeIncomePerMin(state, model)),
        totalCoins:  Math.round(state.totalCoins),
        ballCount:   state.buckets.length,
      })
      snapIdx++
    }
  }

  // Flush any remaining snapshot times
  while (snapIdx < INCOME_SNAP_TIMES.length) {
    snapshots.push({
      timeS:       INCOME_SNAP_TIMES[snapIdx],
      coinsPerMin: Math.round(computeIncomePerMin(state, model)),
      totalCoins:  Math.round(state.totalCoins),
      ballCount:   state.buckets.length,
    })
    snapIdx++
  }

  // Boring-gap metrics (gaps between significant upgrades)
  const boundaries = [0, ...sigTimes, SIM_DURATION_S]
  const gaps = []
  for (let i = 1; i < boundaries.length; i++) gaps.push(boundaries[i] - boundaries[i - 1])

  const avgBoringGap = gaps.length
    ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : SIM_DURATION_S
  const longestGap   = gaps.length ? Math.max(...gaps) : SIM_DURATION_S
  const firstSigS    = sigTimes.length > 0 ? sigTimes[0] : SIM_DURATION_S

  // Per-model warnings
  const warnings = []
  if (firstUpgradeS === null || firstUpgradeS > 60)
    warnings.push(`First upgrade at ${firstUpgradeS ?? '∞'} s — goal is ≤ 60 s`)
  if (firstSigS > 120)
    warnings.push(`First significant (+${(SIG_THRESHOLD * 100).toFixed(0)}%) upgrade at ${firstSigS} s — goal is ≤ 120 s`)
  if (longestGap > 300)
    warnings.push(`Longest boring gap: ${longestGap} s — exceeds 5-min threshold`)
  if (avgBoringGap > 120)
    warnings.push(`Average boring gap: ${avgBoringGap} s — exceeds 2-min target`)
  if (state.buckets.length < 6)
    warnings.push(`Only ${state.buckets.length} balls in ${SIM_DURATION_S / 60} min — early game may be too slow`)
  if (sigTimes.length === 0)
    warnings.push('No significant upgrades detected — economy may be flat or misconfigured')

  return {
    model: model.label,
    summary: {
      timeToFirstUpgradeSeconds:            firstUpgradeS ?? SIM_DURATION_S,
      timeToFirstSignificantUpgradeSeconds: firstSigS,
      averageBoringGapSeconds:              avgBoringGap,
      longestBoringGapSeconds:              longestGap,
      significantUpgradeCount:              sigTimes.length,
      totalPurchases:                       timeline.length,
      totalBallsPurchased:                  state.totalBallsPurchased,
      finalBallCount:                       state.buckets.length,
      finalIncomePerMin:                    Math.round(computeIncomePerMin(state, model)),
      totalCoinsEarned:                     Math.round(state.totalCoins),
      timeToBall2S:                         ballMilestones['2']  ?? null,
      timeToBall3S:                         ballMilestones['3']  ?? null,
      timeToBall4S:                         ballMilestones['4']  ?? null,
      timeToBall5S:                         ballMilestones['5']  ?? null,
      timeToBall6S:                         ballMilestones['6']  ?? null,
      timeToBall7S:                         ballMilestones['7']  ?? null,
      timeToBall8S:                         ballMilestones['8']  ?? null,
    },
    estimatedIncomeOverTime: snapshots,
    upgradePurchaseTimeline: timeline,
    warnings,
  }
}

// ── Run all models ─────────────────────────────────────────────────────────

console.log('⚙  balance:sim — 5-model calibration run\n')
console.log('   NOTE: Statistical model only — chain sizes are expected-value estimates,')
console.log('   not physics simulation. Board positions are not modelled.\n')

const modelResults = {}
for (const [key, model] of Object.entries(PLAYER_MODELS)) {
  process.stdout.write(`  Simulating: ${key.padEnd(24)}`)
  const result = simulateModel(model)
  modelResults[key] = result
  const t8 = result.summary.timeToBall8S
  process.stdout.write(
    t8 != null ? `timeToBall8: ${String(t8).padStart(5)} s\n` : `timeToBall8: (not reached)\n`
  )
}

// ── Calibration ────────────────────────────────────────────────────────────

const calWarnings = []

const modelComparison = Object.entries(modelResults).map(([key, result]) => {
  const sim8 = result.summary.timeToBall8S
  if (sim8 == null) {
    calWarnings.push(`Model "${key}" did not reach 8 balls in ${SIM_DURATION_S / 60} min`)
    return { model: key, timeToBall8S: null, errorPercent: null }
  }
  const err = Math.abs(sim8 - HUMAN_BENCHMARK.timeToBall8S) / HUMAN_BENCHMARK.timeToBall8S * 100
  return { model: key, timeToBall8S: sim8, errorPercent: Math.round(err * 10) / 10 }
})

// Closest model = lowest errorPercent among models that reached ball 8
const reached8 = modelComparison.filter(m => m.errorPercent != null)
const closest  = reached8.length > 0
  ? reached8.reduce((a, b) => a.errorPercent < b.errorPercent ? a : b)
  : null

const calibrated = closest != null && closest.errorPercent <= CALIBRATION_TOLERANCE * 100

if (closest == null)
  calWarnings.push('No model reached 8 balls — cannot calibrate')
else if (!calibrated)
  calWarnings.push(
    `Closest model "${closest.model}" is ${closest.errorPercent}% off benchmark — exceeds ` +
    `${CALIBRATION_TOLERANCE * 100}% tolerance`)

const calibration = {
  humanBenchmark:    HUMAN_BENCHMARK,
  modelComparison,
  closestModel:      closest?.model ?? null,
  calibrated,
  tolerancePercent:  CALIBRATION_TOLERANCE * 100,
  warnings:          calWarnings,
}

// ── Console output ─────────────────────────────────────────────────────────

const HR = '─'.repeat(54)

console.log(`\n── Ball-8 timing vs ${HUMAN_BENCHMARK.source} benchmark ` + HR.slice(38))
console.log(`   Human benchmark (${HUMAN_BENCHMARK.source}): ${HUMAN_BENCHMARK.timeToBall8S} s`)
for (const m of modelComparison) {
  const t8  = m.timeToBall8S != null ? `${String(m.timeToBall8S).padStart(5)} s` : '(not reached)'
  const err = m.errorPercent != null ? `  error: ${String(m.errorPercent).padStart(5)}%` : ''
  const star = m.model === closest?.model ? '  ◀ closest' : ''
  console.log(`   ${m.model.padEnd(22)} ${t8.padEnd(14)}${err}${star}`)
}
console.log()
console.log(`   Calibrated: ${calibrated ? '✅ YES' : '❌ NO'} — closest model: ${closest?.model ?? 'none'}`)

// Full summary for averageAimer (primary target) + closest if different
const toDetail = ['averageAimer']
if (closest?.model && closest.model !== 'averageAimer') toDetail.push(closest.model)

for (const key of toDetail) {
  const result = modelResults[key]
  if (!result) continue
  const s = result.summary
  const label = key === 'averageAimer' ? 'averageAimer (primary)' : key
  console.log(`\n── ${label} summary ` + HR.slice(label.length + 9))
  console.log(`  Taps/min:                    ${PLAYER_MODELS[key].tapsPerMin}`)
  console.log(`  Time to first upgrade:       ${s.timeToFirstUpgradeSeconds} s`)
  console.log(`  Time to first +10% upgrade:  ${s.timeToFirstSignificantUpgradeSeconds} s`)
  console.log(`  Avg boring gap:              ${s.averageBoringGapSeconds} s`)
  console.log(`  Longest boring gap:          ${s.longestBoringGapSeconds} s  (${(s.longestBoringGapSeconds / 60).toFixed(1)} min)`)
  console.log(`  timeToBall (2/4/6/8):        ${s.timeToBall2S ?? '-'} / ${s.timeToBall4S ?? '-'} / ${s.timeToBall6S ?? '-'} / ${s.timeToBall8S ?? '-'} s`)
  console.log(`  Final balls:                 ${s.finalBallCount}`)
  console.log(`  Final income/min:            ${s.finalIncomePerMin.toLocaleString()} coins`)
  for (const w of result.warnings) console.log(`  ⚠  ${w}`)
}

// Calibration warnings
if (calWarnings.length) {
  console.log(`\n── ⚠  Calibration warnings ` + HR.slice(26))
  calWarnings.forEach(w => console.log(`  • ${w}`))
}

// Telemetry comparison table (only when --telemetry provided)
if (humanData) {
  console.log(`\n── Telemetry vs averageAimer ` + HR.slice(27))
  const simModel = PLAYER_MODELS.averageAimer
  const rows = [
    ['timeToBall2 (s)',    humanData.timeToBall2S,         modelResults['averageAimer']?.summary?.timeToBall2S],
    ['timeToBall4 (s)',    humanData.timeToBall4S,         modelResults['averageAimer']?.summary?.timeToBall4S],
    ['timeToBall6 (s)',    humanData.timeToBall6S,         modelResults['averageAimer']?.summary?.timeToBall6S],
    ['timeToBall8 (s)',    humanData.timeToBall8S,         modelResults['averageAimer']?.summary?.timeToBall8S],
    ['tapsPerMin',         humanData.tapsPerMinute,        simModel.tapsPerMin],
    ['hitRate',            humanData.hitRate,              simModel.hitRate],
    ['coinsPerMin',        humanData.coinsPerMinute,       null],
    ['avgCoinsPerTap',     humanData.averageCoinsPerTap,   null],
    ['avgChainSize',       humanData.averageChainSize,     null],
    ['medianChainSize',    humanData.medianChainSize,      null],
    ['p90ChainSize',       humanData.p90ChainSize,         null],
    ['purchasesPerMin',    humanData.purchasesPerMinute,   null],
  ]
  const fmt = v => v != null ? String(typeof v === 'number' ? v.toFixed(2) : v) : '(no data)'
  for (const [label, human, sim] of rows) {
    const h = fmt(human).padEnd(12)
    const s = sim != null ? fmt(sim) : '(see JSON)'
    console.log(`  ${label.padEnd(20)}  human: ${h}  sim: ${s}`)
  }
}

// ── Write JSON report ──────────────────────────────────────────────────────

const outDir  = join(__dirname, 'output')
const outPath = join(outDir, 'latest-report.json')
mkdirSync(outDir, { recursive: true })

const report = {
  version:    '2.0.0',
  createdAt:  new Date().toISOString(),
  sourceConfig: 'src/balance/balance.live.json',
  disclaimer: [
    'Statistical model only. Chain sizes are expected-value estimates from density formulas.',
    'This simulator does not simulate real board positions, velocities, or collision geometry.',
  ].join(' '),
  simulationParams: {
    durationSeconds:      SIM_DURATION_S,
    tickSeconds:          TICK_S,
    significantThreshold: SIG_THRESHOLD,
    calibrationTolerance: CALIBRATION_TOLERANCE,
    telemetryFile:        telemetryPath ?? null,
  },
  calibration,
  models:         modelResults,
  humanTelemetry: humanData ?? null,
}

writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\n📄 Report → tools/balance-sim/output/latest-report.json`)
