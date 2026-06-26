import { describe, expect, it } from 'vitest';
import { detectScript, isJapanese } from '../lang';

describe('isJapanese', () => {
  it.each([
    ['寿司', true],   // kanji
    ['たべる', true], // hiragana
    ['コーヒー', true], // katakana
    ['PMは', true],   // mixed latin + kana
    ['hello', false],
    ['12345', false],
    ['', false],
  ])('isJapanese(%j) === %s', (text, expected) => {
    expect(isJapanese(text)).toBe(expected);
  });
});

describe('detectScript', () => {
  it('classifies kana/kanji as ja', () => {
    expect(detectScript('東京')).toBe('ja');
    expect(detectScript('プロジェクト')).toBe('ja');
  });
  it('classifies plain ascii words as latin', () => {
    expect(detectScript('project')).toBe('latin');
  });
  it('classifies digits/punctuation as other', () => {
    expect(detectScript('123!?')).toBe('other');
  });
});
