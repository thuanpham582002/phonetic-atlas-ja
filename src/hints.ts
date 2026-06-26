const ALPHABET = 'asdfghjklqwertyuiopzxcvbnm';

export interface HintsApi {
  activate(): void;
  deactivate(): void;
  isActive(): boolean;
}

export interface HintsOpts {
  transcriptEl: HTMLElement;
  onSelect: (idx: number) => void;
  onStatus?: (msg: string) => void;
}

function genLabels(n: number): string[] {
  if (n <= ALPHABET.length) return [...ALPHABET.slice(0, n)];
  const out: string[] = [];
  for (let i = 0; i < ALPHABET.length && out.length < n; i++) {
    for (let j = 0; j < ALPHABET.length && out.length < n; j++) {
      out.push(ALPHABET[i] + ALPHABET[j]);
    }
  }
  return out;
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

export function initHints({ transcriptEl, onSelect, onStatus }: HintsOpts): HintsApi {
  let active = false;
  let buffer = '';
  let labelMap = new Map<string, number>();
  let labelEls: HTMLElement[] = [];

  function deactivate() {
    if (!active) return;
    active = false;
    buffer = '';
    labelMap.clear();
    labelEls.forEach(el => el.remove());
    labelEls = [];
    document.body.classList.remove('hints-active');
    onStatus?.('');
  }

  function activate() {
    if (active) { deactivate(); return; }
    const wordEls = Array.from(transcriptEl.querySelectorAll<HTMLElement>('.w'))
      .filter(isVisible);
    if (!wordEls.length) return;
    const labels = genLabels(wordEls.length);
    active = true;
    buffer = '';
    labelMap.clear();
    labelEls = [];
    document.body.classList.add('hints-active');
    wordEls.forEach((el, i) => {
      const label = labels[i];
      const idx = parseInt(el.dataset.i || '', 10);
      if (isNaN(idx)) return;
      labelMap.set(label, idx);
      const tag = document.createElement('span');
      tag.className = 'hint-tag';
      tag.dataset.label = label;
      tag.textContent = label;
      el.appendChild(tag);
      labelEls.push(tag);
    });
    onStatus?.('hint mode — type label, esc to cancel');
  }

  function updateMatches() {
    labelEls.forEach(el => {
      const lbl = el.dataset.label || '';
      if (!buffer) {
        el.classList.remove('hint-partial', 'hint-dim');
        el.textContent = lbl;
      } else if (lbl.startsWith(buffer)) {
        el.classList.add('hint-partial');
        el.classList.remove('hint-dim');
        el.innerHTML = `<b>${lbl.slice(0, buffer.length)}</b>${lbl.slice(buffer.length)}`;
      } else {
        el.classList.add('hint-dim');
        el.classList.remove('hint-partial');
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); deactivate(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); buffer = buffer.slice(0, -1); updateMatches(); return; }
    if (e.key.length !== 1 || !/[a-z]/i.test(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    buffer += e.key.toLowerCase();
    if (labelMap.has(buffer)) {
      const idx = labelMap.get(buffer)!;
      deactivate();
      onSelect(idx);
      return;
    }
    const stillMatches = [...labelMap.keys()].some(k => k.startsWith(buffer));
    if (!stillMatches) { deactivate(); return; }
    updateMatches();
  }, true);

  return { activate, deactivate, isActive: () => active };
}
