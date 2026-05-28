// src/playfab.js — PlayFab client integration
//
// Uses the new Entity API (not the legacy Statistics API which is being retired).
//
// Handles:
//   • Anonymous login (CustomID = stable UUID stored in localStorage)
//   • Cloud save / load  (UpdateUserData / GetUserData — Client API, not retiring)
//   • Leaderboard write  (Statistic/UpdateStatistics — new Entity API)
//   • Leaderboard read   (Leaderboard/GetLeaderboard — new Entity API)
//   • Account upgrade    (anon → email+password via AddUsernamePassword)
//   • Cross-device login (LoginWithEmailAddress)
//
// No Secret Key is required for any of the above — login returns both a
// SessionTicket (legacy Client API) and an EntityToken (new Entity API).

const TITLE_ID   = '1405E8'
const BASE_URL   = `https://${TITLE_ID}.playfabapi.com`
const DEVICE_KEY = 'cr_pf_device_id'

// ── Internal state ─────────────────────────────────────────────────────────

let _sessionTicket = null   // for legacy Client API  (cloud save / login)
let _entityToken   = null   // for new Entity API      (stats / leaderboards)
let _entity        = null   // { Id, Type } for the logged-in player entity
let _playFabId     = null

export function isLoggedIn()    { return _sessionTicket !== null }
export function getPlayFabId()  { return _playFabId }

// ── Sync throttle ──────────────────────────────────────────────────────────
// Cloud writes (saveGame + submitStats) are batched: at most one pair of
// requests fires per SYNC_INTERVAL_MS. Intermediate state snapshots are
// dropped — only the most recent one is sent when the timer fires.
// flushSync() bypasses the timer for pagehide / blur.

const SYNC_INTERVAL_MS = 30_000   // 30 s between cloud writes

let _syncTimer    = null
let _pendingState = null
let _lastSyncMs   = 0

async function _doSync(state) {
  _lastSyncMs   = Date.now()
  _pendingState = null
  await Promise.all([
    saveGame(state).catch(console.warn),
    submitStats(state).catch(console.warn),
  ])
}

/**
 * Queue a cloud sync for the given state.
 * Fires at most once per SYNC_INTERVAL_MS; the most recent state wins.
 * Call flushSync() on pagehide to send immediately without waiting.
 */
export function scheduleSync(state) {
  _pendingState = state
  if (_syncTimer) return
  const elapsed = Date.now() - _lastSyncMs
  const delay   = Math.max(0, SYNC_INTERVAL_MS - elapsed)
  _syncTimer = setTimeout(() => {
    _syncTimer = null
    if (_pendingState) _doSync(_pendingState)
  }, delay)
}

/**
 * Fire any pending sync immediately (ignores the throttle timer).
 * Use on pagehide / blur so progress isn't lost when the app is closed.
 */
export function flushSync() {
  if (!_pendingState || !_sessionTicket) return
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null }
  _doSync(_pendingState)
}

// ── Device ID ──────────────────────────────────────────────────────────────

function _getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

// ── Fetch wrappers ─────────────────────────────────────────────────────────

