import { describe, expect, it } from 'vitest';
import { matchKey, xLength, xText } from '../../../apps/api/src/publishing/x/text.js';

describe('X text formatting and matching', () => {
  it('xText trims and normalizes to NFC', () => {
    const raw = '  Game 7 \u0043\u0327  '; // C + combining cedilla
    const formatted = xText({ text: raw });
    expect(formatted).toBe('Game 7 \u00C7'); // precomposed Ç
  });

  it('xLength counts links as 23 characters', () => {
    const textWithLink = 'Check out https://xlchess.org/game/123 now!';
    // 'Check out ' (10) + 23 + ' now!' (5) = 38
    expect(xLength(textWithLink)).toBe(38);
  });

  describe('matchKey', () => {
    it('matches text containing a link against text where link is stripped', () => {
      const original = 'Breaking news: Ding wins! https://example.com/ding-wins';
      const fromX = 'Breaking news: Ding wins! https://t.co/xyz123abc';
      expect(matchKey(original)).toBe(matchKey(fromX));
      expect(matchKey(original)).toBe('breaking news: ding wins!');
    });

    it('matches HTML-escaped characters returned by X v2 API', () => {
      const original = 'Magnus & Hikaru <rivalry>';
      const fromX = 'Magnus &amp; Hikaru &lt;rivalry&gt;';
      expect(matchKey(fromX)).toBe(matchKey(original));
      expect(matchKey(fromX)).toBe('magnus & hikaru <rivalry>');
    });

    it('handles emoji and Unicode NFC normalization', () => {
      const text1 = 'Grandmaster 🏆 é';
      const text2 = 'Grandmaster 🏆 \u0065\u0301'; // e + combining acute
      expect(matchKey(text1)).toBe(matchKey(text2));
    });

    it('matches text with a trailing media t.co link added by X', () => {
      const original = 'A brilliant tactical sacrifice in Round 4.';
      const returnedByX = 'A brilliant tactical sacrifice in Round 4. https://t.co/9ABCDefgh';
      expect(matchKey(returnedByX)).toBe(matchKey(original));
    });

    it('collapses multiple spaces, tabs and newlines', () => {
      const a = 'Line 1\n\n   Line 2\t';
      const b = 'Line 1 Line 2';
      expect(matchKey(a)).toBe(matchKey(b));
    });
  });
});
