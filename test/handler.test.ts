import { createHmac } from 'node:crypto';
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../src/core/config.js';
import { SpotifyApiError } from '../src/core/spotify.js';
import { HELP_MESSAGE, STARTED_MESSAGE, createHandler, formatError } from '../src/lambda/handler.js';
import { LINE_PUSH_URL, LINE_REPLY_URL } from '../src/line/line.js';
import type { PipelineResult } from '../src/core/types.js';

const SECRET = 'line-secret';
const USER = 'U1234567890abcdef';
const ENV = {
  TARGET_PROGRAM_NAME: 'あのころヒッツ',
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'csecret',
  SPOTIFY_REFRESH_TOKEN: 'rtoken',
  SPOTIFY_PLAYLIST_ID: 'pl',
  LINE_CHANNEL_SECRET: SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: 'access',
  LINE_ALLOWED_USER_IDS: `${USER},U2`,
  AWS_LAMBDA_FUNCTION_NAME: 'mon-spotify-fn',
};

const OK_RESULT: PipelineResult = {
  status: 'updated',
  program: 'あのころヒッツ! 一挙5時間！',
  fetched: 72,
  added: 70,
  skipped: [
    { title: 'a', artist: 'x' },
    { title: 'b', artist: 'y' },
  ],
  dryRun: false,
};

type Call = [string, RequestInit];

function setup(
  opts: {
    runPipeline?: () => Promise<PipelineResult>;
    env?: Record<string, string | undefined>;
    invoke?: () => Promise<unknown>;
  } = {},
) {
  const runPipeline = vi.fn(opts.runPipeline ?? (async () => OK_RESULT));
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
  const send = vi.fn(async (_cmd: InvokeCommand) => (opts.invoke ? opts.invoke() : { StatusCode: 202 }));
  const handler = createHandler({
    runPipeline,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: { ...ENV, ...opts.env },
    lambda: { send },
  });
  const calls = () => fetchImpl.mock.calls as unknown as Call[];
  const bodies = (url: string) =>
    calls()
      .filter(([u]) => u === url)
      .map(([, init]) => JSON.parse(init.body as string) as { to?: string; replyToken?: string; messages: { text: string }[] });
  const replies = () => bodies(LINE_REPLY_URL).map((b) => b.messages[0]!.text);
  const pushes = () => bodies(LINE_PUSH_URL).map((b) => ({ to: b.to, text: b.messages[0]!.text }));
  const invokes = () =>
    send.mock.calls.map(([cmd]) => ({
      ...cmd.input,
      Payload: JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString('utf8')),
    }));
  return { handler, runPipeline, fetchImpl, send, replies, pushes, invokes };
}