// Legacy Client API — uses X-Authorization (session ticket)
async function _call(endpoint, body, useAuth = false) {
  const headers = { 'Content-Type': 'application/json' }
  if (useAuth) {
    if (!_sessionTicket) throw new Error('[PlayFab] Not logged in')
    headers['X-Authorization'] = _sessionTicket
  }
  const res  = await fetch(`${BASE_URL}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = await res.json()
  if (json.code !== 200) throw new Error(`[PlayFab] ${endpoint}: ${json.errorMessage ?? json.error ?? json.code}`)
  return json.data
}

// New Entity API — uses X-EntityToken
async function _callEntity(endpoint, body) {
  if (!_entityToken) throw new Error('[PlayFab] Not logged in (no entity token)')
  const headers = { 'Content-Type': 'application/json', 'X-EntityToken': _entityToken }
  const res  = await fetch(`${BASE_URL}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = await res.json()
  if (json.code !== 200) throw new Error(`[PlayFab] ${endpoint}: ${json.errorMessage ?? json.error ?? json.code}`)
  return json.data
}

// ── Login ──────────────────────────────────────────────────────────────────

/**
 * Anonymous login using a stable device UUID.
 * Populates both _sessionTicket (legacy) and _entityToken (new Entity API).
 */
export async function login() {
  if (_sessionTicket) return

  const customId = _getOrCreateDeviceId()
  const data = await _call('/Client/LoginWithCustomID', {
    TitleId:               TITLE_ID,
    CustomId:              customId,
    CreateAccount:         true,
    InfoRequestParameters: { GetUserData: true },
  })

  _sessionTicket = data.SessionTicket
  _playFabId     = data.PlayFabId
  _entityToken   = data.EntityToken?.EntityToken
  _entity        = data.EntityToken?.Entity   // { Id, Type: 'title_player_account' }
  return data
}

/**
 * Log in with email + password (for cross-device restore).
 */
export async function loginWithEmail(email, password) {
  const data = await _call('/Client/LoginWithEmailAddress', {
    TitleId:               TITLE_ID,
    Email:                 email,
    Password:              password,
    InfoRequestParameters: { GetUserData: true },
  })
  _sessionTicket = data.SessionTicket
  _playFabId     = data.PlayFabId
  _entityToken   = data.EntityToken?.EntityToken
  _entity        = data.EntityToken?.Entity
  return data
}

// ── Account upgrade ────────────────────────────────────────────────────────

/**
 * Link email + password to the current anonymous account.
 * The anonymous save data is preserved — the account is not replaced.
 * After this, loginWithEmail() on any device returns the same account.
 */
export async function linkEmailPassword(username, email, password) {
  return _call('/Client/AddUsernamePassword', { Username: username, Email: email, Password: password }, true)
}

// ── Cloud save ─────────────────────────────────────────────────────────────

// UserData is part of the legacy Client API but is NOT being retired.
const SAVE_KEYS = ['coins', 'totalCoins', 'totalBallsPurchased', 'colorBuckets', 'clicks', 'prestigeCount']

/**
 * Push game state to PlayFab cloud save.
 */
export async function saveGame(state) {
  const data = {}
  for (const key of SAVE_KEYS) {
    if (key in state) data[key] = JSON.stringify(state[key])
  }
  return _call('/Client/UpdateUserData', { Data: data, Permission: 'Private' }, true)
}

/**
 * Load game state from PlayFab cloud save.
 * Returns an object with only the persisted keys, or null if no cloud save exists.
 */
export async function loadGame() {
  const data = await _call('/Client/GetUserData', { Keys: SAVE_KEYS }, true)
  if (!data?.Data || Object.keys(data.Data).length === 0) return null
  const result = {}
  for (const [key, entry] of Object.entries(data.Data)) {
    try { result[key] = JSON.parse(entry.Value) }
    catch { result[key] = entry.Value }
  }
  return result
}

// ── Leaderboards (new Entity API) ──────────────────────────────────────────
//
// Stat + leaderboard names must exist in the PlayFab dashboard
// (or created via tools/setup-playfab-stats.mjs).
//
// Dashboard setup per stat:
//   Statistics → Create → name, AggregationMethod, column "Value"
//   Leaderboards → Create → name, linked to the matching statistic column

const STAT_BEST_CHAIN  = 'best_chain_size'
const STAT_TOTAL_COINS = 'total_coins'
const STAT_BEST_RUN    = 'best_run_coins'

export const STATS = {
  BEST_CHAIN:  STAT_BEST_CHAIN,
  TOTAL_COINS: STAT_TOTAL_COINS,
  BEST_RUN:    STAT_BEST_RUN,
}

/**
 * Submit all three leaderboard stats from the current game state.
 * Uses the new Statistic/UpdateStatistics Entity API endpoint.
 */
export async function submitStats(state) {
  if (!_entity) throw new Error('[PlayFab] No entity — not logged in')
  return _callEntity('/Statistic/UpdateStatistics', {
    Entity:     _entity,
    Statistics: [
      { Name: STAT_BEST_CHAIN,  Scores: [String(Math.round(state.stats?.allTime?.biggestChain ?? 0))] },
      { Name: STAT_TOTAL_COINS, Scores: [String(Math.round(state.totalCoins                   ?? 0))] },
      { Name: STAT_BEST_RUN,    Scores: [String(Math.round(state.stats?.allTime?.bestRunCoins  ?? 0))] },
    ],
  })
}

/**
 * Fetch the top N players for a given leaderboard.
 * Uses the new Leaderboard/GetLeaderboard Entity API endpoint.
 *
 * @param {string} leaderboardName  one of STATS.BEST_CHAIN / TOTAL_COINS / BEST_RUN
 * @param {number} pageSize         default 20
 * @returns {Array<{ rank, displayName, value }>}
 */
export async function getLeaderboard(leaderboardName = STAT_BEST_CHAIN, pageSize = 20) {
  const data = await _callEntity('/Leaderboard/GetLeaderboard', {
    LeaderboardName:  leaderboardName,
    StartingPosition: 0,
    PageSize:         pageSize,
  })
  return (data?.Rankings ?? []).map(e => ({
    rank:        e.Rank + 1,
    displayName: e.DisplayName || e.Entity?.Id?.slice(0, 8) || '?',
    value:       Number(e.Scores?.[0] ?? 0),
  }))
}

/**
 * Fetch the current player's rank for a given leaderboard.
 * Returns null if the player has no score yet.
 *
 * @param {string} leaderboardName  one of STATS.BEST_CHAIN / TOTAL_COINS / BEST_RUN
 * @returns {{ rank, value }|null}
 */
export async function getPlayerRank(leaderboardName = STAT_BEST_CHAIN) {
  if (!_entity) throw new Error('[PlayFab] No entity — not logged in')
  const data = await _callEntity('/Leaderboard/GetLeaderboardAroundEntity', {
    LeaderboardName:      leaderboardName,
    Entity:               _entity,
    MaxSurroundingEntries: 0,
  })
  const entry = data?.Rankings?.[0]
  if (!entry) return null
  return { rank: entry.Rank + 1, value: Number(entry.Scores?.[0] ?? 0) }
}

// ── Analytics opt-out (cloud-persisted) ───────────────────────────────────
// Stores the player's analytics preference in PlayFab UserData so it survives
// localStorage clears and syncs across devices on the same account.

const ANALYTICS_KEY = 'analyticsOptOut'

/**
 * Save analytics opt-out preference to the cloud.
 * @param {boolean} optedOut
 */
export async function saveAnalyticsOptOut(optedOut) {
  if (!_sessionTicket) return
  return _call('/Client/UpdateUserData', {
    Data: { [ANALYTICS_KEY]: optedOut ? '1' : '0' },
    Permission: 'Private',
  }, true)
}

/**
 * Load analytics opt-out preference from the cloud.
 * Returns true (opted out), false (opted in), or null (no preference stored yet).
 */
export async function loadAnalyticsOptOut() {
  if (!_sessionTicket) return null
  const data = await _call('/Client/GetUserData', { Keys: [ANALYTICS_KEY] }, true)
  const val = data?.Data?.[ANALYTICS_KEY]?.Value
  if (val === undefined || val === null) return null
  return val === '1'
}

// ── Browser debug helpers ──────────────────────────────────────────────────
// window.__crPlayFab is available in the browser console for manual testing.
//
//   __crPlayFab.status()                        → login state, pending sync, last sync time
//   __crPlayFab.flush()                         → bypass 30 s timer, push immediately
//   __crPlayFab.leaderboard('best_chain_size')  → print top 20 for any leaderboard
//   __crPlayFab.myRank('best_chain_size')       → print your rank for any leaderboard

if (typeof window !== 'undefined') {
  window.__crPlayFab = {
    status() {
      console.log({
        loggedIn:    isLoggedIn(),
        playFabId:   _playFabId,
        entityId:    _entity?.Id,
        pendingSync: _pendingState !== null,
        lastSyncAgo: _lastSyncMs ? `${Math.round((Date.now() - _lastSyncMs) / 1000)} s ago` : 'never',
        timerActive: _syncTimer !== null,
      })
    },

    flush() {
      if (!_pendingState) { console.warn('[PlayFab] No pending sync'); return }
      flushSync()
      console.log('[PlayFab] Flushed')
    },

    async leaderboard(name = STAT_BEST_CHAIN) {
      const rows = await getLeaderboard(name)
      console.table(rows)
      return rows
    },

    async myRank(name = STAT_BEST_CHAIN) {
      const r = await getPlayerRank(name)
      console.log(r ?? 'No score submitted yet')
      return r
    },
  }
}
