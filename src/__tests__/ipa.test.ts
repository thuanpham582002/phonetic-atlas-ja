import { describe, it, expect } from 'vitest';
import { simplifyIpa, phonemeSpans, ipaInnerHtml, buildFlatPhonemes } from '../ipa';

describe('simplifyIpa', () => {
  it('returns empty/null inputs unchanged', () => {
    expect(simplifyIpa('')).toBe('');
    expect(simplifyIpa(null)).toBe(null);
  });

  it('maps approximant ɹ to r', () => {
    expect(simplifyIpa('ɹɛd')).toBe('rɛd');
  });

  it('maps flap ɾ to r and dark l ɫ to l', () => {
    expect(simplifyIpa('bʌɾɫ')).toBe('bʌrl');
  });

  it('drops glottal stop ʔ', () => {
    expect(simplifyIpa('ʔʌ')).toBe('ʌ');
  });

  it('maps barred i ᵻ to ɪ', () => {
    expect(simplifyIpa('rᵻzʌlt')).toBe('rɪzʌlt');
  });

  it('expands ɚ to ər', () => {
    expect(simplifyIpa('mɚ')).toBe('mər');
  });

  it('leaves unrelated chars alone', () => {
    expect(simplifyIpa('hɛloʊ')).toBe('hɛloʊ');
  });
});

describe('phonemeSpans', () => {
  it('emits one span per phoneme with data attrs', () => {
    const html = phonemeSpans([{ p: 'k', start: 0.1, end: 0.2 }, { p: 'æ', start: 0.2, end: 0.3 }], false);
    expect(html).toContain('data-j="0"');
    expect(html).toContain('data-j="1"');
    expect(html).toContain('data-start="0.1"');
    expect(html).toContain('data-end="0.3"');
    expect(html).toContain('>k<');
    expect(html).toContain('>æ<');
  });

  it('applies simplification when simple=true', () => {
    const html = phonemeSpans([{ p: 'ɹ', start: 0, end: 0.1 }], true);
    expect(html).toContain('>r<');
  });
});

describe('ipaInnerHtml', () => {
  it('uses phoneme spans when phs present', () => {
    const html = ipaInnerHtml([{ p: 'k', start: 0, end: 0.1 }], 'fallback', false);
    expect(html).toMatch(/^\/<span/);
    expect(html).toMatch(/<\/span>\/$/);
  });

  it('falls back to plain ipa string when phs empty', () => {
    expect(ipaInnerHtml([], 'kæt', false)).toBe('/kæt/');
  });

  it('simplifies fallback when simple=true', () => {
    expect(ipaInnerHtml([], 'ɹɛd', true)).toBe('/rɛd/');
  });

  it('handles missing fallback', () => {
    expect(ipaInnerHtml([], '', false)).toBe('//');
  });
});

describe('buildFlatPhonemes', () => {
  it('flattens audio + canonical phonemes with word indices', () => {
    const words = [
      { word: 'a', start: 0, end: 0.2, phonemes: [{ p: 'æ', start: 0, end: 0.2 }], phonemes_canonical: [{ p: 'æ', start: 0, end: 0.2 }] },
      { word: 'b', start: 0.3, end: 0.5, phonemes: [{ p: 'b', start: 0.3, end: 0.4 }, { p: 'i', start: 0.4, end: 0.5 }], phonemes_canonical: [{ p: 'b', start: 0.3, end: 0.5 }] },
    ];
    const { flatAudio, flatCanon } = buildFlatPhonemes(words);
    expect(flatAudio).toHaveLength(3);
    expect(flatCanon).toHaveLength(2);
    expect(flatAudio[1]).toEqual({ wordIdx: 1, phIdx: 0, start: 0.3, end: 0.4 });
    expect(flatAudio[2]).toEqual({ wordIdx: 1, phIdx: 1, start: 0.4, end: 0.5 });
    expect(flatCanon[1]).toEqual({ wordIdx: 1, phIdx: 0, start: 0.3, end: 0.5 });
  });

  it('handles words missing phoneme arrays', () => {
    const { flatAudio, flatCanon } = buildFlatPhonemes([{ word: 'x', start: 0, end: 0.1 }]);
    expect(flatAudio).toEqual([]);
    expect(flatCanon).toEqual([]);
  });
});
