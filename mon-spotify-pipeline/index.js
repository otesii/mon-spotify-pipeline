import 'dotenv/config';
import { fetchTracks } from './fetcher.js';
import { searchTracks, updatePlaylist } from './spotify.js';

const tracks = await fetchTracks(process.env.TARGET_PROGRAM_NAME);
console.log(`${tracks.length}曲を取得`);
const trackIds = await searchTracks(tracks);
await updatePlaylist(process.env.SPOTIFY_PLAYLIST_ID, trackIds);
console.log(`✅ ${trackIds.length}曲を更新完了`);
