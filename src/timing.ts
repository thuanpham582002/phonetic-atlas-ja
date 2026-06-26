import type { FlatPhoneme, Word } from './ipa';

export function findActive(flat: FlatPhoneme[], t: number): { wordIdx: number; phIdx: number } | null {
  if (!flat.length) return null;
  let lo = 0, hi = flat.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid].start <= t) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (found < 0) return null;
  const next = flat[found + 1];
  const validUntil = next ? next.start : flat[found].end + 0.1;
  if (t > validUntil) return null;
  return { wordIdx: flat[found].wordIdx, phIdx: flat[found].phIdx };
}

export function findActiveWord(words: Word[], t: number): number {
  if (!words.length) return -1;
  let lo = 0, hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid];
    if (t >= w.start && t <= w.end) return mid;
    if (t < w.start) hi = mid - 1;
    else lo = mid + 1;
  }
  return -1;
}

export function isSeekableTo(seekable: TimeRanges, t: number): boolean {
  for (let i = 0; i < seekable.length; i++) {
    if (t >= seekable.start(i) && t <= seekable.end(i) + 0.5) return true;
  }
  return false;
}

export function pauseGlyph(gapMs: number): string {
  if (gapMs >= 700) return '<span class="pause brk"></span>';
  if (gapMs >= 350) return '<span class="pause long">·</span>';
  if (gapMs >= 120) return '<span class="pause">·</span>';
  return '';
}
