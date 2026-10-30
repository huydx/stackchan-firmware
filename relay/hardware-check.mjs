// Local hardware exercise through the real relay protocol. No cloud key/API use.
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createRelay, CHUNK } from './server.mjs';

const token = process.env.DEVICE_TOKEN;
if (!token || token.startsWith('REPLACE_')) throw Error('Configure DEVICE_TOKEN in .env first');
const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(cloud, 'listening');
const relay = createRelay({
  host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 8080), token,
  url: `ws://127.0.0.1:${cloud.address().port}`, headers: {}, voice: 'marin', instructions: 'local test',
});
let micFrames = 0, resumedFrames = 0, peak = 0, played = false, sentTone = false;
let finish;
const completed = new Promise(resolve => { finish = resolve; });
const timeout = setTimeout(() => finish(false), 90000);
cloud.on('connection', ws => {
  console.log('Hardware connected; checking microphone and a quiet quarter-second tone.');
  const send = event => ws.send(JSON.stringify(event));
  ws.on('message', data => {
    const event = JSON.parse(data.toString());
    if (event.type === 'session.update') send({ type: 'session.updated' });
    else if (event.type === 'input_audio_buffer.append') {
      const pcm = Buffer.from(event.audio, 'base64');
      if (pcm.length !== CHUNK) return finish(false);
      ++micFrames;
      for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      if (played && ++resumedFrames >= 24) finish(true);
      if (micFrames >= 24 && !sentTone) {
        sentTone = true;
        send({ type: 'response.created' });
        const tone = Buffer.alloc(12000);
        for (let i = 0; i < 6000; ++i) {
          const ramp = Math.min(1, i / 240, (5999 - i) / 240);
          tone.writeInt16LE(Math.round(800 * ramp * Math.sin(2 * Math.PI * 440 * i / 24000)), i * 2);
        }
        send({ type: 'response.output_audio.delta', delta: tone.toString('base64') });
        send({ type: 'response.done', response: { status: 'completed', output: [] } });
      }
    } else if (event.type === 'input_audio_buffer.clear') played = true;
  });
});
await relay.listen();
console.log('Waiting for StackChan on the configured relay port; no cloud API is contacted.');
const ok = await completed;
clearTimeout(timeout);
console.log(JSON.stringify({ passed: ok, microphoneFrames: micFrames, microphonePeak: peak,
  playbackAcknowledgedAndDrained: played, resumedMicrophoneFrames: resumedFrames }));
await relay.close();
for (const ws of cloud.clients) ws.terminate();
await new Promise(resolve => cloud.close(resolve));
process.exitCode = ok ? 0 : 1;
