import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { get } from 'node:http';
import { createRelay, readConfig, sessionUpdate } from '../server.mjs';
import { loadSettings, withSettings } from '../settings.mjs';

async function waitFor(check, timeout = 2000) {
  for (const end = Date.now() + timeout; !check(); await new Promise(resolve => setTimeout(resolve, 10))) {
    if (Date.now() > end) throw Error('Timed out waiting for condition.');
  }
}

async function connectReadyDevice(f) {
  f.cloud.on('connection', socket => socket.on('message', raw => {
    if (JSON.parse(raw).type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
  }));
  const device = new WebSocket(f.url.replace('http:', 'ws:') + '/device', {
    headers: { Authorization: `Bearer ${f.base.token}` },
  });
  const received = [];
  device.on('message', raw => received.push(JSON.parse(raw)));
  await waitFor(() => received.some(message => message.type === 'ready'));
  return { device, received };
}

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'stackchan-dashboard-'));
  const file = pathToFileURL(join(folder, 'settings.json'));
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(cloud, 'listening');
  const base = { ...readConfig({ DEVICE_TOKEN: 'device-test-token-0123456789', OPENAI_API_KEY: 'private-test-api-credential' }),
    host: '127.0.0.1', port: 0, settingsFile: file, url: `ws://127.0.0.1:${cloud.address().port}` };
  const relay = createRelay(base, { error() {} });
  await relay.listen();
  const url = `http://127.0.0.1:${relay.http.address().port}`;
  const put = (data, headers = {}) => fetch(`${url}/api/admin/config`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  t.after(async () => {
    await relay.close();
    for (const client of cloud.clients) client.terminate();
    await new Promise(resolve => cloud.close(resolve));
    await rm(folder, { recursive: true, force: true });
  });
  return { file, base, relay, cloud, url, put };
}

test('dashboard serves local assets and only exposes editable settings', async t => {
  const f = await fixture(t);
  const html = await fetch(f.url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /StackChan Studio/);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const response = await fetch(`${f.url}/api/admin/config`);
  const data = await response.json();
  assert.equal(data.settings.model, 'gpt-realtime-2.1-mini');
  assert.equal(data.capabilities.reasoning, true);
  assert.equal(data.models.find(model => model.id === 'gpt-live-1').capabilities.live, true);
  const text = JSON.stringify(data);
  assert.ok(!text.includes('private-test-api-credential') && !text.includes(f.base.token));
  assert.equal(data.settings.headers, undefined);
  assert.equal((await fetch(`${f.url}/settings.json`)).status, 404);
});

