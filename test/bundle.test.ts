/**
 * Smoke test for the real Lambda bundle (review #1): build with the exact
 * `build:lambda` script into a temp dir, then import the .mjs from an ESM
 * child process (`node -e` would be CJS and hide the missing `require`) and
 * run the schedule path against the CP932 fixture with a stubbed fetch.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'test/fixtures/oa-2026-11-15.cp932.tsv');

const dir = mkdtempSync(join(tmpdir(), 'lambda-bundle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function build(outfile: string): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const script = pkg.scripts['build:lambda'];
  if (!script || !/--outfile=\S+/.test(script)) throw new Error('build:lambda must use --outfile=');
  // Same command as `npm run build:lambda`, only redirected to the temp dir.
  execSync(script.replace(/--outfile=\S+/, `--outfile=${JSON.stringify(outfile)}`), {
    cwd: ROOT,
    env: { ...process.env, PATH: `${join(ROOT, 'node_modules/.bin')}:${process.env.PATH}` },
    stdio: 'pipe',
  });
}

const RUNNER = `
import { readFileSync } from 'node:fs';
const [bundleUrl, fixture] = process.argv.slice(2);
const tsv = readFileSync(fixture);
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  seen.push((init.method ?? 'GET') + ' ' + new URL(url).host);
  if (url.startsWith('https://www.m-on.jp/')) return new Response(tsv, { status: 200 });
  if (url.startsWith('https://accounts.spotify.com/')) {
    return Response.json({ access_token: 'stub', token_type: 'Bearer', expires_in: 3600 });
  }
  if (url.startsWith('https://api.spotify.com/') && url.includes('/search')) return Response.json({ tracks: { items: [] } });
  if (url.startsWith('https://api.spotify.com/')) return Response.json({ snapshot_id: 'x' }, { status: 201 });
  return new Response('unexpected ' + url, { status: 599 });
};
Object.assign(process.env, {
  TARGET_PROGRAM_NAME: 'あのころヒッツ',
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'csecret',
  SPOTIFY_REFRESH_TOKEN: 'rtoken',
  SPOTIFY_PLAYLIST_ID: 'pl',
});
const { handler } = await import(bundleUrl);
const result = await handler({ trigger: 'schedule' });
process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ result, hosts: [...new Set(seen)] }) + '\\n');
`;

describe('Lambda bundle (dist/lambda/index.mjs)', () => {
  it('builds, loads as ESM, decodes CP932 and parses the TSV', { timeout: 20_000 }, () => {
    const bundle = join(dir, 'index.mjs');
    build(bundle);

    const source = readFileSync(bundle, 'utf8');
    expect(source).not.toMatch(/from\s*["']@aws-sdk\/client-lambda["'];?\s*$/m); // external + lazily imported only

    const runner = join(dir, 'run.mjs');
    writeFileSync(runner, RUNNER);
    const out = execFileSync(process.execPath, [runner, pathToFileURL(bundle).href, FIXTURE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    const line = out.split('\n').find((l) => l.startsWith('@@RESULT@@'));
    expect(line, out).toBeDefined();
    const { result, hosts } = JSON.parse(line!.slice('@@RESULT@@'.length)) as {
      result: { program: string | null; fetched: number; added: number };
      hosts: string[];
    };

    // Decoded correctly: the Japanese program name survives CP932 → UTF-8.
    expect(result.program).toContain('あのころヒッツ');
    expect(result.fetched).toBeGreaterThan(0);
    expect(result.added).toBe(0);
    expect(hosts).toContain('GET www.m-on.jp');
  });
});
