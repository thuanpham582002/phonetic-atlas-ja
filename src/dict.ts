import type { DictEntry } from './player';

export interface DictInit {
  getEntry: (idx: number) => DictEntry | null;
  jumpTo: (idx: number) => void;
  getPlaybackRate: () => number;
}

export interface DictApi {
  setSelection: (idx: number) => void;
  step: (dir: 1 | -1) => void;
  playCitation: () => void;
  close: () => void;
  isOpen: () => boolean;
}

export function initDict({ getEntry, jumpTo, getPlaybackRate }: DictInit): DictApi {
  const card = document.getElementById('dict-card');
  const $ = (id: string) => document.getElementById(id);
  if (!card) return { setSelection: () => {}, step: () => {}, playCitation: () => {}, close: () => {}, isOpen: () => false };

  let current: DictEntry | null = null;
  const citationAudio = new Audio();

  function row(id: string, val: string | null) {
    const el = $(id);
    if (!el) return;
    if (val) { el.textContent = val; el.hidden = false; }
    else { el.hidden = true; }
  }

  function renderJa(e: DictEntry) {
    const block = $('dc-ja');
    if (!block) return;
    if (e.lang !== 'ja') { block.hidden = true; return; }
    block.hidden = false;
    const ruby = $('dc-furigana')!;
    const spans = e.furigana && e.furigana.length
      ? e.furigana
      : [{ text: e.lemma, ruby: e.reading || null }];
    ruby.innerHTML = spans.map(s => s.ruby
      ? `${escapeHtml(s.text)}<rt>${escapeHtml(s.ruby)}</rt>`
      : `${escapeHtml(s.text)}<rt></rt>`).join('');
    row('dc-romaji', e.romaji || null);
    const pitch = $('dc-pitch')!;
    const pa = e.pitch_accent;
    if (pa && pa.pattern && pa.pattern.length) {
      pitch.innerHTML = pa.pattern.map(p =>
        `<span class="dc-pitch-mora dc-pitch-${p}">${p}</span>`).join('');
      pitch.parentElement!.hidden = false;
    } else {
      pitch.innerHTML = '';
      pitch.parentElement!.hidden = true;
    }
  }

  function escapeHtml(s: string) {
    return s.replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  }

  function stopCitation() {
    citationAudio.pause();
    citationAudio.removeAttribute('src');
    citationAudio.load();
  }

  function hide() {
    stopCitation();
    current = null;
    card!.hidden = true;
    card!.classList.remove('shown');
  }

  function setSelection(idx: number) {
    if (idx < 0) return hide();
    const e = getEntry(idx);
    if (!e) return hide();
    current = e;

    $('dc-lemma')!.textContent = e.lemma;
    row('dc-pos', e.pos);
    renderJa(e);
    $('dc-cite')!.textContent = e.ipa_citation || '—';
    const citeAudio = $('dc-cite-audio') as HTMLButtonElement | null;
    if (citeAudio) citeAudio.hidden = !(e.ipa_citation_audio_mp3 || e.ipa_citation_audio_ogg);
    // The audio-derived 'said here' IPA comes from an English-trained CTC model
    // and is unreliable for Japanese, so hide that row for JA samples.
    const saidRow = $('dc-said-row');
    if (saidRow) saidRow.hidden = e.lang === 'ja';
    $('dc-said')!.textContent = e.ipa_said || '—';
    const delta = $('dc-delta')!;
    delta.textContent = e.delta;
    delta.className = 'dc-delta ' + e.delta;
    row('dc-gloss', e.gloss);
    row('dc-def', e.definition);
    row('dc-defgloss', e.definition_gloss);
    const note = $('dc-note')!;
    if (e.note) { note.textContent = '⚑ ' + e.note; note.hidden = false; }
    else note.hidden = true;
    $('dc-unenriched')!.hidden = e.enriched;

    $('dc-occ-count')!.textContent =
      `said ${e.occurrences.length}× in this sample`;
    const list = $('dc-occ-list')!;
    list.innerHTML = e.occurrences.map(o => {
      const cur = o.i === e.selected;
      return `<li role="listitem"><button type="button" class="dc-occ${
        cur ? ' dc-occ-current' : ''}" data-i="${o.i}"${
        cur ? ' aria-current="true"' : ''}>` +
        `<span class="dc-occ-t">${o.start.toFixed(2)}s</span>` +
        `<span class="dc-occ-ipa">${o.ipa || '—'}</span>` +
        `<span class="dc-occ-cx">${o.snippet}</span></button></li>`;
    }).join('');

    card!.hidden = false;
    requestAnimationFrame(() => card!.classList.add('shown'));
  }

  function step(dir: 1 | -1) {
    if (!current) return;
    const occ = current.occurrences;
    const at = occ.findIndex(o => o.i === current!.selected);
    if (at < 0 || occ.length < 2) return;
    const next = occ[(at + dir + occ.length) % occ.length];
    jumpTo(next.i);
  }

  function playCitation() {
    const audioUrl = current?.ipa_citation_audio_mp3 || current?.ipa_citation_audio_ogg;
    if (!audioUrl) return;
    citationAudio.pause();
    citationAudio.src = audioUrl;
    citationAudio.currentTime = 0;
    citationAudio.playbackRate = getPlaybackRate();
    citationAudio.play().catch(() => {});
  }

  $('dc-occ-list')?.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest('button[data-i]');
    if (btn) jumpTo(parseInt(btn.getAttribute('data-i') || '', 10));
  });

  $('dc-cite-audio')?.addEventListener('click', playCitation);
  $('dc-close')?.addEventListener('click', hide);

  return { setSelection, step, playCitation, close: hide, isOpen: () => !card!.hidden };
}
