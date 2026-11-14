/**
 * Local daily job (launchd: com.mon-fetcher, 05:00 JST).
 *   1. download the current on-air TSV and archive it under data/ (by broadcast day)
 *   2. if TARGET_PROGRAM_NAME airs today and Spotify is configured, overwrite the playlist
 *
 * Usage: tsx src/local/mon-fetcher-cli.ts [--dry-run] [--no-archive] [--target <name>]
 */
import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadSpotifyConfig } from '../core/config.js';
import { fetchOnairTsv } from '../core/fetcher.js';
import { errorFields, logger } from '../core/logger.js';
import { runPipeline } from '../core/pipeline.js';
import { archiveDay, broadcastDate } from './archive.js';

const SPOTIFY_KEYS = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN', 'SPOTIFY_PLAYLIST_ID'];

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'no-archive': { type: 'boolean', default: false },
      target: { type: 'string' },
      'data-dir': { type: 'string' },
    },
  });
  const dryRun = values['dry-run'] ?? false;
  const dataDir = values['data-dir'] ?? process.env.MON_DATA_DIR ?? path.resolve('data');
  const target = values.target ?? process.env.TARGET_PROGRAM_NAME?.trim();

  const { raw, text, programs } = await fetchOnairTsv();
  logger.info('programs', { count: programs.length, names: programs.map((p) => p.name) });

  if (!values['no-archive']) {
    const date = broadcastDate();
    const paths = await archiveDay(dataDir, date, raw, programs);
    logger.info('archive', { status: 'ok', date, ...paths });
  }

  if (!target) {
    logger.info('pipeline_skip', { reason: 'TARGET_PROGRAM_NAME 未設定（取得・保存のみ）' });
    return 0;
  }

  let spotify;
  if (!dryRun) {
    // None set = archive-only setup (fine). Some set = broken config (fail loudly).
    if (SPOTIFY_KEYS.every((k) => !process.env[k]?.trim())) {
      logger.info('pipeline_skip', { reason: 'Spotify 未設定（取得・保存のみ）' });
      return 0;
    }
    spotify = loadSpotifyConfig(); // throws ConfigError → exit 1
  }

  const result = await runPipeline({ target, spotify, dryRun, tsvText: text });
  logger.info('done', { ...result, skipped: result.skipped.map((t) => `${t.title} / ${t.artist}`) });
  // no_tracks_found means Spotify search is broken: make launchd record a failure.
  return result.status === 'no_tracks_found' ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    logger.error('fatal', errorFields(err));
    process.exit(1);
  },
);
