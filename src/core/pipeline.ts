import type { SpotifyConfig } from './config.js';
import { fetchOnairTsv } from './fetcher.js';
import { logger } from './logger.js';
import { SpotifyClient } from './spotify.js';
import { parseTsv, selectTracks } from './tsv.js';
import type { PipelineResult } from './types.js';

export interface PipelineOptions {
  /** Substring of the program name (TARGET_PROGRAM_NAME). */
  target: string;
  /** Required unless dryRun. */
  spotify?: SpotifyConfig;
  /** Fetch and match only; no Spotify calls. */
  dryRun?: boolean;
  /** Already-decoded TSV text; skips the download (used by the local fetcher). */
  tsvText?: string;
  fetchImpl?: typeof fetch;
  /** Absolute epoch ms; Spotify retries give up instead of sleeping past it (Lambda timeout). */
  deadlineMs?: number;
}

/**
 * fetch TSV → pick the target program → search Spotify → overwrite playlist.
 * Shared by the local CLI and the Lambda handler.
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const text = opts.tsvText ?? (await fetchOnairTsv(fetchImpl)).text;
  const { name, tracks } = selectTracks(parseTsv(text), opts.target);
  logger.info('parse_tracks', { target: opts.target, program: name, count: tracks.length });

  const result: PipelineResult = { status: opts.dryRun ? 'dry_run' : 'updated', program: name, fetched: tracks.length, added: 0, skipped: [], dryRun: !!opts.dryRun };
  if (tracks.length === 0) {
    logger.warn('program_not_found', { target: opts.target });
    return { ...result, status: 'program_not_found' };
  }
  if (opts.dryRun) return result;
  if (!opts.spotify) throw new Error('spotify config is required unless dryRun');

  const client = new SpotifyClient(opts.spotify, fetchImpl, { deadlineMs: opts.deadlineMs });
  const found = await client.searchTracks(tracks);
  const uris = found.flatMap((r) => (r.uri ? [r.uri] : []));
  result.skipped = found.filter((r) => !r.uri).map((r) => r.track);

  // Every search missed: something is wrong on the Spotify side (market,
  // API change…). Keep yesterday's playlist rather than emptying it.
  if (uris.length === 0) {
    logger.warn('playlist_update', { status: 'skipped', reason: 'no_tracks_found', searched: tracks.length });
    return { ...result, status: 'no_tracks_found' };
  }

  await client.replacePlaylist(opts.spotify.playlistId, uris);
  result.added = uris.length;
  logger.info('playlist_update', { status: 'ok', added: result.added, skipped: result.skipped.length });
  return result;
}
