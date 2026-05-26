// tools/setup-playfab-stats.mjs
// One-time script to create PlayFab leaderboard statistics with correct aggregation.
//
// Run once:
//   node tools/setup-playfab-stats.mjs
//
// Requires PLAYFAB_SECRET_KEY in .env (get it from PlayFab dashboard:
//   Title 1405E8 → Settings → Secret Keys → Show Secret)
// The secret key never leaves your machine — this script is not part of the game bundle.

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Load .env manually (no dotenv dependency needed) ──────────────────────
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '../.env')
const env = {}
try {
  readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
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

// ── Stat definitions ───────────────────────────────────────────────────────
// AggregationMethod: 'Last' | 'Min' | 'Max' | 'Sum'
// VersionChangeInterval: 'Never' | 'Hour' | 'Day' | 'Week' | 'Month'

const STATS = [
  {
    StatisticName:        'best_chain_size',
    AggregationMethod:    'Max',
    VersionChangeInterval: 'Never',
    DefaultValue:          0,
  },
  {
    StatisticName:        'total_coins',
    AggregationMethod:    'Last',
    VersionChangeInterval: 'Never',
    DefaultValue:          0,
  },
  {
    StatisticName:        'best_run_coins',
    AggregationMethod:    'Max',
    VersionChangeInterval: 'Never',
    DefaultValue:          0,
  },
]

// ── Admin API call ─────────────────────────────────────────────────────────

async function createStat(def) {
  const res = await fetch(`${BASE_URL}/Admin/CreatePlayerStatisticDefinition`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SecretKey':  SECRET_KEY,
    },
    body: JSON.stringify(def),
  })
  return res.json()
}

// ── Run ────────────────────────────────────────────────────────────────────

console.log(`Setting up PlayFab statistics for title ${TITLE_ID}...\n`)

for (const stat of STATS) {
  process.stdout.write(`  Creating "${stat.StatisticName}" (${stat.AggregationMethod})... `)
  try {
    const result = await createStat(stat)
    if (result.code === 200) {
      console.log('✓')
    } else if (result.error === 'StatisticNameConflict') {
      console.log('already exists (skipped)')
    } else {
      console.log(`✗  ${result.errorMessage ?? result.error ?? JSON.stringify(result)}`)
    }
  } catch (err) {
    console.log(`✗  ${err.message}`)
  }
}

console.log('\nDone. Leaderboards are ready to receive data.')
