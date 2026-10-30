#include <M5Unified.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <atomic>
#include "playback_pool.h"
#if __has_include("bot_config.h")
#include "bot_config.h"
#else
#include "bot_config.example.h"
#endif

// Socket/playback state belongs to the loop task. Capture uses a queue + mutex.
static constexpr uint32_t RATE = 24000;
static constexpr size_t CHUNK = 1024, CAPACITY = 16384;
static WebSocketsClient socket;
static uint8_t ring[CAPACITY];
static PlaybackPool playback;
struct MicFrame { int16_t samples[CHUNK / 2]; };
static QueueHandle_t micQueue;
static SemaphoreHandle_t micLock;
static std::atomic<bool> captureEnabled{false}, captureFailed{false};
static std::atomic<uint32_t> capturedFrames{0}, microphonePeak{0};
static uint32_t playedFrames = 0;
static bool micActive = false;
static size_t head = 0, tail = 0, available = 0;
static bool prebuffered = false;
static uint32_t firstAudioAt = 0;
static uint16_t packetLengths[16];
static size_t packetRead = 0, packetWrite = 0, packetCount = 0;
static bool ready = false, output = false, outputDone = false, muted = false;
static bool fault = false;
static String expression = "neutral";
static String status = "Joining Wi-Fi";
static String authHeader;
static uint32_t nextDraw = 0, resumeAt = 0, speakerStopAt = 0;
static float mouth = 0;

static void captureTask(void *) {
    MicFrame frame;
    for (;;) {
        if (!captureEnabled) { delay(1); continue; }
        xSemaphoreTake(micLock, portMAX_DELAY);
        if (captureEnabled) {
            if (!M5.Mic.record(frame.samples, CHUNK / 2, RATE)) captureFailed = true;
            else {
                while (M5.Mic.isRecording()) delay(1);
                uint32_t peak = 0;
                for (int16_t sample : frame.samples) peak = std::max(peak, uint32_t(abs(int(sample))));
                microphonePeak = peak;
                ++capturedFrames;
                if (captureEnabled && xQueueSend(micQueue, &frame, 0) != pdTRUE) captureFailed = true;
            }
        }
        xSemaphoreGive(micLock);
        delay(1);
    }
}

static void stopMic() {
    captureEnabled = false;
    xSemaphoreTake(micLock, portMAX_DELAY);
    M5.Mic.end();
    micActive = false;
    xQueueReset(micQueue);
    xSemaphoreGive(micLock);
}

static void sendControl(const char *type, size_t bytes = 0) {
    JsonDocument doc;
    doc["type"] = type;
    if (bytes) doc["bytes"] = bytes;
    String text;
    serializeJson(doc, text);
    socket.sendTXT(text);
}

static void stopAudio() {
    // Speaker.end() uninstalls the shared I2S driver even when it is idle.
    // Stop the mic task first, and only tear down an active speaker.
    stopMic();
    if (output || M5.Speaker.isRunning()) {
        M5.Speaker.stop();
        M5.Speaker.end();
    }
    playback.reset();
    head = tail = available = 0;
    prebuffered = false;
    firstAudioAt = 0;
    packetRead = packetWrite = packetCount = 0;
    output = outputDone = false;
    mouth = 0;
}

static void fail(const char *message) {
    ready = false;
    fault = true;
    status = message;
    stopAudio();
    socket.disconnect();
}

