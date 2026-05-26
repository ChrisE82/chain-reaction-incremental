#!/usr/bin/env node
// tools/validate-balance.mjs — CLI wrapper for balance config validation.
// Run: node tools/validate-balance.mjs
// Or via npm script: npm run balance:validate

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { validateBalance } from '../src/balance/validate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const jsonPath  = join(__dirname, '../src/balance/balance.live.json')

let raw
try {
  raw = JSON.parse(readFileSync(jsonPath, 'utf-8'))
} catch (err) {
  console.error(`❌ Could not read balance config: ${err.message}`)
  process.exit(1)
}

const { valid, errors } = validateBalance(raw)

if (!valid) {
  console.error('❌ Balance config is INVALID:')
  errors.forEach(e => console.error(`   • ${e}`))
  process.exit(1)
}

console.log('✅ Balance config is valid.')
