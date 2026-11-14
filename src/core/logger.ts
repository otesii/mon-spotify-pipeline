/**
 * Structured one-line JSON logs (仕様書2: CloudWatch Logs Insights friendly).
 * info → stdout, warn/error → stderr, so launchd and Lambda both capture them.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'info') process.stdout.write(line + '\n');
  else process.stderr.write(line + '\n');
}

export const logger = {
  info: (event: string, fields?: LogFields) => log('info', event, fields),
  warn: (event: string, fields?: LogFields) => log('warn', event, fields),
  error: (event: string, fields?: LogFields) => log('error', event, fields),
};

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { error: err.message, name: err.name };
  return { error: String(err) };
}
