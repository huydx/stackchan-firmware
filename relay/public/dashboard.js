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
