// src/playfab.js — PlayFab client integration
//
// Handles:
//   • Anonymous login (CustomID = stable UUID stored in localStorage)
//   • Cloud save / load  (UpdateUserData / GetUserData)
//   • Leaderboard write  (UpdatePlayerStatistics)
//   • Account upgrade    (anon → email+password via AddUsernamePassword)
//   • Cross-device login (LoginWithEmailAddress)
//
// No Secret Key is required — all calls go through the Client API,
// which authenticates via a session ticket returned at login.
//
// Usage:
//   import * as PlayFab from './playfab.js'
//   await PlayFab.login()
//   await PlayFab.saveGame(state)
//   const remote = await PlayFab.loadGame()

const TITLE_ID   = '1405E8'
const BASE_URL   = `https://${TITLE_ID}.playfabapi.com`
const DEVICE_KEY = 'cr_pf_device_id'

// ── Internal state ─────────────────────────────────────────────────────────

let _sessionTicket = null   // set after any successful login
let _playFabId     = null   // PlayFab player ID

export function isLoggedIn()    { return _sessionTicket !== null }
export function getPlayFabId()  { return _playFabId }

// ── Sync throttle ──────────────────────────────────────────────────────────
// Cloud writes (saveGame + submitStats) are batched: at most one pair of
// requests fires per SYNC_INTERVAL_MS. Intermediate state snapshots are
// dropped — only the most recent one is sent when the timer fires.
// flushSync() bypasses the timer for pagehide / blur.

const SYNC_INTERVAL_MS = 30_000   // 30 s between cloud writes

let _syncTimer    = null
let _pendingState = null   // latest state snapshot waiting to be sent
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
  if (_syncTimer) return                          // already scheduled
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
    // crypto.randomUUID() is available on all modern browsers (including WebView)
    id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

// ── Core fetch wrapper ─────────────────────────────────────────────────────

async function _call(endpoint, body, useAuth = false) {
  const headers = { 'Content-Type': 'application/json' }
  if (useAuth) {
    if (!_sessionTicket) throw new Error('[PlayFab] Not logged in')
    headers['X-Authorization'] = _sessionTicket
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  })

  const json = await res.json()

  if (json.code !== 200) {
    const msg = json.errorMessage || json.error || `HTTP ${json.code}`
    throw new Error(`[PlayFab] ${endpoint}: ${msg}`)
  }

  return json.data
}

// ── Login ──────────────────────────────────────────────────────────────────

/**
 * Anonymous login using a stable device UUID.
 * Creates the PlayFab account on first call; returns the same account
 * on subsequent calls from the same device.
 *
 * Call this once at game start before any save/load.
 */
export async function login() {
  if (_sessionTicket) return   // already logged in

  const customId = _getOrCreateDeviceId()
  const data = await _call('/Client/LoginWithCustomID', {
    TitleId:              TITLE_ID,
    CustomId:             customId,
    CreateAccount:        true,
    InfoRequestParameters: { GetUserData: true },
  })

  _sessionTicket = data.SessionTicket
  _playFabId     = data.PlayFabId
  return data
}

/**
 * Log in with email + password (for cross-device restore).
 * Replaces the anonymous session with the linked account.
 */
export async function loginWithEmail(email, password) {
  const data = await _call('/Client/LoginWithEmailAddress', {
    TitleId:  TITLE_ID,
    Email:    email,
    Password: password,
    InfoRequestParameters: { GetUserData: true },
  })

  _sessionTicket = data.SessionTicket
  _playFabId     = data.PlayFabId
  return data
}

// ── Account upgrade ────────────────────────────────────────────────────────

/**
 * Link email + password to the current anonymous account.
 * The anonymous save data is preserved — the account is not replaced.
 * After this, loginWithEmail() on any device returns the same account.
 *
 * @param {string} username  display name (3–20 chars, alphanumeric + _-)
 * @param {string} email
 * @param {string} password  min 6 chars
 */
export async function linkEmailPassword(username, email, password) {
  return _call('/Client/AddUsernamePassword', { Username: username, Email: email, Password: password }, true)
}

// ── Cloud save ─────────────────────────────────────────────────────────────

// Keys we persist to PlayFab. Keep the list short — each key is a separate
// entry in UserData and PlayFab has a 10 MB total / 300 key limit per player.
// Must match the field names in store.js defaultState().
const SAVE_KEYS = ['coins', 'totalCoins', 'totalBallsPurchased', 'colorBuckets', 'clicks', 'prestigeCount']

