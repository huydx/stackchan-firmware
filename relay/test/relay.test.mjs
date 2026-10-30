import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createRelay, readConfig, CHUNK, WINDOW, MAX_QUEUE } from '../server.mjs';

function inbox(ws) {
  const messages = [], waiters = [];
  ws.on('message', (data, binary) => {
    const message = binary ? Buffer.from(data) : JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(message);
    else messages.push(message);
  });
  return {
    messages,
    next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)),
  };
}
const send = (ws, event) => ws.send(JSON.stringify(event));
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

async function fixture(t) {
  const cloud = new WebSocketServer({ port: 0 });
  await once(cloud, 'listening');
  const errors = [];
  const relay = createRelay({
    host: '127.0.0.1', port: 0, token: 'x'.repeat(32),
    url: `ws://127.0.0.1:${cloud.address().port}`, headers: {},
    voice: 'marin', instructions: 'test bot',
  }, { error: message => errors.push(message) });
  await relay.listen();
  t.after(async () => {
    await relay.close();
    for (const client of cloud.clients) client.terminate();
    await new Promise(resolve => cloud.close(resolve));
  });
  // Attach the cloud inbox synchronously so the relay's session.update cannot race past it.
  const cloudConnected = new Promise(resolve => cloud.once('connection', ws => resolve([ws, inbox(ws)])));
  const device = new WebSocket(`ws://127.0.0.1:${relay.http.address().port}/device`, {
    headers: { Authorization: `Bearer ${'x'.repeat(32)}` },
  });
  const received = inbox(device);
  await once(device, 'open');
  const [upstream, sent] = await cloudConnected;
  const setup = await sent.next();
  assert.deepEqual(await received.next(), { type: 'device_config', volume: 220, brightness: 127 });
  return { relay, cloud, device, received, upstream, sent, setup, errors };
}

test('validates configuration without exposing credentials', () => {
  assert.throws(() => readConfig({}), /DEVICE_TOKEN/);
  assert.throws(() => readConfig({ DEVICE_TOKEN: 'x'.repeat(32) }), /OPENAI_API_KEY/);
  const env = { DEVICE_TOKEN: 'x'.repeat(32), OPENAI_API_KEY: 'secret' };
  const config = readConfig(env);
  assert.equal(config.model, 'gpt-realtime-2.1-mini');
  assert.equal(config.protocol, 'realtime');
  assert.equal(config.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
  const live = readConfig({ ...env, REALTIME_MODEL: 'gpt-live-1' });
  assert.equal(live.protocol, 'live');
  assert.equal(live.url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(config.headers.Authorization, 'Bearer secret');
  const azure = readConfig({ ...env, REALTIME_PROVIDER: 'azure',
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    AZURE_OPENAI_DEPLOYMENT: 'my-deployment', AZURE_OPENAI_API_KEY: 'azure-secret' });
  assert.equal(azure.url, 'wss://example.openai.azure.com/openai/v1/realtime?model=my-deployment');
  assert.equal(azure.headers['api-key'], 'azure-secret');
});

test('gates capture on readiness and rejects unauthenticated connections', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.setup.session.audio.input.format.rate, 24000);
  assert.equal(f.setup.session.audio.input.turn_detection.interrupt_response, false);
  f.device.send(Buffer.alloc(CHUNK));
  await tick();
  assert.equal(f.sent.messages.length, 0);
  send(f.upstream, { type: 'session.updated' });
  assert.deepEqual(await f.received.next(), { type: 'ready' });
  f.device.send(Buffer.alloc(CHUNK, 3));
  const audio = await f.sent.next();
  assert.equal(audio.type, 'input_audio_buffer.append');
  assert.deepEqual(Buffer.from(audio.audio, 'base64'), Buffer.alloc(CHUNK, 3));
  const unauthorized = new WebSocket(`ws://127.0.0.1:${f.relay.http.address().port}/device`);
  unauthorized.on('error', () => {});
  const [, response] = await once(unauthorized, 'unexpected-response');
  assert.equal(response.statusCode, 401);
  response.destroy();
  unauthorized.terminate();
});

