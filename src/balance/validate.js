// src/balance/validate.js — balance config validation (pure; no I/O, no Vite)
// Works in both the browser (via config.js) and Node.js (via CLI tools).

// ── helpers ──────────────────────────────────────────────────────────────────

function _req(errors, path, value, kind = 'number') {
  if (value === undefined || value === null) {
    errors.push(`Missing required field: ${path}`)
    return false
  }
  if (kind === 'number' && typeof value !== 'number') {
    errors.push(`${path} must be a number (got ${typeof value})`)
    return false
  }
  if (kind === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
    errors.push(`${path} must be a plain object`)
    return false
  }
  if (kind === 'array' && !Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return false
  }
  return true
}

function _pos(errors, path, v) {
  if (_req(errors, path, v) && v <= 0)
    errors.push(`${path} must be positive (got ${v})`)
}

function _gt1(errors, path, v) {
  if (_req(errors, path, v) && v <= 1)
    errors.push(`${path} must be > 1 for exponential growth (got ${v})`)
}

function _gte1(errors, path, v) {
  if (_req(errors, path, v) && v < 1)
    errors.push(`${path} must be ≥ 1 (got ${v})`)
}

function _costEntry(errors, ns, obj) {
  if (!_req(errors, ns, obj, 'object')) return
  _pos(errors, `${ns}.baseCost`,    obj.baseCost)
  _gt1(errors, `${ns}.growthRate`,  obj.growthRate)
}

// ── main validator ────────────────────────────────────────────────────────────

