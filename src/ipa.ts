export interface Phoneme {
  p: string;
  start: number;
  end: number;
  stress?: 1 | 2;
}

export interface Word {
  word: string;
  start: number;
  end: number;
  ipa?: string;
  ipa_canonical?: string;
  phonemes?: Phoneme[];
  phonemes_canonical?: Phoneme[];
  f0_norm?: (number | null)[];
  f0_trace?: (number | null)[];
  stress?: boolean;
  peak?: boolean;
  is_filler?: boolean;
}

export interface Pause {
  after: number;
  gap_ms: number;
}

export interface FlatPhoneme {
  wordIdx: number;
  phIdx: number;
  start: number;
  end: number;
}

const SIMPLIFY: Record<string, string> = {
  'ɹ': 'r', 'ɾ': 'r', 'ɫ': 'l', 'ʔ': '',
  'ᵻ': 'ɪ', 'ᵿ': 'ʊ', 'ɨ': 'ɪ', 'ʉ': 'u',
  'ɚ': 'ər', 'ɝ': 'ɜːr', 'ɐ': 'ʌ',
};

export function simplifyIpa(s: string): string {
  return s ? [...s].map(c => SIMPLIFY[c] !== undefined ? SIMPLIFY[c] : c).join('') : s;
}

export function phonemeSpans(phs: Phoneme[], simple: boolean): string {
  return phs.map((ph, j) => {
    const mark = ph.stress === 1 ? 'ˈ' : ph.stress === 2 ? 'ˌ' : '';
    const cls = 'ph' + (ph.stress ? ' stress-' + ph.stress : '');
    const sym = simple ? simplifyIpa(ph.p) : ph.p;
    return `${mark ? `<span class="stress-mark">${mark}</span>` : ''}<span class="${cls}" data-j="${j}" data-start="${ph.start}" data-end="${ph.end}">${sym}</span>`;
  }).join('');
}

export function ipaInnerHtml(phs: Phoneme[], fallback: string, simple: boolean): string {
  if (phs && phs.length) return '/' + phonemeSpans(phs, simple) + '/';
  return `/${simple ? simplifyIpa(fallback || '') : (fallback || '')}/`;
}

export function buildFlatPhonemes(words: Word[]): { flatAudio: FlatPhoneme[]; flatCanon: FlatPhoneme[] } {
  const flatAudio: FlatPhoneme[] = [];
  const flatCanon: FlatPhoneme[] = [];
  words.forEach((w, wi) => {
    (w.phonemes || []).forEach((p, pi) => flatAudio.push({ wordIdx: wi, phIdx: pi, start: p.start, end: p.end }));
    (w.phonemes_canonical || []).forEach((p, pi) => flatCanon.push({ wordIdx: wi, phIdx: pi, start: p.start, end: p.end }));
  });
  return { flatAudio, flatCanon };
}
