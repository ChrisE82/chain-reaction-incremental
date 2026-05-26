// tools/setup-playfab-stats.mjs
// One-time script to create PlayFab Statistics + Leaderboard definitions
// using the new Entity API (not the legacy system being retired).
//
// Run once:
//   node tools/setup-playfab-stats.mjs
//
// Requires PLAYFAB_SECRET_KEY in .env (get it from PlayFab dashboard:
//   Title 1405E8 → Settings → Secret Keys → Show Secret)

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Load .env ──────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '../.env')
const env = {}
try {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=')
    if (k?.trim()) env[k.trim()] = v.join('=').trim()
  })
} catch {
  console.error('Could not read .env — make sure it exists at the project root.')
  process.exit(1)
}

const TITLE_ID   = '1405E8'
const SECRET_KEY = env.PLAYFAB_SECRET_KEY
const BASE_URL   = `https://${TITLE_ID}.playfabapi.com`

if (!SECRET_KEY) {
  console.error('PLAYFAB_SECRET_KEY not found in .env')
  console.error('Get it from: PlayFab dashboard → Title 1405E8 → Settings → Secret Keys')
  process.exit(1)
}

// ── Get title entity token (needed for new Entity API admin calls) ──────────
async function getTitleEntityToken() {
  const res  = await fetch(`${BASE_URL}/Authentication/GetEntityToken`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-SecretKey': SECRET_KEY },
    body:    JSON.stringify({}),
  })
  const json = await res.json()
  if (json.code !== 200) throw new Error(`GetEntityToken failed: ${json.errorMessage ?? json.code}`)
  return json.data.EntityToken
}

// ── Entity API call helper ─────────────────────────────────────────────────
async function callEntity(entityToken, endpoint, body) {
  const res  = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-EntityToken': entityToken },
    body:    JSON.stringify(body),
  })
  return res.json()
}

// ── Definitions ────────────────────────────────────────────────────────────
//
// Each entry creates:
//   1. A Statistic definition  (stores the raw player value + aggregation)
//   2. A Leaderboard definition (ranked view, linked to the statistic column)

const DEFS = [
  {
    stat: {
      Name:                 'best_chain_size',
      EntityType:           'title_player_account',
      Columns:              [{ Name: 'Value', AggregationMethod: 'Max' }],
      VersionConfiguration: { MaxQueryableVersions: 1, ResetInterval: 'Manual' },
    },
    leaderboard: {
      Name:                 'best_chain_size',
      EntityType:           'title_player_account',
      SizeLimit:            1000,
      Columns:              [{ Name: 'Value', SortDirection: 'Descending',
        LinkedStatisticColumn: { StatisticName: 'best_chain_size', StatisticColumn: 'Value' } }],
      VersionConfiguration: { MaxQueryableVersions: 1, ResetInterval: 'Manual' },
    },
  },
  {
    stat: {
      Name:                 'total_coins',
      EntityType:           'title_player_account',
      Columns:              [{ Name: 'Value', AggregationMethod: 'Last' }],
      VersionConfiguration: { MaxQueryableVersions: 1, ResetInterval: 'Manual' },
    },
    leaderboard: {
      Name:                 'total_coins',
      EntityType:           'title_player_account',
      SizeLimit:            1000,
      Columns:              [{ Name: 'Value', SortDirection: 'Descending',
        LinkedStatisticColumn: { StatisticName: 'total_coins', StatisticColumn: 'Value' } }],
      VersionConfiguration: { MaxQueryableVersions: 1, ResetInterval: 'Manual' },
    },
  },
  {
    stat: {
      Name:                 'best_run_coins',
      EntityType:           'title_player_account',
      Columns:              [{ Name: 'Value', AggregationMethod: 'Max' }],
      VersionConfiguration: { MaxQueryableVersions: 1, ResetInterval: 'Manual' },
    },
    leaderboard: {
      Name:                 'best_run_coins',
      EntityType:           'title_player_account',
      SizeLimit:            1000,
      Columns:              [{ Name: 'Value', SortDirection: 'Descending',
        LinkedStatisticColumn: { StatisticName: 'best_run_coins', StatisticColumn: 'Value' } }],
      VersionConfiguration: { MaxQueryableVersions: 1, ResetInterval: 'Manual' },
    },
  },
]

// ── Run ────────────────────────────────────────────────────────────────────

console.log(`Setting up PlayFab statistics + leaderboards for title ${TITLE_ID}...\n`)

let entityToken
try {
  entityToken = await getTitleEntityToken()
  console.log('  Got title entity token ✓\n')
} catch (err) {
  console.error(`  Failed to get entity token: ${err.message}`)
  process.exit(1)
}

for (const { stat, leaderboard } of DEFS) {
  // 1. Create statistic
  process.stdout.write(`  Statistic  "${stat.Name}" (${stat.Columns[0].AggregationMethod})... `)
  try {
    const r = await callEntity(entityToken, '/Statistic/CreateStatisticDefinition', stat)
    if (r.code === 200)                          console.log('✓')
    else if (r.error === 'StatisticNameConflict') console.log('already exists')
    else                                          console.log(`✗  ${r.errorMessage ?? r.error}`)
  } catch (e) { console.log(`✗  ${e.message}`) }

  // 2. Create leaderboard
  process.stdout.write(`  Leaderboard "${leaderboard.Name}" (linked)... `)
  try {
    const r = await callEntity(entityToken, '/Leaderboard/CreateLeaderboardDefinition', leaderboard)
    if (r.code === 200)                            console.log('✓')
    else if (r.error === 'LeaderboardNameConflict') console.log('already exists')
    else                                            console.log(`✗  ${r.errorMessage ?? r.error}`)
  } catch (e) { console.log(`✗  ${e.message}`) }

  console.log()
}

console.log('Done. Statistics and leaderboards are ready to receive data.')
