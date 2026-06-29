import axios from 'axios';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const CHUNK_SIZE = 100;

export async function getAccessToken() {
  const basicAuth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', process.env.SPOTIFY_REFRESH_TOKEN);

  const response = await axios.post(TOKEN_URL, params, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  return response.data.access_token;
}

export async function searchTracks(tracks) {
  const accessToken = await getAccessToken();
  const uris = [];

  for (const { title, artist } of tracks) {
    const response = await axios.get(`${API_BASE}/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: `track:${title} artist:${artist}`,
        type: 'track',
        limit: 1,
      },
    });

    const item = response.data.tracks?.items?.[0];
    if (!item) {
      console.warn(`Track not found, skipping: "${title}" by "${artist}"`);
      continue;
    }

    uris.push(item.uri);
  }

  return uris;
}

export async function updatePlaylist(playlistId, trackUris) {
  const accessToken = await getAccessToken();
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Clear the playlist first: the replace-items endpoint only accepts up to
  // 100 URIs per call, so a single PUT can't both clear and set a longer
  // list. Clearing with an empty array, then adding in <=100 chunks via POST,
  // works for playlists of any size.
  await axios.put(`${API_BASE}/playlists/${playlistId}/tracks`, { uris: [] }, { headers });

  for (let i = 0; i < trackUris.length; i += CHUNK_SIZE) {
    const chunk = trackUris.slice(i, i + CHUNK_SIZE);
    await axios.post(`${API_BASE}/playlists/${playlistId}/tracks`, { uris: chunk }, { headers });
  }
}
