import { readFile } from 'node:fs/promises';
import { MODELS, publicSettings, capabilities } from './settings.mjs';
import { systemTimezone } from './tools.mjs';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
]);
function localRequest(req) {
  const remote = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    if (req.headers.origin && req.headers.origin !== host.origin) return false;
    return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
  } catch { return false; }
}
export function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Error('Use application/json.');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function dashboardHandler(controller) {
  let saving = false;
  return async (req, res) => {
    const route = req.url?.split('?')[0];
    if (!ASSETS.has(route) && !route?.startsWith('/api/admin/')) return false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!localRequest(req)) { json(res, 403, { error: 'Open this dashboard on the relay computer at http://localhost:8080.' }); return true; }
    try {
      if (ASSETS.has(route) && req.method === 'GET') {
        const [file, type] = ASSETS.get(route);
        const data = await readFile(new URL(`public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data);
      } else if (route === '/api/admin/config' && req.method === 'GET') {
        const config = controller.config();
        json(res, 200, { settings: publicSettings(config), capabilities: capabilities(config.model),
          models: MODELS.map(model => ({ ...model, capabilities: capabilities(model.id) })), provider: config.provider || 'openai', systemTimezone: systemTimezone(), restartOnSave: true });
      } else if (route === '/api/admin/status' && req.method === 'GET') {
        json(res, 200, controller.status());
      } else if (route === '/api/admin/config' && req.method === 'PUT') {
        if (saving) { json(res, 409, { error: 'Another settings update is in progress.' }); return true; }
        saving = true;
        try {
          const { config, restarted } = await controller.save(await body(req));
          json(res, 200, { settings: publicSettings(config), capabilities: capabilities(config.model), restarted });
        } finally { saving = false; }
      } else if (route === '/api/admin/test' && req.method === 'POST') {
        const value = await body(req);
        if (typeof value.text !== 'string' || value.text.trim().length < 1 || value.text.length > 300) throw Error('Enter a test phrase of 1–300 characters.');
        controller.test(value.text.trim()); json(res, 200, { ok: true });
      } else if (route === '/api/admin/wifi' && req.method === 'POST') {
        controller.wifi(await body(req)); json(res, 202, { ok: true });
      } else if (route === '/api/admin/look' && req.method === 'POST') {
        const { yaw, pitch } = await body(req);
        if (![yaw, pitch].every(Number.isFinite) || Math.abs(yaw) > 70 || pitch < 0 || pitch > 45) {
          throw Error('Use yaw -70..70 and pitch 0..45 degrees.');
        }
        controller.look({ yaw, pitch }); json(res, 200, { ok: true });
      } else if (route === '/api/admin/servo-test' && req.method === 'POST') {
        await body(req); controller.servoTest(); json(res, 200, { ok: true });
      } else if (route === '/api/admin/camera' && req.method === 'GET') {
        const shot = controller.camera?.();
        if (!shot) { json(res, 404, { error: 'No camera snapshot yet.' }); return true; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store',
          'X-Face': JSON.stringify(shot.face), 'X-Captured-At': String(shot.at) });
        res.end(shot.image);
      } else if (route === '/api/admin/music/stop' && req.method === 'POST') {
        await body(req); controller.stopMusic?.(); json(res, 200, { ok: true });
      } else if (route === '/api/admin/tracking' && req.method === 'GET') {
        json(res, 200, controller.tracking?.() || {});
      } else if (route === '/api/admin/camera/trace' && req.method === 'GET') {
        json(res, 200, controller.faceTrace?.() || []);
      } else if (route === '/api/admin/reconnect' && req.method === 'POST') {
        await body(req); controller.reconnect(); json(res, 200, { ok: true });
      } else json(res, 404, { error: 'Not found.' });
    } catch (error) {
      const message = error instanceof SyntaxError ? 'Invalid JSON.' : error.message;
      json(res, error.status || 400, { error: message });
    }
    return true;
  };
}