static void onSocket(WStype_t type, uint8_t *data, size_t length) {
    if (type == WStype_DISCONNECTED) {
        ready = false;
        stopAudio();
        if (!fault) status = "Relay disconnected";
    } else if (type == WStype_CONNECTED) {
        fault = false;
        status = "Connecting to AI";
        sendControl("hello");
    } else if (type == WStype_BIN) {
        if (!ready || !output || !length || length > CHUNK || length % 2 ||
            length > CAPACITY - available || packetCount == 16) {
            fail("Invalid audio / overflow");
            return;
        }
        for (size_t i = 0; i < length; ++i) {
            ring[head] = data[i];
            head = (head + 1) % CAPACITY;
        }
        available += length;
        if (!firstAudioAt) firstAudioAt = millis();
        packetLengths[packetWrite] = length;
        packetWrite = (packetWrite + 1) % 16;
        ++packetCount;
    } else if (type == WStype_TEXT) {
        JsonDocument doc;
        if (length > 2048 || deserializeJson(doc, data, length)) return;
        const char *event = doc["type"] | "";
        if (!strcmp(event, "ready")) {
            stopAudio();
            ready = true;
            resumeAt = millis();
            status = muted ? "Muted" : "Listening";
        } else if (!strcmp(event, "audio_start") && ready) {
            // Switch the shared I2S bus only after capture has completed.
            stopMic();
            if (!output) {
                if (!M5.Speaker.begin()) { fail("Speaker failed"); return; }
                M5.Speaker.setVolume(BOT_SPEAKER_VOLUME);
            }
            output = true;
            outputDone = false;
            prebuffered = false;
            firstAudioAt = 0;
            status = "Speaking";
        } else if (!strcmp(event, "audio_end")) {
            outputDone = true;
            // isPlaying() releases borrowed PCM before the final I2S DMA tail
            // necessarily reaches the amp. Let that tail finish before end().
            speakerStopAt = millis() + 120;
        } else if (!strcmp(event, "expression")) {
            expression = doc["value"] | "neutral";
        } else if (!strcmp(event, "error")) {
            fail("Relay/API error; see relay");
        }
    }
}

static void drawFace() {
    auto &lcd = M5.Display;
    uint16_t color = !ready ? TFT_ORANGE : muted ? TFT_DARKGREY : TFT_CYAN;
    static String previousStatus, previousExpression;
    static uint16_t previousColor = 0;
    const bool redraw = status != previousStatus || expression != previousExpression || color != previousColor;
    if (!redraw) {
        // Avoid a full-screen SPI transfer between every pair of audio chunks.
        lcd.fillRect(120, 120, 81, 75, TFT_BLACK);
        lcd.fillEllipse(160, expression == "sad" ? 166 : 155, 32, 3 + int(mouth * 25), color);
        return;
    }
    previousStatus = status;
    previousExpression = expression;
    previousColor = color;
    Serial.printf("[bot] state=%s expression=%s\n", status.c_str(), expression.c_str());
    lcd.fillScreen(TFT_BLACK);
    int eyeY = 88;
    if (expression == "sleepy") {
        lcd.fillRect(70, eyeY, 45, 5, color);
        lcd.fillRect(205, eyeY, 45, 5, color);
    } else {
        lcd.fillEllipse(92, eyeY, 18, expression == "happy" ? 8 : 25, color);
        lcd.fillEllipse(227, eyeY, 18, expression == "happy" ? 8 : 25, color);
    }
    if (expression == "angry") {
        lcd.drawLine(65, 45, 115, 65, color);
        lcd.drawLine(205, 65, 255, 45, color);
    }
    int y = expression == "sad" ? 166 : 155;
    lcd.fillEllipse(160, y, 32, 3 + int(mouth * 25), color);
    lcd.setTextColor(TFT_WHITE, TFT_BLACK);
    lcd.setTextDatum(m5gfx::textdatum_t::middle_center);
    lcd.drawString(status, 160, 207);
    lcd.drawString("Tap: mute microphone", 160, 229);
}

void setup() {
    auto cfg = M5.config();
    cfg.internal_mic = true;
    cfg.internal_spk = true;
    M5.begin(cfg);
    M5.Display.setRotation(1);
    M5.Display.setTextSize(1);
    M5.Speaker.end();
    M5.Mic.end();
    // CoreS3's default magnification of 4 attenuates PCM by about 12 dB.
    // 16 gives unity PCM gain at full master volume; 220 leaves headroom.
    auto speakerConfig = M5.Speaker.config();
    speakerConfig.magnification = 16;
    M5.Speaker.config(speakerConfig);
    M5.Speaker.setBufferReleaseCallback(nullptr, [](void *, const void *data, uint8_t) {
        playback.release(data);
    });
    Serial.begin(115200);
    Serial.printf("[bot] startup board=%d display=%dx%d psram=%u\n", int(M5.getBoard()),
                  M5.Display.width(), M5.Display.height(), unsigned(ESP.getPsramSize()));
    micQueue = xQueueCreate(8, sizeof(MicFrame));
    micLock = xSemaphoreCreateMutex();
    if (!micQueue || !micLock || xTaskCreate(captureTask, "bot_capture", 4096, nullptr, 2, nullptr) != pdPASS) {
        status = "Audio allocation failed";
        drawFace();
        for (;;) delay(1000);
    }
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.setSleep(false);
    WiFi.begin(BOT_WIFI_SSID, BOT_WIFI_PASSWORD);
    authHeader = String("Authorization: Bearer ") + BOT_RELAY_TOKEN;
    socket.setExtraHeaders(authHeader.c_str());
    socket.onEvent(onSocket);
    socket.setReconnectInterval(5000);
    socket.enableHeartbeat(15000, 3000, 2);
    socket.begin(BOT_RELAY_HOST, BOT_RELAY_PORT, "/device");
}

