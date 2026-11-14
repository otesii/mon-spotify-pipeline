import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Program } from '../core/types.js';

/**
 * Broadcast day (YYYY-MM-DD) for a moment in time. M-ON!'s day runs
 * 6:00–30:00 JST and m-on.jp keeps showing the previous day's list until
 * 6:00 (observed 2026-11-15 00:30 JST: page dated 2026/11/14). So the 05:00
 * run archives the previous calendar day's list, under that day's date.
 */
export function broadcastDate(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() - 6 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(shifted);
}

/**
 * Keep each day's on-air list: m-on.jp only serves the current day, so this
 * archive is the only history we get.
 *   data/raw/YYYY-MM-DD.tsv        original CP932 bytes
 *   data/programs/YYYY-MM-DD.json  parsed programs (UTF-8)
 */
export async function archiveDay(dataDir: string, date: string, raw: Uint8Array, programs: Program[]) {
  const rawPath = path.join(dataDir, 'raw', `${date}.tsv`);
  const jsonPath = path.join(dataDir, 'programs', `${date}.json`);
  await mkdir(path.dirname(rawPath), { recursive: true });
  await mkdir(path.dirname(jsonPath), { recursive: true });
  // A re-run on the same day must not replace a good archive with a truncated one.
  const prev = await stat(rawPath).catch(() => null);
  if (prev && raw.byteLength < prev.size * 0.5) {
    throw new Error(`既存アーカイブ ${rawPath} (${prev.size} bytes) より大幅に小さい応答 (${raw.byteLength} bytes) のため上書きしません`);
  }
  await writeFile(rawPath, raw);
  await writeFile(jsonPath, JSON.stringify({ date, programs }, null, 2) + '\n');
  return { rawPath, jsonPath };
}
