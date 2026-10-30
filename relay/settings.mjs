import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validTimezone } from './tools.mjs';

export const SETTINGS_FILE = new URL('settings.json', import.meta.url);
export const MODELS = [
  { id: 'gpt-realtime-2.1-mini', name: 'Realtime 2.1 Mini', description: 'Lower-cost voice conversations' },
  { id: 'gpt-realtime-2.1', name: 'Realtime 2.1', description: 'More capable voice reasoning' },
  { id: 'gpt-live-1', name: 'GPT-Live 1', description: 'Continuous voice · billed by session time' },
  { id: 'gpt-realtime-1.5', name: 'Realtime 1.5', description: 'Original guide model' },
];
const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
const LIVE_VOICES = [...VOICES, 'harema', 'shida', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder', 'nuri', 'juni', 'flitz', 'brise', 'sillage', 'nira', 'noeul'];
const DEFAULTS = {
  model: 'gpt-realtime-2.1-mini', voice: 'marin', instructions: '',
  maxOutputTokens: 512, speed: 1, reasoningEffort: 'default',
  turnDetection: 'server_vad', vadThreshold: 0.5, prefixPaddingMs: 300,
  silenceDurationMs: 500, eagerness: 'auto', noiseReduction: 'off', expressionTools: true,
  backendModel: 'gpt-4.1-mini', speakerVolume: 220, screenBrightness: 127, headNod: true, nodAngle: 6, nodPeriodMs: 2400,
  timeTool: true, weatherTool: true, webSearchTool: true, location: '', timezone: '', searchModel: 'gpt-4.1-mini',
  backendInstructions: 'Control the robot face using set_expression when its mood should change. Use the time, weather and web search tools for current information instead of guessing. You cannot move the robot or control other devices. Return a brief factual result.',
};

// Applied by the robot itself; changing only these needs no new conversation.
export const DEVICE_KEYS = ['speakerVolume', 'screenBrightness', 'headNod', 'nodAngle', 'nodPeriodMs'];

export function capabilities(model) {
  const live = model.startsWith('gpt-live-');
  return { live, realtime: !live, reasoning: /^gpt-realtime-2/.test(model),
    voices: live ? LIVE_VOICES : VOICES,
    reasoningEfforts: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'] };
}

export function publicSettings(config) {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, config[key] ?? fallback]));
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Settings must be an object.');
  for (const [key, val] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw Error(`Unknown setting: ${key}`);
    const text = (max, pattern) => {
      if (typeof val !== 'string' || val.length > max || (pattern && !pattern.test(val))) throw Error(`Invalid ${key}.`);
    };
    const number = (min, max, integer = false) => {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max || (integer && !Number.isInteger(val))) throw Error(`${key} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
    };
    const choice = choices => { if (!choices.includes(val)) throw Error(`Invalid ${key}.`); };
    switch (key) {
      case 'model': case 'backendModel': case 'searchModel': text(100, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/); break;
      case 'voice': choice(LIVE_VOICES); break;
      case 'instructions': case 'backendInstructions': text(12000); break;
      case 'maxOutputTokens': number(16, 4096, true); break;
      case 'speed': number(0.25, 1.5); break;
      case 'vadThreshold': number(0, 1); break;
      case 'prefixPaddingMs': number(0, 2000, true); break;
      case 'silenceDurationMs': number(100, 3000, true); break;
      case 'speakerVolume': case 'screenBrightness': number(0, 255, true); break;
      case 'nodAngle': number(2, 20, true); break;
      case 'nodPeriodMs': number(1000, 5000, true); break;
      case 'reasoningEffort': choice(['default', 'minimal', 'low', 'medium', 'high', 'xhigh']); break;
      case 'turnDetection': choice(['server_vad', 'semantic_vad']); break;
      case 'eagerness': choice(['auto', 'low', 'medium', 'high']); break;
      case 'noiseReduction': choice(['off', 'near_field', 'far_field']); break;
      case 'expressionTools': case 'headNod': case 'timeTool': case 'weatherTool': case 'webSearchTool':
        if (typeof val !== 'boolean') throw Error(`${key} must be true or false.`); break;
      case 'location': text(100); break;
      case 'timezone': if (typeof val !== 'string' || (val && !validTimezone(val))) throw Error('Use an IANA time zone such as Asia/Tokyo, or leave it empty.'); break;
    }
  }
  return value;
}

export function withSettings(config, update) {
  validateSettings(update);
  const settings = { ...publicSettings(config), ...update };
  const caps = capabilities(settings.model);
  if (!caps.voices.includes(settings.voice)) throw Error('That voice is not available for the selected model.');
  const next = { ...config, ...settings };
  if (config.provider !== 'azure') {
    if (!/^gpt-(realtime|live)-/.test(settings.model)) throw Error('Choose a Realtime or GPT-Live voice model.');
    next.protocol = caps.live ? 'live' : 'realtime';
    const url = new URL(caps.live ? 'wss://api.openai.com/v1/live/sessions' : 'wss://api.openai.com/v1/realtime');
    if (!caps.live) url.searchParams.set('model', settings.model);
    next.url = url.href;
  } else if (settings.model !== config.model) throw Error('Change Azure deployment selection in .env.');
  return next;
}

export function validateWifi(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Wi-Fi settings must be an object.');
  if (value.builtin === true && Object.keys(value).length === 1) return { builtin: true };
  const { ssid, password } = value;
  if (Object.keys(value).some(key => !['ssid', 'password'].includes(key))) throw Error('Unknown Wi-Fi field.');
  if (typeof ssid !== 'string' || !ssid.length || Buffer.byteLength(ssid) > 32) throw Error('Network name must be 1–32 bytes.');
  if (typeof password !== 'string' || !(password === '' || /^[\x20-\x7e]{8,63}$/.test(password) || /^[0-9a-fA-F]{64}$/.test(password))) {
    throw Error('Password must be empty (open network) or 8–63 characters.');
  }
  return { ssid, password };
}

export async function loadSettings(config, file = SETTINGS_FILE) {
  try { return withSettings(config, JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return withSettings(config, {}); throw error; }
}

export async function saveSettings(config, file = SETTINGS_FILE) {
  const path = file instanceof URL ? file : pathToFileURL(file);
  const temporary = new URL(`.settings-${randomUUID()}.tmp`, path);
  try {
    await writeFile(temporary, JSON.stringify(publicSettings(config), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
