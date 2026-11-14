# mon-spotify-pipeline (v2)

MUSIC ON! TV（エムオン!）の m-on.jp [オンエアリスト](https://www.m-on.jp/oa/) の TSV を取得し、対象番組の楽曲で Spotify プレイリストを上書き更新するパイプライン。

v2 は TypeScript で書き直し、次の2つの実行経路を持つ。

| 経路 | 用途 | エントリ |
|---|---|---|
| ローカル（launchd 毎朝5:00） | その日のTSVを `data/` に保存し、対象番組が放送される日はプレイリストを更新 | `src/local/mon-fetcher-cli.ts` |
| AWS Lambda（[仕様書2](./仕様書2.md)） | EventBridge の定期実行 + LINE Bot からの手動実行・完了通知 | `src/lambda/handler.ts` |

v1 の仕様は [`仕様書.md`](./仕様書.md)、v2 の構想は [`仕様書2.md`](./仕様書2.md)。

## 構成

```
src/
├── core/               # 経路共通
│   ├── fetcher.ts      # TSVダウンロード（CP932 → UTF-8）
│   ├── tsv.ts          # 番組ブロックへのパース・対象番組の抽出（連続枠は統合・重複除去）
│   ├── spotify.ts      # トークン取得/キャッシュ、検索（アーティスト一致優先）、プレイリスト上書き、429/5xxリトライ
│   ├── pipeline.ts     # 取得 → 抽出 → 検索 → 更新
│   ├── config.ts       # 環境変数
│   └── logger.ts       # 1行JSONの構造化ログ
├── local/
│   ├── mon-fetcher-cli.ts  # launchd から呼ぶCLI
│   └── archive.ts          # data/raw/YYYY-MM-DD.tsv, data/programs/YYYY-MM-DD.json
├── line/line.ts        # 署名検証・Webhookパース・返信
└── lambda/handler.ts   # EventBridge / API Gateway(HTTP API) ハンドラ
test/                   # vitest（fixtures に 2026-11-15 の実TSV）
```

## セットアップ

```sh
npm install
cp .env.example .env   # 値を設定
```

Spotify アプリの作成と Refresh Token の取得は v1 と同じ（Redirect URI `http://localhost:8888/callback`、scope は `playlist-modify-public playlist-modify-private`）。2026年2月以降の Development Mode アプリは、所有者の Spotify Premium が必要。

## ローカル実行

```sh
npm run fetch:dry                      # 取得・保存・番組抽出のみ（Spotifyは呼ばない）
npm run fetch                          # プレイリストも更新
npx tsx src/local/mon-fetcher-cli.ts --target "あのころヒッツ" --no-archive
```

- `TARGET_PROGRAM_NAME` が未設定、または Spotify の環境変数が揃っていない場合は、TSV の取得・保存だけ行って正常終了する。
- その日に対象番組が放送されない場合は `program_not_found` を出し、プレイリストは変更しない。
- TSV がオンエアリストの形式でない場合（メンテナンス画面など）や、Spotify の環境変数が一部だけ設定されている場合は失敗とする。失敗時は終了コード 1 で、`fatal` ログを stderr に出力する。
- 保存日付は放送日（6:00〜30:00）で付ける。05:00 の実行では前日分の一覧を前日の日付で保存する（m-on.jp は 6:00 まで前日分を表示している）。
- 検索で1曲も見つからなかった場合は、プレイリストを空にせずに終了コード 1 で終わる。

### launchd

`~/Library/LaunchAgents/com.mon-fetcher.plist`（毎朝5:00、`node node_modules/tsx/dist/cli.mjs src/local/mon-fetcher-cli.ts`、ログは `logs/`）をそのまま使う。

```sh
launchctl load ~/Library/LaunchAgents/com.mon-fetcher.plist     # 有効化
launchctl start com.mon-fetcher                                  # 今すぐ1回実行
launchctl unload ~/Library/LaunchAgents/com.mon-fetcher.plist   # 停止
```

## Lambda

```sh
npm run build:lambda   # dist/lambda/index.mjs（ハンドラ: index.handler, Node.js 20）
```

- 定期実行: EventBridge Scheduler のターゲット Input に `{"trigger":"schedule"}` を設定する（EventBridge Rules の `source: aws.events` / `aws.scheduler` も可）。判定できないイベントは例外にして、失敗として記録されるようにしている。
- LINE: API Gateway HTTP API `POST /webhook`。`X-Line-Signature` を検証し、「作って」「更新」を含むメッセージを受けたら「⏳ 更新を開始しました」と即返信し、自分自身を非同期（`InvocationType: Event`）で呼び出す。結果は push メッセージで届く（API Gateway の30秒上限と LINE の再送を避けるため）。再送イベント（`isRedelivery`）は無視する。
- **`LINE_ALLOWED_USER_IDS` が未設定だと、誰からのメッセージでも実行しない（既定で拒否）。**
- 実行ロールには、CloudWatch Logs の権限に加えて、自分自身に対する `lambda:InvokeFunction` が必要。`@aws-sdk/client-lambda` はランタイム同梱のものを使う（バンドルには含めない）。
- 環境変数は `.env.example` を参照（`LINE_*` は Lambda でのみ使う）。

## 開発

```sh
npm test
npm run typecheck
```

## 既知の制約

- Spotify の検索は表記揺れ（読み仮名、記号、feat. 表記など）で見つからないことがある。見つからない曲は `spotify_search` の `not_found` ログに出してスキップする。
- プレイリストは差分更新ではなく、毎回全件を置き換える。途中で失敗すると一部だけ更新された状態が残る（`PlaylistPartiallyUpdatedError` としてログに出る）。
- Spotify のプレイリスト操作は `/playlists/{id}/items` を使う（2026年3月以降、旧 `/tracks` は 403 を返す）。
