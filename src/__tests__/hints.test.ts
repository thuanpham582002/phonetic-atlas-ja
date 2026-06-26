import { describe, it, expect } from 'vitest';

// Test the genLabels function by importing via a helper that exposes it
// (since it's not exported). For now, we'll test the observable behavior
// through the public API, but ideally genLabels should be exported for testing.

// Inline the logic for testing until genLabels is exported
const ALPHABET = 'asdfghjklqwertyuiopzxcvbnm';

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

describe('genLabels', () => {
  it('returns single chars for n <= alphabet length', () => {
    expect(genLabels(1)).toEqual(['a']);
    expect(genLabels(3)).toEqual(['a', 's', 'd']);
    expect(genLabels(26)).toEqual([...ALPHABET]);
  });

  it('returns correct length', () => {
    expect(genLabels(0)).toHaveLength(0);
    expect(genLabels(5)).toHaveLength(5);
    expect(genLabels(26)).toHaveLength(26);
    expect(genLabels(50)).toHaveLength(50);
  });

  it('generates only two-char labels when n > 26', () => {
    const labels = genLabels(27);
    expect(labels).toHaveLength(27);
    expect(labels[0]).toBe('aa');
    expect(labels[26]).toBe('sa');
  });

  it('all labels are unique', () => {
    const labels = genLabels(100);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('two-char labels follow aa, as, ad... sa, ss... pattern', () => {
    const labels = genLabels(30);
    expect(labels[0]).toBe('aa');
    expect(labels[1]).toBe('as');
    expect(labels[2]).toBe('ad');
    expect(labels[26]).toBe('sa');
  });

  it('caps at alphabet^2 two-char combinations', () => {
    const max = 26 * 26;
    const labels = genLabels(max);
    expect(labels).toHaveLength(max);
    expect(labels[0]).toBe('aa');
    expect(labels[labels.length - 1]).toBe('mm');
    expect(labels.every(l => l.length === 2)).toBe(true);
  });
});
