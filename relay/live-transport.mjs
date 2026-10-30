import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// Adapt Live's continuous duplex stream to this device's half-duplex player.
// The existing device protocol and its bounded playback-credit queue stay intact.
export class LiveTransport extends EventEmitter {
  constructor(url, options, config) {
    super();
    this.config = config;
    this.socket = new WebSocket(url, options);
    this.input = [];
    this.inputBytes = 0;
    this.deferred = [];
    this.deferredBytes = 0;
    this.calls = new Map();
    this.started = this.closing = this.burst = this.playback = false;
    this.lastSpeech = 0;
    this.sequence = 0;
    this.socket.on('open', () => this.emit('open'));
    this.socket.on('message', (raw, binary) => this.receive(raw, binary));
    this.socket.on('pong', () => this.emit('pong'));
    this.socket.on('error', error => this.emit('error', error));
    this.socket.on('close', (...args) => {
      clearInterval(this.clock);
      clearTimeout(this.closeTimeout);
      this.emit('close', ...args);
    });
  }
  get readyState() { return this.socket.readyState; }
  get bufferedAmount() { return this.socket.bufferedAmount; }
  ping() { this.socket.ping(); }
  legacy(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  sendLive(event) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }
  send(raw) {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.update') {
      const session = {
        model: this.config.model,
        instructions: this.config.instructions + (this.config.expressionTools === false ? '' : ' A backend can change your face expression. Delegate those changes to it.'),
        audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: this.config.voice } },
        delegation: {
          type: 'responses',
          responses: {
            model: this.config.backendModel || 'gpt-4.1-mini',
            instructions: this.config.backendInstructions ?? 'Control the robot face using set_expression when its mood should change. You cannot move the robot or control other devices. Return a brief factual result.',
            max_output_tokens: 256,
            parallel_tool_calls: false,
            tools: event.session.tools.map(tool => ({ ...tool, strict: true })),
          },
        },
      };
      if (this.config.greeting) session.input = [{ type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: this.config.greeting }] }];
      this.sendLive({ type: 'session.start', session });
    } else if (event.type === 'input_audio_buffer.append') {
      if (!this.playback) {
        const pcm = Buffer.from(event.audio, 'base64');
        this.input.push(pcm);
        this.inputBytes += pcm.length;
        if (this.inputBytes > 48000) this.legacy({ type: 'error', error: { code: 'live_input_overflow' } });
      }
    } else if (event.type === 'input_audio_buffer.clear') {
      this.playback = false;
      this.input.length = this.inputBytes = 0;
      const waiting = this.deferred;
      this.deferred = [];
      this.deferredBytes = 0;
      for (const delta of waiting) this.audio(delta);
    } else if (event.type === 'conversation.item.create') {
      this.sendLive({ type: 'response.item.create', item: event.item });
    } else if (event.type === 'response.create') {
      if (event.response?.instructions) this.sendLive({ type: 'session.commentary.append',
        event_id: `commentary_${++this.sequence}`, delegation_id: null, content: event.response.instructions });
      else this.sendLive(event);
    }
  }
  tick() {
    if (!this.started || this.closing) return;
    if (this.socket.bufferedAmount > 64 * 1024) {
      this.legacy({ type: 'error', error: { code: 'live_input_backpressure' } });
      return;
    }
    // Keep the Live audio clock running with silence while the device owns the
    // shared bus for output, or while its microphone is muted.
    const pcm = Buffer.alloc(960); // 20 ms, mono PCM16LE at 24 kHz
    let filled = 0;
    while (!this.playback && this.input.length && filled < pcm.length) {
      const source = this.input[0];
      const take = Math.min(source.length, pcm.length - filled);
      source.copy(pcm, filled, 0, take);
      filled += take;
      this.inputBytes -= take;
      if (take === source.length) this.input.shift();
      else this.input[0] = source.subarray(take);
    }
    this.sendLive({ type: 'session.input_audio.append', audio: pcm.toString('base64') });
    // Live has no per-utterance output-done event and also emits silent frames.
    // Bound an audible burst locally; playback ACKs still decide when to return
    // the hardware bus to the mic. Late audio waits behind the current drain.
    if (this.burst && Date.now() - this.lastSpeech > 700) {
      this.burst = false;
      this.legacy({ type: 'response.done', response: { status: 'completed', output: [] } });
    }
  }
  pump(now = performance.now()) {
    const due = Math.floor((now - this.clockStart) / 20);
    // setInterval(20) accumulates scheduler delay. Derive the sample count from
    // a monotonic clock instead, catching up short scheduling stalls exactly.
    if (due - this.clockFrames > 25) {
      this.legacy({ type: 'error', error: { code: 'live_clock_lag' } });
      return;
    }
    while (this.clockFrames < due && !this.closing) {
      ++this.clockFrames;
      this.tick();
    }
  }
  audio(delta) {
    if (typeof delta !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(delta)) {
      this.legacy({ type: 'error', error: { code: 'invalid_live_audio' } });
      return;
    }
    const pcm = Buffer.from(delta, 'base64');
    if (pcm.length % 2) {
      this.legacy({ type: 'error', error: { code: 'invalid_live_pcm' } });
      return;
    }
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    if (!this.burst && peak <= 32) return; // do not seize the speaker for idle silence
    if (!this.burst && this.playback) {
      this.deferred.push(delta);
      this.deferredBytes += pcm.length;
      if (this.deferredBytes > 1536 * 1024) this.legacy({ type: 'error', error: { code: 'live_output_overflow' } });
      return;
    }
    if (!this.burst) {
      this.burst = this.playback = true;
      this.input.length = this.inputBytes = 0;
      this.lastSpeech = Date.now();
      this.legacy({ type: 'response.created' });
    }
    if (peak > 32) this.lastSpeech = Date.now();
    this.legacy({ type: 'response.output_audio.delta', delta });
  }
  receive(raw, binary) {
    let event;
    try {
      if (binary) throw Error();
      event = JSON.parse(raw.toString());
    } catch {
      this.legacy({ type: 'error', error: { code: 'invalid_live_event' } });
      return;
    }
    if (!event || typeof event.type !== 'string') {
      this.legacy({ type: 'error', error: { code: 'invalid_live_event' } });
      return;
    }
    if (event.type === 'session.started') {
      this.started = true;
      this.clockStart = performance.now();
      this.clockFrames = 0;
      this.clock = setInterval(() => this.pump(), 10);
      this.legacy({ type: 'session.updated' });
      if (this.config.greeting) this.sendLive({ type: 'session.commentary.append',
        event_id: 'startup_greeting', delegation_id: null, content: this.config.greeting });
    } else if (event.type === 'session.output_audio.delta') this.audio(event.delta);
    else if (event.type === 'response.event') {
      const inner = event.event;
      const id = inner?.response_id || inner?.response?.id || this.backendId;
      if (inner?.type === 'response.created') {
        this.backendId = id;
        this.calls.set(id, []);
      } else if (inner?.type === 'response.output_item.done' && inner.item?.type === 'function_call') {
        const calls = this.calls.get(id) || [];
        calls.push(inner.item);
        this.calls.set(id, calls);
      } else if (['response.completed', 'response.done'].includes(inner?.type)) {
        const calls = this.calls.get(id) || [];
        this.calls.delete(id);
        if (calls.length) this.legacy({ type: 'response.done', response: { status: 'completed', output: calls } });
      }
    } else if (event.type === 'error') this.legacy(event);
    else if (event.type === 'session.closed') {
      this.emit('usage', event.usage);
      clearTimeout(this.closeTimeout);
      this.socket.close();
    }
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.clock);
    if (this.started && this.readyState === WebSocket.OPEN) {
      this.sendLive({ type: 'session.close' });
      this.closeTimeout = setTimeout(() => this.socket.terminate(), 5000);
    } else this.socket.close();
  }
  terminate() {
    this.closing = true;
    clearInterval(this.clock);
    clearTimeout(this.closeTimeout);
    this.socket.terminate();
  }
}
