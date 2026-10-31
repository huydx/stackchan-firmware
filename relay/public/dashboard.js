const $ = id => document.getElementById(id);
const form = $('settingsForm');
let saved, models = [], selectedCaps, provider, busy = false, latestStatus;
let toastTimer, polling = false;
const numeric = new Set(['speed', 'maxOutputTokens', 'vadThreshold', 'prefixPaddingMs', 'silenceDurationMs', 'speakerVolume', 'screenBrightness', 'nodAngle', 'nodPeriodMs']);
const percent = value => `${Math.round(Number(value) / 255 * 100)}%`;

async function api(path, options = {}) {
  const response = await fetch(`/api/admin/${path}`, { ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(6000) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'The relay could not complete the request.');
  return data;
}
function notify(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 5500);
}
function values() {
  const data = { ...saved };
  for (const key of Object.keys(data)) {
    const input = form.elements.namedItem(key);
    if (input) data[key] = input.type === 'checkbox' ? input.checked : numeric.has(key) ? Number(input.value) : input.value;
  }
  return data;
}
function changed() { return saved && JSON.stringify(values()) !== JSON.stringify(saved); }
function updateDirty() {
  const dirty = changed();
  $('saveState').textContent = busy ? 'Applying settings…' : dirty ? 'You have unsaved changes' : 'All changes saved';
  $('dirtyDot').classList.toggle('unsaved', !!dirty);
  $('saveButton').disabled = busy || !dirty;
  $('discardButton').disabled = busy || !dirty;
  $('promptCount').textContent = `${$('instructions').value.length.toLocaleString()} / 12,000`;
  $('speedValue').textContent = `${Number(form.elements.speed.value).toFixed(2)}×`;
  $('thresholdValue').textContent = Number(form.elements.vadThreshold.value).toFixed(2);
  $('volumeValue').textContent = percent(form.elements.speakerVolume.value);
  $('brightnessValue').textContent = percent(form.elements.screenBrightness.value);
  $('nodAngleValue').textContent = `${form.elements.nodAngle.value}°`;
  $('nodPeriodValue').textContent = `${(Number(form.elements.nodPeriodMs.value) / 1000).toFixed(1)} s`;
  $('nodAngle').disabled = $('nodPeriodMs').disabled = !$('headNod').checked;
  $('trackReverseX').disabled = $('trackReverseY').disabled = !$('faceTracking').checked;
}
function updateCapabilities() {
  const model = $('model').value;
  const option = models.find(item => item.id === model);
  selectedCaps = option?.capabilities || selectedCaps;
  const live = selectedCaps.live;
  const previousVoice = $('voiceSelect').value || saved?.voice;
  $('voiceSelect').replaceChildren(...selectedCaps.voices.map(voice => new Option(voice.charAt(0).toUpperCase() + voice.slice(1), voice)));
  $('voiceSelect').value = selectedCaps.voices.includes(previousVoice) ? previousVoice : 'marin';
  $('modelHelp').textContent = option?.description || 'Use a voice model available to your API account.';
  $('liveNote').hidden = !live;
  $('backendSettings').hidden = !live;
  $('speed').disabled = live;
  $('speedHelp').textContent = live ? 'For GPT-Live, ask for a faster or slower style in the prompt.' : 'Changes the playback pace of generated speech.';
  $('reasoningEffort').disabled = !selectedCaps.reasoning;
  $('reasoningHelp').textContent = selectedCaps.reasoning ? 'More reasoning can use more tokens and add delay.' : 'This model does not expose Realtime reasoning effort.';
  $('maxOutputTokens').disabled = live;
  $('tokensHelp').textContent = live ? 'GPT-Live manages speech continuously; no per-reply token limit here.' : 'A ceiling for each reply, including tool calls. Not a word count.';
  $('turnSettings').disabled = live;
  $('turnHelp').textContent = live ? 'GPT-Live handles turn-taking. The robot still pauses its mic during playback.' : 'The robot automatically replies after your turn. Its microphone pauses during playback.';
  const semantic = $('turnDetection').value === 'semantic_vad';
  $('silenceSettings').hidden = semantic;
  $('silenceSettings').disabled = live || semantic;
  $('semanticSettings').hidden = !semantic;
  form.elements.eagerness.disabled = live || !semantic;
}
function populate(settings) {
  saved = settings;
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (input) { if (input.type === 'checkbox') input.checked = value; else input.value = value; }
  }
  updateCapabilities(); $('voiceSelect').value = settings.voice; updateDirty();
}
function renderStatus(status) {
  latestStatus = status;
  const ready = status.deviceConnected && status.apiReady;
  $('connectionBadge').className = `badge ${ready ? '' : 'warning'}`;
  $('connectionText').textContent = ready ? 'Robot connected' : status.deviceConnected ? 'Connecting to model' : 'Robot offline';
  $('apiDot').classList.toggle('ready', ready);
  document.querySelector('.session-card').classList.toggle('speaking', status.activity === 'speaking');
  const labels = { offline: 'Waiting for the robot', connecting: 'Connecting to the model', listening: 'Listening', idle: 'Ready when you are', thinking: 'Thinking…', speaking: 'Speaking' };
  $('activityText').textContent = labels[status.activity] || 'Ready when you are';
  $('activityHelp').textContent = !status.deviceConnected ? 'Start the Realtime app on your StackChan.' : !status.apiReady ? 'The relay is setting up the voice session.' : status.activity === 'speaking' ? 'Playing audio. The microphone is paused.' : 'Talk to your robot to start a conversation.';
  $('runningModel').textContent = status.model;
  $('apiState').textContent = status.apiReady ? 'Ready' : 'Not ready';
  $('micState').textContent = status.activity === 'speaking' ? 'Paused for playback' : status.lastMicAt && Date.now() - status.lastMicAt < 1500 ? 'Streaming' : 'Idle';
  $('audioQueued').textContent = `${status.queuedAudioMs || 0} ms`;
  $('testButton').disabled = !ready || ['thinking', 'speaking'].includes(status.activity) || busy;
  $('reconnectButton').disabled = !status.deviceConnected || busy;
  renderWifi(status);
  renderCamera(status);
  $('nowPlaying').hidden = !status.music;
  if (status.music) $('songTitle').textContent = [status.music.title, status.music.artist].filter(Boolean).join(' · ');
  if (status.lastError) {
    $('pageError').textContent = `The last session reported ${status.lastError.code}. Review your settings or choose another model.`;
    $('pageError').hidden = false;
  } else $('pageError').hidden = true;
}
const wifiMessages = {
  saved: ssid => ['', `Connected to ${ssid} and saved. The robot will use it from now on.`],
  forgotten: ssid => ['', `Saved network forgotten. The robot is back on its built-in network (${ssid}).`],
  connected_not_saved: ssid => ['error', `Connected to ${ssid}, but the robot couldn't save it. It will return to its previous network after a restart.`],
  storage_unavailable: () => ['error', "The robot's storage isn't available, so the network can't be saved or forgotten."],
  reverted: () => ['error', "The robot couldn't reach this relay through the new network, so it went back to the previous one. Check the name, password, and that it's a 2.4 GHz network on this LAN."],
  saved_unavailable: ssid => ['error', `The saved network wasn't available at startup, so the robot is using its built-in network (${ssid}).`],
};
function renderWifi(status) {
  const device = status.device, wifi = status.wifi, connected = status.deviceConnected;
  const signal = rssi => rssi == null ? '—' : `${rssi >= -60 ? 'Strong' : rssi >= -70 ? 'Good' : 'Weak'} · ${rssi} dBm`;
  $('wifiSsid').textContent = device?.ssid || '—';
  $('wifiSignal').textContent = connected ? signal(device?.rssi) : '—';
  $('wifiIp').textContent = device?.ip || '—';
  $('wifiCurrent').textContent = !connected ? 'Robot offline' : !device ? 'Waiting for robot' : device.savedNetwork ? 'Saved network' : 'Built-in network';
  const trying = wifi?.state === 'trying' && Date.now() - wifi.startedAt < 90000;
  // Older firmware never reports device_status, so Wi-Fi can't be managed yet.
  const manageable = connected && device && !trying && !busy;
  $('wifiSwitchButton').disabled = !manageable || !$('wifiNewSsid').value.trim();
  $('wifiBuiltinButton').hidden = !device?.savedNetwork;
  $('wifiBuiltinButton').disabled = !manageable;
  let notice = null;
  if (connected && !device) notice = ['', 'Waiting for the robot to report its network. Older robot firmware cannot change Wi-Fi from here.'];
  else if (trying) notice = ['', wifi.builtin ? 'Switching the robot back to its built-in network… This can take up to 30 seconds.' : `Switching the robot to ${wifi.ssid}… It will reconnect within 30 seconds.`];
  else if (wifi?.state === 'trying') notice = ['error', "The robot hasn't reported back about the Wi-Fi change. Check the robot's screen."];
  else if (wifi?.finishedAt && Date.now() - wifi.finishedAt < 300000) notice = (wifiMessages[wifi.state] || (() => ['error', 'The robot reported an unknown Wi-Fi result.']))(wifi.ssid);
  $('wifiNotice').hidden = !notice;
  if (notice) { $('wifiNotice').className = `notice ${notice[0]}`; $('wifiNotice').textContent = notice[1]; }
}
function renderCamera(status) {
  const camera = status.deviceConnected ? status.device?.camera : null;
  const labels = { face: 'Face found', searching: 'Looking', off: 'Off', unavailable: 'No camera' };
  $('cameraState').textContent = status.faceDetector === 'unavailable' ? 'Detector unavailable' : labels[camera] || '—';
  $('cameraHelp').textContent = status.faceDetector === 'unavailable'
    ? "This Mac couldn't start face detection (it needs macOS and the Swift compiler). Check the relay log."
    : camera === 'unavailable' ? "The robot's camera didn't start. Restart the robot to try again."
    : "The camera looks for faces; this Mac detects them. Snapshots stay on this Mac and aren't saved.";
}
async function changeWifi(request, message) {
  $('wifiSwitchButton').disabled = $('wifiBuiltinButton').disabled = true;
  try {
    await api('wifi', { method: 'POST', body: JSON.stringify(request) });
    $('wifiNewPassword').value = '';
    notify(message);
  } catch (error) { notify(error.message, true); }
  finally { await refreshStatus(); }
}
async function refreshStatus() {
  if (polling) return;
  polling = true;
  try { renderStatus(await api('status')); }
  catch {
    $('connectionBadge').className = 'badge warning'; $('connectionText').textContent = 'Relay unavailable';
    $('testButton').disabled = $('reconnectButton').disabled = true;
  } finally { polling = false; }
}
form.addEventListener('input', updateDirty);
form.addEventListener('change', () => { updateCapabilities(); updateDirty(); });
$('discardButton').addEventListener('click', () => populate(saved));
form.addEventListener('submit', async event => {
  event.preventDefault(); if (!form.reportValidity() || busy || !changed()) return;
  const settings = values(); busy = true; updateDirty();
  try {
    const result = await api('config', { method: 'PUT', body: JSON.stringify(settings) });
    selectedCaps = result.capabilities; populate(result.settings);
    notify(result.restarted ? 'Saved. Your robot will reconnect with a new conversation.' : 'Saved and applied.');
    await refreshStatus();
  } catch (error) { notify(error.message, true); }
  finally { busy = false; updateDirty(); }
});
$('testButton').addEventListener('click', async () => {
  $('testButton').disabled = true;
  try { await api('test', { method: 'POST', body: JSON.stringify({ text: $('testPhrase').value }) }); notify('Voice test requested using the saved settings.'); }
  catch (error) { notify(error.message, true); }
  finally { setTimeout(refreshStatus, 1000); }
});
$('wifiNewSsid').addEventListener('input', () => { if (latestStatus) renderWifi(latestStatus); });
for (const id of ['wifiNewSsid', 'wifiNewPassword']) {
  // Enter here switches networks rather than submitting the settings form.
  $(id).addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!$('wifiSwitchButton').disabled) $('wifiSwitchButton').click();
  });
}
$('wifiSwitchButton').addEventListener('click', () => {
  const ssid = $('wifiNewSsid').value.trim();
  changeWifi({ ssid, password: $('wifiNewPassword').value }, `Sent ${ssid} to the robot. Watch for it to reconnect.`);
});
$('wifiBuiltinButton').addEventListener('click', () => changeWifi({ builtin: true }, 'Switching the robot back to its built-in network.'));
$('stopMusicButton').addEventListener('click', async () => {
  try { await api('music/stop', { method: 'POST', body: '{}' }); notify('Stopping the song.'); }
  catch (error) { notify(error.message, true); }
  finally { await refreshStatus(); }
});
$('reconnectButton').addEventListener('click', async () => {
  $('reconnectButton').disabled = true;
  try { await api('reconnect', { method: 'POST', body: '{}' }); notify('Starting a new conversation. Your saved settings stay the same.'); }
  catch (error) { notify(error.message, true); }
  finally { await refreshStatus(); }
});
window.addEventListener('beforeunload', event => { if (changed()) { event.preventDefault(); event.returnValue = ''; } });
async function init() {
  try {
    const data = await api('config'); models = data.models; selectedCaps = data.capabilities; provider = data.provider;
    $('model').replaceChildren(...models.map(model => new Option(model.name, model.id)));
    if (!models.some(model => model.id === data.settings.model)) $('model').add(new Option(data.settings.model, data.settings.model));
    $('model').disabled = provider === 'azure'; $('providerNote').hidden = provider !== 'azure';
    $('timezone').placeholder = data.systemTimezone;
    if (provider === 'azure') {
      $('webSearchTool').disabled = $('searchModel').disabled = true;
      $('searchHelp').textContent = 'Web search needs an OpenAI API key; it is not available with Azure.';
    }
    populate(data.settings); await refreshStatus(); setInterval(refreshStatus, 2000);
  } catch (error) { $('pageError').hidden = false; $('pageError').textContent = `Couldn't load the dashboard: ${error.message}`; }
}
init();

