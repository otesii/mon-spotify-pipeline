# mon-spotify-pipeline

MUSIC ON! TV（エムオン!）の m-on.jp オンエアリストTSVを取得し、対象番組の楽曲リストで Spotify プレイリストを自動更新するパイプライン。

詳細仕様は [`../仕様書.md`](../仕様書.md) を参照。

## 構成

```
index.js     # エントリポイント（fetcher → spotify の順に呼び出し）
fetcher.js   # m-on.jp からTSVを取得し、CP932→UTF-8変換・対象番組の楽曲を抽出
spotify.js   # Spotify Web API（Refresh Token方式）でトラック検索・プレイリスト更新
```

## セットアップ

### 1. 依存パッケージのインストール

```sh
npm install
```

### 2. Spotify アプリの作成と Refresh Token の取得

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) でアプリを作成し、`Client ID` / `Client Secret` を取得する
2. アプリの設定で Redirect URI に `http://localhost:8888/callback` を追加する
3. OAuth 2.0 Authorization Code フローで一度だけブラウザ認証を行い、`Refresh Token` を取得する
4. 更新したい Spotify プレイリストの ID（プレイリストURL末尾の文字列）を控える

### 3. 環境変数の設定

```sh
cp .env.example .env
```

`.env` を編集し、以下を設定する。

| 変数名 | 内容 |
|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify アプリの Client ID |
| `SPOTIFY_CLIENT_SECRET` | Spotify アプリの Client Secret |
| `SPOTIFY_REFRESH_TOKEN` | 取得した Refresh Token |
| `SPOTIFY_PLAYLIST_ID` | 更新対象のプレイリスト ID |
| `TARGET_PROGRAM_NAME` | TSV内の番組名（部分一致でフィルタ） |

`.env` は `.gitignore` 済みのため、誤ってコミットされることはない。

## ローカル実行

```sh
npm start
```

成功すると以下のようなログが出力される。

```
72曲を取得
✅ 70曲を更新完了
```

Spotify検索で見つからなかった楽曲は `console.warn` でスキップ通知され、処理は継続する。

## 定期実行（GitHub Actions）

[`.github/workflows/update-playlist.yml`](.github/workflows/update-playlist.yml) により、毎週月曜 9:00 UTC（18:00 JST）に自動実行される。`workflow_dispatch` から手動実行も可能。

リポジトリ側で以下を設定する。

**Settings → Secrets and variables → Actions → Secrets**

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`
- `SPOTIFY_PLAYLIST_ID`

**Settings → Secrets and variables → Actions → Variables**

- `TARGET_PROGRAM_NAME`

ワークフローは `working-directory: mon-spotify-pipeline` を基準に `npm ci && node index.js` を実行するため、`package-lock.json` をコミットしておく必要がある（未コミットの場合は事前に `npm install` を実行すること）。

## 既知の制約

- Spotify Search API は曲名・アーティスト名の表記揺れ（読み仮名、記号、フィーチャリング表記など）でマッチしないことがある。見つからない楽曲はログに warning を出してスキップする。
- プレイリスト更新は差分更新ではなく、毎回全曲を削除して入れ替える完全上書き方式。
