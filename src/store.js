// Chain Reaction: Idle — persistent state

const STORAGE_KEY = 'cr_incremental_state'

export const UPGRADE_BASES = { speed: 15, radius: 20, duration: 25, respawn: 30 }

function defaultState() {
  return {
    coins:         0,
    totalCoins:    0,
    balls:         [{ speedLevel: 0, radiusLevel: 0, durationLevel: 0, respawnLevel: 0 }],
    unlockedSlots: 1,
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaultState(), ...JSON.parse(raw) }
  } catch (_) {}
  return defaultState()
}

function saveState(st) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(st))
}

let state = loadState()

export function getState() { return state }

// cost to upgrade from `level` → `level+1`
export function upgradeCost(base, level) {
  return Math.ceil(base * Math.pow(1.2, level))
}

// cost to unlock the (n+1)th slot when n slots are currently unlocked
export function slotCost(n) {
  return Math.floor(50 * Math.pow(2, n - 1))
}

// Derive live stats from stored upgrade levels
export function ballStats(ball) {
  return {
    speed:     0.30 * Math.pow(1.10, ball.speedLevel),    // virt-units/frame
    maxRadius: 15   * Math.pow(1.08, ball.radiusLevel),   // virt-units
    holdMs:    400  * Math.pow(1.15, ball.durationLevel),  // ms
    respawnMs: 5000 * Math.pow(0.85, ball.respawnLevel),   // ms
  }
}

export function addCoins(n) {
  state.coins      += n
  state.totalCoins += n
  saveState(state)
}

export function tryUpgrade(ballIdx, stat) {
  const ball = state.balls[ballIdx]
  if (!ball) return false
  const key  = stat + 'Level'
  const cost = upgradeCost(UPGRADE_BASES[stat], ball[key])
  if (state.coins < cost) return false
  state.coins -= cost
  ball[key]++
  saveState(state)
  return true
}

export function tryUnlockSlot() {
  const n    = state.unlockedSlots
  const cost = slotCost(n)
  if (state.coins < cost) return false
  state.coins -= cost
  state.unlockedSlots++
  state.balls.push({ speedLevel: 0, radiusLevel: 0, durationLevel: 0, respawnLevel: 0 })
  saveState(state)
  return true
}

export function devAddCoins(n) {
  state.coins      += n
  state.totalCoins += n
  saveState(state)
}

export function devReset() {
  state = defaultState()
  saveState(state)
  return state
}
