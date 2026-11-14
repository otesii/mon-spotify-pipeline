import type { InvokeCommand } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { type Env, loadSpotifyConfig, loadTargetProgram, requireEnv } from '../core/config.js';
import { errorFields, logger } from '../core/logger.js';
import type { PipelineOptions } from '../core/pipeline.js';
import type { PipelineResult } from '../core/types.js';
import {
  hashUserId,
  isTriggerMessage,
  isUserAllowed,
  parseAllowedUserIds,
  parseWebhook,
  pushMessage,
  replyMessage,
  verifySignature,
} from '../line/line.js';

export const HELP_MESSAGE = '「作って」または「更新」と送るとプレイリストを更新します。';
export const STARTED_MESSAGE = '⏳ 更新を開始しました';

/** Minimal surface of LambdaClient we use; injectable for tests. */
export interface LambdaInvoker {
  send(command: InvokeCommand): Promise<unknown>;
}

export interface HandlerDeps {
  runPipeline: (opts: PipelineOptions) => Promise<PipelineResult>;
  fetchImpl: typeof fetch;
  env: Env;
  /** Created lazily from @aws-sdk/client-lambda (provided by the Lambda runtime) when omitted. */
  lambda?: LambdaInvoker;
}

export interface ScheduleEvent {
  source?: string;
  trigger?: string;
  [key: string]: unknown;
}

/** Payload of the async self-invocation started by a LINE trigger. */
export interface LineRunEvent {
  trigger: 'line';
  userId: string;
}

export type HandlerEvent = APIGatewayProxyEventV2 | ScheduleEvent | LineRunEvent;
export type LineRunResult = { trigger: 'line'; status: PipelineResult['status'] | 'error' };
export type HandlerResult = APIGatewayProxyStructuredResultV2 | PipelineResult | LineRunResult;

// Lazy import keeps the Spotify client out of module init (and out of unit tests).
const defaultRunPipeline: HandlerDeps['runPipeline'] = async (opts) =>
  (await import('../core/pipeline.js')).runPipeline(opts);

function isHttpEvent(event: HandlerEvent): event is APIGatewayProxyEventV2 {
  return typeof event === 'object' && event !== null && ('requestContext' in event || 'headers' in event);
}

function isScheduleEvent(event: HandlerEvent): boolean {
  const e = event as ScheduleEvent;
  return e.source === 'aws.scheduler' || e.source === 'aws.events' || e.trigger === 'schedule';
}

function isLineRunEvent(event: HandlerEvent): event is LineRunEvent {
  const e = event as Partial<LineRunEvent>;
  return e.trigger === 'line' && typeof e.userId === 'string' && e.userId !== '';
}

function header(headers: APIGatewayProxyEventV2['headers'] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function http(statusCode: number, body: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body };
}

export function formatResult(r: PipelineResult): string {
  switch (r.status) {
    case 'updated':
      return `✅ ${r.program} ${r.added}曲でプレイリストを更新しました（見つからなかった曲: ${r.skipped.length}）`;
    case 'dry_run':
      return `ℹ️ (dry run) ${r.program ?? '番組'}: ${r.fetched}曲を照合しました（プレイリストは変更していません）`;
    case 'program_not_found':
      return '⚠️ 対象の番組が番組表に見つかりませんでした（プレイリストは変更していません）';
    case 'no_tracks_found':
      return `⚠️ ${r.program ?? '番組'}の${r.fetched}曲がSpotifyで1曲も見つかりませんでした（プレイリストは変更していません）`;
    default: {
      const unknownStatus: never = r.status;
      logger.warn('unknown_pipeline_status', { status: String(unknownStatus) });
      return '⚠️ 更新結果を確認できませんでした';
    }
  }
}

