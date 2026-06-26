// Unicode-range script detection for selected text. Used to route a
// selection to the Japanese lookup path (furigana/pitch) vs. the English
// IPA path without relying on a per-sample lang flag.

const HIRAGANA = /[\u3040-\u309f]/;
const KATAKANA = /[\u30a0-\u30ff\u31f0-\u31ff]/;
// CJK unified ideographs (kanji), incl. common extension-A block.
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const JAPANESE = new RegExp(
  `${HIRAGANA.source}|${KATAKANA.source}|${KANJI.source}`,
);

/** True if the text contains any hiragana, katakana, or kanji. */
export function isJapanese(text: string): boolean {
  return JAPANESE.test(text);
}

export type Script = 'ja' | 'latin' | 'other';

/** Coarse script of a selection: 'ja' if it has any kana/kanji. */
export function detectScript(text: string): Script {
  if (isJapanese(text)) return 'ja';
  if (/[A-Za-z]/.test(text)) return 'latin';
  return 'other';
}
