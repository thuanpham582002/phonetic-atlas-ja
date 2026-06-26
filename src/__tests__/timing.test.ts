import { describe, it, expect } from 'vitest';
import { findActive, findActiveWord, isSeekableTo, pauseGlyph } from '../timing';

const flat = [
  { wordIdx: 0, phIdx: 0, start: 0.0, end: 0.1 },
  { wordIdx: 0, phIdx: 1, start: 0.1, end: 0.2 },
  { wordIdx: 1, phIdx: 0, start: 0.5, end: 0.6 },
  { wordIdx: 1, phIdx: 1, start: 0.6, end: 0.8 },
];

describe('findActive', () => {
  it('returns null for empty array', () => {
    expect(findActive([], 0.5)).toBe(null);
  });

  it('returns null when t is before first phoneme', () => {
    expect(findActive(flat, -0.1)).toBe(null);
  });

  it('finds phoneme at exact start', () => {
    expect(findActive(flat, 0.1)).toEqual({ wordIdx: 0, phIdx: 1 });
  });

  it('finds phoneme inside its range', () => {
    expect(findActive(flat, 0.15)).toEqual({ wordIdx: 0, phIdx: 1 });
  });

  it('extends a phoneme until the next one starts (gap belongs to previous)', () => {
    expect(findActive(flat, 0.35)).toEqual({ wordIdx: 0, phIdx: 1 });
  });

  it('returns null past last phoneme end+0.1 with no successor', () => {
    expect(findActive([{ wordIdx: 0, phIdx: 0, start: 0, end: 0.1 }], 0.25)).toBe(null);
  });

  it('finds last phoneme within end+0.1 tolerance', () => {
    expect(findActive(flat, 0.85)).toEqual({ wordIdx: 1, phIdx: 1 });
  });

  it('returns null past last phoneme tolerance', () => {
    expect(findActive(flat, 1.0)).toBe(null);
  });
});

describe('findActiveWord', () => {
  const words = [
    { word: 'a', start: 0.0, end: 0.3 },
    { word: 'b', start: 0.5, end: 0.8 },
    { word: 'c', start: 1.0, end: 1.4 },
  ];

  it('returns -1 when empty', () => {
    expect(findActiveWord([], 0.5)).toBe(-1);
  });

  it('finds word containing t', () => {
    expect(findActiveWord(words, 0.6)).toBe(1);
  });

  it('matches at exact boundary', () => {
    expect(findActiveWord(words, 0.0)).toBe(0);
    expect(findActiveWord(words, 1.4)).toBe(2);
  });

  it('returns -1 in inter-word gap', () => {
    expect(findActiveWord(words, 0.4)).toBe(-1);
  });

  it('returns -1 past last word', () => {
    expect(findActiveWord(words, 2.0)).toBe(-1);
  });
});

function fakeSeekable(ranges) {
  return {
    length: ranges.length,
    start: i => ranges[i][0],
    end: i => ranges[i][1],
  };
}

describe('isSeekableTo', () => {
  it('returns false for empty seekable', () => {
    expect(isSeekableTo(fakeSeekable([]), 5)).toBe(false);
  });

  it('returns true inside a range', () => {
    expect(isSeekableTo(fakeSeekable([[0, 30]]), 15)).toBe(true);
  });

  it('returns false outside all ranges', () => {
    expect(isSeekableTo(fakeSeekable([[0, 5]]), 28)).toBe(false);
  });

  it('allows 0.5s grace past end', () => {
    expect(isSeekableTo(fakeSeekable([[0, 10]]), 10.4)).toBe(true);
    expect(isSeekableTo(fakeSeekable([[0, 10]]), 10.6)).toBe(false);
  });

  it('matches across multiple ranges', () => {
    expect(isSeekableTo(fakeSeekable([[0, 5], [10, 20]]), 15)).toBe(true);
    expect(isSeekableTo(fakeSeekable([[0, 5], [10, 20]]), 7)).toBe(false);
  });
});

describe('pauseGlyph', () => {
  it('returns empty string below 120ms', () => {
    expect(pauseGlyph(0)).toBe('');
    expect(pauseGlyph(119)).toBe('');
  });

  it('returns short pause at 120-349ms', () => {
    expect(pauseGlyph(120)).toBe('<span class="pause">·</span>');
    expect(pauseGlyph(349)).toBe('<span class="pause">·</span>');
  });

  it('returns long pause at 350-699ms', () => {
    expect(pauseGlyph(350)).toBe('<span class="pause long">·</span>');
    expect(pauseGlyph(699)).toBe('<span class="pause long">·</span>');
  });

  it('returns break at 700ms+', () => {
    expect(pauseGlyph(700)).toBe('<span class="pause brk"></span>');
    expect(pauseGlyph(2000)).toBe('<span class="pause brk"></span>');
  });
});
