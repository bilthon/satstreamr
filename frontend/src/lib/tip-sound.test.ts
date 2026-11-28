// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_TIP_SOUND, loadTipSound, playTipSound, previewTipSound, saveTipSound } from './tip-sound.js';

const played: string[] = [];
const clips: FakeAudio[] = [];
let playResult: () => Promise<void> = () => Promise.resolve();
class FakeAudio {
  currentTime = 0;
  paused = true;
  constructor(readonly src: string) { clips.push(this); }
  pause() { this.paused = true; }
  play() {
    this.paused = false;
    played.push(this.src);
    return playResult();
  }
}
vi.stubGlobal('Audio', FakeAudio);

afterEach(() => {
  localStorage.clear();
  played.length = 0;
  playResult = () => Promise.resolve();
});

it.each([
  'not json',
  'null',
  '"sats-zap"',
  '{"sound":"sats-coin"}',
  '{"muted":true}',
  '{"sound":"airhorn","muted":false}',
  '{"sound":"sats-coin","muted":"yes"}',
])('falls back to the default for stored %s', raw => {
  localStorage.setItem('satstreamr_tip_sound', raw);
  expect(loadTipSound()).toEqual(DEFAULT_TIP_SOUND);
});

it('defaults to an audible zap when nothing is stored', () => {
  expect(loadTipSound()).toEqual({ sound: 'sats-zap', muted: false });
});

it('round-trips a saved preference', () => {
  saveTipSound({ sound: 'cash-register', muted: true });
  expect(JSON.parse(localStorage.getItem('satstreamr_tip_sound')!)).toEqual({ sound: 'cash-register', muted: true });
  expect(loadTipSound()).toEqual({ sound: 'cash-register', muted: true });
});

it('plays the selected clip when unmuted', () => {
  saveTipSound({ sound: 'sats-sparkle', muted: false });
  playTipSound();
  expect(played).toHaveLength(1);
  expect(played[0]).toContain('sats-sparkle.mp3');
});

it('stays silent when muted', () => {
  saveTipSound({ sound: 'sats-sparkle', muted: true });
  playTipSound();
  expect(played).toEqual([]);
});

it('previews the requested clip even when muted', () => {
  saveTipSound({ sound: 'sats-zap', muted: true });
  previewTipSound('sats-coin');
  expect(played).toHaveLength(1);
  expect(played[0]).toContain('sats-coin.mp3');
});

it('stops the previous clip when another sound starts', () => {
  previewTipSound('sats-zap');
  previewTipSound('sats-coin');
  const zap = clips.find(item => item.src.includes('sats-zap.mp3'))!;
  expect(zap.paused).toBe(true);
  expect(played.at(-1)).toContain('sats-coin.mp3');
});

it('restarts a clip that is still playing', () => {
  previewTipSound('cash-register');
  const clip = clips.find(item => item.src.includes('cash-register.mp3'))!;
  clip.currentTime = 0.4;
  previewTipSound('cash-register');
  expect(clip.currentTime).toBe(0);
  expect(played.filter(src => src.includes('cash-register.mp3'))).toHaveLength(2);
});

it('never throws when playback is refused or unsupported', async () => {
  playResult = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  expect(() => playTipSound()).not.toThrow();
  playResult = () => { throw new Error('not implemented'); };
  expect(() => playTipSound()).not.toThrow();
  await Promise.resolve();
});
