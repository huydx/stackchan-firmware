import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { LiveTransport } from './live-transport.mjs';
import { DEVICE_KEYS, capabilities, loadSettings, publicSettings, saveSettings, validateWifi, withSettings } from './settings.mjs';
import { dashboardHandler } from './dashboard.mjs';
import { createToolRunner, toolDefinitions } from './tools.mjs';

export const CHUNK = 1024;
export const WINDOW = 8192;
export const MAX_QUEUE = 1536 * 1024;
const expressions = ['neutral', 'happy', 'sad', 'angry', 'sleepy'];

export function readConfig(env = process.env) {
  const provider = env.REALTIME_PROVIDER || 'openai';
  if (!['openai', 'azure'].includes(provider)) throw Error('Invalid REALTIME_PROVIDER');
  const token = env.DEVICE_TOKEN;
  if (!token || token.length < 24 || token.startsWith('REPLACE_')) {
    throw Error('Set DEVICE_TOKEN to a random token of at least 24 characters');
  }
  const model = env.REALTIME_MODEL || 'gpt-realtime-2.1-mini';
  const protocol = provider === 'openai' && model.startsWith('gpt-live-') ? 'live' : 'realtime';
  let url, headers;
  if (provider === 'azure') {
    const endpoint = new URL(env.AZURE_OPENAI_ENDPOINT);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
        !env.AZURE_OPENAI_DEPLOYMENT || !env.AZURE_OPENAI_API_KEY) {
      throw Error('Set Azure HTTPS endpoint, deployment, and key');
    }
    url = new URL('/openai/v1/realtime', endpoint);
    url.protocol = 'wss:';
    url.searchParams.set('model', env.AZURE_OPENAI_DEPLOYMENT);
    headers = { 'api-key': env.AZURE_OPENAI_API_KEY };
  } else {
    if (!env.OPENAI_API_KEY) throw Error('Set OPENAI_API_KEY');
    url = new URL(protocol === 'live' ? 'wss://api.openai.com/v1/live/sessions' : 'wss://api.openai.com/v1/realtime');
    if (protocol === 'realtime') url.searchParams.set('model', model);
    headers = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT');
  return {
    host: env.HOST || '127.0.0.1', port, token, url: url.href, headers, model, protocol, provider,
    backendModel: env.LIVE_BACKEND_MODEL || 'gpt-4.1-mini', greeting: env.BOT_GREETING || '',
    voice: env.REALTIME_VOICE || 'marin',
    instructions: env.BOT_INSTRUCTIONS || 'You are StackChan, a friendly small robot. Speak briefly in Japanese. Show your mood through your face when appropriate. Your voice is AI generated.',
  };
}

export function sessionUpdate(config) {
  const settings = publicSettings(config);
  const result = {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: config.instructions,
      max_output_tokens: settings.maxOutputTokens,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          noise_reduction: settings.noiseReduction === 'off' ? null : { type: settings.noiseReduction },
          turn_detection: settings.turnDetection === 'semantic_vad' ? {
            type: 'semantic_vad', eagerness: settings.eagerness,
            create_response: true, interrupt_response: false,
          } : {
            type: 'server_vad', threshold: settings.vadThreshold, prefix_padding_ms: settings.prefixPaddingMs,
            silence_duration_ms: settings.silenceDurationMs, create_response: true, interrupt_response: false,
          },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: config.voice, speed: settings.speed },
      },
      tools: [...settings.expressionTools ? [{
        type: 'function', name: 'set_expression',
        description: 'Change the robot face to match the conversation.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { expression: { type: 'string', enum: expressions } },
          required: ['expression'],
        },
      }] : [], ...toolDefinitions(settings, config.provider)],
    },
  };
  result.session.tool_choice = result.session.tools.length ? 'auto' : 'none';
  if (capabilities(settings.model).reasoning && settings.reasoningEffort !== 'default') {
    result.session.reasoning = { effort: settings.reasoningEffort };
  }
  return result;
}

const text32 = value => typeof value === 'string' ? value.slice(0, 32) : null;