test('bounds in-flight PCM, preserves short packets, and waits for playback before listening', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  send(f.upstream, { type: 'session.updated' });
  await f.received.next();
  send(f.upstream, { type: 'response.created' });
  const pcm = Buffer.alloc(WINDOW + 500, 7);
  send(f.upstream, { type: 'response.output_audio.delta', delta: pcm.toString('base64') });
  assert.deepEqual(await f.received.next(), { type: 'audio_start' });
  const result = [];
  for (let i = 0; i < 8; ++i) result.push(await f.received.next());
  await tick();
  assert.equal(f.received.messages.length, 0, 'no more frames before playback ACK');
  send(f.upstream, { type: 'response.done', response: { status: 'completed', output: [] } });
  f.device.send(Buffer.alloc(CHUNK));
  await tick();
  assert.equal(f.sent.messages.length, 0, 'mic blocked during output');
  send(f.device, { type: 'played', bytes: CHUNK });
  const short = await f.received.next();
  assert.equal(short.length, 500);
  result.push(short);
  assert.deepEqual(Buffer.concat(result), pcm);
  for (let i = 0; i < 7; ++i) send(f.device, { type: 'played', bytes: CHUNK });
  send(f.device, { type: 'played', bytes: 500 });
  assert.deepEqual(await f.received.next(), { type: 'audio_end' });
  send(f.device, { type: 'drained' });
  assert.deepEqual(await f.sent.next(), { type: 'input_audio_buffer.clear' });
  f.device.send(Buffer.alloc(CHUNK));
  assert.equal((await f.sent.next()).type, 'input_audio_buffer.append');
});

test('validates tools, returns results, and continues the response once', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  send(f.upstream, { type: 'session.updated' });
  await f.received.next();
  send(f.upstream, { type: 'response.done', response: { status: 'completed', output: [
    { type: 'function_call', name: 'set_expression', call_id: 'valid', arguments: '{"expression":"happy"}' },
    { type: 'function_call', name: 'set_expression', call_id: 'invalid', arguments: '{"expression":"bad"}' },
  ] } });
  assert.deepEqual(await f.received.next(), { type: 'expression', value: 'happy' });
  const valid = await f.sent.next(), invalid = await f.sent.next();
  assert.equal(JSON.parse(valid.item.output).ok, true);
  assert.equal(JSON.parse(invalid.item.output).ok, false);
  assert.deepEqual(await f.sent.next(), { type: 'response.create' });
  assert.equal(f.received.messages.length, 0);
});

test('rejects invalid ACK instead of corrupting playback credit', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  send(f.device, { type: 'played', bytes: CHUNK });
  assert.equal((await f.received.next()).code, 'invalid_playback_ack');
  await once(f.device, 'close');
});

test('closes on audio overflow and releases the upstream session', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  send(f.upstream, { type: 'session.updated' });
  await f.received.next();
  const closed = once(f.upstream, 'close');
  send(f.upstream, { type: 'response.output_audio.delta', delta: Buffer.alloc(MAX_QUEUE / 2).toString('base64') });
  assert.equal((await f.received.next()).type, 'audio_start');
  for (let i = 0; i < 8; ++i) assert.equal((await f.received.next()).length, CHUNK);
  send(f.upstream, { type: 'response.output_audio.delta', delta: Buffer.alloc(MAX_QUEUE / 2 + 2).toString('base64') });
  const error = await f.received.next();
  assert.equal(error.code, 'audio_overflow');
  await closed;
});

test('device disconnect closes the cloud connection', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const closed = once(f.upstream, 'close');
  f.device.close();
  await closed;
});

test('data tool calls run asynchronously before the response continues', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  send(f.upstream, { type: 'session.updated' });
  await f.received.next();
  send(f.upstream, { type: 'response.created' });
  send(f.upstream, { type: 'response.done', response: { status: 'completed', output: [
    { type: 'function_call', name: 'get_current_time', call_id: 'time', arguments: '{"timezone":"Asia/Tokyo"}' },
  ] } });
  const output = await f.sent.next();
  assert.equal(output.item.call_id, 'time');
  const result = JSON.parse(output.item.output);
  assert.equal(result.ok, true);
  assert.equal(result.timezone, 'Asia/Tokyo');
  assert.deepEqual(await f.sent.next(), { type: 'response.create' });
});

test('a reply cut off by its token limit ends normally instead of failing the session', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  send(f.upstream, { type: 'session.updated' });
  await f.received.next();
  send(f.upstream, { type: 'response.created' });
  send(f.upstream, { type: 'response.output_audio.delta', delta: Buffer.alloc(CHUNK).toString('base64') });
  assert.equal((await f.received.next()).type, 'audio_start');
  assert.equal((await f.received.next()).length, CHUNK);
  send(f.upstream, { type: 'response.done', response: { status: 'incomplete', output: [] } });
  send(f.device, { type: 'played', bytes: CHUNK });
  assert.deepEqual(await f.received.next(), { type: 'audio_end' });
  assert.deepEqual(f.errors, []);
});
