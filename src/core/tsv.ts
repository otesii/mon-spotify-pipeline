import iconv from 'iconv-lite';
import type { Program, Track } from './types.js';

/**
 * The download is CP932 even though the server labels it UTF-8.
 */
export function decodeTsv(buf: Uint8Array): string {
  return iconv.decode(Buffer.from(buf), 'cp932');
}

/**
 * Parse the on-air TSV (columns: 時間, 番組名, タイトル, アーティスト名).
 * A program's first row carries time + name; following rows leave those
 * columns blank (the HTML table's rowspan), so they belong to the last
 * program seen.
 */
export function parseTsv(text: string): Program[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const programs: Program[] = [];
  let current: Program | null = null;

  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const [time = '', name = '', title = '', artist = ''] = line.split('\t').map((c) => c.trim());
    if (i === 0 && name === '番組名') continue; // header

    if (name !== '') {
      current = { time, name, tracks: [] };
      programs.push(current);
    }
    if (current && title !== '') {
      current.tracks.push({ title, artist });
    }
  }
  return programs;
}

/**
 * Tracks of the first block whose name contains `target`, plus the blocks
 * directly after it with the *same* name (one show split over several slots).
 * A different show that also matches (e.g. "あのころヒッツ … 2006→2010年"
 * later the same day) is not mixed in. Duplicate (title, artist) pairs keep
 * their first occurrence.
 */
export function selectTracks(programs: Program[], target: string): { name: string | null; tracks: Track[] } {
  const first = programs.findIndex((p) => p.name.includes(target));
  if (first === -1) return { name: null, tracks: [] };
  const name = programs[first]!.name;
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (let i = first; i < programs.length && programs[i]!.name === name; i++) {
    for (const t of programs[i]!.tracks) {
      const key = `${t.title}\u0000${t.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(t);
    }
  }
  return { name, tracks };
}

/** Throws when the text does not look like the on-air TSV (maintenance page, empty body…). */
export function assertOnairTsv(text: string, programs: Program[]): void {
  const header = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  if (!header.includes('番組名') || !header.includes('タイトル')) {
    throw new Error(`オンエアリストTSVではない応答です（先頭行: ${JSON.stringify(header.slice(0, 60))}）`);
  }
  if (programs.length === 0) throw new Error('オンエアリストTSVに番組が1件もありません');
}
