import zapUrl from '../assets/tip-sounds/sats-zap.mp3';
import coinUrl from '../assets/tip-sounds/sats-coin.mp3';
import sparkleUrl from '../assets/tip-sounds/sats-sparkle.mp3';
import registerUrl from '../assets/tip-sounds/cash-register.mp3';

export const TIP_SOUNDS = [
  { id: 'sats-zap', label: 'Zap' },
  { id: 'sats-coin', label: 'Coin' },
  { id: 'sats-sparkle', label: 'Sparkle' },
  { id: 'cash-register', label: 'Cash register' },
] as const;
export type TipSoundId = typeof TIP_SOUNDS[number]['id'];
export type TipSoundPreference = { sound: TipSoundId, muted: boolean };
export const DEFAULT_TIP_SOUND: TipSoundPreference = { sound: 'sats-zap', muted: false };

const STORAGE_KEY = 'satstreamr_tip_sound';
const URLS: Record<TipSoundId, string> = {
  'sats-zap': zapUrl,
  'sats-coin': coinUrl,
  'sats-sparkle': sparkleUrl,
  'cash-register': registerUrl,
};
const clips = new Map<TipSoundId, HTMLAudioElement>();

function isTipSoundId(value: unknown): value is TipSoundId {
  return TIP_SOUNDS.some(entry => entry.id === value);
}

export function loadTipSound(): TipSoundPreference {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    if (typeof value === 'object' && value !== null) {
      const { sound, muted } = value as Record<string, unknown>;
      if (isTipSoundId(sound) && typeof muted === 'boolean') return { sound, muted };
    }
  } catch {
    return DEFAULT_TIP_SOUND;
  }
  return DEFAULT_TIP_SOUND;
}

export function saveTipSound(preference: TipSoundPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch (e) {
    console.warn('[tip-sound] failed to persist preference:', e);
  }
}

export function previewTipSound(id: TipSoundId): void {
  try {
    let clip = clips.get(id);
    if (!clip) {
      clip = new Audio(URLS[id]);
      clips.set(id, clip);
    }
    for (const [otherId, other] of clips) {
      if (otherId === id || typeof other.pause !== 'function') continue;
      try {
        other.pause();
      } catch {
        continue;
      }
    }
    clip.currentTime = 0;
    void clip.play()?.catch(() => {});
  } catch {
    return;
  }
}

export function playTipSound(): void {
  const { sound, muted } = loadTipSound();
  if (!muted) previewTipSound(sound);
}
