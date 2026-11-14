import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertOnairTsv, decodeTsv, parseTsv, selectTracks } from '../src/core/tsv.js';

const fixture = decodeTsv(readFileSync(new URL('./fixtures/oa-2026-11-15.cp932.tsv', import.meta.url)));

describe('parseTsv (real 2026-11-15 download)', () => {
  const programs = parseTsv(fixture);

  it('decodes CP932 and groups rows into the 8 program slots', () => {
    expect(programs.map((p) => p.time)).toEqual([
      '6:00～6:30', '6:30～8:30', '8:30～13:00', '13:00～17:30',
      '17:30～21:30', '21:30～23:00', '23:00～25:00', '25:00～30:00',
    ]);
    expect(programs[0]).toMatchObject({ name: '歴代カラオケスーパーヒッツ' });
    expect(programs[0]!.tracks.slice(0, 2)).toEqual([
      { title: 'アルペジオ', artist: '[ALEXANDROS]' },
      { title: 'サザンカ', artist: 'SEKAI NO OWARI' },
    ]);
  });

  it('accounts for every song row', () => {
    const songRows = fixture.split(/\r?\n/).slice(1).filter((l) => l.split('\t')[2]?.trim());
    expect(programs.reduce((n, p) => n + p.tracks.length, 0)).toBe(songRows.length);
  });

  it('selects the target program by substring', () => {
    const { name, tracks } = selectTracks(programs, 'あのころヒッツ');
    expect(name).toBe('あのころヒッツ! 一挙5時間！ 2001→2005年');
    expect(tracks.length).toBeGreaterThan(0);
  });

  it('returns nothing when the program does not air', () => {
    expect(selectTracks(programs, 'あのころヒッツ! 一挙5時間！ 2021→2025年')).toEqual({ name: null, tracks: [] });
  });
});

describe('parseTsv edge cases', () => {
  const tsv = [
    '時間\t番組名\tタイトル\tアーティスト名',
    '1:00～2:00\tShow A\tSong1\tArtist1',
    '\t\tSong2\tArtist2',
    '2:00～3:00\tShow A\tSong1\tArtist1', // same show in next slot, duplicate song
    '\t\tSong3\t',
    '3:00～4:00\tShow B\t\t', // program row without songs
    '',
  ].join('\r\n');

  it('merges consecutive slots of the same show and dedupes', () => {
    expect(selectTracks(parseTsv(tsv), 'Show A').tracks).toEqual([
      { title: 'Song1', artist: 'Artist1' },
      { title: 'Song2', artist: 'Artist2' },
      { title: 'Song3', artist: '' },
    ]);
  });

  it('keeps a program with no songs', () => {
    expect(parseTsv(tsv).at(-1)).toEqual({ time: '3:00～4:00', name: 'Show B', tracks: [] });
  });
});

describe('selectTracks: different shows matching the same substring', () => {
  const tsv = [
    '時間\t番組名\tタイトル\tアーティスト名',
    '1:00～2:00\tあのころヒッツ 2001→2005年\tA\ta',
    '2:00～3:00\tOther\tX\tx',
    '3:00～4:00\tあのころヒッツ 2006→2010年\tB\tb',
  ].join('\n');

  it('takes only the first matching show', () => {
    expect(selectTracks(parseTsv(tsv), 'あのころヒッツ')).toEqual({
      name: 'あのころヒッツ 2001→2005年',
      tracks: [{ title: 'A', artist: 'a' }],
    });
  });
});

describe('assertOnairTsv', () => {
  it('accepts the real download', () => {
    expect(() => assertOnairTsv(fixture, parseTsv(fixture))).not.toThrow();
  });
  it('rejects an HTML maintenance page', () => {
    const html = '<!DOCTYPE html><html><body>メンテナンス中</body></html>';
    expect(() => assertOnairTsv(html, parseTsv(html))).toThrow(/TSVではない/);
  });
  it('rejects a header-only body', () => {
    const t = '時間\t番組名\tタイトル\tアーティスト名\n';
    expect(() => assertOnairTsv(t, parseTsv(t))).toThrow(/1件も/);
  });
});
