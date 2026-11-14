import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../core/logger.js';

export const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
export const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

/** Words that mean "build/update the playlist". Keep the trigger rule here only. */
const TRIGGER_WORDS = ['作って', '更新'];
const DETAIL_EXCERPT_LEN = 200;

export interface LineTextEvent {
  replyToken: string;
  text: string;
  userId?: string;
  webhookEventId?: string;
  /** deliveryContext.isRedelivery — LINE re-sent an event we may already have handled. */
  isRedelivery: boolean;
}

/**
 * X-Line-Signature = base64(HMAC-SHA256(channelSecret, rawBody)).
 * Pass the raw body bytes as received; a string is treated as its UTF-8 bytes.
 */
export function verifySignature(rawBody: Uint8Array | string, signature: string | undefined, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = Buffer.from(createHmac('sha256', channelSecret).update(bytes).digest('base64'), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function isTriggerMessage(text: string): boolean {
  return TRIGGER_WORDS.some((w) => text.includes(w));
}

/** Short, non-reversible id for logs so raw LINE userIds (personal data) never hit CloudWatch. */
export function hashUserId(userId: string | undefined): string | null {
  if (!userId) return null;
  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 12);
}

/** Extract text-message events from a webhook body. Non-text / malformed events are dropped. */
export function parseWebhook(body: string): LineTextEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const events = (parsed as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];

  const out: LineTextEvent[] = [];
  for (const e of events as Array<Record<string, any>>) {
    if (e?.type !== 'message' || e.message?.type !== 'text') continue;
    if (typeof e.replyToken !== 'string' || typeof e.message.text !== 'string') continue;
    const userId = typeof e.source?.userId === 'string' ? (e.source.userId as string) : undefined;
    const webhookEventId = typeof e.webhookEventId === 'string' ? (e.webhookEventId as string) : undefined;
    out.push({
      replyToken: e.replyToken,
      text: e.message.text,
      ...(userId ? { userId } : {}),
      ...(webhookEventId ? { webhookEventId } : {}),
      isRedelivery: e.deliveryContext?.isRedelivery === true,
    });
  }
  return out;
}

/** Parse LINE_ALLOWED_USER_IDS (comma-separated). Unset/empty → empty set (nobody allowed). */
export function parseAllowedUserIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Default-deny: an empty allow-list allows nobody. */
export function isUserAllowed(userId: string | undefined, allowed: ReadonlySet<string>): boolean {
  return !!userId && allowed.has(userId);
}

async function postLine(
  kind: 'line_reply' | 'line_push',
  url: string,
  payload: Record<string, unknown>,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, DETAIL_EXCERPT_LEN);
    logger.error(kind, { status: 'error', httpStatus: res.status, detail });
    throw new Error(`LINE ${kind === 'line_reply' ? 'reply' : 'push'} failed: ${res.status}`);
  }
  logger.info(kind, { status: 'ok' });
}

export async function replyMessage(
  replyToken: string,
  text: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await postLine('line_reply', LINE_REPLY_URL, { replyToken, messages: [{ type: 'text', text }] }, accessToken, fetchImpl);
}

/** Push API: used for results of async runs, after the reply token has been spent. */
export async function pushMessage(
  to: string,
  text: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await postLine('line_push', LINE_PUSH_URL, { to, messages: [{ type: 'text', text }] }, accessToken, fetchImpl);
}