function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header || '');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function createRelay(config, log = console, { fetch } = {}) {
  let active, controls;
  let state = { deviceConnected: false, apiReady: false, activity: 'offline', micFrames: 0,
    playedAudioBytes: 0, queuedAudioMs: 0, lastMicAt: null };
  let lastError = null, deviceInfo = null, wifiChange = null;
  const startedAt = Date.now();
  const deviceConfig = () => {
    const settings = publicSettings(config);
    return { type: 'device_config', volume: settings.speakerVolume, brightness: settings.screenBrightness,
      nod: settings.headNod, nodAngle: settings.nodAngle, nodPeriod: settings.nodPeriodMs };
  };
  const dashboard = dashboardHandler({
    config: () => config,
    status: () => ({ ...state,
      activity: state.activity === 'listening' && Date.now() - state.lastMicAt > 1500 ? 'idle' : state.activity,
      lastError, device: deviceInfo, wifi: wifiChange, model: config.model || 'gpt-realtime-2.1-mini',
      protocol: config.protocol || 'realtime', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }),
    save: async update => {
      const next = withSettings(config, update);
      await saveSettings(next, config.settingsFile);
      const before = publicSettings(config), after = publicSettings(next);
      const deviceOnly = Object.keys(after).every(key => DEVICE_KEYS.includes(key) || after[key] === before[key]);
      config = next;
      // Volume and brightness apply on the robot immediately; anything else needs a new session.
      if (deviceOnly) controls?.configure();
      else if (active) active.close(1000, 'Settings updated');
      return { config, restarted: !deviceOnly && !!active };
    },
    wifi: value => {
      const request = validateWifi(value);
      if (!controls) { const error = Error('Connect the robot before changing its Wi-Fi.'); error.status = 409; throw error; }
      if (wifiChange?.state === 'trying' && Date.now() - wifiChange.startedAt < 90000) {
        const error = Error('A Wi-Fi change is already in progress.'); error.status = 409; throw error;
      }
      // The password goes only to the robot; it is never stored or logged here.
      wifiChange = { state: 'trying', ssid: request.builtin ? null : request.ssid, builtin: !!request.builtin, startedAt: Date.now() };
      controls.wifi(request);
    },
    test: text => {
      if (!controls || !state.apiReady || state.activity === 'speaking' || state.activity === 'thinking') {
        const error = Error('Wait for the robot and API to be ready, with no reply playing.'); error.status = 409; throw error;
      }
      controls.test(text);
    },
    reconnect: () => { if (active) active.close(1000, 'New conversation'); },
  });
  const http = createServer(async (req, res) => {
    if (await dashboard(req, res)) return;
    res.writeHead(req.url === '/healthz' ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(req.url === '/healthz' ? 'ok\n' : 'not found\n');
  });
  const devices = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/device' || !authorized(req.headers.authorization, config.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } else if (active) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
    } else devices.handleUpgrade(req, socket, head, ws => devices.emit('connection', ws));
  });

  devices.on('connection', device => {
    active = device;
    state = { deviceConnected: true, apiReady: false, activity: 'connecting', micFrames: 0,
      playedAudioBytes: 0, queuedAudioMs: 0, lastMicAt: null };
    const session = state;
    device.send(JSON.stringify(deviceConfig()));
    const options = {
      headers: config.headers, maxPayload: 2 * 1024 * 1024,
      perMessageDeflate: false, handshakeTimeout: 10000,
    };
    const upstream = config.protocol === 'live' ? new LiveTransport(config.url, options, config) : new WebSocket(config.url, options);
    if (config.protocol === 'live') upstream.on('usage', usage => {
      log.info?.(`GPT-Live final session seconds: ${Number(usage?.seconds || 0)}`);
    });
    let ready = false, busy = false, started = false, ending = false, endSent = false;
    let queuedBytes = 0, inFlight = 0, closed = false;
    const queue = [], sentSizes = [];
    let cloudAlive = true, deviceAlive = true;
    let lastProgress = Date.now();
    const json = (ws, obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
    const toDevice = obj => json(device, obj);
    const runTool = createToolRunner({ ...config, ...publicSettings(config) }, { fetch, log });
    const toCloud = obj => json(upstream, obj);
    controls = { test: text => toCloud({ type: 'response.create', response: {
      instructions: `Read aloud this test phrase, without taking any actions: ${text}`,
      tool_choice: 'none', max_output_tokens: 512,
    } }),
    configure: () => toDevice(deviceConfig()),
    wifi: request => toDevice({ type: 'wifi_set', ...request }) };
    const fail = code => {
      if (closed) return;
      lastError = { code, at: new Date().toISOString() };
      log.error(`Realtime session stopped: ${code}`);
      toDevice({ type: 'error', code });
      cleanup();
      device.close(1011, 'Session stopped; reconnect');
    };
    function cleanup() {
      if (closed) return;
      closed = true;
      session.apiReady = false;
      clearInterval(heartbeat);
      clearTimeout(setupTimeout);
      queue.length = sentSizes.length = 0;
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      else upstream.close();
    }
    // TCP send completion is not proof of playback. Only device ACKs return credit.
    function pump() {
      while (!closed && queue.length && sentSizes.length < 8 && inFlight + queue[0].length <= WINDOW) {
        const chunk = queue.shift();
        queuedBytes -= chunk.length;
        inFlight += chunk.length;
        sentSizes.push(chunk.length);
        device.send(chunk, { binary: true }, error => { if (error) fail('device_send'); });
      }
      if (ending && !queuedBytes && !inFlight && !endSent) {
        endSent = true;
        toDevice({ type: 'audio_end' });
      }
      session.queuedAudioMs = Math.round((queuedBytes + inFlight) / 48);
    }
    const setupTimeout = setTimeout(() => fail('session_setup_timeout'), 15000);
    const heartbeat = setInterval(() => {
      if (!cloudAlive || !deviceAlive) return fail('heartbeat_timeout');
      if (busy && Date.now() - lastProgress > 45000) return fail('playback_timeout');
      cloudAlive = deviceAlive = false;
      if (upstream.readyState === WebSocket.OPEN) upstream.ping();
      if (device.readyState === WebSocket.OPEN) device.ping();
    }, 15000);
    upstream.on('pong', () => { cloudAlive = true; });
    device.on('pong', () => { deviceAlive = true; });
    upstream.on('open', () => toCloud(sessionUpdate(config)));
    upstream.on('error', () => fail('upstream_connection'));
    upstream.on('close', () => { if (!closed) fail('upstream_closed'); });
    device.on('error', () => { cleanup(); device.terminate(); });
    device.on('close', () => {
      cleanup(); session.deviceConnected = false; session.activity = 'offline';
      if (active === device) { active = undefined; controls = undefined; }
    });

    device.on('message', (data, binary) => {
      if (closed) return;
      if (binary) {
        if (data.length !== CHUNK) return fail('invalid_microphone_chunk');
        if (ready && !busy) {
          ++session.micFrames; session.lastMicAt = Date.now(); session.activity = 'listening';
          if (upstream.bufferedAmount > 64 * 1024) return fail('upstream_backpressure');
          toCloud({ type: 'input_audio_buffer.append', audio: data.toString('base64') });
        }
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); } catch { return fail('invalid_device_json'); }
      if (message?.type === 'hello') return;
      if (message?.type === 'device_status') {
        const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
        const integer = value => Number.isInteger(value) ? value : null;
        deviceInfo = { ssid: text(message.ssid, 32), ip: text(message.ip, 45), rssi: integer(message.rssi),
          savedNetwork: message.savedNetwork === true, storage: message.storage === true,
          volume: integer(message.volume), brightness: integer(message.brightness), at: Date.now() };
        return;
      }
      if (message?.type === 'wifi_result') {
        const result = ['saved', 'forgotten', 'connected_not_saved', 'reverted', 'saved_unavailable', 'storage_unavailable']
          .includes(message.result) ? message.result : 'unknown';
        wifiChange = { ...wifiChange, state: result, ssid: text32(message.ssid), finishedAt: Date.now() };
        return;
      }
      if (message?.type === 'played') {
        if (!sentSizes.length || message.bytes !== sentSizes[0]) return fail('invalid_playback_ack');
        inFlight -= sentSizes.shift();
        session.playedAudioBytes += message.bytes;
        lastProgress = Date.now();
        pump();
      } else if (message?.type === 'drained') {
        if (!endSent || queuedBytes || inFlight) return fail('invalid_drain');
        started = ending = endSent = busy = false;
        session.activity = 'idle';
        toCloud({ type: 'input_audio_buffer.clear' });
      } else fail('unknown_device_event');
    });

    async function call(item) {
      let args;
      try { args = JSON.parse(item.arguments); } catch { return { ok: false, error: 'Invalid arguments' }; }
      if (item.name !== 'set_expression') return runTool(item.name, args);
      if (config.expressionTools === false || !expressions.includes(args?.expression)) return { ok: false, error: 'Unsupported tool or expression' };
      toDevice({ type: 'expression', value: args.expression });
      return { ok: true, expression: args.expression };
    }
    // Lookups can take seconds; the turn stays busy, so the mic waits for the answer.
    async function runCalls(calls) {
      if (!started) session.activity = 'thinking';
      const results = await Promise.all(calls.map(call));
      if (closed) return;
      lastProgress = Date.now();
      calls.forEach((item, index) => toCloud({ type: 'conversation.item.create', item: {
        type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(results[index]),
      } }));
      toCloud({ type: 'response.create' });
    }
    upstream.on('message', (data, binary) => {
      if (closed) return;
      let event;
      try {
        if (binary) throw Error();
        event = JSON.parse(data.toString());
      } catch { return fail('invalid_upstream_json'); }
      if (!event || typeof event.type !== 'string') return fail('invalid_upstream_event');
      lastProgress = Date.now();
      if (event.type === 'session.updated' && !ready) {
        clearTimeout(setupTimeout);
        ready = true;
        session.apiReady = true; session.activity = 'idle'; lastError = null;
        toDevice({ type: 'ready' });
      } else if (event.type === 'error') {
        // Log codes only: never dump request headers, keys, or conversation audio.
        fail(`api_${String(event.error?.code || 'error').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80)}`);
      } else if (event.type === 'response.created') {
        busy = true;
        session.activity = 'thinking';
      } else if (event.type === 'response.output_audio.delta') {
        if (!ready || ending || typeof event.delta !== 'string' ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) {
          return fail('invalid_audio_delta');
        }
        const pcm = Buffer.from(event.delta, 'base64');
        if (pcm.length % 2 || pcm.length + queuedBytes + inFlight > MAX_QUEUE) return fail('audio_overflow');
        if (!pcm.length) return;
        busy = true;
        if (!started) {
          started = true;
          session.activity = 'speaking';
          toDevice({ type: 'audio_start' });
        }
        for (let i = 0; i < pcm.length; i += CHUNK) {
          const chunk = Buffer.from(pcm.subarray(i, i + CHUNK));
          queue.push(chunk);
          queuedBytes += chunk.length;
        }
        pump();
      } else if (event.type === 'response.done') {
        // "incomplete" means the reply hit its token limit: play what arrived and continue.
        if (!['completed', 'incomplete'].includes(event.response?.status)) return fail('response_incomplete');
        if (!Array.isArray(event.response.output)) return fail('invalid_response_output');
        const calls = event.response.output.filter(item => item?.type === 'function_call');
        if (calls.length) runCalls(calls);
        else if (started) { ending = true; pump(); }
        else { busy = false; session.activity = 'idle'; }
      }
    });
  });
  return {
    http,
    listen: () => new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(config.port, config.host, () => {
        http.off('error', reject);
        resolve();
      });
    }),
    close: () => new Promise(resolve => {
      for (const device of devices.clients) device.terminate();
      devices.close();
      http.close(resolve);
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await loadSettings(readConfig());
    const relay = createRelay(config);
    await relay.listen();
    console.log(`StackChan relay listening on ${config.host}:${config.port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      await relay.close();
      process.exit(0);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
