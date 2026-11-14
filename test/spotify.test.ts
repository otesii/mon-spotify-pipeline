import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYLIST_ITEMS_PATH,
  PlaylistPartiallyUpdatedError,
  SpotifyApiError,
  SpotifyClient,
} from '../src/core/spotify.js';

const creds = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken' };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}
function tokenRes(token = 'tok', expiresIn = 3600): Response {
  return json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
}
function item(id: string, ...artists: string[]) {
  return { id, uri: `spotify:track:${id}`, name: id, artists: artists.map((name) => ({ name })) };
}
function named(id: string, name: string, ...artists: string[]) {
  return { ...item(id, ...artists), name };
}
function searchRes(...items: unknown[]): Response {
  return json({ tracks: { items } });
}

type Call = { url: string; init: RequestInit };

/** vi.fn fetch that dispatches token requests and replays a queue for API calls (Error entries are thrown). */
function mockFetch(apiResponses: (Response | Error)[], tokenResponses: Response[] = [tokenRes()]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const q = url.startsWith('https://accounts.spotify.com') ? tokenResponses : apiResponses;
    const r = q.shift();
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    if (r instanceof Error) throw r;
    return r;
  });
  return { fn: fn as unknown as typeof fetch, mock: fn, calls };
}

const apiCalls = (calls: Call[]) => calls.filter((c) => !c.url.startsWith('https://accounts.spotify.com'));
const qOf = (c: Call) => new URL(c.url).searchParams.get('q');

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('getAccessToken', () => {
  it('fetches once and caches until shortly before expiry', async () => {
    let now = 1_000_000;
    const { fn, calls } = mockFetch([], [tokenRes('a', 3600), tokenRes('b', 3600)]);
    const client = new SpotifyClient(creds, fn, { now: () => now });

    expect(await client.getAccessToken()).toBe('a');
    expect(await client.getAccessToken()).toBe('a');
    expect(calls).toHaveLength(1);

    const c = calls[0]!;
    expect(c.init.method).toBe('POST');
    const headers = c.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    const body = new URLSearchParams(String(c.init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rtoken');

    now += 3600_000 - 59_000; // within the 60s margin → refresh
    expect(await client.getAccessToken()).toBe('b');
    expect(calls).toHaveLength(2);
  });

  it('reuses the token across searches and playlist updates', async () => {
    const { fn, calls } = mockFetch([searchRes(item('x', 'A')), searchRes(item('y', 'B')), json({ snapshot_id: 's' })]);
    const client = new SpotifyClient(creds, fn);
    await client.searchTracks([
      { title: 't1', artist: 'A' },
      { title: 't2', artist: 'B' },
    ]);
    await client.replacePlaylist('pl', ['spotify:track:x']);
    expect(calls.filter((c) => c.url.startsWith('https://accounts.spotify.com'))).toHaveLength(1);
    expect((apiCalls(calls)[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});

describe('searchTrack', () => {
  it('returns the artist-matching item from the strict query', async () => {
    const { fn, calls } = mockFetch([searchRes(item('cover', 'Someone'), item('orig', 'ＹＯＡＳＯＢＩ'))]);
    const client = new SpotifyClient(creds, fn);
    expect(await client.searchTrack({ title: '夜に駆ける', artist: 'yoasobi' })).toBe('spotify:track:orig');

    const [c] = apiCalls(calls);
    const u = new URL(c!.url);
    expect(u.pathname).toBe('/v1/search');
    expect(u.searchParams.get('q')).toBe('track:"夜に駆ける" artist:"yoasobi"');
    expect(u.searchParams.get('type')).toBe('track');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('market')).toBe('JP');
  });

  it('rejects strict items whose artist does not match, then tries the loose query', async () => {
    const { fn, calls } = mockFetch([searchRes(item('first', 'X'), item('second', 'Y')), searchRes(item('z', 'Other'))]);
    const client = new SpotifyClient(creds, fn);
    expect(await client.searchTrack({ title: 'Song', artist: 'Zed' })).toBeNull();
    expect(apiCalls(calls)).toHaveLength(2);
  });

  it('matches credited artists (feat./×/&/、) by normalized containment', async () => {
    const client = (res: Response) => new SpotifyClient(creds, mockFetch([res]).fn);
    // TSV credit with feat. → Spotify lists the main artist only
    expect(
      await client(searchRes(item('a', 'Someone'), item('b', 'ＭＩＳＩＡ'))).searchTrack({ title: 'S', artist: 'MISIA feat. 他' }),
    ).toBe('spotify:track:b');
    // spaces/punctuation ignored, containment either way
    expect(
      await client(searchRes(item('c', 'Mr.Children'))).searchTrack({ title: 'S', artist: 'Mr. Children' }),
    ).toBe('spotify:track:c');
    expect(await client(searchRes(item('d', 'Hey! Say! JUMP'))).searchTrack({ title: 'S', artist: 'heysayjump' })).toBe(
      'spotify:track:d',
    );
    // collaboration credits split on ×, &, 、
    for (const credit of ['米津玄師×菅田将暉', 'Foo & 菅田将暉', 'Foo、菅田将暉']) {
      expect(await client(searchRes(item('e', '菅田将暉'))).searchTrack({ title: 'S', artist: credit })).toBe('spotify:track:e');
    }
  });

  it('does not treat a single-character key as contained in everything', async () => {
    const { fn } = mockFetch([searchRes(item('x', 'Alice')), searchRes(item('y', 'Bob'))]);
    expect(await new SpotifyClient(creds, fn).searchTrack({ title: 'S', artist: 'a' })).toBeNull();
  });

  it('uses the loose query only with an artist match', async () => {
    const { fn, calls } = mockFetch([searchRes(), searchRes(item('wrong', 'Other'), item('right', 'Artist'))]);
    const client = new SpotifyClient(creds, fn);
    expect(await client.searchTrack({ title: 'Song', artist: 'artist' })).toBe('spotify:track:right');
    expect(qOf(apiCalls(calls)[1]!)).toBe('Song artist');
  });

  it('returns null when nothing is found (loose hits without artist match are rejected)', async () => {
    const { fn, calls } = mockFetch([searchRes(), searchRes(item('wrong', 'Other'))]);
    const client = new SpotifyClient(creds, fn);
    expect(await client.searchTrack({ title: 'Song', artist: 'Artist' })).toBeNull();
    expect(apiCalls(calls)).toHaveLength(2);
  });

  it('uses a title-only query when artist is empty and accepts the first item if its title matches', async () => {
    const { fn, calls } = mockFetch([searchRes(named('t', 'ｓｏｎｇ - 2020 Remaster', 'Anyone'), named('u', 'Song', 'B'))]);
    const client = new SpotifyClient(creds, fn);
    expect(await client.searchTrack({ title: 'Song', artist: '' })).toBe('spotify:track:t');
    expect(qOf(apiCalls(calls)[0]!)).toBe('track:"Song"');
    expect(apiCalls(calls)).toHaveLength(1);

    const p = mockFetch([searchRes(named('p', 'Song (TV Size)', 'Anyone'))]);
    expect(await new SpotifyClient(creds, p.fn).searchTrack({ title: 'Song', artist: '' })).toBe('spotify:track:p');
  });

  it('returns null when artist is empty and the first strict item title differs', async () => {
    const { fn, calls } = mockFetch([searchRes(named('k', 'Song (Karaoke Version) Medley', 'Anyone'), named('s', 'Song', 'B'))]);
    expect(await new SpotifyClient(creds, fn).searchTrack({ title: 'Song', artist: '' })).toBeNull();
    expect(apiCalls(calls)).toHaveLength(1); // no loose query without an artist
  });

  it('searchTracks preserves order including misses', async () => {
    const { fn } = mockFetch([searchRes(item('a', 'A')), searchRes(), searchRes(), searchRes(item('c', 'C'))]);
    const client = new SpotifyClient(creds, fn);
    const tracks = [
      { title: '1', artist: 'A' },
      { title: '2', artist: 'B' },
      { title: '3', artist: 'C' },
    ];
    const res = await client.searchTracks(tracks);
    expect(res.map((r) => r.uri)).toEqual(['spotify:track:a', null, 'spotify:track:c']);
    expect(res.map((r) => r.track)).toEqual(tracks);
  });
});

describe('retry', () => {
  it('waits Retry-After on 429 and retries', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = mockFetch([
      new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } }),
      new Response('', { status: 429, headers: { 'Retry-After': '999' } }),
      searchRes(item('ok', 'A')),
    ]);
    const client = new SpotifyClient(creds, fn, { sleep });
    expect(await client.searchTrack({ title: 't', artist: 'A' })).toBe('spotify:track:ok');
    expect(sleep.mock.calls).toEqual([[2000], [30_000]]);
    expect(apiCalls(calls)).toHaveLength(3);
  });

  it('retries 5xx up to 3 times then throws', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = mockFetch(Array.from({ length: 4 }, () => new Response('boom', { status: 503 })));
    const client = new SpotifyClient(creds, fn, { sleep });
    await expect(client.searchTrack({ title: 't', artist: 'A' })).rejects.toMatchObject({ status: 503 });
    expect(apiCalls(calls)).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('retries thrown fetch errors (network) like 5xx', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = mockFetch([new TypeError('fetch failed'), searchRes(item('ok', 'A'))]);
    const client = new SpotifyClient(creds, fn, { sleep });
    expect(await client.searchTrack({ title: 't', artist: 'A' })).toBe('spotify:track:ok');
    expect(apiCalls(calls)).toHaveLength(2);
    expect(sleep.mock.calls).toEqual([[500]]);
  });

  it('rethrows the fetch error after retries are exhausted', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = mockFetch(Array.from({ length: 4 }, () => new TypeError('fetch failed')));
    const client = new SpotifyClient(creds, fn, { sleep });
    await expect(client.searchTrack({ title: 't', artist: 'A' })).rejects.toThrow('fetch failed');
    expect(apiCalls(calls)).toHaveLength(4);
  });

  it('aborts a hanging request after timeoutMs and retries', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).startsWith('https://accounts.spotify.com')) return tokenRes();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (n++ === 0) {
        // hang until aborted
        return new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        });
      }
      return searchRes(item('ok', 'A'));
    });
    const client = new SpotifyClient(creds, fn as unknown as typeof fetch, { sleep, timeoutMs: 20 });
    expect(await client.searchTrack({ title: 't', artist: 'A' })).toBe('spotify:track:ok');
    expect(n).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws immediately when a Retry-After wait would pass the deadline', async () => {
    const sleep = vi.fn(async () => {});
    const now = 1_000_000;
    const { fn, calls } = mockFetch([new Response('slow', { status: 429, headers: { 'Retry-After': '5' } })]);
    const client = new SpotifyClient(creds, fn, { sleep, now: () => now, deadlineMs: now + 3000 });
    await expect(client.searchTrack({ title: 't', artist: 'A' })).rejects.toMatchObject({ status: 429 });
    expect(sleep).not.toHaveBeenCalled();
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it('still retries when the wait fits before the deadline', async () => {
    const sleep = vi.fn(async () => {});
    const now = 1_000_000;
    const { fn } = mockFetch([new Response('', { status: 503 }), searchRes(item('ok', 'A'))]);
    const client = new SpotifyClient(creds, fn, { sleep, now: () => now, deadlineMs: now + 3000 });
    expect(await client.searchTrack({ title: 't', artist: 'A' })).toBe('spotify:track:ok');
    expect(sleep.mock.calls).toEqual([[500]]);
  });

  it('does not sleep past the deadline on a network-error backoff', async () => {
    const sleep = vi.fn(async () => {});
    const now = 1_000_000;
    const { fn } = mockFetch([new TypeError('fetch failed')]);
    const client = new SpotifyClient(creds, fn, { sleep, now: () => now, deadlineMs: now + 100 });
    await expect(client.searchTrack({ title: 't', artist: 'A' })).rejects.toThrow('fetch failed');
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('replacePlaylist', () => {
  it('chunks 230 uris into 1 PUT + 2 POST', async () => {
    const { fn, calls } = mockFetch([json({}), json({}), json({})]);
    const client = new SpotifyClient(creds, fn);
    const uris = Array.from({ length: 230 }, (_, i) => `spotify:track:${i}`);
    await client.replacePlaylist('PL1', uris);

    const api = apiCalls(calls);
    expect(api.map((c) => c.init.method)).toEqual(['PUT', 'POST', 'POST']);
    for (const c of api) expect(c.url).toBe(`https://api.spotify.com/v1/playlists/PL1/${PLAYLIST_ITEMS_PATH}`);
    const bodies = api.map((c) => JSON.parse(String(c.init.body)).uris as string[]);
    expect(bodies.map((b) => b.length)).toEqual([100, 100, 30]);
    expect(bodies.flat()).toEqual(uris);
  });

  it('retries the PUT on 5xx (idempotent)', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = mockFetch([new Response('', { status: 502 }), json({})]);
    await new SpotifyClient(creds, fn, { sleep }).replacePlaylist('PL1', ['u']);
    expect(apiCalls(calls).map((c) => c.init.method)).toEqual(['PUT', 'PUT']);
  });

  it('retries a POST on 429', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = mockFetch([json({}), new Response('', { status: 429, headers: { 'Retry-After': '1' } }), json({})]);
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`);
    await new SpotifyClient(creds, fn, { sleep }).replacePlaylist('PL1', uris);
    expect(apiCalls(calls).map((c) => c.init.method)).toEqual(['PUT', 'POST', 'POST']);
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  it('does not retry a POST on 5xx and reports a partial update', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = mockFetch([json({}), json({}), new Response('bad gateway', { status: 502 })]);
    const uris = Array.from({ length: 230 }, (_, i) => `spotify:track:${i}`);
    const err = await new SpotifyClient(creds, fn, { sleep }).replacePlaylist('PL1', uris).catch((e: unknown) => e);

    expect(apiCalls(calls).map((c) => c.init.method)).toEqual(['PUT', 'POST', 'POST']);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(PlaylistPartiallyUpdatedError);
    expect(err).toBeInstanceOf(SpotifyApiError);
    const e = err as PlaylistPartiallyUpdatedError;
    expect(e.status).toBe(502);
    expect(e.applied).toBe(200);
    expect(e.total).toBe(230);
    expect(e.message).toMatch(/partially updated.*200 of 230/);
    expect(e.cause).toBeInstanceOf(SpotifyApiError);
  });

  it('does not retry a POST on a network error and reports a partial update', async () => {
    const sleep = vi.fn(async () => {});
    const netErr = new TypeError('fetch failed');
    const { fn, calls } = mockFetch([json({}), netErr]);
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`);
    const err = await new SpotifyClient(creds, fn, { sleep }).replacePlaylist('PL1', uris).catch((e: unknown) => e);

    expect(apiCalls(calls)).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(PlaylistPartiallyUpdatedError);
    expect((err as PlaylistPartiallyUpdatedError).status).toBe(0);
    expect((err as PlaylistPartiallyUpdatedError).cause).toBe(netErr);
    expect((err as Error).message).toMatch(/partially updated.*100 of 150/);
  });

  it('a failing first PUT is a plain SpotifyApiError (playlist untouched)', async () => {
    const { fn } = mockFetch([new Response('nope', { status: 403 })]);
    const err = await new SpotifyClient(creds, fn).replacePlaylist('PL1', ['u']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err).not.toBeInstanceOf(PlaylistPartiallyUpdatedError);
  });

  it('clears with an empty PUT', async () => {
    const { fn, calls } = mockFetch([json({})]);
    await new SpotifyClient(creds, fn).replacePlaylist('PL1', []);
    const api = apiCalls(calls);
    expect(api).toHaveLength(1);
    expect(api[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(api[0]!.init.body))).toEqual({ uris: [] });
  });
});

describe('errors', () => {
  it('throws SpotifyApiError with status and body excerpt on non-OK', async () => {
    const { fn } = mockFetch([new Response('{"error":{"status":403,"message":"Forbidden"}}', { status: 403 })]);
    const err = await new SpotifyClient(creds, fn).replacePlaylist('PL1', ['u']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect((err as SpotifyApiError).status).toBe(403);
    expect((err as SpotifyApiError).message).toContain('Forbidden');
    expect((err as SpotifyApiError).message).not.toContain('tok');
  });

  it('throws on token failure without leaking secrets', async () => {
    const { fn } = mockFetch([], [new Response('{"error":"invalid_grant"}', { status: 400 })]);
    const err = await new SpotifyClient(creds, fn).getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect((err as SpotifyApiError).status).toBe(400);
    expect((err as SpotifyApiError).message).not.toMatch(/csecret|rtoken/);
  });
});
