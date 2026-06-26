// Teleprompter overlay — see docs/teleprompter-overlay-plan.md.
// Self-contained: owns its own <audio>, fetches words.json directly, and
// renders a 3-line prev/curr/next strip with word-synced highlight, IPA,
// loop modes (all/sentence/A-B), and word/sentence navigation.

import './overlay.css';

interface TWord {
  i: number;
  raw: string;
  lex: string | null;
  sent: number;
  start: number;
  end: number;
  ipa: string;
  stress?: boolean;
  peak?: boolean;
  is_filler?: boolean;
  f0_norm?: (number | null)[];
}
interface TSentence {
  i: number;
  span: [number, number]; // inclusive on both ends
  text: string;
}
interface Lexeme {
  key?: string;
  lemma?: string;
  pos?: string | null;
  ipa_citation: string;
  gloss?: string | null;
  definition?: string | null;
  definition_gloss?: string | null;
  note?: string | null;
  ipa_citation_audio_ogg?: string | null;
  ipa_citation_audio_mp3?: string | null;
  occurrences: number[];
}
interface DictAudioOption {
  source?: string;
  lang?: string | null;
  url: string;
}
interface TPause { after: number; gap_ms: number; }
interface WordsDoc {
  transcript: TWord[];
  sentences: TSentence[];
  lexicon: Record<string, Lexeme>;
  pauses?: TPause[];
}
interface SampleEntry { id: string; title: string; level?: string; duration?: number; }
interface SessionInfo { session_id: string; words_url: string; audio_url: string; }

type LoopMode = 'all' | 'sentence' | 'ab';

const LAST_SAMPLE_KEY = 'phonetic-atlas:overlay:lastSample';

