// ?view=overlay → teleprompter overlay, skip the main app.
// See docs/teleprompter-overlay-plan.md.
const __params = new URLSearchParams(location.search);
const __view = __params.get('view');
const __focus = (__params.get('focus') || '').trim().toLowerCase();
const __sample = (__params.get('sample') || '').trim();
if (__view === 'overlay') {
  import('./overlay').then(m => m.initOverlay());
}

import './styles.css';
import { initPlayer } from './player';
import { initCamera } from './camera';
import { initDict } from './dict';
import type { DictApi } from './dict';
import { initRecorder } from './recorder';
import { initHints } from './hints';

if (__view !== 'overlay') {
initMainApp();
}

function initMainApp() {
const $ = (s: string): any => document.querySelector(s);
const $$ = (s: string): any[] => Array.from(document.querySelectorAll(s));

const today = new Date();
$('#today').textContent = today.getFullYear() + '·' + String(today.getMonth() + 1).padStart(2, '0') + '·' + String(today.getDate()).padStart(2, '0');

let selectedSample: string | null = null;
let currentSetup: { title: string; meta?: string } | null = null;

function setSamplesStatus(msg: string, isErr = false) {
  const el = $('#samples-hint');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

fetch('/api/samples').then(r => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}).then(samples => {
  const root = $('#samples');
  if (!samples.length) {
    root.innerHTML = '<div class="empty">No samples — drop folders into <code>samples/</code> with <code>audio.mp3</code>, <code>transcript.txt</code>.</div>';
    return;
  }
  root.innerHTML = samples.map((s: any) => {
    const dur = s.duration ? `· ${Math.round(s.duration)}s` : '';
    return `
    <div class="sample" data-id="${s.id}">
      <span class="marker"></span>
      <button class="preview-btn" data-preview="${s.id}" data-audio="${s.audio_url || ''}" type="button" aria-label="Preview audio" title="Preview">▶</button>
      <span class="sample-text">
        <span class="sample-title">${s.title}</span>
        <span class="sample-desc">${s.description || ''}</span>
      </span>
      <span class="sample-meta">${s.level || ''} ${dur}</span>
    </div>`;
  }).join('');

  if (__focus) {
    const hits = samples.filter((s: any) => `${s.title} ${s.description} ${s.transcript}`.toLowerCase().includes(__focus));
    $$('.sample').forEach(card => card.classList.toggle('focus-hit', hits.some((s: any) => s.id === card.dataset.id)));
    if (hits.length) {
      setSamplesStatus(`found ${hits.length} sample(s) mentioning “${__focus}”`);
      root.querySelector('.focus-hit')?.scrollIntoView({ block: 'center' });
    } else {
      setSamplesStatus(`no sample mentions “${__focus}”`, true);
    }
  }

  const previewAudio = new Audio();
  let previewingBtn: any = null;
  function stopPreview() {
    previewAudio.pause();
    if (previewingBtn) {
      previewingBtn.classList.remove('playing');
      previewingBtn.textContent = '▶';
      previewingBtn = null;
    }
  }
  previewAudio.addEventListener('ended', stopPreview);

  // Load a sample by id: select its card, fetch its session, enter drill mode.
  // Shared by card clicks and the ?sample=<id> deep-link.
  async function loadSample(id: string) {
    const sample = samples.find((s: any) => s.id === id);
    if (!sample) {
      setSamplesStatus(`no sample “${id}”`, true);
      return;
    }
    const card = $$('.sample').find((c: any) => c.dataset.id === id) || null;
    stopPreview();
    selectedSample = id;
    $$('.sample').forEach((c: any) => c.classList.toggle('selected', c === card));
    const dur = sample.duration ? Math.round(sample.duration) + 's' : '';
    const metaBits = [sample.level, dur, sample.description].filter(Boolean);
    currentSetup = { title: sample.title, meta: metaBits.join(' · ') };
    card?.scrollIntoView({ block: 'center' });
    setSamplesStatus('loading…');
    try {
      const r = await fetch(`/api/sample-session/${encodeURIComponent(sample.id)}`);
      if (!r.ok) throw new Error(r.status === 404 ? 'sample has not been preprocessed' : 'HTTP ' + r.status);
      await player.loadPlayer(await r.json());
      setSamplesStatus('loaded');
      enterDrillMode();
    } catch (err) {
      setSamplesStatus((err as Error).message, true);
    }
  }

  root.addEventListener('click', async (e: Event) => {
    const target = e.target as HTMLElement;
    const previewBtn = target.closest('.preview-btn') as HTMLElement | null;
    if (previewBtn) {
      e.stopPropagation();
      const url = previewBtn.dataset.audio;
      if (!url) return;
      if (previewingBtn === previewBtn) { stopPreview(); return; }
      stopPreview();
      previewAudio.src = url;
      previewAudio.currentTime = 0;
      previewAudio.play().catch(() => {});
      previewBtn.classList.add('playing');
      previewBtn.textContent = '■';
      previewingBtn = previewBtn;
      return;
    }
    const card = target.closest('.sample') as HTMLElement | null;
    if (!card) return;
    await loadSample(card.dataset.id || '');
  });

  // ?sample=<id> → auto-load that sample straight into the player on boot.
  if (__sample) loadSample(__sample);
});

const audioEl = $('#audio') as HTMLAudioElement;
const transcriptEl = $('#transcript') as HTMLElement;
const loopWordEl = $('#loopWord') as HTMLInputElement;
const delayEl = $('#delay') as HTMLInputElement;
const repeatsEl = $('#repeats') as HTMLInputElement;
const speedEl = $('#speed') as HTMLInputElement;
const speedVal = $('#speedVal') as HTMLElement;
const followEl = $('#follow') as HTMLInputElement;
const showIpaEl = $('#showIpa') as HTMLInputElement;
const simpleIpaEl = $('#simpleIpa') as HTMLInputElement;
const showCanonEl = $('#showCanon') as HTMLInputElement;
const showToneEl = $('#showTone') as HTMLInputElement;
const showPauseEl = $('#showPause') as HTMLInputElement;
const statusEl = $('#status') as HTMLElement;
const playerWrapEl = $('#player-wrap') as HTMLElement;

const SETTINGS_KEY = 'phonetic_atlas_settings_v1';
const persisted = ['loopWord', 'delay', 'repeats', 'speed', 'follow', 'showIpa', 'simpleIpa', 'showCanon', 'showTone', 'showPause'];

function saveSettings() {
  const s: Record<string, string | boolean> = {};
  for (const id of persisted) {
    const el = document.getElementById(id) as HTMLInputElement;
    s[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const id of persisted) {
      if (s[id] === undefined) continue;
      const el = document.getElementById(id) as HTMLInputElement;
      if (el.type === 'checkbox') el.checked = s[id];
      else el.value = s[id];
    }
  } catch {}
}
loadSettings();
persisted.forEach(id => document.getElementById(id)!.addEventListener('change', saveSettings));

function syncChips() {
  const map: Record<string, HTMLInputElement> = {
    'chip-loop': loopWordEl,
    'chip-follow': followEl,
    'chip-ipa': showIpaEl,
    'chip-simple': simpleIpaEl,
    'chip-canon': showCanonEl,
    'chip-tone': showToneEl,
    'chip-pause': showPauseEl,
  };
  for (const [chipId, input] of Object.entries(map)) {
    $('#' + chipId).classList.toggle('on', input.checked);
  }
  document.body.classList.toggle('no-tone', !showToneEl.checked);
  document.body.classList.toggle('no-pause', !showPauseEl.checked);
}
syncChips();
['loopWord', 'follow', 'showIpa', 'simpleIpa', 'showCanon', 'showTone', 'showPause'].forEach(id =>
  document.getElementById(id)!.addEventListener('change', syncChips));

let dict: DictApi;
const player = initPlayer({
  audioEl,
  transcriptEl,
  playerWrapEl,
  statusEl,
  controlsEls: {
    loopWordEl, delayEl, repeatsEl, speedEl, speedVal,
    followEl, showIpaEl, simpleIpaEl, showCanonEl,
    showToneEl, showPauseEl,
  },
  onSelect: () => {},
});
dict = initDict({
  getEntry: (i) => player.getDictEntry(i),
  jumpTo: (i) => player.jumpTo(i),
  getPlaybackRate: () => audioEl.playbackRate,
});

initCamera();

const recorder = initRecorder({
  onStateChange: (s) => {
    document.body.classList.toggle('is-recording', s === 'recording');
    document.body.classList.toggle('has-recording', s === 'has-recording');
    const chip = document.getElementById('chip-rec');
    if (chip) chip.textContent = s === 'recording' ? '● rec' : s === 'has-recording' ? '✓ rec' : 'rec';
  },
  onError: (m) => setSamplesStatus(m, true),
});
document.getElementById('chip-rec')?.addEventListener('click', () => {
  if (recorder.isRecording() || !recorder.hasRecording()) recorder.toggle();
  else recorder.play();
});
const hints = initHints({
  transcriptEl,
  onSelect: (i) => player.jumpTo(i),
  onStatus: (m) => { if (m) statusEl.textContent = m; },
});

function enterDrillMode() {
  if (currentSetup) {
    $('#setup-title').textContent = currentSetup.title;
    $('#setup-meta').textContent = currentSetup.meta || '';
  }
  document.body.classList.add('drilling');
}
function exitDrillMode() {
  document.body.classList.remove('drilling');
  const a = $('#audio'); if (a) a.pause();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#change-btn').addEventListener('click', exitDrillMode);

speedEl.addEventListener('input', saveSettings);

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).matches('input, textarea, select')) return;
  if (e.target === audioEl || document.activeElement === audioEl) return;
  const selectedIdx = player.getSelectedIdx();
  const activeIdx = player.getActiveIdx();
  const wordsLen = player.getWordsLength();
  switch (e.key) {
    case ' ': e.preventDefault(); audioEl.paused ? audioEl.play() : audioEl.pause(); break;
    case 'l': case 'L': loopWordEl.checked = !loopWordEl.checked; loopWordEl.dispatchEvent(new Event('change')); syncChips(); saveSettings(); break;
    case 'r': case 'R': if (selectedIdx >= 0) player.jumpTo(selectedIdx); break;
    case 'ArrowRight': e.preventDefault(); if (e.shiftKey) { dict.step(1); } else { player.jumpTo(Math.min((selectedIdx < 0 ? activeIdx : selectedIdx) + 1, wordsLen - 1)); } break;
    case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) { dict.step(-1); } else { player.jumpTo(Math.max((selectedIdx < 0 ? activeIdx : selectedIdx) - 1, 0)); } break;
    case 'ArrowUp': e.preventDefault(); speedEl.value = Math.min(1.5, parseFloat(speedEl.value) + 0.05).toFixed(2); speedEl.dispatchEvent(new Event('input')); break;
    case 'ArrowDown': e.preventDefault(); speedEl.value = Math.max(0.5, parseFloat(speedEl.value) - 0.05).toFixed(2); speedEl.dispatchEvent(new Event('input')); break;
    case '[': delayEl.value = String(Math.max(0, (parseInt(delayEl.value, 10) || 0) - 100)); saveSettings(); break;
    case ']': delayEl.value = String(Math.min(5000, (parseInt(delayEl.value, 10) || 0) + 100)); saveSettings(); break;
    case ',': repeatsEl.value = String(Math.max(0, (parseInt(repeatsEl.value, 10) || 0) - 1)); saveSettings(); break;
    case '.': repeatsEl.value = String(Math.min(50, (parseInt(repeatsEl.value, 10) || 0) + 1)); saveSettings(); break;
    case 'Escape': if (dict.isOpen()) dict.close(); else player.clearSelection(); break;
    case 'm': case 'M': e.preventDefault(); recorder.toggle(); break;
    case 'p': case 'P': e.preventDefault(); recorder.play(); break;
    case 'f': case 'F': e.preventDefault(); hints.activate(); break;
    case 'c': case 'C': e.preventDefault(); dict.playCitation(); break;
    case 'd': case 'D': e.preventDefault(); if (dict.isOpen()) { dict.close(); } else { const i = selectedIdx >= 0 ? selectedIdx : activeIdx; if (i >= 0) dict.setSelection(i); } break;
  }
});
} // end initMainApp
