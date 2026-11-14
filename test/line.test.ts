import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  LINE_PUSH_URL,
  LINE_REPLY_URL,
  hashUserId,
  isTriggerMessage,
  isUserAllowed,
  parseAllowedUserIds,
  parseWebhook,
  pushMessage,
  replyMessage,
  verifySignature,
} from '../src/line/line.js';

const SECRET = 'test-secret';
const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('base64');

describe('verifySignature', () => {
  const body = JSON.stringify({ events: [] });

  it('accepts a correct signature', () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects wrong secret, tampered body, missing or malformed signature', () => {
    expect(verifySignature(body, sign(body, 'other'), SECRET)).toBe(false);
    expect(verifySignature(body + ' ', sign(body), SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, 'short', SECRET)).toBe(false);
  });

  it('handles multibyte bodies', () => {
    const jp = JSON.stringify({ text: 'あのころヒッツ作って' });
    expect(verifySignature(jp, sign(jp), SECRET)).toBe(true);
  });

  it('signs the raw bytes, not a re-encoded string', () => {
    // Invalid UTF-8 (lone 0xff) would change if round-tripped through a string.
    const raw = Buffer.concat([Buffer.from('{"events":[],"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    const sig = createHmac('sha256', SECRET).update(raw).digest('base64');
    expect(verifySignature(raw, sig, SECRET)).toBe(true);
    expect(verifySignature(raw.toString('utf8'), sig, SECRET)).toBe(false);
  });
});

describe('isTriggerMessage', () => {
  it('matches trigger words only', () => {
    expect(isTriggerMessage('あのころヒッツ作って')).toBe(true);
    expect(isTriggerMessage('プレイリスト更新')).toBe(true);
    expect(isTriggerMessage('こんにちは')).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('extracts text message events only', () => {
    const body = JSON.stringify({
      events: [
        { type: 'message', replyToken: 'r1', source: { userId: 'U1' }, message: { type: 'text', text: '作って' } },
        { type: 'message', replyToken: 'r2', message: { type: 'sticker' } },
        { type: 'follow', replyToken: 'r3' },
        {
          type: 'message',
          replyToken: 'r4',
          webhookEventId: 'W4',
          deliveryContext: { isRedelivery: true },
          message: { type: 'text', text: 'hi' },
        },
      ],
    });
    expect(parseWebhook(body)).toEqual([
      { replyToken: 'r1', text: '作って', userId: 'U1', isRedelivery: false },
      { replyToken: 'r4', text: 'hi', webhookEventId: 'W4', isRedelivery: true },
    ]);
  });

  it('returns [] for verify webhooks and junk', () => {
    expect(parseWebhook('{"destination":"x","events":[]}')).toEqual([]);
    expect(parseWebhook('not json')).toEqual([]);
    expect(parseWebhook('null')).toEqual([]);
  });
});

describe('allowed users', () => {
  it.each([undefined, '', ' , '])('denies everyone when unset/empty (%o)', (value) => {
    const allowed = parseAllowedUserIds(value);
    expect(allowed.size).toBe(0);
    expect(isUserAllowed(undefined, allowed)).toBe(false);
    expect(isUserAllowed('U1', allowed)).toBe(false);
  });

  it('restricts to listed ids', () => {
    const allowed = parseAllowedUserIds(' U1 , U2,,');
    expect(isUserAllowed('U1', allowed)).toBe(true);
    expect(isUserAllowed('U3', allowed)).toBe(false);
    expect(isUserAllowed(undefined, allowed)).toBe(false);
  });
});

describe('replyMessage', () => {
  it('POSTs to the reply endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await replyMessage('tok', 'hello', 'access', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LINE_REPLY_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access');
    expect(JSON.parse(init.body as string)).toEqual({ replyToken: 'tok', messages: [{ type: 'text', text: 'hello' }] });
  });

  it('throws on non-OK', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));
    await expect(replyMessage('tok', 'x', 'a', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/400/);
  });
});

describe('pushMessage', () => {
  it('POSTs to the push endpoint with to=userId', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await pushMessage('U1', 'done', 'access', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LINE_PUSH_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access');
    expect(JSON.parse(init.body as string)).toEqual({ to: 'U1', messages: [{ type: 'text', text: 'done' }] });
  });

  it('throws on non-OK without echoing the response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret detail', { status: 429 }));
    const err = await pushMessage('U1', 'x', 'a', fetchImpl as unknown as typeof fetch).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/429/);
    expect((err as Error).message).not.toMatch(/secret detail/);
  });
});

describe('hashUserId', () => {
  it('returns a short stable sha256 prefix, never the raw id', () => {
    const h = hashUserId('Uabcdef0123456789');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(h).toBe(hashUserId('Uabcdef0123456789'));
    expect(h).not.toContain('Uabcdef');
    expect(hashUserId(undefined)).toBeNull();
  });
});