export function initOverlay() {
  document.body.classList.add('overlay-mode');
  document.body.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="top">
        <div class="left-col">
          <select class="picker" id="picker" title="Sample"></select>
          <button class="play-btn" id="playBtn" title="Play / Pause (Space)">▶</button>
        </div>
        <div class="title" id="title" hidden></div>
        <div class="ctrls">
          <button id="ipaToggle" class="on">IPA</button>
          <button id="prosodyToggle" class="on" title="Prosody — bold = stress, ↗/↘ = pitch (p)">♪</button>
          <button id="speedBtn" title="Playback speed ([/])">1×</button>
          <button id="loopAll" class="on">Loop ∞</button>
          <button id="loopSent">Loop sent</button>
          <button id="loopAb">A-B</button>
        </div>
      </div>
      <div class="lines">
        <div class="line prev" id="linePrev"></div>
        <div class="line curr" id="lineCurr"></div>
        <div class="line next" id="lineNext"></div>
      </div>
      <div class="progress">
        <i id="bar"></i>
        <span class="ab-mark ab-a" id="abMarkA" style="display:none"></span>
        <span class="ab-mark ab-b" id="abMarkB" style="display:none"></span>
      </div>
      <audio id="audio" preload="auto" style="display:none"></audio>
      <div class="search-bar" id="searchBar" hidden>
        <input class="search-input" id="searchInput" placeholder="Search samples…" spellcheck="false" autocomplete="off" />
        <div class="search-results" id="searchResults"></div>
        <button class="search-close" id="searchClose" title="Close (Esc)">✕</button>
      </div>
      <div class="dict-bar" id="dictBar" hidden>
        <button class="dict-close" id="dictClose" title="Close (Esc)">✕</button>
        <span class="dict-lemma" id="dictLemma">—</span>
        <button class="dict-audio" id="dictAudio" type="button" title="Play dictionary pronunciation (A)" hidden>🔊</button>
        <span class="dict-pos" id="dictPos" hidden></span>
        <span class="dict-ipa">
          <span class="dict-lbl">cite</span>
          <span class="dict-cite" id="dictCite">—</span>
          <span class="dict-arrow">→</span>
          <span class="dict-lbl">said</span>
          <span class="dict-said" id="dictSaid">—</span>
          <span class="dict-delta" id="dictDelta"></span>
        </span>
        <span class="dict-sense" id="dictSense"></span>
        <span class="dict-occ" id="dictOcc"></span>
      </div>
      <button type="button" class="collapse-toggle" id="collapseToggle" title="Collapse overlay" aria-label="Collapse overlay">‹</button>
      <div class="empty" id="empty">Loading samples…</div>
      <div class="resize n"  data-resize="North"></div>
      <div class="resize s"  data-resize="South"></div>
      <div class="resize e"  data-resize="East"></div>
      <div class="resize w"  data-resize="West"></div>
      <div class="resize nw" data-resize="NorthWest"></div>
      <div class="resize ne" data-resize="NorthEast"></div>
      <div class="resize sw" data-resize="SouthWest"></div>
      <div class="resize se" data-resize="SouthEast" title="Drag to resize"></div>
    </div>
  `;

  const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;
  const picker     = $<HTMLSelectElement>('#picker');
  const title      = $('#title');
  const linePrev   = $('#linePrev');
  const lineCurr   = $('#lineCurr');
  const lineNext   = $('#lineNext');
  const bar        = $('#bar');
  const playBtn    = $<HTMLButtonElement>('#playBtn');
  const ipaToggle  = $<HTMLButtonElement>('#ipaToggle');
  const loopAll    = $<HTMLButtonElement>('#loopAll');
  const loopSent   = $<HTMLButtonElement>('#loopSent');
  const loopAb     = $<HTMLButtonElement>('#loopAb');
  const speedBtn      = $<HTMLButtonElement>('#speedBtn');
  const prosodyToggle = $<HTMLButtonElement>('#prosodyToggle');
  const searchBar    = $<HTMLElement>('#searchBar');
  const searchInput  = $<HTMLInputElement>('#searchInput');
  const searchResults = $<HTMLElement>('#searchResults');
  const overlay    = $('#overlay');
  const audio      = $<HTMLAudioElement>('#audio');
  const empty      = $('#empty');
  const abMarkA    = $('#abMarkA');
  const abMarkB    = $('#abMarkB');
  const dictBar    = $<HTMLElement>('#dictBar');
  const dictLemma  = $('#dictLemma');
  const dictAudio  = $<HTMLButtonElement>('#dictAudio');
  const dictPos    = $('#dictPos');
  const dictCite   = $('#dictCite');
  const dictSaid   = $('#dictSaid');
  const dictDelta  = $('#dictDelta');
  const dictSense  = $('#dictSense');
  const dictOcc    = $('#dictOcc');
  const collapseToggle = $<HTMLButtonElement>('#collapseToggle');

  // ── state ────────────────────────────────────────────────────────────
  let words: TWord[] = [];
  let sentences: TSentence[] = [];
  let lexicon: Record<string, Lexeme> = {};
  let pauses: Map<number, number> = new Map(); // word index → trailing gap ms
  let totalDur = 0;
  let activeWi = -1;          // current word index (-1 = none)
  let mode: LoopMode = 'all';
  let abA: number | null = null; // word index
  let abB: number | null = null;
  let abPick: 'A' | 'B' = 'A';
  let showIpa = true;
  let showProsody = true;
  let dictWi: number | null = null; // currently displayed word in dict view
  let dictAudioOptions: DictAudioOption[] = [];
  const dictPronAudio = new Audio();
  let loopSentSi: number | null = null; // sentence currently being looped in 'sentence' mode
  let collapsed = false;

  // ── data load ────────────────────────────────────────────────────────
  async function loadSamples() {
    const all: SampleEntry[] = await fetch('/api/samples')
      .then((r): Promise<SampleEntry[]> => r.json())
      .catch((): SampleEntry[] => []);
    if (!all.length) {
      empty.textContent = 'No samples — add folders under samples/.';
      return;
    }
    // Show only samples that have a preprocessed words.json. Preprocessing is
    // a CLI step (the server has no on-demand process endpoint), so unprocessed
    // entries would just 404 the moment they're picked.
    const probes = await Promise.all(
      all.map(s =>
        fetch(`/api/sample-session/${s.id}`)
          .then(async r => r.ok ? { ok: true, stale: !!(await r.json()).stale } : { ok: false, stale: false })
          .catch(() => ({ ok: false, stale: false }))
      )
    );
    const list = all
      .map((s, i) => ({ ...s, stale: probes[i].stale, ok: probes[i].ok }))
      .filter(s => s.ok);
    if (!list.length) {
      empty.innerHTML =
        'No preprocessed samples. Run from the repo root:<br>' +
        '<code>.venv/bin/python scripts/process_samples.py &lt;sample-name&gt;</code>';
      return;
    }
    picker.innerHTML = list.map(s => {
      const lvl = s.level ? ' · ' + s.level : '';
      const stale = s.stale ? ' · stale' : '';
      return `<option value="${s.id}">${s.title}${lvl}${stale}</option>`;
    }).join('');
    const remembered = localStorage.getItem(LAST_SAMPLE_KEY);
    const pick = remembered && list.find(s => s.id === remembered) ? remembered : list[0].id;
    picker.value = pick;
    await loadSample(pick);
  }

  async function loadSample(sampleId: string) {
    empty.textContent = 'Loading…';
    empty.style.display = '';
    try {
      const ses: SessionInfo = await fetch(`/api/sample-session/${sampleId}`).then(r => {
        if (!r.ok) throw new Error(`session ${r.status}`);
        return r.json();
      });
      const doc: WordsDoc = await fetch(ses.words_url).then(r => {
        if (!r.ok) throw new Error(`words ${r.status}`);
        return r.json();
      });
      words     = doc.transcript || [];
      sentences = doc.sentences  || [];
      lexicon   = doc.lexicon    || {};
      pauses    = new Map((doc.pauses || []).map(p => [p.after, p.gap_ms]));
      audio.src = ses.audio_url;
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 1 && audio.duration) return resolve();
        audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
      });
      applySpeed();
      totalDur = audio.duration || (words[words.length - 1]?.end ?? 0);
      abA = abB = null; abPick = 'A';
      activeWi = -1;
      localStorage.setItem(LAST_SAMPLE_KEY, sampleId);
      empty.style.display = 'none';
      render();
    } catch (err) {
      empty.innerHTML =
        `Failed to load: ${(err as Error).message}. Preprocess from the repo root:<br>` +
        `<code>.venv/bin/python scripts/process_samples.py ${sampleId}</code>`;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────
  function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, c => (
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
    ));
  }
  function ipaFor(w: TWord): string {
    const cite = w.lex ? lexicon[w.lex]?.ipa_citation : '';
    return cite || w.ipa || '';
  }
  function findActiveWi(t: number): number {
    // exact match
    for (let i = 0; i < words.length; i++) {
      if (t >= words[i].start && t < words[i].end) return i;
    }
    // between words → snap to nearest preceding
    let last = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].end <= t) last = i;
      else break;
    }
    return last;
  }
  function sentenceOfWord(wi: number): number {
    if (wi < 0) return 0;
    return words[wi]?.sent ?? 0;
  }
  function sentenceStartTime(si: number): number {
    const s = sentences[si];
    return s ? words[s.span[0]]?.start ?? 0 : 0;
  }
  function sentenceEndTime(si: number): number {
    const s = sentences[si];
    return s ? words[s.span[1]]?.end ?? totalDur : totalDur;
  }

  // ── render ───────────────────────────────────────────────────────────
  // Render the WHOLE transcript into one container so the teleprompter
  // scroll is continuous across sentence boundaries. Only the active-state
  // classes change per tick; the transform on .line.curr animates smoothly.
  // Derive a coarse pitch direction from the normalized F0 contour: compare
  // average of the first third vs the last third. Returns '↗' / '↘' / ''.
  function pitchArrow(f0: (number | null)[] | undefined): string {
    if (!f0 || f0.length < 3) return '';
    const vals = f0.filter((x): x is number => x != null && !isNaN(x));
    if (vals.length < 3) return '';
    const k = Math.max(1, Math.floor(vals.length / 3));
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const d = avg(vals.slice(-k)) - avg(vals.slice(0, k));
    if (d >  0.18) return '↗';
    if (d < -0.18) return '↘';
    return '';
  }

  function tipFor(w: TWord): string {
    const lex = w.lex ? lexicon[w.lex] : null;
    const parts: string[] = [];
    if (lex?.ipa_citation) parts.push(`/${lex.ipa_citation}/`);
    if (w.ipa && w.ipa !== lex?.ipa_citation) parts.push(`said: /${w.ipa}/`);
    if (lex?.pos) parts.push(lex.pos);
    const sense = lex?.gloss || lex?.definition_gloss || lex?.definition;
    if (sense) parts.push(sense);
    return parts.join(' · ');
  }
  // Visual breath/pause after a word. Scales width with gap_ms; uses ‖ for
  // long pauses (>600ms), · for medium ones. Skipped for <200ms (natural).
  function pauseSpan(wi: number): string {
    const ms = pauses.get(wi);
    if (!ms || ms < 200) return '';
    const w = Math.min(44, Math.max(8, Math.round(ms / 28)));
    const glyph = ms > 600 ? '‖' : '·';
    return `<span class="pause" style="min-width:${w}px" data-ms="${ms}">${glyph}</span>`;
  }

  function renderAll(el: HTMLElement, active: number) {
    el.innerHTML = words.map((w) => {
      let cls =
        (w.i === active)     ? 'w active' :
        (w.i === active - 1) ? 'w justspoken' :
        (w.i  <  active)     ? 'w spoken' :
                               'w';
      if (w.stress)    cls += ' stress';
      if (w.peak)      cls += ' peak';
      if (w.is_filler) cls += ' filler';
      const abCls =
        (abA === w.i) ? ' ab-a' :
        (abB === w.i) ? ' ab-b' : '';
      const ipa = `<span class="ipa">${escapeHtml(ipaFor(w))}</span>`;
      const arr = pitchArrow(w.f0_norm);
      const pitch = arr ? `<span class="pitch">${arr}</span>` : '';
      const tip = tipFor(w);
      const titleAttr = tip ? ` title="${escapeHtml(tip).replace(/"/g, '&quot;')}"` : '';
      return `<span class="${cls}${abCls}" data-wi="${w.i}"${titleAttr}>` +
             `<span class="txt">${escapeHtml(w.raw)}${pitch}</span>${ipa}</span>` +
             pauseSpan(w.i);
    }).join(' ');
  }

  // Pin the active word to the horizontal center of the .lines viewport via
  // a CSS variable. Transition lives in CSS, so word→word changes animate.
  const lines = lineCurr.parentElement as HTMLElement;
  function centerActive() {
    const active = lineCurr.querySelector('.w.active') as HTMLElement | null;
    if (!active) return; // keep previous offset between active spans
    const viewport = lines.clientWidth;
    const target = active.offsetLeft + active.offsetWidth / 2;
    lineCurr.style.setProperty('--scroll', `${(viewport / 2 - target).toFixed(1)}px`);
  }

  // ── sample search (Cmd+K) ────────────────────────────────────────────
  let searchHits: HTMLOptionElement[] = [];
  let searchIdx = 0;
  function renderSearchResults() {
    searchResults.innerHTML = searchHits.slice(0, 12).map((o, i) =>
      `<button type="button" class="search-pill${i === searchIdx ? ' on' : ''}" data-id="${o.value}">${escapeHtml(o.text)}</button>`
    ).join('');
  }
  function doSearch(q: string) {
    const all = Array.from(picker.options) as HTMLOptionElement[];
    const needle = q.trim().toLowerCase();
    searchHits = needle ? all.filter(o => o.text.toLowerCase().includes(needle)) : all.slice();
    searchIdx = 0;
    renderSearchResults();
  }
  function stepSearch(dir: 1 | -1) {
    if (!searchHits.length) return;
    searchIdx = (searchIdx + dir + searchHits.length) % searchHits.length;
    renderSearchResults();
  }
  function openSearch() {
    if (dictWi != null) closeDict();
    overlay.classList.add('search-open');
    searchBar.hidden = false;
    searchInput.value = '';
    doSearch('');
    requestAnimationFrame(() => searchInput.focus());
  }
  function closeSearch() {
    overlay.classList.remove('search-open');
    searchBar.hidden = true;
    searchInput.blur();
  }
  function applySearchPick(id?: string) {
    const target = id ?? searchHits[searchIdx]?.value;
    if (!target) return;
    picker.value = target;
    loadSample(target);
    closeSearch();
  }

  // ── dict view (replaces bar content) ─────────────────────────────────
  function ctxSnippet(j: number): string {
    const a = Math.max(0, j - 4), b = Math.min(words.length - 1, j + 4);
    return words.slice(a, b + 1).map((w, k) =>
      a + k === j ? `‹${w.raw}›` : w.raw).join(' ');
  }
  function dictAudioFallback(lex: Lexeme | null): DictAudioOption[] {
    const url = lex?.ipa_citation_audio_mp3 || lex?.ipa_citation_audio_ogg || '';
    return url ? [{ url, source: 'oxford', lang: 'enUS' }] : [];
  }

  function setDictAudioState(state: 'loading' | 'ready' | 'empty' | 'playing') {
    dictAudio.hidden = state === 'empty';
    dictAudio.disabled = state === 'loading' || state === 'empty';
    dictAudio.textContent = state === 'loading' ? '…' : state === 'playing' ? '■' : '🔊';
    dictAudio.classList.toggle('on', state === 'playing');
  }

  function loadDictAudio(lex: Lexeme | null) {
    dictAudioOptions = dictAudioFallback(lex);
    setDictAudioState(dictAudioOptions.length ? 'ready' : 'empty');
  }

  function playDictAudio() {
    if (!dictAudioOptions.length) return;
    const opt = dictAudioOptions[0];
    dictPronAudio.pause();
    dictPronAudio.src = opt.url;
    dictPronAudio.currentTime = 0;
    dictPronAudio.playbackRate = audio.playbackRate;
    setDictAudioState('playing');
    dictPronAudio.play().catch(() => setDictAudioState(dictAudioOptions.length ? 'ready' : 'empty'));
  }

  function renderDict() {
    if (dictWi == null) return;
    const w = words[dictWi];
    const lex = w?.lex ? lexicon[w.lex] : null;
    if (!lex) { closeDict(); return; }
    dictLemma.textContent = lex.lemma || lex.key || w.raw;
    if (lex.pos) { dictPos.textContent = lex.pos; dictPos.hidden = false; }
    else dictPos.hidden = true;
    dictCite.textContent = lex.ipa_citation || '—';
    dictSaid.textContent = w.ipa || '—';
    const same = (w.ipa || '') === lex.ipa_citation;
    dictDelta.textContent = same ? '≈' : '≠';
    dictDelta.className = 'dict-delta ' + (same ? 'matches' : 'differs');
    const sense = lex.gloss || lex.definition_gloss || lex.definition || lex.note || '';
    dictSense.textContent = sense;
    dictOcc.innerHTML = lex.occurrences.map((oi) => {
      const cur = oi === dictWi;
      return `<button type="button" class="dict-occ-pill${cur ? ' on' : ''}" data-wi="${oi}" title="${ctxSnippet(oi).replace(/"/g, '&quot;')}">${words[oi].start.toFixed(1)}s</button>`;
    }).join('');
    loadDictAudio(lex);
  }
  function openDict(wi: number) {
    if (wi < 0 || wi >= words.length) return;
    if (!words[wi]?.lex || !lexicon[words[wi].lex!]) return; // no entry
    dictWi = wi;
    dictBar.hidden = false;
    overlay.classList.add('dict-open');
    renderDict();
  }
  function closeDict() {
    dictWi = null;
    dictAudioOptions = [];
    dictPronAudio.pause();
    dictBar.hidden = true;
    overlay.classList.remove('dict-open');
  }
  function stepOcc(dir: 1 | -1) {
    if (dictWi == null) return;
    const lex = lexicon[words[dictWi].lex || ''];
    if (!lex || lex.occurrences.length < 2) return;
    const at = lex.occurrences.indexOf(dictWi);
    if (at < 0) return;
    const next = lex.occurrences[(at + dir + lex.occurrences.length) % lex.occurrences.length];
    dictWi = next;
    seekToWord(next);
    renderDict();
  }

  function render() {
    if (!words.length) return;
    const si = sentenceOfWord(activeWi);
    renderAll(lineCurr, activeWi);
    centerActive();
    title.textContent = `${picker.options[picker.selectedIndex]?.text || ''}` +
      ` · sentence ${Math.min(si + 1, sentences.length)} / ${sentences.length}`;
    const t = audio.currentTime;
    bar.style.width = (totalDur ? Math.max(0, Math.min(100, 100 * t / totalDur)) : 0).toFixed(2) + '%';
    // A-B marks on progress bar
    abMarkA.style.display = abA != null ? '' : 'none';
    abMarkB.style.display = abB != null ? '' : 'none';
    if (abA != null) abMarkA.style.left = (100 * (words[abA].start / Math.max(0.001, totalDur))).toFixed(2) + '%';
    if (abB != null) abMarkB.style.left = (100 * (words[abB].end   / Math.max(0.001, totalDur))).toFixed(2) + '%';
  }

  async function setCollapsed(next: boolean) {
    collapsed = next;
    overlay.classList.toggle('collapsed', collapsed);
    collapseToggle.textContent = collapsed ? '›' : '‹';
    collapseToggle.title = collapsed ? 'Expand overlay' : 'Collapse overlay';
    collapseToggle.setAttribute('aria-label', collapseToggle.title);
    if (!isTauri) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_collapsed', { collapsed });
      requestAnimationFrame(centerActive);
    } catch (err) {
      console.warn('set_collapsed failed', err);
    }
  }

  // ── loop logic ───────────────────────────────────────────────────────
  function applyLoopGuard() {
    if (!words.length) return;
    const t = audio.currentTime;
    if (mode === 'all') {
      audio.loop = true;
      return;
    }
    audio.loop = false;
    if (mode === 'sentence') {
      // Anchored sentence index — loops only around this sentence. Manual
      // seek (shortcut / click) re-anchors it via seekToWord so the user can
      // cross sentence boundaries instead of being yanked back.
      const si = loopSentSi ?? sentenceOfWord(activeWi >= 0 ? activeWi : findActiveWi(t));
      const sEnd = sentenceEndTime(si);
      const sStart = sentenceStartTime(si);
      if (t >= sEnd - 0.005 || t < sStart - 0.05) {
        seek(sStart);
        if (!audio.paused) audio.play().catch(() => {});
      }
    } else if (mode === 'ab') {
      if (abA != null && abB != null) {
        const aT = words[abA].start;
        const bT = words[abB].end;
        if (t >= bT - 0.005 || t < aT - 0.05) {
          seek(aT);
          if (!audio.paused) audio.play().catch(() => {});
        }
      }
    }
  }

  // ── seek + navigation ────────────────────────────────────────────────
  function seek(t: number) {
    audio.currentTime = Math.max(0, Math.min(totalDur - 0.001, t));
  }
  function seekToWord(wi: number) {
    if (wi < 0 || wi >= words.length) return;
    seek(words[wi].start + 0.001);
    // Manual nav re-anchors the sentence loop so crossing boundaries works.
    if (mode === 'sentence') loopSentSi = sentenceOfWord(wi);
  }
  function stepWord(delta: number) {
    if (!words.length) return;
    const cur = activeWi >= 0 ? activeWi : findActiveWi(audio.currentTime);
    const next = Math.max(0, Math.min(words.length - 1, cur + delta));
    seekToWord(next);
  }
  function stepSentence(delta: number) {
    if (!sentences.length) return;
    const cur = sentenceOfWord(activeWi >= 0 ? activeWi : findActiveWi(audio.currentTime));
    const next = Math.max(0, Math.min(sentences.length - 1, cur + delta));
    const s = sentences[next];
    if (s) seekToWord(s.span[0]);
  }

  // ── audio loop / animation tick ──────────────────────────────────────
  let lastRenderedWi = -1;
  function tick() {
    requestAnimationFrame(tick);
    if (!words.length) return;
    applyLoopGuard();
    const t = audio.currentTime;
    const wi = findActiveWi(t);
    if (wi !== lastRenderedWi) {
      activeWi = wi;
      lastRenderedWi = wi;
      render();
    } else {
      const w = wi >= 0 ? words[wi] : null;
      bar.style.width = (totalDur ? Math.max(0, Math.min(100, 100 * t / totalDur)) : 0).toFixed(2) + '%';
      void w;
    }
  }
  requestAnimationFrame(tick);

  // ── event wiring ─────────────────────────────────────────────────────
  picker.addEventListener('change', () => { loadSample(picker.value); });

  playBtn.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  audio.addEventListener('play',  () => { playBtn.textContent = '⏸'; });
  audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
  dictPronAudio.addEventListener('ended', () => setDictAudioState(dictAudioOptions.length ? 'ready' : 'empty'));
  dictPronAudio.addEventListener('pause', () => {
    if (!dictPronAudio.ended) setDictAudioState(dictAudioOptions.length ? 'ready' : 'empty');
  });
  audio.addEventListener('ended', () => {
    if (mode === 'all') { audio.currentTime = 0; audio.play().catch(() => {}); }
    else { playBtn.textContent = '▶'; }
  });

  function setMode(next: LoopMode) {
    mode = next;
    loopAll.classList.toggle('on', mode === 'all');
    loopSent.classList.toggle('on', mode === 'sentence');
    loopAb.classList.toggle('on', mode === 'ab');
    audio.loop = (mode === 'all');
    loopSentSi = (mode === 'sentence')
      ? sentenceOfWord(activeWi >= 0 ? activeWi : findActiveWi(audio.currentTime))
      : null;
  }
  loopAll.addEventListener('click',  () => setMode('all'));
  loopSent.addEventListener('click', () => setMode('sentence'));
  loopAb.addEventListener('click',   () => {
    setMode('ab');
    abA = abB = null; abPick = 'A';
    render();
  });

  ipaToggle.addEventListener('click', () => {
    showIpa = !showIpa;
    ipaToggle.classList.toggle('on', showIpa);
    overlay.classList.toggle('no-ipa', !showIpa);
  });
  prosodyToggle.addEventListener('click', () => {
    showProsody = !showProsody;
    prosodyToggle.classList.toggle('on', showProsody);
    overlay.classList.toggle('no-prosody', !showProsody);
  });
  collapseToggle.addEventListener('click', () => {
    setCollapsed(!collapsed);
  });

  // Tauri bridge: detect we're inside the Tauri shell to wire window dragging.
  const isTauri = typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function';

  // Drag + resize via @tauri-apps/api. Use a single window-level mousedown
  // listener (capture phase) so the handlers stay attached no matter what
  // happens to inner DOM — earlier per-element listeners stopped firing after
  // some interactions on macOS.
  if (isTauri) {
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      window.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;

        const resizeEl = t.closest('.resize') as HTMLElement | null;
        if (resizeEl) {
          e.preventDefault();
          const dir = resizeEl.dataset.resize;
          if (dir) {
            win.startResizeDragging(dir as any).catch((err) =>
              console.warn('startResizeDragging failed', err));
          }
          return;
        }

        const topBar = t.closest('.overlay .top') as HTMLElement | null;
        if (topBar && !t.closest('button, select, input, .nav, .ctrls')) {
          win.startDragging().catch((err) =>
            console.warn('startDragging failed', err));
        }
      }, true);
    }).catch((err) => console.warn('@tauri-apps/api/window import failed', err));
  }

  // Word / sentence click → seek + A-B pick.
  function onLineClick(line: HTMLElement, which: 'prev' | 'curr' | 'next') {
    line.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const wEl = target.closest('.w') as HTMLElement | null;
      const baseSi = sentenceOfWord(activeWi >= 0 ? activeWi : findActiveWi(audio.currentTime));
      const lineSi = which === 'prev' ? baseSi - 1 : which === 'next' ? baseSi + 1 : baseSi;
      if (wEl) {
        const wi = parseInt(wEl.dataset.wi || '', 10);
        if (isNaN(wi)) return;
        if (mode === 'ab') {
          if (abPick === 'A') { abA = wi; abB = null; abPick = 'B'; }
          else                 { abB = wi >= (abA ?? 0) ? wi : (abA ?? wi); abPick = 'A'; if (abA != null && wi < abA) { abA = wi; abB = (abA ?? wi); } }
          seekToWord(abA ?? wi);
          render();
        } else {
          seekToWord(wi);
        }
        return;
      }
      const s = sentences[lineSi];
      if (s) seekToWord(s.span[0]);
    });
  }
  onLineClick(linePrev, 'prev');
  onLineClick(lineCurr, 'curr');
  onLineClick(lineNext, 'next');

  // Nav buttons

  // Playback speed — cycle / step through preset rates.
  const SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5];
  let speedIdx = SPEED_PRESETS.indexOf(1.0);
  function applySpeed() {
    const r = SPEED_PRESETS[speedIdx];
    audio.playbackRate = r;
    dictPronAudio.playbackRate = r;
    speedBtn.textContent = (Number.isInteger(r) ? r.toFixed(0) : r.toString()) + '×';
    speedBtn.classList.toggle('on', r !== 1.0);
  }
  function stepSpeed(dir: 1 | -1) {
    speedIdx = Math.max(0, Math.min(SPEED_PRESETS.length - 1, speedIdx + dir));
    applySpeed();
  }
  speedBtn.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEED_PRESETS.length;
    applySpeed();
  });

  function cycleLoopMode() {
    const next: LoopMode = mode === 'all' ? 'sentence' : mode === 'sentence' ? 'ab' : 'all';
    if (next === 'ab') { abA = abB = null; abPick = 'A'; }
    setMode(next);
    render();
  }

  // Sample-search event wiring.
  searchInput.addEventListener('input', () => doSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')       { e.preventDefault(); closeSearch(); }
    else if (e.key === 'Enter')   { e.preventDefault(); applySearchPick(); }
    else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); stepSearch(+1); }
    else if (e.key === 'ArrowUp'   || (e.key === 'Tab' &&  e.shiftKey)) { e.preventDefault(); stepSearch(-1); }
  });
  searchResults.addEventListener('click', (e) => {
    const pill = (e.target as HTMLElement).closest('.search-pill') as HTMLElement | null;
    if (pill) applySearchPick(pill.dataset.id);
  });
  $<HTMLButtonElement>('#searchClose').addEventListener('click', closeSearch);

  // Keyboard
  window.addEventListener('keydown', (e) => {
    if (e.key === 'o' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setCollapsed(!collapsed);
      return;
    }
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (overlay.classList.contains('search-open')) closeSearch();
      else openSearch();
      return;
    }
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    if      (e.key === ' ')                              { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'ArrowLeft'  && e.metaKey)        { e.preventDefault(); seekToWord(0); }
    else if (e.key === 'ArrowRight' && e.metaKey)        { e.preventDefault(); seekToWord(words.length - 1); }
    else if (e.key === 'ArrowLeft'  && e.shiftKey)       { e.preventDefault(); stepSentence(-1); }
    else if (e.key === 'ArrowRight' && e.shiftKey)       { e.preventDefault(); stepSentence(+1); }
    else if (e.key === 'ArrowLeft')                      { e.preventDefault(); stepWord(-1); }
    else if (e.key === 'ArrowRight')                     { e.preventDefault(); stepWord(+1); }
    else if (e.key === 'i' || e.key === 'I')             { e.preventDefault(); ipaToggle.click(); }
    else if (e.key === 'p' || e.key === 'P')             { e.preventDefault(); prosodyToggle.click(); }
    else if (e.key === 'l' || e.key === 'L')             { e.preventDefault(); cycleLoopMode(); }
    else if (e.key === '[')                              { e.preventDefault(); stepSpeed(-1); }
    else if (e.key === ']')                              { e.preventDefault(); stepSpeed(+1); }
    else if ((e.key === 'a' || e.key === 'A') && dictWi != null) {
      e.preventDefault(); playDictAudio();
    }
    else if (e.key === 'd' || e.key === 'D')             {
      e.preventDefault();
      if (dictWi != null) closeDict();
      else openDict(activeWi >= 0 ? activeWi : findActiveWi(audio.currentTime));
    }
    else if (e.key === 'Escape')                         { e.preventDefault(); closeDict(); }
    else if ((e.key === 'j' || e.key === 'k') && dictWi != null) {
      e.preventDefault(); stepOcc(e.key === 'j' ? +1 : -1);
    }
  });

  dictBar.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'dictClose' || target.closest('#dictClose')) { closeDict(); return; }
    if (target.id === 'dictAudio' || target.closest('#dictAudio')) { playDictAudio(); return; }
    const pill = target.closest('.dict-occ-pill') as HTMLElement | null;
    if (pill) {
      const wi = parseInt(pill.dataset.wi || '', 10);
      if (!isNaN(wi)) { dictWi = wi; seekToWord(wi); renderDict(); }
    }
  });

  loadSamples();
}
