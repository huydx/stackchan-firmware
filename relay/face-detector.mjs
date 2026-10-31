// Face detection for the robot's camera snapshots, run on this Mac with
// Apple's Vision framework through a small Swift helper (face/FaceDetect.swift).
// Frames stay on this computer; nothing is stored or sent to the cloud.
import { execFile, spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('face/FaceDetect.swift', import.meta.url));
const BINARY = fileURLToPath(new URL('.build/face-detect', import.meta.url));
const TIMEOUT_MS = 3000;

async function build(log) {
  const [source, binary] = await Promise.all([stat(SOURCE), stat(BINARY).catch(() => null)]);
  if (binary && binary.mtimeMs >= source.mtimeMs) return;
  await mkdir(new URL('.build/', import.meta.url), { recursive: true });
  log.info?.('Building the face detection helper…');
  await new Promise((resolve, reject) => execFile('swiftc', ['-O', SOURCE, '-o', BINARY], { timeout: 180000 },
    error => error ? reject(error) : resolve()));
}

// Largest face center, normalized to -1..1 from the image center.
export function largestFace(faces) {
  const face = (Array.isArray(faces) ? faces : []).filter(face => [face?.x, face?.y, face?.w, face?.h].every(Number.isFinite))
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return face ? { found: true, x: face.x * 2 - 1, y: face.y * 2 - 1, w: face.w, h: face.h } : { found: false };
}

export function createFaceDetector({ log = console, platform = process.platform, command = BINARY, prepare = build } = {}) {
  let state = platform === 'darwin' ? 'idle' : 'unavailable';
  let child, ready, buffer = '';
  const waiting = [];
  const settle = value => waiting.shift()?.(value);

  function start() {
    ready ??= prepare(log).then(() => {
      child = spawn(command, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try { settle(largestFace(JSON.parse(line).faces)); } catch { settle({ found: false }); }
        }
      });
      const reset = () => {
        child = undefined; ready = undefined; buffer = '';
        while (waiting.length) settle({ found: false });
      };
      child.on('exit', reset);
      child.on('error', reset);
      child.stdin.on('error', () => {});
      state = 'ready';
    }).catch(error => {
      state = 'unavailable';
      log.error(`Face detection unavailable: ${String(error.message).split('\n')[0].slice(0, 80)}`);
    });
    return ready;
  }

  return {
    get state() { return state; },
    async detect(image) {
      if (state === 'unavailable') return { found: false };
      if (state === 'idle') state = 'starting';
      await start();
      if (!child) return { found: false };
      return new Promise(resolve => {
        const timer = setTimeout(() => { resolve({ found: false }); child?.kill(); }, TIMEOUT_MS);
        waiting.push(value => { clearTimeout(timer); resolve(value); });
        const header = Buffer.alloc(4);
        header.writeUInt32BE(image.length);
        child.stdin.write(Buffer.concat([header, image]));
      });
    },
    close() { child?.kill(); },
  };
}