// ---- Face tracking panel ----------------------------------------------------
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (parent, tag, attrs = {}, text) => {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text != null) el.textContent = text;
  parent.appendChild(el);
  return el;
};
const MODES = {
  resting: ['Resting', 'Home pose, servos relaxed. A voice starts a search (not within 30 s of giving up); a face in view starts centering right away.'],
  searching: ['Searching', 'Sweeping ±50° at 12°/s on two heights, for up to 20 s. A face starts centering; nothing found means giving up.'],
  centering: ['Centering', 'Turning toward the face for 5–10 s, measured from where each snapshot was taken, even through missed detections. Locks once centered after 5 s, or at 10 s.'],
  locked: ['Locked on', 'Staying with the face, correcting only outside the center dead zone. If the face is gone for 3 s, it searches again.'],
  givingup: ['Giving up', 'A 20 s search found nobody, so the head is returning to its home pose before resting.'],
  waking: ['Waking', 'Servo power is cycling; the servos take about a second to boot before they accept commands.'],
  look: ['Look test', 'A manual look command from the admin API is pointing the head for a few seconds.'],
  testing: ['Self-test', 'The servo self-test is running; automatic motion is paused.'],
  off: ['Off', 'Face tracking is switched off in Robot settings. The head only nods while speaking.'],
  unavailable: ['Unavailable', 'The body controller or servos are not available, so the head cannot move.'],
};
const CORE = { resting: [70, 130], searching: [215, 45], centering: [395, 45], locked: [495, 150], givingup: [215, 212] };
const EDGES = [
  ['resting', 'searching', 'M88 112 Q110 55 162 45', [104, 70], 'voice heard'],
  ['searching', 'centering', 'M267 45 L342 45', [305, 37], 'face found'],
  ['centering', 'locked', 'M440 60 Q480 85 492 132', [496, 92], '5–10 s'],
  ['locked', 'searching', 'M446 158 Q330 150 236 63', [350, 146], 'gone 3 s'],
  ['searching', 'givingup', 'M206 63 L206 194', [172, 130], '20 s, none'],
  ['givingup', 'resting', 'M163 215 Q95 212 74 149', [100, 206], 'home'],
  ['resting', 'centering', 'M118 140 Q260 115 360 62', [262, 118], 'face seen'],
];
const tracker = { built: false, nodes: {}, edges: [], mode: null, firedTimer: 0, polling: false, visible: false, lastImageAt: 0 };

