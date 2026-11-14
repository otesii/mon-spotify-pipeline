import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../src/core/pipeline.js';
import { decodeTsv } from '../src/core/tsv.js';

const tsvText = decodeTsv(readFileSync(new URL('./fixtures/oa-2026-11-15.cp932.tsv', import.meta.url)));
const spotify = { clientId: 'id', clientSecret: 'secret', refreshToken: 'rt', playlistId: 'PL' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Fake Spotify: token ok; search returns `hit` for every query. */
function fakeSpotify(hit: (q: string) => unknown[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'accounts.spotify.com') return json({ access_token: 'AT', expires_in: 3600 });
    if (url.pathname === '/v1/search') return json({ tracks: { items: hit(url.searchParams.get('q') ?? '') } });
    if (url.pathname.startsWith('/v1/playlists/')) return json({ snapshot_id: 's' }, init?.method === 'PUT' ? 200 : 201);
    throw new Error(`unexpected ${url}`);
  });
}

describe('runPipeline', () => {
  it('dry run matches without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const r = await runPipeline({ target: 'あのころヒッツ', dryRun: true, tsvText, fetchImpl });
    expect(r).toMatchObject({ status: 'dry_run', fetched: 62, added: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('program_not_found leaves Spotify alone', async () => {
    const fetchImpl = vi.fn();
    const r = await runPipeline({ target: '存在しない番組', spotify, tsvText, fetchImpl });
    expect(r.status).toBe('program_not_found');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no_tracks_found does not empty the playlist', async () => {
    const fetchImpl = fakeSpotify(() => []);
    const r = await runPipeline({ target: 'あのころヒッツ', spotify, tsvText, fetchImpl });
    expect(r).toMatchObject({ status: 'no_tracks_found', added: 0 });
    expect(r.skipped).toHaveLength(62);
    const playlistCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes('/playlists/'));
    expect(playlistCalls).toHaveLength(0);
  });
});
