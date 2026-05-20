// Modular UI feedback: haptics (Vibration API) + sound (Web Audio tones).
// No audio asset files — tones are synthesized, so it stays IAB-safe and
// adds zero bundle weight. Both channels are globally gated by flags the
// admin controls (settings.haptics_enabled / settings.sound_enabled), pushed
// in at runtime via setFeedbackConfig().
//
// Usage:  import { feedback } from './feedback';  feedback('success');

export type Cue = 'tap' | 'toggle' | 'success' | 'error';

let hapticsOn = true;
let soundOn = true;

export function setFeedbackConfig(cfg: { haptics?: boolean; sound?: boolean }) {
  if (typeof cfg.haptics === 'boolean') hapticsOn = cfg.haptics;
  if (typeof cfg.sound === 'boolean') soundOn = cfg.sound;
}

/* ---------- Haptics (Android Chrome; silent no-op on iOS) ---------- */
const VIBRATE: Record<Cue, number | number[]> = {
  tap: 10,
  toggle: 15,
  success: [12, 40, 12],
  error: [30, 25, 30],
};

function haptic(cue: Cue) {
  if (!hapticsOn) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(VIBRATE[cue]); } catch { /* ignore */ }
}

/* ---------- Sound (Web Audio, lazily created on first user gesture) ---------- */
const TONE: Record<Cue, { freq: number; dur: number; type: OscillatorType }> = {
  tap: { freq: 440, dur: 0.05, type: 'sine' },
  toggle: { freq: 540, dur: 0.06, type: 'triangle' },
  success: { freq: 720, dur: 0.13, type: 'sine' },
  error: { freq: 180, dur: 0.16, type: 'sawtooth' },
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
  if (!soundOn) return;
  const a = audio();
  if (!a) return;
  try {
    if (a.state === 'suspended') void a.resume();
    const { freq, dur, type } = TONE[cue];
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t = a.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.10, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + dur);
  } catch { /* ignore */ }
}

/* ---------- Public API: fire both channels for a cue ---------- */
export function feedback(cue: Cue) {
  haptic(cue);
  sound(cue);
}
