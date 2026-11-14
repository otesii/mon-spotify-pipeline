import { assertOnairTsv, decodeTsv, parseTsv } from './tsv.js';
import type { Program } from './types.js';
import { logger } from './logger.js';

export const ONAIR_TSV_URL = 'https://www.m-on.jp/oa/download/';

export interface FetchedTsv {
  /** Raw CP932 bytes, kept so the local fetcher can archive them as-is. */
  raw: Uint8Array;
  text: string;
  programs: Program[];
}

export async function fetchOnairTsv(fetchImpl: typeof fetch = fetch, url = ONAIR_TSV_URL): Promise<FetchedTsv> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`TSV取得失敗: HTTP ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  const text = decodeTsv(raw);
  const programs = parseTsv(text);
  assertOnairTsv(text, programs);
  logger.info('fetch_tsv', { status: 'ok', bytes: raw.byteLength, rows: text.split(/\r?\n/).filter(Boolean).length, programs: programs.length });
  return { raw, text, programs };
}