void loop() {
    M5.update();
    if (M5.Touch.getDetail().wasClicked()) {
        muted = !muted;
        if (!output) {
            stopMic();
            if (ready) status = muted ? "Muted" : "Listening";
        }
    }
    if (WiFi.status() == WL_CONNECTED) socket.loop();
    else if (ready) {
        ready = false;
        stopAudio();
        socket.disconnect();
        status = "Wi-Fi disconnected";
    }

    if (captureFailed.exchange(false)) fail("Microphone / capture queue failed");
    if (ready && output) {
        while (auto *block = playback.releasedFront()) {
            for (size_t i = 0; i < block->frames; ++i) {
                sendControl("played", block->frameBytes[i]);
                ++playedFrames;
            }
            playback.popReleased();
        }
        // Buffer beyond one 100 ms Live audio packet to absorb Wi-Fi jitter.
        // Short replies start after 150 ms, since audio_end waits for our ACKs.
        if (!prebuffered && (available >= 6144 ||
            (available && uint32_t(millis() - firstAudioAt) >= 150))) prebuffered = true;
        while (prebuffered && available && playback.pending() < 2 && M5.Speaker.isPlaying(0) < 2) {
            auto *block = playback.freeBlock();
            if (!block) break;
            block->bytes = block->frames = 0;
            auto *dest = reinterpret_cast<uint8_t *>(block->pcm);
            while (packetCount && block->frames < PlaybackPool::FRAMES) {
                const size_t bytes = packetLengths[packetRead];
                if (block->bytes + bytes > PlaybackPool::BLOCK_BYTES) break;
                packetRead = (packetRead + 1) % 16;
                --packetCount;
                for (size_t i = 0; i < bytes; ++i) {
                    dest[block->bytes + i] = ring[tail];
                    tail = (tail + 1) % CAPACITY;
                }
                available -= bytes;
                block->frameBytes[block->frames++] = bytes;
                block->bytes += bytes;
            }
            uint32_t amplitude = 0;
            for (size_t i = 0; i < block->bytes / 2; ++i) amplitude += abs(int(block->pcm[i]));
            mouth = min(1.0f, float(amplitude) / (block->bytes / 2) / 6000.0f);
            playback.submit(block);
            if (!M5.Speaker.playRaw(block->pcm, block->bytes / 2, RATE, false, 1, 0)) {
                fail("Speaker failed");
                break;
            }
        }
        if (ready && outputDone && !available && !playback.pending() &&
            !M5.Speaker.isPlaying(0) && int32_t(millis() - speakerStopAt) >= 0) {
            M5.Speaker.end();
            output = outputDone = false;
            mouth = 0;
            resumeAt = millis() + 250;
            sendControl("drained");
            status = muted ? "Muted" : "Listening";
        }
    } else if (ready && !muted && int32_t(millis() - resumeAt) >= 0) {
        if (!micActive) {
            xSemaphoreTake(micLock, portMAX_DELAY);
            micActive = M5.Mic.begin();
            xSemaphoreGive(micLock);
            if (!micActive) fail("Microphone failed");
            else captureEnabled = true;
        }
        MicFrame frame;
        while (ready && xQueueReceive(micQueue, &frame, 0) == pdTRUE) {
            socket.sendBIN(reinterpret_cast<uint8_t *>(frame.samples), CHUNK);
        }
    }
    if (int32_t(millis() - nextDraw) >= 0) {
        drawFace();
        nextDraw = millis() + 100;
    }
    static uint32_t nextDiagnostic = 0;
    if (int32_t(millis() - nextDiagnostic) >= 0) {
        Serial.printf("[bot] wifi=%d ip=%s ready=%d output=%d muted=%d mic_frames=%lu played_frames=%lu mic_peak=%lu\n",
                      int(WiFi.status()), WiFi.localIP().toString().c_str(), ready, output, muted,
                      (unsigned long)capturedFrames.load(), (unsigned long)playedFrames,
                      (unsigned long)microphonePeak.load());
        nextDiagnostic = millis() + 5000;
    }
    delay(1);
}
