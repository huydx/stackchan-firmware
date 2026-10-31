// Song playback for the "sing" tool: yt-dlp finds the top YouTube Music song
// for a query and downloads its audio, which ffmpeg converts to the robot's
// 24 kHz mono PCM with loudness leveled. One song at a time.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_SECONDS = 600;
const START_TIMEOUT_MS = 30000;

// The relay runs as a login service with a minimal PATH, so look in Homebrew too.
export const findTool = name => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  .map(dir => join(dir, name)).find(path => existsSync(path)) || name;

export function createMusicPlayer({ ytdlp = findTool('yt-dlp'), ffmpeg = findTool('ffmpeg'), spawn = nodeSpawn, log = console } = {}) {
  let current = null;

  function stop(reason = 'stopped') {
    if (!current) return;
    const song = current;
    current = null;
    song.stopped = true;
    song.downloader.kill('SIGKILL');
    song.converter.kill('SIGKILL');
    song.finish(reason);
  }

  // Resolves once audio is flowing ({ ok, title, artist, duration }) or with
  // { ok: false } if nothing plays. onAudio returns false to apply back-pressure.
  async function play(query, { onAudio, onEnd }) {
    stop('replaced');
    if (typeof query !== 'string' || !query.trim() || query.length > 200) return { ok: false, error: 'Name a song to play.' };
    const folder = await mkdtemp(join(tmpdir(), 'stackchan-music-'));
    const metaFile = join(folder, 'song.tsv');
    const url = `https://music.youtube.com/search?q=${encodeURIComponent(query.trim())}#songs`;
    const downloader = spawn(ytdlp, ['--no-warnings', '--quiet', '--playlist-items', '1', '-f', 'bestaudio',
      '--match-filter', `duration < ${MAX_SECONDS}`, '--print-to-file', '%(title)s\t%(artist,channel)s\t%(duration)s', metaFile,
      '-o', '-', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    const converter = spawn(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-t', String(MAX_SECONDS), '-vn',
      '-ac', '1', '-ar', '24000', '-af', 'loudnorm=I=-16:TP=-1.5', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    downloader.stdout.pipe(converter.stdin);
    converter.stdin.on('error', () => {});
    downloader.on('error', () => converter.kill('SIGKILL'));

    return new Promise(resolve => {
      let started = false, ended = false;
      const song = { downloader, converter, stopped: false };
      song.finish = reason => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        rm(folder, { recursive: true, force: true }).catch(() => {});
        if (!started) resolve({ ok: false, error: reason === 'timeout' ? 'The song took too long to start.' : 'No playable song was found.' });
        else onEnd(reason);
      };
      current = song;
      const timer = setTimeout(() => { if (!started) stop('timeout'); }, START_TIMEOUT_MS);
      converter.stdout.on('data', chunk => {
        if (song.stopped) return;
        if (!started) {
          // Synchronous, so the first chunk is delivered before the next one.
          started = true;
          let meta = '';
          try { meta = readFileSync(metaFile, 'utf8'); } catch {}
          const [title, artist, duration] = meta.trim().split('\t');
          resolve({ ok: true, title: title || query, artist: artist || null, duration: Number(duration) || null });
        }
        if (onAudio(chunk) === false) converter.stdout.pause();
      });
      converter.on('close', () => {
        if (current === song) current = null;
        if (!song.stopped) song.finish('finished');
      });
      converter.on('error', error => {
        log.error(`Music conversion failed: ${error.code || 'error'}`);
        stop('failed');
      });
    });
  }

  return {
    play,
    stop,
    resume: () => current?.converter.stdout.resume(),
    get playing() { return !!current; },
  };
}
