// Background relay: wait for private credentials, reload when .env changes.
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createRelay, readConfig } from './server.mjs';

let relay, lastVersion, lastMessage, updating = false;
const report = message => {
  if (message !== lastMessage) console.log(message);
  lastMessage = message;
};
async function refresh() {
  if (updating) return;
  updating = true;
  try {
    const file = new URL('.env', import.meta.url);
    const { mtimeMs } = await stat(file);
    if (mtimeMs === lastVersion) return;
    const env = parseEnv(await readFile(file, 'utf8'));
    let config;
    try { config = readConfig(env); }
    catch {
      report('Waiting for a complete API configuration in the private relay .env file.');
      return;
    }
    if (relay) await relay.close();
    relay = createRelay(config);
    await relay.listen();
    lastVersion = mtimeMs;
    report(`StackChan relay listening on ${config.host}:${config.port}`);
  } catch {
    report('Relay configuration unavailable; retrying.');
  } finally { updating = false; }
}
await refresh();
const timer = setInterval(refresh, 3000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  clearInterval(timer);
  if (relay) await relay.close();
  process.exit(0);
});