function buildTracker() {
  const graph = $('stateGraph');
  const defs = svgEl(graph, 'defs');
  const glow = svgEl(defs, 'filter', { id: 'tracker-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  svgEl(glow, 'feGaussianBlur', { stdDeviation: '3', result: 'blur' });
  const merge = svgEl(glow, 'feMerge');
  svgEl(merge, 'feMergeNode', { in: 'blur' });
  svgEl(merge, 'feMergeNode', { in: 'SourceGraphic' });
  const marker = svgEl(defs, 'marker', { id: 'tracker-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '6', markerHeight: '6', orient: 'auto' });
  svgEl(marker, 'path', { d: 'M0 0 L8 4 L0 8 z', fill: '#5d8278' });
  for (const [from, to, d, [lx, ly], label] of EDGES) {
    const group = svgEl(graph, 'g', { class: 'edge' });
    svgEl(group, 'path', { d, 'marker-end': 'url(#tracker-arrow)' });
    svgEl(group, 'text', { x: lx, y: ly, 'text-anchor': 'middle' }, label);
    tracker.edges.push({ from, to, group });
  }
  for (const [mode, [x, y]] of Object.entries(CORE)) {
    const group = svgEl(graph, 'g', { class: 'node' });
    group.style.setProperty('--accent', `var(--m-${mode})`);
    svgEl(group, 'rect', { class: 'ring', x: x - 50, y: y - 17, width: 100, height: 34, rx: 17 });
    svgEl(group, 'rect', { x: x - 50, y: y - 17, width: 100, height: 34, rx: 17 });
    svgEl(group, 'text', { x, y }, MODES[mode][0].toUpperCase());
    tracker.nodes[mode] = group;
  }
  tracker.aux = svgEl(graph, 'g', { class: 'aux-pill' });
  tracker.auxRect = svgEl(tracker.aux, 'rect', { x: 8, y: 8, width: 120, height: 24, rx: 12 });
  tracker.auxText = svgEl(tracker.aux, 'text', { x: 68, y: 20 });
  tracker.aux.setAttribute('display', 'none');

  const overlay = $('cameraOverlay');
  svgEl(overlay, 'line', { class: 'overlay-guide', x1: 160, y1: 0, x2: 160, y2: 240 });
  svgEl(overlay, 'line', { class: 'overlay-guide', x1: 0, y1: 120, x2: 320, y2: 120 });
  svgEl(overlay, 'rect', { class: 'overlay-zone', x: 144, y: 108, width: 32, height: 24 });
  tracker.faceLine = svgEl(overlay, 'line', { class: 'overlay-line', x1: 160, y1: 120, x2: 160, y2: 120 });
  tracker.faceBox = svgEl(overlay, 'rect', { class: 'overlay-face', x: 0, y: 0, width: 0, height: 0, rx: 4 });

  // Yaw: top-down, robot facing up; positive yaw is the robot's left (screen left).
  const yaw = $('yawDial'), yc = [110, 112], yr = 88;
  const yawPoint = (deg, r = yr) => [yc[0] - r * Math.sin(deg * Math.PI / 180), yc[1] - r * Math.cos(deg * Math.PI / 180)];
  const arc = (from, to, point) => { const [a, b] = [point(from), point(to)]; return `M${a[0]} ${a[1]} A${yr} ${yr} 0 0 ${from > to ? 1 : 0} ${b[0]} ${b[1]}`; };
  svgEl(yaw, 'path', { class: 'dial-track', d: arc(70, -70, yawPoint) });
  tracker.yawSweep = svgEl(yaw, 'path', { class: 'dial-sweep', d: arc(50, -50, yawPoint), opacity: 0 });
  for (const deg of [-60, -30, 0, 30, 60]) {
    const [a, b] = [yawPoint(deg, yr - 9), yawPoint(deg, yr + 7)];
    svgEl(yaw, 'line', { class: 'dial-tick', x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  }
  svgEl(yaw, 'text', { class: 'dial-label', x: 8, y: 124 }, 'ITS LEFT');
  svgEl(yaw, 'text', { class: 'dial-label', x: 170, y: 124 }, 'ITS RIGHT');
  tracker.yawTarget = svgEl(yaw, 'line', { class: 'dial-target', x1: yc[0], y1: yc[1], x2: yc[0], y2: yc[1] - yr });
  tracker.yawNeedle = svgEl(yaw, 'line', { class: 'dial-needle', x1: yc[0], y1: yc[1], x2: yc[0], y2: yc[1] - yr + 6 });
  svgEl(yaw, 'circle', { class: 'dial-hub', cx: yc[0], cy: yc[1], r: 5 });
  tracker.yawValue = svgEl(yaw, 'text', { class: 'dial-value', x: yc[0], y: yc[1] - 26 }, '0°');
  tracker.yawPoint = yawPoint;

  // Pitch: side view, facing right; 0° level, up to 45°.
  const pitch = $('pitchDial'), pc = [22, 112], pr = 100;
  const pitchPoint = (deg, r = pr) => [pc[0] + r * Math.cos(deg * Math.PI / 180), pc[1] - r * Math.sin(deg * Math.PI / 180)];
  const [p0, p1] = [pitchPoint(0), pitchPoint(45)];
  svgEl(pitch, 'path', { class: 'dial-track', d: `M${p0[0]} ${p0[1]} A${pr} ${pr} 0 0 0 ${p1[0]} ${p1[1]}` });
  for (const deg of [0, 15, 30, 45]) {
    const [a, b] = [pitchPoint(deg, pr - 9), pitchPoint(deg, pr + 7)];
    svgEl(pitch, 'line', { class: 'dial-tick', x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  }
  svgEl(pitch, 'text', { class: 'dial-label', x: 100, y: 124 }, 'LEVEL');
  tracker.pitchTarget = svgEl(pitch, 'line', { class: 'dial-target', x1: pc[0], y1: pc[1], x2: p0[0], y2: p0[1] });
  tracker.pitchNeedle = svgEl(pitch, 'line', { class: 'dial-needle', x1: pc[0], y1: pc[1], x2: p0[0] - 6, y2: p0[1] });
  svgEl(pitch, 'circle', { class: 'dial-hub', cx: pc[0], cy: pc[1], r: 5 });
  tracker.pitchValue = svgEl(pitch, 'text', { class: 'dial-value', x: 70, y: 62 }, '0°');
  tracker.pitchPoint = pitchPoint;

  $('timelineLegend').replaceChildren(...['resting', 'searching', 'centering', 'locked', 'givingup'].map(mode => {
    const item = document.createElement('span');
    item.style.setProperty('--swatch', `var(--m-${mode})`);
    item.textContent = MODES[mode][0];
    return item;
  }));
  tracker.built = true;
}

const setLine = (line, [x, y]) => { line.setAttribute('x2', x.toFixed(1)); line.setAttribute('y2', y.toFixed(1)); };

function renderTracker(data) {
  const panel = $('vision');
  const head = data.connected && data.head && Date.now() - data.head.at < 3000 ? data.head : null;
  const mode = !data.connected ? null : head ? head.mode : data.enabled === false ? 'off' : 'waking';
  panel.style.setProperty('--accent', mode ? `var(--m-${mode})` : 'var(--m-off)');
  $('trackerChip').textContent = !mode ? 'Robot offline' : MODES[mode][0] + (head?.nod ? ' · nodding' : '');
  $('explainTitle').textContent = mode ? MODES[mode][0] : 'Robot offline';
  $('explainText').textContent = mode ? MODES[mode][1] : 'Connect the robot to see its tracking state.';

  for (const [name, node] of Object.entries(tracker.nodes)) node.classList.toggle('active', name === mode);
  const aux = mode && !CORE[mode];
  tracker.aux.setAttribute('display', aux ? 'inline' : 'none');
  if (aux) tracker.auxText.textContent = MODES[mode][0].toUpperCase();
  if (mode !== tracker.mode) {
    // Light up the transition just taken.
    for (const edge of tracker.edges) edge.group.classList.toggle('fired', edge.from === tracker.mode && edge.to === mode);
    clearTimeout(tracker.firedTimer);
    tracker.firedTimer = setTimeout(() => tracker.edges.forEach(edge => edge.group.classList.remove('fired')), 2500);
    tracker.mode = mode;
  }

  // Gaze dials (tenths of a degree from the robot).
  const yaw = (head?.yaw ?? 0) / 10, pitch = (head?.pitch ?? 0) / 10;
  setLine(tracker.yawNeedle, tracker.yawPoint(yaw, 82));
  setLine(tracker.yawTarget, tracker.yawPoint(mode === 'searching' ? yaw : (head?.targetYaw ?? 0) / 10, 94));
  tracker.yawSweep.setAttribute('opacity', mode === 'searching' ? 1 : 0);
  tracker.yawValue.textContent = `${Math.round(Math.abs(yaw))}°${yaw > 0.5 ? ' L' : yaw < -0.5 ? ' R' : ''}`;
  setLine(tracker.pitchNeedle, tracker.pitchPoint(pitch, 94));
  setLine(tracker.pitchTarget, tracker.pitchPoint(mode === 'searching' ? pitch : (head?.targetPitch ?? 0) / 10, 106));
  tracker.pitchValue.textContent = `${Math.round(pitch)}°`;

  // Camera overlay: face box in a 320x240 frame.
  const face = data.face;
  const fresh = face?.found && Date.now() - face.at < 1500;
  $('cameraView').closest('.camera-frame').classList.toggle('searching', mode === 'searching');
  if (face?.found && Number.isFinite(face.w)) {
    const cx = (face.x + 1) * 160, cy = (face.y + 1) * 120, w = face.w * 320, h = face.h * 240;
    Object.entries({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }).forEach(([k, v]) => tracker.faceBox.setAttribute(k, v.toFixed(1)));
    tracker.faceLine.setAttribute('x2', cx.toFixed(1));
    tracker.faceLine.setAttribute('y2', cy.toFixed(1));
    $('faceReadout').textContent = `${fresh ? 'Face' : 'Last face'}  x ${face.x >= 0 ? '+' : ''}${face.x.toFixed(2)}  y ${face.y >= 0 ? '+' : ''}${face.y.toFixed(2)}`;
  } else $('faceReadout').textContent = 'No face';
  tracker.faceBox.classList.toggle('stale', !fresh);
  tracker.faceBox.setAttribute('opacity', face?.found ? 1 : 0);
  tracker.faceLine.setAttribute('opacity', fresh ? 1 : 0);
  const found = (data.detections || []).filter(entry => Date.now() - entry.at < 10000);
  $('detectRate').textContent = found.length ? `${Math.round(100 * found.filter(entry => entry.found).length / found.length)}% detected · 10 s` : data.detector === 'unavailable' ? 'detector unavailable' : '—';
  if (face && face.at !== tracker.lastImageAt) {
    tracker.lastImageAt = face.at;
    const image = $('cameraView');
    image.onload = () => { image.hidden = false; $('cameraEmpty').hidden = true; };
    image.src = `/api/admin/camera?t=${face.at}`;
  }

  // Timeline: state bands over the last 60 s, with detection ticks.
  const timeline = $('timeline'), now = Date.now(), span = 60000, toX = at => Math.max(0, 600 - (now - at) / span * 600);
  timeline.replaceChildren();
  const history = data.connected ? data.history || [] : [];
  history.forEach((entry, index) => {
    const end = history[index + 1]?.at ?? now;
    if (now - end > span) return;
    const x = toX(entry.at), rect = svgEl(timeline, 'rect', { x, y: 6, width: Math.max(1, toX(end) - x), height: 24 });
    rect.style.fill = `var(--m-${entry.mode})`;
    rect.style.opacity = '.85';
  });
  for (const entry of data.detections || []) {
    if (entry.found && now - entry.at < span) svgEl(timeline, 'rect', { x: toX(entry.at), y: 0, width: 1.5, height: 5, fill: '#6ee7a8' });
  }
}

async function pollTracker() {
  if (tracker.polling || !tracker.visible || document.hidden) return;
  tracker.polling = true;
  try { renderTracker(await api('tracking')); }
  catch { renderTracker({ connected: false }); }
  finally { tracker.polling = false; }
}

buildTracker();
new IntersectionObserver(entries => { tracker.visible = entries.some(entry => entry.isIntersecting); if (tracker.visible) pollTracker(); })
  .observe($('vision'));
setInterval(pollTracker, 300);
