import { ipaInnerHtml, buildFlatPhonemes } from './ipa';
import type { Word, Pause, FlatPhoneme } from './ipa';
import { findActive, findActiveWord, isSeekableTo, pauseGlyph } from './timing';
import { contourSvg } from './contour';

export interface ControlsEls {
  loopWordEl: HTMLInputElement;
  delayEl: HTMLInputElement;
  repeatsEl: HTMLInputElement;
  speedEl: HTMLInputElement;
  speedVal: HTMLElement;
  followEl: HTMLInputElement;
  showIpaEl: HTMLInputElement;
  simpleIpaEl: HTMLInputElement;
  showCanonEl: HTMLInputElement;
  showToneEl?: HTMLInputElement;
  showPauseEl?: HTMLInputElement;
}

export interface PlayerInit {
  audioEl: HTMLAudioElement;
  transcriptEl: HTMLElement;
  controlsEls: ControlsEls;
  playerWrapEl: HTMLElement;
  statusEl: HTMLElement;
  onSelect?: (idx: number) => void;
}

export interface FuriganaSpan { text: string; ruby: string | null }
export interface PitchAccent { accent: number | null; pattern: Array<'H' | 'L'> | null }

export interface Lexeme {
  key: string;
  lemma: string;
  surface_forms: string[];
  ipa_citation: string;
  ipa_citation_source?: string | null;
  ipa_citation_confidence?: string | null;
  ipa_citation_url?: string | null;
  ipa_citation_audio_ogg?: string | null;
  ipa_citation_audio_mp3?: string | null;
  ipa_citation_alternatives?: Array<{ entry_id?: string | null; pos?: string | null; ipa?: string | null; url?: string | null }>;
  pos: string | null;
  gloss: string | null;
  definition: string | null;
  definition_gloss: string | null;
  note: string | null;
  reading?: string | null;
  romaji?: string | null;
  mora?: string[] | null;
  furigana?: FuriganaSpan[] | null;
  pitch_accent?: PitchAccent | null;
  occurrences: number[];
}

export interface DictEntry {
  lang: string;
  lemma: string;
  pos: string | null;
  ipa_citation: string;
  ipa_citation_audio_ogg?: string | null;
  ipa_citation_audio_mp3?: string | null;
  ipa_said: string;
  delta: 'matches' | 'differs';
  gloss: string | null;
  definition: string | null;
  definition_gloss: string | null;
  note: string | null;
  reading?: string | null;
  romaji?: string | null;
  furigana?: FuriganaSpan[] | null;
  pitch_accent?: PitchAccent | null;
  enriched: boolean;
  selected: number;
  occurrences: { i: number; start: number; ipa: string; snippet: string }[];
}

export interface PlayerPayload {
  words_url: string;
  audio_url: string;
}

export interface PlayerApi {
  loadPlayer(payload: PlayerPayload): Promise<void>;
  jumpTo(idx: number, opts?: { play?: boolean; loop?: boolean }): void;
  getSelectedIdx(): number;
  getActiveIdx(): number;
  getWordsLength(): number;
  clearSelection(): void;
  getDictEntry(idx: number): DictEntry | null;
  getOccurrences(idx: number): number[];
}

