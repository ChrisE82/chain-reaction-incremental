/**
 * rng.js — deterministic seeded PRNG for Chain Reaction: Idle
 *
 * Algorithm: Mulberry32 — 32-bit state, excellent distribution, tiny footprint.
 * All roguelite board layouts (initial spawn + refreshes) are driven by this RNG
 * so any run can be reproduced exactly from its seed.
 */

/**
 * Returns a PRNG function seeded from `seed`.
 * Each call to the returned function advances the state and returns a float
 * uniformly distributed in [0, 1), matching the Math.random() contract.
 */
export function seededRng(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Generate a cryptographically random 32-bit unsigned seed.
 * Falls back to Math.random() on environments without Web Crypto.
 */
export function makeSeed() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return buf[0]
  }
  return (Math.random() * 0xFFFFFFFF) >>> 0
}

/**
 * Derive a deterministic per-round seed from the run seed and round number.
 * Uses a mixing step so consecutive round numbers don't produce correlated seeds.
 */
export function deriveRoundSeed(runSeed, roundNumber) {
  let h = (runSeed ^ (roundNumber * 0x9e3779b9)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Derive a deterministic seed for a specific refresh within a round.
 * refreshIndex 0 = initial board, 1 = first manual refresh, etc.
 */
export function deriveRefreshSeed(roundSeed, refreshIndex) {
  let h = (roundSeed ^ (refreshIndex * 0x5851f42d)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Format a seed as an 8-character uppercase hex string for display.
 * e.g. 0xDEADBEEF → "DEADBEEF"
 */
export function formatSeed(seed) {
  return (seed >>> 0).toString(16).toUpperCase().padStart(8, '0')
}
