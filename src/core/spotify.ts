import type { SpotifyCredentials } from './config.js';
import { logger } from './logger.js';
import type { SearchResult, Track } from './types.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
/**
 * Playlist items path segment. Spotify renamed /playlists/{id}/tracks → /items; the change took
 * effect for existing apps on 2026-03-09. Switch here if needed.
 */
export const PLAYLIST_ITEMS_PATH = 'items';
const CHUNK_SIZE = 100;
const SEARCH_LIMIT = 5;
const MARKET = 'JP';
const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_SEC = 1;
const MAX_RETRY_AFTER_SEC = 30;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Refresh the token this many ms before it actually expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const BODY_EXCERPT_LEN = 200;

export type SleepFn = (ms: number) => Promise<void>;

export interface SpotifyClientOptions {
  /** Injectable for tests so retries don't actually wait. */
  sleep?: SleepFn;
  /** Injectable clock (ms since epoch) for token-expiry and deadline tests. */
  now?: () => number;
  /** Per-request timeout (ms) applied via AbortSignal.timeout. Default 10s. */
  timeoutMs?: number;
  /**
   * Overall deadline as absolute epoch ms (compared against `now()`). When a Retry-After/backoff
   * wait would pass it, the error is thrown immediately instead of sleeping. Also caps per-request timeouts.
   */
  deadlineMs?: number;
}

/** How a request may be retried. */
interface RetryPolicy {
  /**
   * false for non-idempotent requests (playlist append): retry on 429 only, never on 5xx or
   * network/timeout errors, since the server may already have applied the request.
   */
  idempotent: boolean;
}
const IDEMPOTENT: RetryPolicy = { idempotent: true };
const NON_IDEMPOTENT: RetryPolicy = { idempotent: false };

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SpotifyApiError extends Error {
  override name = 'SpotifyApiError';
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly bodyExcerpt: string,
  ) {
    super(`Spotify API ${method} ${url} failed: ${status} ${bodyExcerpt}`);
  }
}

/**
 * replacePlaylist failed after the first PUT succeeded: the playlist now holds only the first
 * `applied` of `total` items. `cause` is the underlying error (SpotifyApiError or a network error);
 * status/method/url/bodyExcerpt are copied from it when it is a SpotifyApiError (status 0 otherwise).
 */
export class PlaylistPartiallyUpdatedError extends SpotifyApiError {
  override name = 'PlaylistPartiallyUpdatedError';
  override readonly cause: unknown;
  constructor(
    public readonly playlistId: string,
    public readonly applied: number,
    public readonly total: number,
    cause: unknown,
  ) {
    const api = cause instanceof SpotifyApiError ? cause : null;
    super(api?.status ?? 0, api?.method ?? 'POST', api?.url ?? '', api?.bodyExcerpt ?? '');
    this.cause = cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    this.message = `Playlist ${playlistId} is partially updated: ${applied} of ${total} items applied (${reason})`;
  }
}

interface SpotifyArtist {
  name: string;
}
interface SpotifyTrackItem {
  id: string;
  uri: string;
  name: string;
  artists: SpotifyArtist[];
}
interface SearchResponse {
  tracks?: { items?: (SpotifyTrackItem | null)[] };
}
interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

/** NFKC + lowercase + collapse whitespace, for case/width-insensitive comparison. */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** NFKC + lowercase, then drop whitespace, punctuation and symbols. Used for fuzzy matching. */
function normalizeKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** Credited-artist separators (applied after NFKC + lowercase): feat./ft./featuring/×/&/,/、 */
const ARTIST_SEPARATOR = /\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|[×&,、]/u;

/** Normalized keys for an artist credit: the whole string plus each credited artist. */
function artistKeys(s: string): string[] {
  const lower = s.normalize('NFKC').toLowerCase();
  const keys = [lower, ...lower.split(ARTIST_SEPARATOR)].map(normalizeKey).filter((k) => k !== '');
  return [...new Set(keys)];
}

/** Containment either way; the contained key must be ≥2 chars (or equal) so "a" doesn't match everything. */
function keysOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && long.includes(short);
}

/** Title key ignoring trailing " - ..." and "(...)" suffixes (e.g. " - Remastered", "(TV Size)"). */
function titleKey(s: string): string {
  let t = s.normalize('NFKC').trim();
  for (;;) {
    const next = t
      .replace(/\s+-\s+.*$/u, '')
      .replace(/\s*[(\[][^()\[\]]*[)\]]\s*$/u, '')
      .trim();
    if (next === t || next === '') break;
    t = next;
  }
  return normalizeKey(t);
}

