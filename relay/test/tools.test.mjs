import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRunner, toolDefinitions } from '../tools.mjs';

const base = { timeTool: true, weatherTool: true, webSearchTool: true, location: 'Tokyo', timezone: 'Asia/Tokyo',
  searchModel: 'gpt-4.1-mini', headers: { Authorization: 'Bearer test-key' } };
const reply = data => ({ ok: true, json: async () => data });

test('tool schemas are strict-compatible and follow the enabled settings', () => {
  for (const tool of toolDefinitions(base)) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
  }
  assert.deepEqual(toolDefinitions({ ...base, weatherTool: false }).map(tool => tool.name), ['get_current_time', 'web_search']);
  assert.deepEqual(toolDefinitions(base, 'azure').map(tool => tool.name), ['get_current_time', 'get_weather']);
});

test('current time uses the configured or requested time zone', async () => {
  const run = createToolRunner(base);
  const home = await run('get_current_time', { timezone: null });
  assert.equal(home.ok, true);
  assert.equal(home.timezone, 'Asia/Tokyo');
  assert.match(home.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(home.time, /^\d{2}:\d{2}$/);
  assert.equal((await run('get_current_time', { timezone: 'Europe/Paris' })).timezone, 'Europe/Paris');
  assert.equal((await run('get_current_time', { timezone: 'Nowhere/Here' })).ok, false);
});

test('weather geocodes the city and summarizes Open-Meteo data', async () => {
  const urls = [];
  const fetch = async url => {
    urls.push(new URL(url));
    if (url.includes('geocoding')) return reply({ results: [{ name: 'Osaka', admin1: 'Osaka', country: 'Japan', latitude: 34.69, longitude: 135.5 }] });
    return reply({ current: { temperature_2m: 18.2, apparent_temperature: 17, relative_humidity_2m: 60, weather_code: 3, wind_speed_10m: 9 },
      daily: { weather_code: [61, 0], temperature_2m_max: [20, 22], temperature_2m_min: [14, 13], precipitation_probability_max: [80, 5] } });
  };
  const result = await createToolRunner(base, { fetch })('get_weather', { location: 'Osaka' });
  assert.equal(urls[0].searchParams.get('name'), 'Osaka');
  assert.equal(urls[1].searchParams.get('latitude'), '34.69');
  assert.equal(result.location, 'Osaka, Osaka, Japan');
  assert.equal(result.current.conditions, 'overcast');
  assert.deepEqual(result.today, { conditions: 'light rain', high_c: 20, low_c: 14, precipitation_chance_pct: 80 });
  assert.equal(result.tomorrow.conditions, 'clear sky');
  const noHome = await createToolRunner({ ...base, location: '' }, { fetch })('get_weather', { location: null });
  assert.match(noHome.error, /Ask which city/);
});

test('web search calls the Responses API and returns speakable text', async () => {
  let request;
  const fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return reply({ output: [{ type: 'web_search_call' }, { type: 'message', content: [
      { type: 'output_text', text: 'The match ended 2-1 on October 29 ([news.example](https://news.example/a)). See https://x.example for more.' }] }] });
  };
  const result = await createToolRunner(base, { fetch })('web_search', { query: 'latest match result' });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(request.body.tools, [{ type: 'web_search' }]);
  assert.equal(request.body.model, 'gpt-4.1-mini');
  assert.equal(result.answer, 'The match ended 2-1 on October 29. See for more.');
});

test('failures, disabled tools and bad input return errors without leaking details', async () => {
  const logged = [];
  const fetch = async () => ({ ok: false, status: 500 });
  const run = createToolRunner({ ...base, webSearchTool: false }, { fetch, log: { error: line => logged.push(line) } });
  assert.equal((await run('web_search', { query: 'secret plans' })).ok, false);
  const failed = await run('get_weather', { location: 'Secret Town' });
  assert.equal(failed.ok, false);
  assert.ok(logged.length === 1 && !logged[0].includes('Secret'));
  assert.equal((await createToolRunner(base)('web_search', { query: '' })).ok, false);
});

test('search answers drop markdown sections and stay short enough to speak', async () => {
  const long = `${'A fact happened today. '.repeat(40)}## Highlights: - **one** - two`;
  const fetch = async () => reply({ output: [{ type: 'message', content: [{ type: 'output_text', text: long }] }] });
  const { answer } = await createToolRunner(base, { fetch })('web_search', { query: 'news' });
  assert.ok(answer.length <= 700 && answer.endsWith('.'));
  assert.ok(!answer.includes('#') && !answer.includes('Highlights'));
});