/**
 * Validates a balance config object.
 * @param {unknown} cfg
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBalance(cfg) {
  const errors = []

  if (!cfg || typeof cfg !== 'object') {
    return { valid: false, errors: ['Balance config must be a plain object'] }
  }

  // ── economy ────────────────────────────────────────────────────────────────
  const e = cfg.economy
  if (!_req(errors, 'economy', e, 'object')) {
    return { valid: false, errors }   // nothing more to validate
  }

  _pos(errors, 'economy.baseCoinValue', e.baseCoinValue)

  if (_req(errors, 'economy.value', e.value, 'object')) {
    _pos(errors, 'economy.value.maxBonus', e.value.maxBonus)
    _pos(errors, 'economy.value.curve',    e.value.curve)
  }

  if (_req(errors, 'economy.speed', e.speed, 'object')) {
    _pos(errors, 'economy.speed.base',     e.speed.base)
    _pos(errors, 'economy.speed.maxBonus', e.speed.maxBonus)
    _pos(errors, 'economy.speed.curve',    e.speed.curve)
  }

  if (_req(errors, 'economy.diameter', e.diameter, 'object')) {
    _pos(errors, 'economy.diameter.baseR', e.diameter.baseR)
    _pos(errors, 'economy.diameter.maxR',  e.diameter.maxR)
    _pos(errors, 'economy.diameter.curve', e.diameter.curve)
    if (typeof e.diameter.maxR === 'number' && typeof e.diameter.baseR === 'number'
        && e.diameter.maxR <= e.diameter.baseR)
      errors.push(`economy.diameter.maxR (${e.diameter.maxR}) must be > baseR (${e.diameter.baseR})`)
  }

  if (_req(errors, 'economy.duration', e.duration, 'object')) {
    _pos(errors, 'economy.duration.baseMs',  e.duration.baseMs)
    _pos(errors, 'economy.duration.maxBonus',e.duration.maxBonus)
    _pos(errors, 'economy.duration.curve',   e.duration.curve)
  }

  if (_req(errors, 'economy.tap', e.tap, 'object')) {
    if (_req(errors, 'economy.tap.radius', e.tap.radius, 'object')) {
      _pos(errors, 'economy.tap.radius.baseR',    e.tap.radius.baseR)
      _pos(errors, 'economy.tap.radius.maxBonus', e.tap.radius.maxBonus)
      _pos(errors, 'economy.tap.radius.curve',    e.tap.radius.curve)
    }
    if (_req(errors, 'economy.tap.duration', e.tap.duration, 'object')) {
      _pos(errors, 'economy.tap.duration.baseMs',  e.tap.duration.baseMs)
      _pos(errors, 'economy.tap.duration.maxBonus',e.tap.duration.maxBonus)
      _pos(errors, 'economy.tap.duration.curve',   e.tap.duration.curve)
    }
  }

  const uc = e.upgradeCost
  if (_req(errors, 'economy.upgradeCost', uc, 'object')) {
    for (const k of ['value', 'speed', 'diameter', 'duration'])
      _costEntry(errors, `economy.upgradeCost.${k}`, uc[k])
    _gt1(errors, 'economy.upgradeCost.cycleMult', uc.cycleMult)
    for (const k of ['tapRadius', 'tapDuration'])
      _costEntry(errors, `economy.upgradeCost.${k}`, uc[k])
  }

  const ball = e.ball
  if (_req(errors, 'economy.ball', ball, 'object')) {
    if (_req(errors, 'economy.ball.earlyTable', ball.earlyTable, 'object')) {
      for (const [k, v] of Object.entries(ball.earlyTable)) {
        if (typeof v !== 'number' || v <= 0)
          errors.push(`economy.ball.earlyTable["${k}"] must be a positive number`)
      }
    }
    _pos(errors, 'economy.ball.lateBase',  ball.lateBase)
    _gt1(errors, 'economy.ball.lateMult',  ball.lateMult)
    _gt1(errors, 'economy.ball.cycleMult', ball.cycleMult)
    if (ball.lateStart !== undefined
        && (typeof ball.lateStart !== 'number' || ball.lateStart < 0))
      errors.push('economy.ball.lateStart must be a non-negative number')
  }

  const chain = e.chain
  if (_req(errors, 'economy.chain', chain, 'object')) {
    if (_req(errors, 'economy.chain.table', chain.table, 'array')) {
      if (chain.table.length < 2)
        errors.push('economy.chain.table must have at least 2 entries')
      chain.table.forEach((v, i) => {
        if (typeof v !== 'number' || v < 0)
          errors.push(`economy.chain.table[${i}] must be a non-negative number`)
      })
    }
    _gte1(errors, 'economy.chain.lateRate', chain.lateRate)
  }

  // ── physics ────────────────────────────────────────────────────────────────
  const ph = cfg.physics
  if (_req(errors, 'physics', ph, 'object')) {
    _pos(errors, 'physics.ballRadius',              ph.ballRadius)
    _pos(errors, 'physics.ballCollisionRadiusMult', ph.ballCollisionRadiusMult)

    const as = ph.arenaScale
    if (_req(errors, 'physics.arenaScale', as, 'object')) {
      if (_req(errors, 'physics.arenaScale.thresholds', as.thresholds, 'array')) {
        if (as.thresholds.length === 0)
          errors.push('physics.arenaScale.thresholds must not be empty')
        as.thresholds.forEach((t, i) => {
          if (!t || typeof t.maxBalls !== 'number' || typeof t.scale !== 'number')
            errors.push(`physics.arenaScale.thresholds[${i}] must have numeric maxBalls and scale`)
        })
      }
      _pos(errors, 'physics.arenaScale.lateMax',     as.lateMax)
      _pos(errors, 'physics.arenaScale.lateBase',    as.lateBase)
      _pos(errors, 'physics.arenaScale.lateLogMult', as.lateLogMult)
    }
  }

  // ── ballBase ───────────────────────────────────────────────────────────────
  const bb = cfg.ballBase
  if (_req(errors, 'ballBase', bb, 'object')) {
    _pos(errors, 'ballBase.growDuration',   bb.growDuration)
    _pos(errors, 'ballBase.holdDuration',   bb.holdDuration)
    _pos(errors, 'ballBase.shrinkDuration', bb.shrinkDuration)
  }

  // ── timing ─────────────────────────────────────────────────────────────────
  const ti = cfg.timing
  if (_req(errors, 'timing', ti, 'object')) {
    for (const k of [
      'tapGrowMs', 'tapHoldMs', 'tapShrinkMs',
      'refillStartDelayMs', 'spawnStaggerMaxMs', 'spawnGrowMs', 'spawnSettleMs',
      'autoUpgradeIntervalMs',
    ]) _pos(errors, `timing.${k}`, ti[k])
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Like validateBalance but throws on failure. Returns cfg unchanged if valid.
 * Use in config.js / Node scripts where a bad config must halt execution.
 * @param {unknown} cfg
 * @returns {object}
 */
export function assertBalance(cfg) {
  const { valid, errors } = validateBalance(cfg)
  if (!valid) {
    throw new Error(
      `[balance] Invalid config:\n${errors.map(e => `  • ${e}`).join('\n')}`
    )
  }
  return /** @type {object} */ (cfg)
}