function quote(s: string): string {
  // Double quotes inside a field filter would break the query.
  return s.replace(/"/g, ' ').trim();
}

export class SpotifyClient {
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly deadlineMs: number | undefined;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string> | null = null;

  constructor(
    private readonly creds: SpotifyCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    opts: SpotifyClientOptions = {},
  ) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deadlineMs = opts.deadlineMs;
  }

  /** refresh_token grant; cached until ~60s before expiry. Concurrent callers share one request. */
  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.tokenExpiresAt) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.creds.refreshToken });
    const res = await this.send(TOKEN_URL, IDEMPOTENT, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await res.json()) as TokenResponse;
    if (!data.access_token) throw new SpotifyApiError(res.status, 'POST', TOKEN_URL, 'no access_token in response');
    const ttlMs = (data.expires_in ?? 3600) * 1000;
    this.token = data.access_token;
    this.tokenExpiresAt = this.now() + Math.max(0, ttlMs - TOKEN_EXPIRY_MARGIN_MS);
    return this.token;
  }

  /** Returns a spotify:track URI, or null when nothing suitable matched. */
  async searchTrack(track: Track): Promise<string | null> {
    const title = track.title.trim();
    const artist = track.artist.trim();
    const targets = artistKeys(artist);
    const artistMatches = (item: SpotifyTrackItem) =>
      targets.length > 0 &&
      item.artists.some((a) => artistKeys(a.name).some((k) => targets.some((t) => keysOverlap(k, t))));

    let hit: SpotifyTrackItem | undefined;

    const strictQ = artist ? `track:"${quote(title)}" artist:"${quote(artist)}"` : `track:"${quote(title)}"`;
    const strict = await this.search(strictQ);
    // Spotify's artist: filter is fuzzy, so the strict result must still pass the artist check.
    hit = strict.find(artistMatches);
    if (!hit && !artist) {
      // No artist to check: accept the top hit only if its title matches (avoids covers/same-name songs).
      const first = strict[0];
      const key = titleKey(title);
      if (first && key !== '' && titleKey(first.name) === key) hit = first;
    }

    if (!hit && artist) {
      // Looser query: only accept an artist match to avoid picking a different song.
      const loose = await this.search(`${title} ${artist}`);
      hit = loose.find(artistMatches);
    }

    logger.info('spotify_search', {
      status: hit ? 'found' : 'not_found',
      title: track.title,
      artist: track.artist,
      track_id: hit?.id ?? null,
    });
    return hit?.uri ?? null;
  }

  /** Sequential; result order matches input order. */
  async searchTracks(tracks: Track[]): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    for (const track of tracks) {
      results.push({ track, uri: await this.searchTrack(track) });
    }
    return results;
  }

  /**
   * Overwrite the playlist: PUT first ≤100 (empty list clears), then POST the rest in chunks of 100.
   * POSTs retry on 429 only (a retried 5xx could duplicate items). If a POST fails, throws
   * PlaylistPartiallyUpdatedError: the playlist is left with only the items applied so far.
   */
  async replacePlaylist(playlistId: string, uris: string[]): Promise<void> {
    const url = `${API_BASE}/playlists/${encodeURIComponent(playlistId)}/${PLAYLIST_ITEMS_PATH}`;
    await this.api('PUT', url, { uris: uris.slice(0, CHUNK_SIZE) });
    for (let i = CHUNK_SIZE; i < uris.length; i += CHUNK_SIZE) {
      try {
        await this.api('POST', url, { uris: uris.slice(i, i + CHUNK_SIZE) }, NON_IDEMPOTENT);
      } catch (err) {
        const e = new PlaylistPartiallyUpdatedError(playlistId, i, uris.length, err);
        logger.error('spotify_playlist_partial', { applied: i, total: uris.length, error: e.message });
        throw e;
      }
    }
  }

  private async search(q: string): Promise<SpotifyTrackItem[]> {
    const params = new URLSearchParams({ q, type: 'track', limit: String(SEARCH_LIMIT), market: MARKET });
    const res = await this.api('GET', `${API_BASE}/search?${params.toString()}`);
    const data = (await res.json()) as SearchResponse;
    return (data.tracks?.items ?? []).filter((i): i is SpotifyTrackItem => !!i && !!i.uri);
  }

  private async api(method: string, url: string, json?: unknown, policy: RetryPolicy = IDEMPOTENT): Promise<Response> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    return this.send(url, policy, init);
  }

  /**
   * fetch with a per-request timeout and retries: 429 (Retry-After) always; 5xx and thrown fetch
   * errors (network/timeout, backoff) only for idempotent requests. A wait that would pass the
   * deadline throws right away. Throws SpotifyApiError on non-OK, or the fetch error itself.
   */
  private async send(url: string, policy: RetryPolicy, init: RequestInit): Promise<Response> {
    const method = init.method ?? 'GET';
    const path = safePath(url);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.requestTimeoutMs()) });
      } catch (err) {
        const waitMs = 500 * 2 ** attempt;
        if (!policy.idempotent || attempt >= MAX_RETRIES || this.passesDeadline(waitMs)) throw err;
        logger.warn('spotify_retry', {
          error: err instanceof Error ? err.name : 'unknown',
          method,
          path,
          attempt: attempt + 1,
          wait_ms: waitMs,
        });
        await this.sleep(waitMs);
        continue;
      }
      if (res.ok) return res;

      const retryable = res.status === 429 || (policy.idempotent && res.status >= 500);
      const waitMs = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : 500 * 2 ** attempt;
      if (retryable && attempt < MAX_RETRIES && !this.passesDeadline(waitMs)) {
        logger.warn('spotify_retry', { status: res.status, method, path, attempt: attempt + 1, wait_ms: waitMs });
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(waitMs);
        continue;
      }
      if (retryable && attempt < MAX_RETRIES) {
        logger.warn('spotify_deadline', { status: res.status, method, path, wait_ms: waitMs });
      }

      const text = await res.text().catch(() => '');
      throw new SpotifyApiError(res.status, method, path, text.slice(0, BODY_EXCERPT_LEN));
    }
  }

  /** timeoutMs, capped to the time left before the deadline (min 1ms). */
  private requestTimeoutMs(): number {
    if (this.deadlineMs === undefined) return this.timeoutMs;
    return Math.max(1, Math.min(this.timeoutMs, this.deadlineMs - this.now()));
  }

  private passesDeadline(waitMs: number): boolean {
    return this.deadlineMs !== undefined && this.now() + waitMs > this.deadlineMs;
  }
}

function retryAfterMs(header: string | null): number {
  const n = header == null ? NaN : Number(header);
  const sec = Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETRY_AFTER_SEC;
  return Math.min(sec, MAX_RETRY_AFTER_SEC) * 1000;
}

/** URL without query string (search queries are fine, but keep errors/logs short). */
function safePath(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}