export function initPlayer({ audioEl, transcriptEl, controlsEls, playerWrapEl, statusEl, onSelect }: PlayerInit): PlayerApi {
  const {
    loopWordEl, delayEl, repeatsEl, speedEl, speedVal,
    followEl, showIpaEl, simpleIpaEl, showCanonEl,
  } = controlsEls;

  let words: Word[] = [];
  let lexicon: Record<string, Lexeme> = {};
  let lang = 'en';
  let v2t: any[] = [];
  let pauses: Pause[] = [];
  let nodeOf: (HTMLElement | null)[] = [];
  let flatAudio: FlatPhoneme[] = [];
  let flatCanon: FlatPhoneme[] = [];
  let activeIdx = -1;
  let selectedIdx = -1;
  let activePhAudio: Element | null = null;
  let activePhCanon: Element | null = null;
  let loopRange: { start: number; end: number } | null = null;
  let loopsDone = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let internalSeek = false;

  function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }

  function setStatus(m: string) { statusEl.textContent = m || ''; }
  function updateStatus() {
    if (loopRange) {
      const max = parseInt(repeatsEl.value, 10) || 0;
      setStatus(max ? `loop ${loopsDone}/${max}` : `loop ${loopsDone}/∞`);
    } else setStatus('');
  }
  function clearLoop() {
    loopRange = null; loopsDone = 0;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    updateStatus();
  }

  function seekAndPlay(t: number, play = !audioEl.paused) {
    const doSeek = () => {
      internalSeek = true;
      audioEl.currentTime = t;
      if (play) audioEl.play().catch(() => {});
    };
    if (isSeekableTo(audioEl.seekable, t)) { doSeek(); return; }
    if (audioEl.paused && play) audioEl.play().catch(() => {});
    const onReady = () => {
      if (isSeekableTo(audioEl.seekable, t)) {
        audioEl.removeEventListener('progress', onReady);
        audioEl.removeEventListener('canplaythrough', onReady);
        doSeek();
      }
    };
    audioEl.addEventListener('progress', onReady);
    audioEl.addEventListener('canplaythrough', onReady);
  }

  function selectWord(idx: number) {
    if (idx < 0 || idx >= words.length) return;
    selectedIdx = idx;
    transcriptEl.querySelectorAll('.w.selected').forEach(el => el.classList.remove('selected'));
    const el = nodeOf[idx];
    if (el) { el.classList.add('selected'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    onSelect?.(idx);
  }

  function jumpTo(idx: number, { play = !audioEl.paused, loop = loopWordEl.checked }: { play?: boolean; loop?: boolean } = {}) {
    if (idx < 0 || idx >= words.length) return;
    selectWord(idx);
    const w = words[idx];
    loopRange = loop ? { start: w.start, end: w.end } : null;
    loopsDone = 0;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    seekAndPlay(w.start, play);
    updateStatus();
  }

  function renderIpa() {
    const simple = simpleIpaEl.checked;
    const showCanon = showCanonEl.checked;
    document.body.classList.toggle('hide-canon', !showCanon);
    document.body.classList.toggle('no-ipa', !showIpaEl.checked);
    transcriptEl.querySelectorAll('.w').forEach(span => {
      const i = parseInt((span as HTMLElement).dataset.i || '', 10);
      const w = words[i];
      const audioLineEl = span.querySelector('.ipa-audio');
      const canonEl = span.querySelector('.ipa-canon');
      if (audioLineEl) {
        audioLineEl.innerHTML = ipaInnerHtml(w.phonemes || [], w.ipa || '', simple);
      }
      if (canonEl) {
        canonEl.innerHTML = ipaInnerHtml(w.phonemes_canonical || [], w.ipa_canonical || '', simple);
      }
    });
    const flats = buildFlatPhonemes(words);
    flatAudio = flats.flatAudio;
    flatCanon = flats.flatCanon;
  }

  async function loadPlayer(payload: PlayerPayload) {
    const data = await fetch(payload.words_url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    if (data.schema_version !== 2 || !Array.isArray(data.transcript)) {
      playerWrapEl.classList.add('shown');
      transcriptEl.innerHTML =
        '<p class="stale-warning">This session was generated by an older ' +
        'version. Regenerate it with the sample preprocess CLI.</p>';
      statusEl.textContent = 'stale session — preprocess required';
      return;
    }
    lexicon = data.lexicon || {};
    lang = (data.session?.lang_src || 'en').toLowerCase();
    const isJa = lang === 'ja';
    // Japanese has no reliable audio-derived IPA — the CTC phoneme model is
    // English-trained and re-tokenizes ja by character. The citation layer
    // (espeak-ng, MFA-timed) is the trustworthy one, so for ja we surface it
    // as the primary inline IPA and drop the audio layer. Mirrors the dict
    // card, which hides the "said here" row for ja.
    document.body.classList.toggle('lang-ja', isJa);
    v2t = data.transcript || [];
    words = v2t.map((t: any) => ({
      word: t.raw,
      start: t.start,
      end: t.end,
      ipa: t.ipa,
      ipa_canonical: (t.lex && lexicon[t.lex]?.ipa_citation) || '',
      phonemes: t.phonemes,
      phonemes_canonical: t.phonemes_citation,
      f0_norm: t.f0_norm,
      stress: t.stress,
      peak: t.peak,
      is_filler: t.is_filler,
    }));
    pauses = data.pauses || [];
    audioEl.src = payload.audio_url;
    playerWrapEl.classList.add('shown');
    const pauseByIdx = new Map(pauses.map(p => [p.after, p.gap_ms]));
    transcriptEl.innerHTML = words.map((w, i) => {
      const audioLine = (!isJa && (w.ipa || w.phonemes?.length)) ? `<span class="ipa ipa-audio"></span>` : '';
      const canonLine = w.ipa_canonical ? `<span class="ipa ipa-canon"></span>` : '';
      const cls = ['w'];
      if (w.stress) cls.push('stress');
      if (w.peak) cls.push('peak');
      if (w.is_filler) cls.push('filler');
      const contour = contourSvg(w.f0_norm || w.f0_trace);
      const trailing = pauseByIdx.has(i) ? pauseGlyph(pauseByIdx.get(i) as number) : '';
      return `<span class="${cls.join(' ')}" data-i="${i}"><span class="word-line">${contour}<span class="word-text">${escapeHtml(w.word)}</span></span>${audioLine}${canonLine}</span>${trailing}`;
    }).join(' ');
    nodeOf = words.map((_, i) => transcriptEl.querySelector<HTMLElement>(`.w[data-i="${i}"]`));
    renderIpa();
    playerWrapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onTimeChange() {
    if (loopRange && !pendingTimer && audioEl.currentTime >= loopRange.end) {
      const max = parseInt(repeatsEl.value, 10) || 0;
      loopsDone++;
      updateStatus();
      if (max > 0 && loopsDone >= max) { clearLoop(); return; }
      audioEl.pause();
      const delay = Math.max(0, parseInt(delayEl.value, 10) || 0);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (!loopRange || document.hidden) return;
        internalSeek = true;
        audioEl.currentTime = loopRange.start;
        audioEl.play().catch(() => {});
      }, delay);
    }
    if (!followEl.checked) return;
    const t = audioEl.currentTime;
    const idx = findActiveWord(words, t);
    if (idx !== activeIdx) {
      if (activeIdx >= 0 && nodeOf[activeIdx]) nodeOf[activeIdx]!.classList.remove('active');
      if (idx >= 0 && nodeOf[idx]) nodeOf[idx]!.classList.add('active');
      activeIdx = idx;
    }
    if (idx >= 0 && nodeOf[idx]) {
      const w = words[idx];
      const dur = w.end - w.start;
      if (dur > 0) {
        const frac = Math.max(0, Math.min(1, (t - w.start) / dur));
        const x = frac * 100;
        const scrub = nodeOf[idx]!.querySelector('.contour line.scrub');
        if (scrub) { scrub.setAttribute('x1', String(x)); scrub.setAttribute('x2', String(x)); }
      }
    }
    const aHit = findActive(flatAudio, t);
    const cHit = findActive(flatCanon, t);
    const a = aHit && nodeOf[aHit.wordIdx]
      ? nodeOf[aHit.wordIdx]!.querySelector(`.ipa-audio .ph[data-j="${aHit.phIdx}"]`)
      : null;
    const c = cHit && nodeOf[cHit.wordIdx]
      ? nodeOf[cHit.wordIdx]!.querySelector(`.ipa-canon .ph[data-j="${cHit.phIdx}"]`)
      : null;
    if (a !== activePhAudio) {
      if (activePhAudio) activePhAudio.classList.remove('active');
      if (a) a.classList.add('active');
      activePhAudio = a;
    }
    if (c !== activePhCanon) {
      if (activePhCanon) activePhCanon.classList.remove('active');
      if (c) c.classList.add('active');
      activePhCanon = c;
    }
  }

  simpleIpaEl.addEventListener('change', renderIpa);
  showCanonEl.addEventListener('change', renderIpa);
  showIpaEl.addEventListener('change', renderIpa);

  transcriptEl.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const ph = target.closest('.ph') as HTMLElement | null;
    if (ph) {
      e.stopPropagation();
      const span = ph.closest('.w') as HTMLElement | null;
      const idx = parseInt(span?.dataset.i || '', 10);
      if (!isNaN(idx)) selectWord(idx);
      const start = parseFloat(ph.dataset.start || '');
      const end = parseFloat(ph.dataset.end || '');
      seekAndPlay(start);
      if (loopWordEl.checked) { loopRange = { start, end }; loopsDone = 0; updateStatus(); }
      return;
    }
    const span = target.closest('.w') as HTMLElement | null;
    if (span) jumpTo(parseInt(span.dataset.i || '', 10));
  }, true);

  audioEl.addEventListener('seeking', () => {
    if (internalSeek) { internalSeek = false; return; }
    if (loopRange) clearLoop();
  });

  function tick() {
    requestAnimationFrame(tick);
    if (audioEl.paused || audioEl.ended) return;
    onTimeChange();
  }
  requestAnimationFrame(tick);
  audioEl.addEventListener('seeked', onTimeChange);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      audioEl.pause();
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }
  });

  speedEl.addEventListener('input', () => {
    audioEl.playbackRate = parseFloat(speedEl.value);
    speedVal.textContent = audioEl.playbackRate.toFixed(2) + '×';
  });
  speedEl.dispatchEvent(new Event('input'));

  loopWordEl.addEventListener('change', () => {
    if (loopWordEl.checked && selectedIdx >= 0) {
      const w = words[selectedIdx];
      loopRange = { start: w.start, end: w.end };
      loopsDone = 0;
      updateStatus();
    } else clearLoop();
  });

  return {
    loadPlayer,
    jumpTo,
    getSelectedIdx: () => selectedIdx,
    getActiveIdx: () => activeIdx,
    getWordsLength: () => words.length,
    clearSelection: () => {
      transcriptEl.querySelectorAll('.w.selected').forEach(el => el.classList.remove('selected'));
      selectedIdx = -1;
      clearLoop();
      onSelect?.(-1);
    },
    getOccurrences: (idx: number) => {
      const t = v2t[idx];
      const ent = t && t.lex ? lexicon[t.lex] : null;
      return ent ? ent.occurrences : [];
    },
    getDictEntry: (idx: number): DictEntry | null => {
      const t = v2t[idx];
      if (!t || !t.lex) return null;
      const ent = lexicon[t.lex];
      if (!ent) return null;
      const ctx = (j: number) => {
        const a = Math.max(0, j - 4), b = Math.min(v2t.length - 1, j + 4);
        return v2t.slice(a, b + 1).map((x: any, k: number) =>
          a + k === j ? `‹${x.raw}›` : x.raw).join(' ');
      };
      return {
        lang,
        lemma: ent.lemma || ent.key,
        pos: ent.pos,
        ipa_citation: ent.ipa_citation,
        ipa_citation_audio_ogg: ent.ipa_citation_audio_ogg,
        ipa_citation_audio_mp3: ent.ipa_citation_audio_mp3,
        ipa_said: t.ipa || '',
        delta: (t.ipa || '') === ent.ipa_citation ? 'matches' : 'differs',
        gloss: ent.gloss,
        definition: ent.definition,
        definition_gloss: ent.definition_gloss,
        note: ent.note,
        reading: ent.reading,
        romaji: ent.romaji,
        furigana: ent.furigana,
        pitch_accent: ent.pitch_accent,
        enriched: !!(ent.gloss || ent.definition || ent.pos || ent.note),
        selected: idx,
        occurrences: ent.occurrences.map((oi: number) => ({
          i: oi,
          start: v2t[oi].start,
          ipa: v2t[oi].ipa || '',
          snippet: ctx(oi),
        })),
      };
    },
  };
}