test('settings persist atomically with private permissions and load on restart', async t => {
  const f = await fixture(t);
  const instructions = '短く日本語で話してください。\nLiteral text: <script>alert(1)</script>';
  const response = await f.put({ instructions, speed: 0.85, maxOutputTokens: 256,
    reasoningEffort: 'low', noiseReduction: 'far_field' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.settings.instructions, instructions);
  assert.equal(data.restarted, false, 'no robot session was open to restart');
  const stored = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(stored.instructions, instructions);
  assert.equal(stored.token, undefined);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const loaded = await loadSettings(f.base, f.file);
  assert.equal(loaded.speed, 0.85);
  assert.equal(loaded.token, f.base.token);
  assert.equal(loaded.headers.Authorization, f.base.headers.Authorization);
});

test('rejects unsupported fields, invalid values, foreign origins and rebound hosts', async t => {
  const f = await fixture(t);
  for (const value of [{ temperature: 0.7 }, { speed: 2 }, { maxOutputTokens: 100000 },
    { instructions: [] }, { expressionTools: 'yes' }, { token: 'replace-token' }]) {
    assert.equal((await f.put(value)).status, 400);
  }
  assert.equal((await f.put({ speed: 0.9 }, { Origin: 'https://untrusted.example' })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    get(`${f.url}/api/admin/config`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
});

test('applying settings closes the old device session after persistence', async t => {
  const f = await fixture(t);
  f.cloud.on('connection', socket => socket.on('message', raw => {
    if (JSON.parse(raw).type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
  }));
  const device = new WebSocket(f.url.replace('http:', 'ws:') + '/device', {
    headers: { Authorization: `Bearer ${f.base.token}` },
  });
  const received = [];
  device.on('message', raw => received.push(JSON.parse(raw)));
  await waitFor(() => received.some(message => message.type === 'ready'));
  assert.deepEqual(received[0], { type: 'device_config', volume: 220, brightness: 127 });
  assert.equal((await (await fetch(`${f.url}/api/admin/status`)).json()).apiReady, true);
  const closed = once(device, 'close');
  assert.equal((await f.put({ instructions: 'New conversation instructions.' })).status, 200);
  await closed;
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).instructions, 'New conversation instructions.');
  assert.equal((await (await fetch(`${f.url}/api/admin/status`)).json()).apiReady, false);
});

test('supported controls map to API fields and incompatible controls are omitted', () => {
  const base = readConfig({ DEVICE_TOKEN: 'device-test-token-0123456789', OPENAI_API_KEY: 'test-credential' });
  const config = withSettings(base, { speed: 0.9, reasoningEffort: 'high', maxOutputTokens: 256,
    turnDetection: 'semantic_vad', eagerness: 'low', noiseReduction: 'near_field', expressionTools: false });
  const update = sessionUpdate(config).session;
  assert.equal(update.audio.output.speed, 0.9);
  assert.deepEqual(update.reasoning, { effort: 'high' });
  assert.equal(update.max_output_tokens, 256);
  assert.equal(update.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(update.audio.input.turn_detection.eagerness, 'low');
  assert.equal(update.audio.input.noise_reduction.type, 'near_field');
  assert.deepEqual(update.tools.map(tool => tool.name), ['get_current_time', 'get_weather', 'web_search']);
  assert.equal(update.tool_choice, 'auto');
  const none = sessionUpdate(withSettings(config, { timeTool: false, weatherTool: false, webSearchTool: false })).session;
  assert.deepEqual(none.tools, []);
  assert.equal(none.tool_choice, 'none');
  assert.throws(() => withSettings(base, { timezone: 'Mars/Olympus' }), /time zone/);
  assert.equal(withSettings(base, { timezone: 'Asia/Tokyo', location: 'Tokyo' }).timezone, 'Asia/Tokyo');
  const older = sessionUpdate(withSettings(config, { model: 'gpt-realtime-1.5' })).session;
  assert.equal(older.reasoning, undefined);
  assert.throws(() => withSettings(base, { voice: 'harema' }), /voice/);
});

test('test voice requires a connected, ready session', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/api/admin/test`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(response.status, 409);
});

test('volume and brightness apply live without restarting the conversation', async t => {
  const f = await fixture(t);
  const { device, received } = await connectReadyDevice(f);
  let closed = false;
  device.on('close', () => { closed = true; });
  const response = await f.put({ speakerVolume: 150, screenBrightness: 40 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).restarted, false);
  await waitFor(() => received.some(message => message.type === 'device_config' && message.volume === 150));
  assert.deepEqual(received.at(-1), { type: 'device_config', volume: 150, brightness: 40 });
  assert.equal(closed, false);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).screenBrightness, 40);
  for (const value of [{ speakerVolume: 256 }, { screenBrightness: -1 }, { speakerVolume: 1.5 }]) {
    assert.equal((await f.put(value)).status, 400);
  }
  device.close();
});

test('Wi-Fi changes are validated, forwarded to the robot, and never stored', async t => {
  const f = await fixture(t);
  const post = data => fetch(`${f.url}/api/admin/wifi`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post({ ssid: 'Home', password: 'password123' })).status, 409, 'robot offline');
  const { device, received } = await connectReadyDevice(f);
  for (const value of [{ ssid: '', password: 'password123' }, { ssid: 'x'.repeat(33), password: '' },
    { ssid: 'Home', password: 'short' }, { ssid: 'Home', password: 'password123', extra: 1 }, { builtin: 'yes' }]) {
    assert.equal((await post(value)).status, 400);
  }
  device.send(JSON.stringify({ type: 'device_status', ssid: 'Old', ip: '192.168.0.9', rssi: -51,
    savedNetwork: false, storage: true, volume: 220, brightness: 127 }));
  assert.equal((await post({ ssid: 'Home 5', password: 'password123' })).status, 202);
  await waitFor(() => received.some(message => message.type === 'wifi_set'));
  assert.deepEqual(received.at(-1), { type: 'wifi_set', ssid: 'Home 5', password: 'password123' });
  assert.equal((await post({ builtin: true })).status, 409, 'one change at a time');
  device.send(JSON.stringify({ type: 'wifi_result', result: 'saved', ssid: 'Home 5' }));
  let status;
  for (const end = Date.now() + 2000; status?.wifi?.state !== 'saved' && Date.now() < end;) {
    status = await (await fetch(`${f.url}/api/admin/status`)).json();
  }
  assert.equal(status.device.ssid, 'Old');
  assert.equal(status.device.rssi, -51);
  assert.equal(status.wifi.state, 'saved');
  assert.ok(!JSON.stringify(status).includes('password123'));
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
  assert.equal(status.deviceConnected, true, 'status messages do not end the session');
  device.close();
});