/**
 * Push game state to PlayFab cloud save.
 * Only serializes the keys we care about to keep payload small.
 *
 * @param {object} state  the full game state object from store.js
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
 *
 * @returns {object|null}
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

// ── Leaderboard ────────────────────────────────────────────────────────────

// Statistic names must match what's created in the PlayFab dashboard:
//   Title 1405E8 → Leaderboards → New Statistic
//
//   best_chain_size   — aggregation: Maximum
//   total_coins       — aggregation: Last   (always increases, so Last = max)
//   best_run_coins    — aggregation: Maximum
const STAT_BEST_CHAIN   = 'best_chain_size'
const STAT_TOTAL_COINS  = 'total_coins'
const STAT_BEST_RUN     = 'best_run_coins'

/**
 * Submit all three leaderboard stats from the current game state.
 * Called automatically via the cloud-save hook on every purchase,
 * and on pagehide. Safe to call frequently — PlayFab deduplicates.
 *
 * @param {object} state  full game state from store.js getState()
 */
export async function submitStats(state) {
  return _call('/Client/UpdatePlayerStatistics', {
    Statistics: [
      { StatisticName: STAT_BEST_CHAIN,  Value: Math.round(state.stats?.allTime?.biggestChain  ?? 0) },
      { StatisticName: STAT_TOTAL_COINS, Value: Math.round(state.totalCoins                    ?? 0) },
      { StatisticName: STAT_BEST_RUN,    Value: Math.round(state.stats?.allTime?.bestRunCoins  ?? 0) },
    ],
  }, true)
}

/** Stat name constants — use these when calling getLeaderboard / getPlayerRank. */
export const STATS = {
  BEST_CHAIN:  STAT_BEST_CHAIN,
  TOTAL_COINS: STAT_TOTAL_COINS,
  BEST_RUN:    STAT_BEST_RUN,
}

/**
 * Fetch the top N players for a given stat.
 *
 * @param {string} statName    one of STATS.BEST_CHAIN / TOTAL_COINS / BEST_RUN
 * @param {number} maxResults  default 20
 * @returns {Array<{ rank, displayName, value }>}
 */
export async function getLeaderboard(statName = STAT_BEST_CHAIN, maxResults = 20) {
  const data = await _call('/Client/GetLeaderboard', {
    StatisticName:   statName,
    StartPosition:   0,
    MaxResultsCount: maxResults,
  }, true)

  return (data?.Leaderboard ?? []).map(e => ({
    rank:        e.Position + 1,
    displayName: e.DisplayName || e.PlayFabId.slice(0, 8),
    value:       e.StatValue,
  }))
}

/**
 * Fetch the current player's rank for a given stat.
 * Returns null if the player has no score yet.
 *
 * @param {string} statName  one of STATS.BEST_CHAIN / TOTAL_COINS / BEST_RUN
 * @returns {{ rank, value }|null}
 */
export async function getPlayerRank(statName = STAT_BEST_CHAIN) {
  const data = await _call('/Client/GetLeaderboardAroundPlayer', {
    StatisticName:   statName,
    MaxResultsCount: 1,
  }, true)

  const entry = data?.Leaderboard?.[0]
  if (!entry) return null
  return { rank: entry.Position + 1, value: entry.StatValue }
}

// ── Browser debug helpers ──────────────────────────────────────────────────
// window.__crPlayFab is available in the browser console for manual testing.
//
//   __crPlayFab.status()                   → login state, pending sync, last sync time
//   __crPlayFab.flush()                    → fire pending sync immediately (bypass 30 s timer)
//   __crPlayFab.leaderboard('best_chain_size')  → print top 20 for any stat
//   __crPlayFab.myRank('best_chain_size')       → print your rank for any stat

if (typeof window !== 'undefined') {
  window.__crPlayFab = {
    status() {
      console.log({
        loggedIn:     isLoggedIn(),
        playFabId:    _playFabId,
        pendingSync:  _pendingState !== null,
        lastSyncAgo:  _lastSyncMs ? `${Math.round((Date.now() - _lastSyncMs) / 1000)} s ago` : 'never',
        timerActive:  _syncTimer !== null,
      })
    },

    flush() {
      if (!_pendingState) { console.warn('[PlayFab] No pending sync'); return }
      flushSync()
      console.log('[PlayFab] Flushed')
    },

    async leaderboard(statName = STAT_BEST_CHAIN) {
      const rows = await getLeaderboard(statName)
      console.table(rows)
      return rows
    },

    async myRank(statName = STAT_BEST_CHAIN) {
      const r = await getPlayerRank(statName)
      console.log(r ?? 'No score submitted yet')
      return r
    },
  }
}
