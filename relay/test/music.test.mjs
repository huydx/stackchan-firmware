import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { createMusicPlayer } from '../music.mjs';

const until = async check => { while (!check()) await new Promise(resolve => setTimeout(resolve, 5)); };

// Fake yt-dlp and ffmpeg processes: the test drives their output.
function fakeSpawn() {
  const processes = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.command = command; child.args = args;
    child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.killed = false; child.kill = () => { child.killed = true; child.emit('close'); };
    processes.push(child);
    return child;
  };
  return { spawn, processes };
}

test('plays the top YouTube Music result as 24 kHz mono PCM and reports its title', async () => {
  const { spawn, processes } = fakeSpawn();
  const player = createMusicPlayer({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', spawn });
  const chunks = [];
  let ended;
  const playing = player.play('Idol YOASOBI', { onAudio: chunk => { chunks.push(chunk); return true; }, onEnd: reason => { ended = reason; } });
  await until(() => processes.length === 2);
  const [downloader, converter] = processes;
  assert.ok(downloader.args.at(-1).startsWith('https://music.youtube.com/search?q=Idol%20YOASOBI'));
  assert.deepEqual(converter.args.slice(converter.args.indexOf('-ac'), converter.args.indexOf('-ac') + 4), ['-ac', '1', '-ar', '24000']);
  writeFileSync(downloader.args[downloader.args.indexOf('--print-to-file') + 2], 'Idol\tYOASOBI\t213\n');
  converter.stdout.write(Buffer.alloc(4096));
  assert.deepEqual(await playing, { ok: true, title: 'Idol', artist: 'YOASOBI', duration: 213 });
  assert.equal(player.playing, true);
  converter.emit('close');
  assert.equal(ended, 'finished');
  assert.equal(chunks[0].length, 4096);
});

test('stopping kills both processes, and no audio means not found', async () => {
  const { spawn, processes } = fakeSpawn();
  const player = createMusicPlayer({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', spawn });
  const missing = player.play('no such song', { onAudio: () => true, onEnd() {} });
  await until(() => processes.length === 2);
  processes[1].emit('close');
  assert.equal((await missing).ok, false);
  let ended;
  const playing = player.play('song', { onAudio: () => true, onEnd: reason => { ended = reason; } });
  await until(() => processes.length === 4);
  processes[3].stdout.write(Buffer.alloc(100));
  assert.equal((await playing).ok, true);
  player.stop();
  assert.equal(ended, 'stopped');
  assert.ok(processes[2].killed && processes[3].killed);
  assert.equal((await player.play('', { onAudio() {}, onEnd() {} })).ok, false);
});