function webhook(payload: unknown, o: { sign?: string; base64?: boolean; headerName?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = o.sign ?? createHmac('sha256', SECRET).update(body).digest('base64');
  return {
    version: '2.0',
    routeKey: 'POST /webhook',
    rawPath: '/webhook',
    headers: { [o.headerName ?? 'x-line-signature']: sig, 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST', path: '/webhook' } },
    body: o.base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: !!o.base64,
  } as unknown as APIGatewayProxyEventV2;
}

const msg = (text: string, o: { userId?: string; replyToken?: string; redelivery?: boolean } = {}) => ({
  type: 'message',
  replyToken: o.replyToken ?? 'rt',
  webhookEventId: `W-${o.replyToken ?? 'rt'}`,
  deliveryContext: { isRedelivery: !!o.redelivery },
  source: { type: 'user', userId: o.userId ?? USER },
  message: { type: 'text', text },
});
const textEvent = (text: string, userId = USER) => ({ events: [msg(text, { userId })] });

const status = async (p: Promise<unknown>) => ((await p) as APIGatewayProxyStructuredResultV2).statusCode;

/** Collect structured log lines written by the logger. */
function captureLogs() {
  const lines: string[] = [];
  const grab = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(grab as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(grab as typeof process.stderr.write);
  return () => lines.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handler: schedule', () => {
  it.each([{ source: 'aws.scheduler' }, { source: 'aws.events' }, { trigger: 'schedule' }])('runs pipeline for %o', async (ev) => {
    const { handler, runPipeline, fetchImpl, send } = setup();
    await expect(handler(ev)).resolves.toEqual(OK_RESULT);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'あのころヒッツ', spotify: expect.objectContaining({ playlistId: 'pl' }) }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rethrows pipeline errors', async () => {
    const { handler } = setup({ runPipeline: async () => { throw new Error('boom'); } });
    await expect(handler({ source: 'aws.scheduler' })).rejects.toThrow('boom');
  });
});

describe('handler: unknown events', () => {
  it.each([{}, { foo: 1 }, { trigger: 'line' }, { source: 'aws.s3' }])('throws for %o', async (ev) => {
    const { handler, runPipeline } = setup();
    await expect(handler(ev)).rejects.toThrow(/Unrecognised event/);
    expect(runPipeline).not.toHaveBeenCalled();
  });
});

describe('handler: LINE webhook', () => {
  it('401 on bad signature', async () => {
    const { handler, runPipeline, send } = setup();
    expect(await status(handler(webhook(textEvent('作って'), { sign: 'bad' })))).toBe(401);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('401 on missing signature', async () => {
    const { handler } = setup();
    const ev = webhook(textEvent('作って'));
    ev.headers = {};
    expect(await status(handler(ev))).toBe(401);
  });

  it('200 for verify webhook with no events', async () => {
    const { handler, runPipeline, fetchImpl } = setup();
    expect(await status(handler(webhook({ destination: 'x', events: [] })))).toBe(200);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('trigger → async self-invoke + ⏳ reply, pipeline NOT run inline (base64 body, mixed-case header)', async () => {
    const { handler, runPipeline, replies, invokes } = setup();
    const res = await handler(webhook(textEvent('あのころヒッツ作って'), { base64: true, headerName: 'X-Line-Signature' }));
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(200);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(invokes()).toEqual([
      { FunctionName: 'mon-spotify-fn', InvocationType: 'Event', Payload: { trigger: 'line', userId: USER } },
    ]);
    expect(replies()).toEqual([STARTED_MESSAGE]);
  });

  it('verifies the signature over raw bytes of a base64 body', async () => {
    const { handler, send } = setup();
    // Body with an invalid UTF-8 byte: a string round-trip would change the HMAC input.
    const raw = Buffer.concat([Buffer.from('{"events":[],"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    const ev = {
      headers: { 'x-line-signature': createHmac('sha256', SECRET).update(raw).digest('base64') },
      requestContext: {},
      body: raw.toString('base64'),
      isBase64Encoded: true,
    } as unknown as APIGatewayProxyEventV2;
    expect(await status(handler(ev))).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('collapses multiple triggers in one request to a single run', async () => {
    const { handler, send, replies } = setup();
    const payload = { events: [msg('作って', { replyToken: 'r1' }), msg('更新', { replyToken: 'r2', userId: 'U2' })] };
    expect(await status(handler(webhook(payload)))).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(replies()).toEqual([STARTED_MESSAGE]);
  });

  it('skips redelivered events', async () => {
    const { handler, send, fetchImpl } = setup();
    const payload = { events: [msg('作って', { redelivery: true })] };
    expect(await status(handler(webhook(payload)))).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('async invoke failure → generic ❌ reply, still 200', async () => {
    const getLogs = captureLogs();
    const { handler, replies } = setup({
      invoke: async () => { throw new Error('AccessDeniedException: arn:aws:lambda:secret'); },
    });
    expect(await status(handler(webhook(textEvent('作って'))))).toBe(200);
    expect(replies()).toEqual(['❌ 内部エラーが発生しました']);
    expect(getLogs()).toContain('AccessDeniedException');
  });

  it('missing AWS_LAMBDA_FUNCTION_NAME → 設定エラー reply', async () => {
    captureLogs();
    const { handler, replies, send } = setup({ env: { AWS_LAMBDA_FUNCTION_NAME: undefined } });
    await handler(webhook(textEvent('作って')));
    expect(send).not.toHaveBeenCalled();
    expect(replies()).toEqual(['❌ 設定エラーが発生しました']);
  });

  it('non-trigger text → help reply, no run', async () => {
    const { handler, send, replies } = setup();
    await handler(webhook(textEvent('こんにちは')));
    expect(send).not.toHaveBeenCalled();
    expect(replies()).toEqual([HELP_MESSAGE]);
  });

  it('reply failure is logged, still 200', async () => {
    captureLogs();
    const { handler, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response('err', { status: 500 }));
    expect(await status(handler(webhook(textEvent('作って'))))).toBe(200);
  });

  it('ignores users not in LINE_ALLOWED_USER_IDS and does not log the raw userId', async () => {
    const getLogs = captureLogs();
    const { handler, send, fetchImpl } = setup({ env: { LINE_ALLOWED_USER_IDS: 'U9' } });
    expect(await status(handler(webhook(textEvent('作って', 'Uintruder000000'))))).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getLogs()).toContain('line_user_ignored');
    expect(getLogs()).not.toContain('Uintruder000000');
  });

  it.each([undefined, ''])('denies everyone when LINE_ALLOWED_USER_IDS is %o, warning once', async (value) => {
    const getLogs = captureLogs();
    const { handler, send, fetchImpl } = setup({ env: { LINE_ALLOWED_USER_IDS: value } });
    const payload = { events: [msg('作って', { replyToken: 'r1' }), msg('こんにちは', { replyToken: 'r2' })] };
    expect(await status(handler(webhook(payload)))).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getLogs().match(/line_allowlist_empty/g)).toHaveLength(1);
  });
});

describe('handler: async LINE run (self-invocation)', () => {
  const runEvent = { trigger: 'line' as const, userId: USER };

  it('runs the pipeline and pushes ✅ to the user', async () => {
    const { handler, runPipeline, pushes, replies } = setup();
    await expect(handler(runEvent)).resolves.toEqual({ trigger: 'line', status: 'updated' });
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(replies()).toEqual([]);
    expect(pushes()).toEqual([
      { to: USER, text: '✅ あのころヒッツ! 一挙5時間！ 70曲でプレイリストを更新しました（見つからなかった曲: 2）' },
    ]);
  });

  it.each([
    ['program_not_found', { ...OK_RESULT, status: 'program_not_found', program: null, fetched: 0, added: 0, skipped: [] }],
    ['no_tracks_found', { ...OK_RESULT, status: 'no_tracks_found', added: 0 }],
  ] as const)('%s → ⚠️ push saying the playlist was not changed', async (_s, result) => {
    captureLogs();
    const { handler, pushes } = setup({ runPipeline: async () => result as PipelineResult });
    await handler(runEvent);
    const [p] = pushes();
    expect(p!.text).toMatch(/^⚠️/);
    expect(p!.text).toContain('プレイリストは変更していません');
    expect(p!.text).not.toContain('✅');
  });

  it('passes deadlineMs from the Lambda context (remaining - 5s)', async () => {
    const { handler, runPipeline } = setup();
    const before = Date.now();
    await handler(runEvent, { getRemainingTimeInMillis: () => 60_000 });
    const opts = (runPipeline.mock.calls as unknown as unknown[][])[0]![0] as unknown as { deadlineMs?: number };
    expect(opts.deadlineMs).toBeGreaterThanOrEqual(before + 55_000);
    expect(opts.deadlineMs).toBeLessThanOrEqual(Date.now() + 55_000);
  });

  it('omits deadlineMs without a Lambda context', async () => {
    const { handler, runPipeline } = setup();
    await handler(runEvent);
    expect((runPipeline.mock.calls as unknown as unknown[][])[0]![0]).not.toHaveProperty('deadlineMs');
  });

  it('pipeline error → generic ❌ push, details only in logs, does not throw (no Lambda retry)', async () => {
    const getLogs = captureLogs();
    const err = new SpotifyApiError(403, 'PUT', '/playlists/pl/items', '{"error":"Forbidden secret-body"}');
    const { handler, pushes } = setup({ runPipeline: async () => { throw err; } });
    await expect(handler(runEvent)).resolves.toEqual({ trigger: 'line', status: 'error' });
    expect(pushes()).toEqual([{ to: USER, text: '❌ Spotify API エラー (403)が発生しました' }]);
    expect(getLogs()).toContain('secret-body');
    expect(getLogs()).not.toContain(USER);
  });

  it('push failure is logged, does not throw', async () => {
    captureLogs();
    const { handler, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response('err', { status: 500 }));
    await expect(handler(runEvent)).resolves.toEqual({ trigger: 'line', status: 'updated' });
  });

  it('refuses users outside the allow-list', async () => {
    captureLogs();
    const { handler, runPipeline, fetchImpl } = setup({ env: { LINE_ALLOWED_USER_IDS: '' } });
    await expect(handler(runEvent)).resolves.toEqual({ trigger: 'line', status: 'error' });
    expect(runPipeline).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('formatError', () => {
  it('maps errors to generic categories', () => {
    expect(formatError(new SpotifyApiError(429, 'GET', '/search', 'x'))).toBe('❌ Spotify API エラー (429)が発生しました');
    expect(formatError(new ConfigError('環境変数 SPOTIFY_CLIENT_SECRET が設定されていません'))).toBe('❌ 設定エラーが発生しました');
    expect(formatError(new DOMException('timed out', 'TimeoutError'))).toBe('❌ タイムアウトが発生しました');
    expect(formatError(new Error('Dynamic require of "buffer" is not supported'))).toBe('❌ 内部エラーが発生しました');
    expect(formatError('weird')).toBe('❌ 内部エラーが発生しました');
  });
});
