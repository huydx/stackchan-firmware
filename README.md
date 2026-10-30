# StackChan Realtime — standalone Launcher app

A separate Arduino/PlatformIO firmware for the existing **M5Stack StackChan /
CoreS3**, inspired by [this guide](https://zenn.dev/nomhiro/articles/stack-chan-poc-001).
It does not use Muse pairing, an SDK token, Whisper, or Kokoro. Existing Muse
firmware sources are unchanged. The standalone app can coexist with them under
Launcher when the device has a suitable free app slot.

```
CoreS3 mic/speaker + face <-- PCM16 WebSocket --> Node relay <-- TLS --> Realtime API
```

The relay defaults to OpenAI **`gpt-realtime-2.1-mini`**, using the Realtime
WebSocket API and direct face-expression tools. GPT-Live remains optional;
only that mode uses a separate `gpt-4.1-mini` Responses backend for face tools.
The guide's `gpt-realtime-1.5` and Azure OpenAI **GA** Realtime are also available.
Audio is 24 kHz, signed 16-bit little-endian mono. Conversation
defaults to Japanese. The model can
change five face expressions; the mouth follows playback amplitude. Tap the
screen to mute/unmute capture. Audio is half-duplex: the microphone pauses
while the bot speaks, so voice interruption is not supported. No servo,
camera, PIR, or body LED control is included.

## Keep Launcher

**Build an application binary only. Do not replace Launcher.**

- `pio run` creates `firmware.bin`, suitable for reviewing/installing as an app
  through Launcher. This project blocks PlatformIO `upload`, `uploadfs`, and
  `erase` targets. It never invokes a serial flasher.
- `partitions.csv` is only a compile-time 1.375 MiB application size budget.
  **Never flash the generated bootloader, partition table, a merged image,
  or a full-flash image onto this device.**
- All NVS opens are rejected, initialization is a no-op, and erases are rejected.
  The Wi-Fi driver is initialized with `nvs_enable=false` and RAM-only storage.
  This avoids changing Launcher, original StackChan, and Muse NVS namespaces.
  Wi-Fi and relay configuration are compiled into this app instead.
- The original installation's layout is documented in
  [the Muse Launcher profile](../../esp32/tools/muse/stackchan-launcher/README.md).
  Its `0xaa0000` 4 MiB slot is **occupied by Muse**, not free space. This
  app must not be installed over that slot to keep Muse.
- On the configured device, `RealtimeBot` was added as OTA_2 at **0xea0000**,
  size **0x160000** (1.375 MiB), in the verified erased tail. Existing entries
  were preserved, and Launcher, original StackChan, assets, and Muse were
  checked by device checksum. Original boot metadata, NVS, and the installation
  manifest remain in the ignored `stackchan-backups/realtime-install/` directory.
  This layout is device-specific; inspect another unit's actual table first.

For a later installation, copy **only** `firmware.bin` to microSD as
`stackchan-realtime.bin`, then use the existing Launcher's app installation
flow after checking the target slot. See
[Launcher binary documentation](https://github.com/bmorcelli/Launcher/wiki/Obtaining-binaries-to-launch).
This is an app image, not a Launcher update.

## Configure and build

Use Python 3.12+ and PlatformIO Core; this standalone project does not use the
ESP-IDF 6 environment required by the main Muse firmware. Dependencies are
pinned in `platformio.ini`.

From the repo root:

```sh
python3.12 -m venv /tmp/stackchan-realtime-pio
/tmp/stackchan-realtime-pio/bin/pip install platformio
cp firmware/stackchan-realtime/include/bot_config.example.h firmware/stackchan-realtime/include/bot_config.h
openssl rand -hex 32
```

Edit `include/bot_config.h` with your 2.4 GHz Wi-Fi credentials, relay computer's
LAN IP, and that random token. Match the token in the relay's `.env` below.
The config file is ignored by Git. No cloud API key belongs in firmware.

```sh
/tmp/stackchan-realtime-pio/bin/pio run -d firmware/stackchan-realtime
```

Output: `.pio/build/stackchan-realtime/firmware.bin` inside this directory.
Without `bot_config.h`, the build uses placeholder credentials from the example
for compile verification; that image cannot connect until configured and rebuilt.
Configured binaries contain your Wi-Fi password and device token: keep them private.

## Run the relay

Use Node.js 22+. On a computer reachable from the bot:

```sh
cd firmware/stackchan-realtime/relay
npm ci
cp .env.example .env
```

Edit `.env`: set `DEVICE_TOKEN` to match the bot, and `OPENAI_API_KEY` to your
API key. The example binds to `0.0.0.0:8080` for LAN access. Allow that TCP port
through the computer's firewall. The default in code is localhost if `HOST`
is omitted. Keep the computer awake while chatting.

For Azure, set `REALTIME_PROVIDER=azure`, your HTTPS resource endpoint,
deployment name, and `AZURE_OPENAI_API_KEY`. The relay uses
`/openai/v1/realtime?model=DEPLOYMENT` with an `api-key` header. The article's
dated preview endpoint/schema is not used. `REALTIME_VOICE` and
`BOT_INSTRUCTIONS` customize the voice/personality. For OpenAI, setting
`REALTIME_MODEL=gpt-live-1` selects `/v1/live/sessions`; setting a
`gpt-realtime-*` model selects the older `/v1/realtime` protocol.

```sh
npm start
```

The bot shows `Listening` only after the API confirms the session configuration.
`/healthz` checks relay process health, not API credentials or model access.
API failures are logged as codes without conversation audio or keys.
After a lost connection, the bot retries every five seconds with a new session;
conversation history is not persisted.

Device traffic is authenticated using the shared token but uses **plain `ws`**
on the LAN, as in the guide. Use a trusted local network; do not expose this
port to the internet. Cloud traffic uses `wss` with certificate verification.

GPT-Live bills connected session time, including idle listening, with backend
usage billed separately. Power the bot off when it is not in use to end its
connection. See [the model pricing](https://developers.openai.com/api/docs/models/gpt-live-1).

Live sends continuous audio, including silence, and has no utterance-done event.
The relay maintains its input audio clock while the device's mic is paused,
ignores idle output silence, and closes a local playback burst after 700 ms of
quiet audio. The player still drains before capture resumes. Late speech waits
behind the current drain. The hardware remains half-duplex even though GPT-Live
supports full duplex. Face tools use the delegated Responses event stream.

For a persistent relay, `node service.mjs` waits for complete credentials in
the private `.env` file, starts the relay, and reloads it when that file changes.
A machine's login service can run that command automatically. It does not
contact the API until the bot connects.

The configured Mac uses the login agent `local.stackchan.realtime-relay`.
Its logs are in `~/Library/Logs/StackChanRealtime/`; its credentials remain in
this project's ignored `relay/.env`. Keep that file private.

`npm run hardware-check` temporarily runs a local mock API through the actual
relay. It checks incoming microphone PCM, sends a quiet quarter-second tone,
waits for playback completion, and verifies microphone capture resumes. Stop
the normal relay first so port 8080 is available. This check uses no API credit.

## Audio flow and verification

Microphone capture runs in its own task with a bounded queue. A mutex ensures
capture is finished before handing the I2S bus to the speaker. Playback combines
network frames into 4096-byte blocks, prebuffers about 128 ms, and queues the next
block while the current one plays. Each `playRaw` buffer remains unchanged until
the library releases that exact pointer through its callback. The relay converts
base64 to PCM, splits it into frames of at most 1024 bytes, and permits at most
eight frames / 8192 bytes in flight. Only **consumed PCM buffers** return credit,
so a TCP write cannot flood the device. A final drain delay lets queued I2S audio
reach the speaker before shutdown. Its output queue is capped at 1.5 MiB;
overflow or invalid protocol data closes the session instead of dropping audio.

```sh
python3 -m unittest discover -s firmware/stackchan-realtime/tests
cd firmware/stackchan-realtime/relay
npm test
npm audit
```

Tests use local mock WebSockets, require no API key, and cover authentication,
session readiness, PCM round trips, playback credit, short packets, tool
validation, overflow, and disconnect cleanup. Host checks also verify the
upload-target guard, NVS/Wi-Fi wrappers, buffer ownership, and ordered playback credit.
They do not validate live model
access or physical audio/display behavior. After installation, verify listening,
two consecutive spoken turns, tap-to-mute, and reconnection before normal use.

On the configured StackChan, hardware microphone capture, speaker completion,
capture resumption, a live API greeting, and disconnect recovery were verified.
The installed build uses quad PSRAM and an M5Unified revision with native
StackChan audio support. The normal background relay is running with server VAD.

Protocol: device → relay sends 1024-byte binary mic frames, `hello`,
`played` with the exact completed frame's `bytes`, then `drained` after
`audio_end`. Relay → device sends `ready`, `audio_start`, binary PCM frames,
`audio_end`, `expression` with `value`, and `error` with `code`. Ping/pong
detects dead connections. End-of-audio follows all playback acknowledgements;
the relay gates mic input until `drained` and clears the API input buffer.

References: [OpenAI Live migration](https://developers.openai.com/api/docs/guides/live-migration),
[Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets),
[OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations),
[Azure Realtime WebSockets](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets).
