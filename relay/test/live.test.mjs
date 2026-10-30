import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { LiveTransport } from '../live-transport.mjs';
import { sessionUpdate } from '../server.mjs';

function inbox(socket) {
  const pending = [], waiting = [];
  socket.on('message', data => {
    const event = JSON.parse(data.toString());
    if (waiting.length) waiting.shift()(event);
    else pending.push(event);
  });
  return { pending, next: () => pending.length ? Promise.resolve(pending.shift()) :
    new Promise(resolve => waiting.push(resolve)) };
}
async function fixture(t) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const connection = once(server, 'connection');
  const config = { model: 'gpt-live-1', voice: 'marin', instructions: 'Friendly Japanese robot.' };
  const transport = new LiveTransport(`ws://127.0.0.1:${server.address().port}`, {}, config);
  const events = inbox(transport);
  transport.on('error', error => assert.fail(error));
  await once(transport, 'open');
  const [cloud] = await connection;
  const commands = inbox(cloud);
  transport.send(JSON.stringify(sessionUpdate(config)));
  const start = await commands.next();
  cloud.send(JSON.stringify({ type: 'session.started', session: { id: 'live_test' } }));
  assert.equal((await events.next()).type, 'session.updated');
  clearInterval(transport.clock); // deterministic, manually advance the audio clock
  cloud.on('message', raw => {
    if (JSON.parse(raw.toString()).type === 'session.close') cloud.send(JSON.stringify({
      type: 'session.closed', usage: { seconds: 1 } }));
  });
  t.after(async () => {
    const closed = once(transport, 'close');
    transport.close();
    await closed;
    await new Promise(resolve => server.close(resolve));
  });
  return { transport, events, commands, start };
}

test('Live startup keeps gpt-live-1 and delegates the existing expression tool', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.start.type, 'session.start');
  assert.equal(f.start.session.model, 'gpt-live-1');
  assert.deepEqual(f.start.session.audio.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(f.start.session.delegation.responses.tools[0].name, 'set_expression');
});

test('Live input remains clocked and idle output silence does not seize the speaker', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const pcm = Buffer.alloc(1024, 1);
  f.transport.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
  f.transport.tick();
  const input = await f.commands.next();
  assert.equal(input.type, 'session.input_audio.append');
  assert.deepEqual(Buffer.from(input.audio, 'base64'), pcm.subarray(0, 960));
  f.transport.audio(Buffer.alloc(4800).toString('base64'));
  assert.equal(f.events.pending.length, 0);
  f.transport.audio(pcm.toString('base64'));
  assert.equal((await f.events.next()).type, 'response.created');
  assert.equal((await f.events.next()).type, 'response.output_audio.delta');
  f.transport.tick();
  assert.deepEqual(Buffer.from((await f.commands.next()).audio, 'base64'), Buffer.alloc(960));
});

test('Live burst completion waits for a quiet interval and late speech waits for drain', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const delta = Buffer.alloc(1024, 5).toString('base64');
  f.transport.audio(delta);
  await f.events.next(); await f.events.next();
  f.transport.lastSpeech = Date.now() - 701;
  f.transport.tick();
  await f.commands.next();
  assert.equal((await f.events.next()).type, 'response.done');
  f.transport.audio(delta);
  assert.equal(f.events.pending.length, 0, 'late audio cannot enter a closing device burst');
  f.transport.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
  assert.equal((await f.events.next()).type, 'response.created');
  assert.equal((await f.events.next()).delta, delta);
});

test('Live keeps completed function items when backend completion has no output array', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const receive = event => f.transport.receive(Buffer.from(JSON.stringify({ type: 'response.event', event })), false);
  receive({ type: 'response.created', response: { id: 'backend_1' } });
  receive({ type: 'response.output_item.done', response_id: 'backend_1', item: {
    type: 'function_call', call_id: 'face_1', name: 'set_expression', arguments: '{"expression":"happy"}' } });
  receive({ type: 'response.completed', response: { id: 'backend_1', output: [] } });
  const event = await f.events.next();
  assert.equal(event.response.output[0].call_id, 'face_1');
  f.transport.send(JSON.stringify({ type: 'conversation.item.create', item: {
    type: 'function_call_output', call_id: 'face_1', output: '{"ok":true}' } }));
  assert.equal((await f.commands.next()).type, 'response.item.create');
  f.transport.send(JSON.stringify({ type: 'response.create' }));
  assert.equal((await f.commands.next()).type, 'response.create');
});

test('Live sample clock catches scheduler delays without accumulating input latency', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let samples = 0;
  f.transport.sendLive = event => {
    if (event.type === 'session.input_audio.append') samples += Buffer.from(event.audio, 'base64').length / 2;
    else if (event.type === 'session.close') f.transport.socket.close();
  };
  f.transport.clockStart = f.transport.clockFrames = 0;
  for (let step = 1; step <= 100; ++step) f.transport.pump(step * 22.5);
  assert.equal(samples, Math.floor(2250 / 20) * 480);
  assert.equal(f.transport.clockFrames, 112);
});