/** User-facing error text: a generic category only. Details stay in the logs. */
export function formatError(err: unknown): string {
  const e = err as { name?: unknown; status?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  let category = '内部エラー';
  if (name === 'SpotifyApiError' && typeof e?.status === 'number') category = `Spotify API エラー (${e.status})`;
  else if (name === 'ConfigError') category = '設定エラー';
  else if (name === 'TimeoutError' || name === 'AbortError') category = 'タイムアウト';
  return `❌ ${category}が発生しました`;
}

export function createHandler(overrides: Partial<HandlerDeps> = {}) {
  const deps: HandlerDeps = {
    runPipeline: overrides.runPipeline ?? defaultRunPipeline,
    fetchImpl: overrides.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    env: overrides.env ?? process.env,
    ...(overrides.lambda ? { lambda: overrides.lambda } : {}),
  };

  /** Margin left for pushing the result after the pipeline gives up. */
  const DEADLINE_MARGIN_MS = 5_000;

  const execute = (deadlineMs?: number) =>
    deps.runPipeline({
      target: loadTargetProgram(deps.env),
      spotify: loadSpotifyConfig(deps.env),
      fetchImpl: deps.fetchImpl,
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    });

  async function lambda(): Promise<LambdaInvoker> {
    if (!deps.lambda) {
      const { LambdaClient } = await import('@aws-sdk/client-lambda');
      deps.lambda = new LambdaClient({});
    }
    return deps.lambda;
  }

  /** Fire-and-forget self invocation (InvocationType 'Event') so the webhook can answer immediately. */
  async function startAsyncRun(userId: string): Promise<void> {
    const functionName = requireEnv(deps.env, 'AWS_LAMBDA_FUNCTION_NAME');
    const { InvokeCommand } = await import('@aws-sdk/client-lambda');
    const payload: LineRunEvent = { trigger: 'line', userId };
    await (await lambda()).send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload), 'utf8'),
      }),
    );
    logger.info('async_invoke', { status: 'ok', user: hashUserId(userId) });
  }

  async function handleSchedule(): Promise<PipelineResult> {
    logger.info('invoke', { trigger: 'schedule' });
    try {
      const result = await execute();
      if (result.status !== 'updated') logger.warn('playlist_not_updated', { trigger: 'schedule', status: result.status });
      return result;
    } catch (err) {
      logger.error('pipeline_error', { trigger: 'schedule', ...errorFields(err) });
      throw err; // let Lambda/Scheduler record the failure
    }
  }

  /**
   * Async leg of a LINE trigger: run the pipeline and push the result.
   * Never throws — an async-invoke failure would make Lambda retry and run the pipeline again.
   */
  async function handleLineRun(event: LineRunEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<LineRunResult> {
    const user = hashUserId(event.userId);
    logger.info('invoke', { trigger: 'line_run', user });

    let accessToken: string;
    try {
      accessToken = requireEnv(deps.env, 'LINE_CHANNEL_ACCESS_TOKEN');
    } catch (err) {
      logger.error('config_error', errorFields(err));
      return { trigger: 'line', status: 'error' };
    }
    // Defence in depth: the payload should only come from our own webhook leg.
    if (!isUserAllowed(event.userId, parseAllowedUserIds(deps.env.LINE_ALLOWED_USER_IDS))) {
      logger.warn('line_user_ignored', { trigger: 'line_run', user });
      return { trigger: 'line', status: 'error' };
    }

    let text: string;
    let status: LineRunResult['status'];
    try {
      const deadlineMs =
        typeof context?.getRemainingTimeInMillis === 'function'
          ? Date.now() + context.getRemainingTimeInMillis() - DEADLINE_MARGIN_MS
          : undefined;
      const result = await execute(deadlineMs);
      status = result.status;
      text = formatResult(result);
    } catch (err) {
      logger.error('pipeline_error', { trigger: 'line', ...errorFields(err) });
      status = 'error';
      text = formatError(err);
    }
    try {
      await pushMessage(event.userId, text, accessToken, deps.fetchImpl);
    } catch (err) {
      logger.error('line_push_error', errorFields(err));
    }
    return { trigger: 'line', status };
  }

  async function handleWebhook(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    logger.info('invoke', { trigger: 'line' });
    const rawBytes = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0);

    let secret: string;
    let accessToken: string;
    try {
      secret = requireEnv(deps.env, 'LINE_CHANNEL_SECRET');
      accessToken = requireEnv(deps.env, 'LINE_CHANNEL_ACCESS_TOKEN');
    } catch (err) {
      logger.error('config_error', errorFields(err));
      return http(500, 'server misconfigured');
    }

    if (!verifySignature(rawBytes, header(event.headers, 'x-line-signature'), secret)) {
      logger.warn('line_signature', { status: 'invalid' });
      return http(401, 'invalid signature');
    }

    const events = parseWebhook(rawBytes.toString('utf8'));
    const allowed = parseAllowedUserIds(deps.env.LINE_ALLOWED_USER_IDS);
    if (events.length > 0 && allowed.size === 0) {
      logger.warn('line_allowlist_empty', { message: 'LINE_ALLOWED_USER_IDS is not set; all LINE triggers are denied' });
    }

    let started = false;
    for (const ev of events) {
      const user = hashUserId(ev.userId);
      if (ev.isRedelivery) {
        logger.info('line_redelivery_skipped', { user, webhookEventId: ev.webhookEventId ?? null });
        continue;
      }
      if (!isUserAllowed(ev.userId, allowed)) {
        logger.warn('line_user_ignored', { user });
        continue;
      }

      let text: string;
      if (!isTriggerMessage(ev.text)) {
        text = HELP_MESSAGE;
      } else if (started) {
        logger.info('line_trigger_collapsed', { user });
        continue; // at most one pipeline run per request
      } else {
        started = true;
        try {
          await startAsyncRun(ev.userId!);
          text = STARTED_MESSAGE;
        } catch (err) {
          logger.error('async_invoke_error', errorFields(err));
          text = formatError(err);
        }
      }
      try {
        await replyMessage(ev.replyToken, text, accessToken, deps.fetchImpl);
      } catch (err) {
        logger.error('line_reply_error', errorFields(err));
      }
    }
    // Always 200 after a valid signature so LINE does not retry.
    return http(200, 'OK');
  }

  return async function handler(
    event: HandlerEvent,
    context?: Pick<Context, 'getRemainingTimeInMillis'>,
  ): Promise<HandlerResult> {
    if (isScheduleEvent(event)) return handleSchedule();
    if (isLineRunEvent(event)) return handleLineRun(event, context);
    if (isHttpEvent(event)) return handleWebhook(event);
    const keys = typeof event === 'object' && event !== null ? Object.keys(event) : [];
    logger.error('unknown_event', { keys });
    // Throw so Lambda/Scheduler records a failure (e.g. a Scheduler target missing {"trigger":"schedule"}).
    throw new Error(`Unrecognised event (keys: ${keys.join(',') || 'none'}); expected {"trigger":"schedule"}`);
  };
}

export const handler = createHandler();
