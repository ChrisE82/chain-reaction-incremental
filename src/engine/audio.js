// src/engine/audio.js — Web Audio system (AudioContext, trigger tones, intro sounds).

// Intro phase durations (ms) — mirrored from main.js constants.
// Used only to compute the buildup/rumble duration in playIntroBuildup() and playRumble().
const INTRO_RUMBLE_DURATION = 900
const INTRO_SUCK_DURATION   = 2400

// Small lookahead offset (seconds) applied to all scheduled audio events.
// audioCtx.resume() is async — without this, sounds scheduled at ac.currentTime
// while the context is still starting up arrive late.
const AUDIO_AHEAD = 0.025

let audioCtx = null

export function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

export function playTrigger(n) {
  try {
    const ac   = getAudio()
    const now  = ac.currentTime + AUDIO_AHEAD
    const osc  = ac.createOscillator()
    const gain = ac.createGain()
    osc.connect(gain); gain.connect(ac.destination)
    osc.type = 'sine'
    const freq = 300 * Math.pow(1.07, Math.min(n, 24))
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.07)
    gain.gain.setValueAtTime(0.18, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)
    osc.start(now); osc.stop(now + 0.22)
  } catch (_) {}
}

// Rising pitch-sweep played during the intro rumble + suck phases.
// Reads as a "charging up" that resolves when the birth explosion hits.
export function playIntroBuildup() {
  try {
    const ac  = getAudio()
    const now = ac.currentTime + AUDIO_AHEAD
    const dur = (INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION) / 1000  // ~3.3 s

    // Primary sweep — sine tone rising from 110 Hz to 1400 Hz
    const osc1  = ac.createOscillator()
    const gain1 = ac.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(110, now)
    osc1.frequency.exponentialRampToValueAtTime(1400, now + dur * 0.92)
    gain1.gain.setValueAtTime(0, now)
    gain1.gain.linearRampToValueAtTime(0.13, now + 0.9)
    gain1.gain.setValueAtTime(0.13, now + dur * 0.88)
    gain1.gain.linearRampToValueAtTime(0, now + dur)
    osc1.connect(gain1); gain1.connect(ac.destination)
    osc1.start(now); osc1.stop(now + dur)

    // Harmonic layer — a fifth above, slightly delayed entry, adds body
    const osc2  = ac.createOscillator()
    const gain2 = ac.createGain()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(165, now)
    osc2.frequency.exponentialRampToValueAtTime(2100, now + dur * 0.92)
    gain2.gain.setValueAtTime(0, now)
    gain2.gain.linearRampToValueAtTime(0.06, now + 1.4)
    gain2.gain.setValueAtTime(0.06, now + dur * 0.88)
    gain2.gain.linearRampToValueAtTime(0, now + dur)
    osc2.connect(gain2); gain2.connect(ac.destination)
    osc2.start(now); osc2.stop(now + dur)
  } catch (_) {}
}

export function playRumble() {
  try {
    const ac  = getAudio()
    const now = ac.currentTime + AUDIO_AHEAD
    const dur = (INTRO_RUMBLE_DURATION + INTRO_SUCK_DURATION) / 1000  // ~3.3 s

    // White-noise buffer the length of rumble + suck phases
    const frames = Math.ceil(ac.sampleRate * dur)
    const buf    = ac.createBuffer(1, frames, ac.sampleRate)
    const data   = buf.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1

    const src  = ac.createBufferSource()
    src.buffer = buf

    // Low-pass filter gives it a deep "room shake" character
    const filter = ac.createBiquadFilter()
    filter.type  = 'lowpass'
    filter.frequency.setValueAtTime(120, now)
    filter.frequency.linearRampToValueAtTime(55, now + dur)

    const gain = ac.createGain()
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.linearRampToValueAtTime(0.28, now + 0.6)   // build up
    gain.gain.setValueAtTime(0.28, now + dur - 0.9)
    gain.gain.linearRampToValueAtTime(0.001, now + dur)   // fade out before birth

    src.connect(filter)
    filter.connect(gain)
    gain.connect(ac.destination)
    src.start(now); src.stop(now + dur)
  } catch (_) {}
}

// Single sharp "collapse" pop played at the moment the shaking singularity
// implodes just before the explosion ring fires.
// Layers: sub-bass thump (impact body) + noise crack (transient snap) + high click (attack edge).
export function playBirthPop() {
  try {
    const ac  = getAudio()
    const now = ac.currentTime + AUDIO_AHEAD

    // Sub-bass thump — sine sweeping down from 90 → 28 Hz, punchy and physical
    const osc1  = ac.createOscillator()
    const gain1 = ac.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(90, now)
    osc1.frequency.exponentialRampToValueAtTime(28, now + 0.18)
    gain1.gain.setValueAtTime(0, now)
    gain1.gain.linearRampToValueAtTime(0.85, now + 0.004)   // near-instant attack
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.40)
    osc1.connect(gain1); gain1.connect(ac.destination)
    osc1.start(now); osc1.stop(now + 0.40)

    // Noise crack — band-passed white noise for the "snap" texture
    const frames = Math.ceil(ac.sampleRate * 0.20)
    const buf    = ac.createBuffer(1, frames, ac.sampleRate)
    const data   = buf.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
    const src    = ac.createBufferSource()
    src.buffer   = buf
    const filt   = ac.createBiquadFilter()
    filt.type    = 'bandpass'
    filt.frequency.setValueAtTime(1200, now)
    filt.Q.setValueAtTime(0.7, now)
    const gain2  = ac.createGain()
    gain2.gain.setValueAtTime(0.45, now)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.20)
    src.connect(filt); filt.connect(gain2); gain2.connect(ac.destination)
    src.start(now); src.stop(now + 0.20)

    // High-frequency click — very brief bright transient that sells the "point" moment
    const osc2  = ac.createOscillator()
    const gain3 = ac.createGain()
    osc2.type = 'triangle'
    osc2.frequency.setValueAtTime(3200, now)
    gain3.gain.setValueAtTime(0.30, now)
    gain3.gain.exponentialRampToValueAtTime(0.001, now + 0.06)
    osc2.connect(gain3); gain3.connect(ac.destination)
    osc2.start(now); osc2.stop(now + 0.06)
  } catch (_) {}
}
