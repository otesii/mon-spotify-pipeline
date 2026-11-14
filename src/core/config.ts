export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface SpotifyConfig extends SpotifyCredentials {
  playlistId: string;
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function requireEnv(env: Env, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`環境変数 ${key} が設定されていません`);
  return v;
}

export function loadSpotifyConfig(env: Env = process.env): SpotifyConfig {
  return {
    clientId: requireEnv(env, 'SPOTIFY_CLIENT_ID'),
    clientSecret: requireEnv(env, 'SPOTIFY_CLIENT_SECRET'),
    refreshToken: requireEnv(env, 'SPOTIFY_REFRESH_TOKEN'),
    playlistId: requireEnv(env, 'SPOTIFY_PLAYLIST_ID'),
  };
}

export function loadTargetProgram(env: Env = process.env): string {
  return requireEnv(env, 'TARGET_PROGRAM_NAME');
}
