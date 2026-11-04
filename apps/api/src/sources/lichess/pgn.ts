export interface PgnGame {
  /** Tag pairs in file order. A repeated tag keeps its last value. */
  headers: Record<string, string>;
  /** This game's PGN exactly as published (tags and moves). */
  pgn: string;
}

const TAG = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/;

function unescapeTag(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/**
 * Splits a multi-game PGN into games and reads each game's tag pairs. Moves are kept verbatim in
 * `pgn`; they are not parsed or validated here (that belongs to research in module 1.5).
 * Throws if the text does not look like PGN.
 */
export function parsePgnGames(text: string): PgnGame[] {
  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (normalised === '') return [];
  if (!normalised.startsWith('[')) throw new Error('not PGN: text does not start with a tag pair');

  // A new game starts at an [Event ...] tag that follows a blank line.
  const chunks = normalised.split(/\n\s*\n(?=\[Event ")/);
  return chunks.map((chunk) => {
    const headers: Record<string, string> = {};
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('[')) break; // movetext begins after the tag section
      const m = TAG.exec(line);
      if (!m) throw new Error(`malformed PGN tag line: ${line.slice(0, 80)}`);
      headers[m[1]!] = unescapeTag(m[2]!);
    }
    if (Object.keys(headers).length === 0) throw new Error('PGN game without tag pairs');
    return { headers, pgn: chunk.trim() + '\n' };
  });
}
