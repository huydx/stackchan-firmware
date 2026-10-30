import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { LiveTransport } from './live-transport.mjs';

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
    host: env.HOST || '127.0.0.1', port, token, url: url.href, headers, model, protocol,
    backendModel: env.LIVE_BACKEND_MODEL || 'gpt-4.1-mini', greeting: env.BOT_GREETING || '',
    voice: env.REALTIME_VOICE || 'marin',
    instructions: env.BOT_INSTRUCTIONS || 'You are StackChan, a friendly small robot. Speak briefly in Japanese. Show your mood through your face when appropriate. Your voice is AI generated.',
  };
}

export function sessionUpdate(config) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: config.instructions,
      max_output_tokens: 512,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: {
            type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300,
            silence_duration_ms: 500, create_response: true, interrupt_response: false,
          },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: config.voice },
      },
      tools: [{
        type: 'function', name: 'set_expression',
        description: 'Change the robot face to match the conversation.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { expression: { type: 'string', enum: expressions } },
          required: ['expression'],
        },
      }],
      tool_choice: 'auto',
    },
  };
}

function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header || '');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function createRelay(config, log = console) {
  const http = createServer((req, res) => {
    res.writeHead(req.url === '/healthz' ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(req.url === '/healthz' ? 'ok\n' : 'not found\n');
  });
  const devices = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let active;
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/device' || !authorized(req.headers.authorization, config.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } else if (active) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
    } else devices.handleUpgrade(req, socket, head, ws => devices.emit('connection', ws));
  });

  devices.on('connection', device => {
    active = device;
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
    const toCloud = obj => json(upstream, obj);
    const fail = code => {
      if (closed) return;
      log.error(`Realtime session stopped: ${code}`);
      toDevice({ type: 'error', code });
      cleanup();
      device.close(1011, 'Session stopped; reconnect');
    };
    function cleanup() {
      if (closed) return;
      closed = true;
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
    device.on('close', () => { cleanup(); if (active === device) active = undefined; });

    device.on('message', (data, binary) => {
      if (closed) return;
      if (binary) {
        if (data.length !== CHUNK) return fail('invalid_microphone_chunk');
        if (ready && !busy) {
          if (upstream.bufferedAmount > 64 * 1024) return fail('upstream_backpressure');
          toCloud({ type: 'input_audio_buffer.append', audio: data.toString('base64') });
        }
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); } catch { return fail('invalid_device_json'); }
      if (message?.type === 'hello') return;
      if (message?.type === 'played') {
        if (!sentSizes.length || message.bytes !== sentSizes[0]) return fail('invalid_playback_ack');
        inFlight -= sentSizes.shift();
        lastProgress = Date.now();
        pump();
      } else if (message?.type === 'drained') {
        if (!endSent || queuedBytes || inFlight) return fail('invalid_drain');
        started = ending = endSent = busy = false;
        toCloud({ type: 'input_audio_buffer.clear' });
      } else fail('unknown_device_event');
    });

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
        toDevice({ type: 'ready' });
      } else if (event.type === 'error') {
        // Log codes only: never dump request headers, keys, or conversation audio.
        fail(`api_${String(event.error?.code || 'error').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80)}`);
      } else if (event.type === 'response.created') {
        busy = true;
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
          toDevice({ type: 'audio_start' });
        }
        for (let i = 0; i < pcm.length; i += CHUNK) {
          const chunk = Buffer.from(pcm.subarray(i, i + CHUNK));
          queue.push(chunk);
          queuedBytes += chunk.length;
        }
        pump();
      } else if (event.type === 'response.done') {
        if (event.response?.status !== 'completed') return fail('response_incomplete');
        if (!Array.isArray(event.response.output)) return fail('invalid_response_output');
        const calls = event.response.output.filter(item => item?.type === 'function_call');
        for (const call of calls) {
          let result;
          try {
            const args = JSON.parse(call.arguments);
            if (call.name !== 'set_expression' || !expressions.includes(args?.expression)) throw Error();
            toDevice({ type: 'expression', value: args.expression });
            result = { ok: true, expression: args.expression };
          } catch { result = { ok: false, error: 'Unsupported tool or expression' }; }
          toCloud({ type: 'conversation.item.create', item: {
            type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result),
          } });
        }
        if (calls.length) toCloud({ type: 'response.create' });
        else if (started) { ending = true; pump(); }
        else busy = false;
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
    const config = readConfig();
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
