import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveDay, broadcastDate } from '../src/local/archive.js';

describe('broadcastDate (day runs 6:00–30:00 JST)', () => {
  it('05:00 JST belongs to the previous day', () => {
    expect(broadcastDate(new Date('2026-11-15T05:00:00+09:00'))).toBe('2026-11-14');
  });
  it('06:00 JST starts a new day', () => {
    expect(broadcastDate(new Date('2026-11-15T06:00:00+09:00'))).toBe('2026-11-15');
  });
});

describe('archiveDay', () => {
  it('writes raw bytes and parsed json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mon-'));
    const raw = new Uint8Array([1, 2, 3]);
    const { rawPath, jsonPath } = await archiveDay(dir, '2026-11-14', raw, []);
    expect(new Uint8Array(await readFile(rawPath))).toEqual(raw);
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({ date: '2026-11-14', programs: [] });
  });

  it('refuses to replace a good archive with a much smaller body', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mon-'));
    await mkdir(path.join(dir, 'raw'), { recursive: true });
    await writeFile(path.join(dir, 'raw', '2026-11-14.tsv'), new Uint8Array(1000));
    await expect(archiveDay(dir, '2026-11-14', new Uint8Array(10), [])).rejects.toThrow(/上書きしません/);
  });
});
