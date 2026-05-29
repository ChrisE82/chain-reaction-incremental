// src/ui/fmt.js — number formatting helpers used across all UI modules.

/** Format a coin amount: 1 234 → "1 234", 12 345 → "12.3K", 1 234 567 → "1.23M" */
export function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.floor(n).toString()
}

/** Format a chain multiplier for HUD display. */
export function fmtMult(m) {
  if (m === 0) return '0'
  if (Number.isInteger(m)) return m.toString()
  return m % 1 === 0.5 || m < 2 ? m.toFixed(2).replace(/\.?0+$/, '') : m.toFixed(1).replace(/\.?0+$/, '')
}

/** Format a chain bonus amount for the bonus label. */
export function fmtBonus(n) {
  n = Math.floor(n)
  if (n >= 10000) return fmt(n)
  if (n >= 1000)  return Math.floor(n / 1000) + ',' + String(n % 1000).padStart(3, '0')
  return n.toString()
}
