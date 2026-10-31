// Live-information tools the voice model can call. Results are short JSON
// for speech; failures return { ok: false } instead of throwing.
const TIMEOUT_MS = 15000;
const WEATHER_CODES = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
  82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm',
  96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};
// Nullable rather than optional parameters, so the schemas also work in strict mode (GPT-Live backend).
const DEFINITIONS = {
  get_current_time: {
    setting: 'timeTool',
    description: 'Get the current local date, time and weekday. Use it whenever the answer depends on today or now; never guess.',
    properties: { timezone: { type: ['string', 'null'], description: 'IANA time zone such as Asia/Tokyo, or null for the robot\'s home time zone.' } },
  },
  get_weather: {
    setting: 'weatherTool',
    description: 'Get current weather and the forecast for today and tomorrow. Never guess the weather.',
    properties: { location: { type: ['string', 'null'], description: 'City name, preferably in English, or null for the robot\'s home location.' } },
  },
  // Named play_song, not sing: the voice models decline requests to sing.
  play_song: {
    setting: 'musicTool',
    description: 'Play a real recording of a song from YouTube Music on your speaker. Whenever the user asks you to sing, play, or put on a song or music, call this right away instead of declining: you cannot sing with your own voice, but you can play the song. Say one short line first, such as "Here it comes!", then stay silent while it plays. The user taps the screen to stop it.',
    properties: { query: { type: 'string', description: 'Song title and artist, e.g. "Idol YOASOBI".' } },
  },
  web_search: {
    setting: 'webSearchTool',
    description: 'Search the web for news, recent events, prices, schedules or other facts that may have changed. Say a short phrase such as "let me check" first.',
    properties: { query: { type: 'string', description: 'A concise search query.' } },
  },
};

export const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function validTimezone(value) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

export function toolDefinitions(settings, provider = 'openai') {
  return Object.entries(DEFINITIONS)
    // Web search uses OpenAI's Responses API, which an Azure deployment key cannot call.
    .filter(([name, tool]) => settings[tool.setting] && !(name === 'web_search' && provider === 'azure'))
    .map(([name, tool]) => ({
      type: 'function', name, description: tool.description,
      parameters: { type: 'object', additionalProperties: false, properties: tool.properties, required: Object.keys(tool.properties) },
    }));
}

async function getJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return response.json();
}

function currentTime(settings, timezone) {
  const zone = timezone || settings.timezone || systemTimezone();
  if (!validTimezone(zone)) return { ok: false, error: `Unknown time zone ${zone}.` };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(part => [part.type, part.value]));
  return { ok: true, timezone: zone, date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday };
}

async function weather(settings, fetchImpl, location) {
  const name = (location || settings.location || '').trim();
  if (!name) return { ok: false, error: 'No location is set. Ask which city.' };
  const geo = await getJson(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: '1', format: 'json' })}`);
  const place = geo.results?.[0];
  if (!place) return { ok: false, error: `Could not find ${name}.` };
  const query = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'auto', forecast_days: '2',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  });
  const data = await getJson(fetchImpl, `https://api.open-meteo.com/v1/forecast?${query}`);
  const day = index => ({ conditions: WEATHER_CODES[data.daily?.weather_code?.[index]] ?? 'unknown',
    high_c: data.daily?.temperature_2m_max?.[index], low_c: data.daily?.temperature_2m_min?.[index],
    precipitation_chance_pct: data.daily?.precipitation_probability_max?.[index] });
  return { ok: true, location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    current: { conditions: WEATHER_CODES[data.current?.weather_code] ?? 'unknown', temperature_c: data.current?.temperature_2m,
      feels_like_c: data.current?.apparent_temperature, humidity_pct: data.current?.relative_humidity_2m,
      wind_kmh: data.current?.wind_speed_10m }, today: day(0), tomorrow: day(1) };
}

// Models sometimes append markdown lists despite instructions; keep only the
// prose, without formatting, cut at a sentence boundary.
function speakable(text, max = 700) {
  const prose = text.split(/(?:^|\s)#{1,6}\s/)[0].replace(/\*\*|__|`/g, '').trim();
  if (prose.length <= max) return prose;
  const cut = prose.slice(0, max), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'));
  return end > 0 ? cut.slice(0, end + 1) : cut;
}

async function webSearch(config, fetchImpl, query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) return { ok: false, error: 'Give a short search query.' };
  const data = await getJson(fetchImpl, 'https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: config.headers?.Authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.searchModel || 'gpt-4.1-mini', tools: [{ type: 'web_search' }], input: query.trim(),
      instructions: `Search the web, then answer in at most three short sentences for a voice assistant. Include dates when relevant. No URLs, citations or markdown. Today is ${currentTime(config).date}.`,
      max_output_tokens: 300,
    }),
  });
  const text = (data.output || []).flatMap(item => item?.type === 'message' ? item.content || [] : [])
    .filter(part => part?.type === 'output_text').map(part => part.text).join(' ')
    .replace(/\(\s*\[[^\]]+\]\([^)]*\)\s*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\(?https?:\/\/\S+\)?/g, '').replace(/\s+/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  const answer = speakable(text);
  return answer ? { ok: true, answer } : { ok: false, error: 'The search returned no answer.' };
}

// Returns a runner for one session. Settings come from the session's config.
export function createToolRunner(config, { fetch: fetchImpl = globalThis.fetch, log = console } = {}) {
  const enabled = new Set(toolDefinitions(config, config.provider).map(tool => tool.name));
  return async (name, args) => {
    if (!enabled.has(name)) return { ok: false, error: 'Unsupported tool.' };
    try {
      if (name === 'get_current_time') return currentTime(config, args?.timezone);
      if (name === 'get_weather') return await weather(config, fetchImpl, args?.location);
      return await webSearch(config, fetchImpl, args?.query);
    } catch (error) {
      // Log the tool and failure class only, never the query or location.
      log.error(`Tool ${name} failed: ${error.name === 'TimeoutError' ? 'timeout' : String(error.message).slice(0, 40)}`);
      return { ok: false, error: 'The lookup failed. Say you could not check right now.' };
    }
  };
}
