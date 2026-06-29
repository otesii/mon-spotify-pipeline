import axios from 'axios';
import iconv from 'iconv-lite';

export async function fetchTracks(targetProgram) {
  const res = await axios.get('https://www.m-on.jp/oa/download/', {
    responseType: 'arraybuffer',
  });
  const text = iconv.decode(Buffer.from(res.data), 'cp932');
  const lines = text.split(/\r?\n/).slice(1);

  const tracks = [];
  let inTarget = false;

  for (const line of lines) {
    const [, program, title, artist] = line.split('\t');

    if (program && program.includes(targetProgram)) {
      inTarget = true;
    } else if (program && inTarget) {
      break;
    }

    if (inTarget && title) {
      tracks.push({ title: title.trim(), artist: artist?.trim() ?? '' });
    }
  }

  return tracks;
}
