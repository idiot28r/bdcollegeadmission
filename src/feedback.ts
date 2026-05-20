// Modular UI feedback: haptics (Vibration API) + sound (Web Audio tones).
// No audio asset files — tones are synthesized, so it stays IAB-safe and
// adds zero bundle weight.
//
// Two gates per channel: an ADMIN gate (settings.haptics_enabled /
// sound_enabled — global kill switch) and a USER gate (per-student
// preference in the sidebar). A channel fires only when BOTH allow it.
//
// Usage:  import { feedback } from './feedback';  feedback('success');

export type Cue = 'tap' | 'press' | 'toggle' | 'success' | 'error';

let adminHaptics = true, adminSound = true;
let userHaptics = true, userSound = true;

export function setAdminFeedback(cfg: { haptics?: boolean; sound?: boolean }) {
  if (typeof cfg.haptics === 'boolean') adminHaptics = cfg.haptics;
  if (typeof cfg.sound === 'boolean') adminSound = cfg.sound;
}
export function setUserFeedback(cfg: { haptics?: boolean; sound?: boolean }) {
  if (typeof cfg.haptics === 'boolean') userHaptics = cfg.haptics;
  if (typeof cfg.sound === 'boolean') userSound = cfg.sound;
}
const hapticsOn = () => adminHaptics && userHaptics;
const soundOn = () => adminSound && userSound;

/* ---------- Haptics (Android Chrome; silent no-op on iOS) ---------- */
// Numbers are vibration durations in ms; the API has no amplitude control,
// so "stronger" = longer pulse. 'press' is the strong cue for the primary
// Options/Answer/Explain buttons.
const VIBRATE: Record<Cue, number | number[]> = {
  tap: 10,
  press: 45,
  toggle: 18,
  success: [12, 40, 14],
  error: [35, 30, 35],
};

function haptic(cue: Cue) {
  if (!hapticsOn()) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(VIBRATE[cue]); } catch { /* ignore */ }
}

/* ---------- Sound (Web Audio, lazily created on first user gesture) ---------- */
// Each cue is a sequence of tones played back-to-back. 'error' is a quick
// two-frequency "ti-tik".
type Step = { freq: number; dur: number; type: OscillatorType };
const TONE: Record<Cue, Step[]> = {
  tap:     [{ freq: 440, dur: 0.05, type: 'sine' }],
  press:   [{ freq: 500, dur: 0.06, type: 'sine' }],
  toggle:  [{ freq: 540, dur: 0.06, type: 'triangle' }],
  success: [{ freq: 660, dur: 0.08, type: 'sine' }, { freq: 880, dur: 0.10, type: 'sine' }],
  error:   [{ freq: 400, dur: 0.06, type: 'square' }, { freq: 250, dur: 0.07, type: 'square' }],
};

let ac: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ac) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch { return null; }
  }
  return ac;
}

function sound(cue: Cue) {
  if (!soundOn()) return;
  const a = audio();
  if (!a) return;
  try {
    if (a.state === 'suspended') void a.resume();
    let t = a.currentTime;
    for (const step of TONE[cue]) {
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = step.type;
      osc.frequency.value = step.freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.10, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + step.dur);
      osc.connect(gain).connect(a.destination);
      osc.start(t);
      osc.stop(t + step.dur);
      t += step.dur; // back-to-back for the ti-tik effect
    }
  } catch { /* ignore */ }
}

/* ---------- Public API: fire both channels for a cue ---------- */
export function feedback(cue: Cue) {
  haptic(cue);
  sound(cue);
}
