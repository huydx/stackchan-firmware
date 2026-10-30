#include <M5Unified.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <atomic>
#include <nvs.h>
#include "playback_pool.h"
#include "body_lights.h"
#include "head_nod.h"
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
static uint8_t speakerVolume = BOT_SPEAKER_VOLUME;
static bool nodEnabled = true;
static int nodAmplitude = 60;  // tenths of a degree
static uint32_t nodPeriod = 2400;
static int pitchZero = PITCH_DEFAULT_ZERO;

// A new network is kept only after it reaches the relay (or, at boot, joins
// Wi-Fi) within 30 s; otherwise the previous network is restored.
extern "C" esp_err_t bot_storage_init();
enum class Trial : uint8_t { None, Boot, Change, Forget };
static Trial trial = Trial::None, requested = Trial::None;
static String wifiSsid = BOT_WIFI_SSID, wifiPassword = BOT_WIFI_PASSWORD;
static String previousSsid, previousPassword, requestedSsid, requestedPassword;
static bool storageReady = false, usingSaved = false, previousSaved = false, relayConnected = false;
static uint32_t trialUntil = 0, nextDeviceStatus = 0;
static const char *wifiResult = nullptr;

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

static bool loadSavedWifi(String &ssid, String &password) {
    nvs_handle_t handle;
    if (!storageReady || nvs_open("rtbot", NVS_READONLY, &handle) != ESP_OK) return false;
    char savedSsid[33], savedPassword[65];
    size_t ssidLength = sizeof savedSsid, passwordLength = sizeof savedPassword;
    const bool found = nvs_get_str(handle, "ssid", savedSsid, &ssidLength) == ESP_OK &&
                       nvs_get_str(handle, "pass", savedPassword, &passwordLength) == ESP_OK;
    nvs_close(handle);
    if (found) { ssid = savedSsid; password = savedPassword; }
    return found;
}

// Saves the current network, or forgets the saved one when forget is true.
static bool storeWifi(bool forget) {
    nvs_handle_t handle;
    if (!storageReady || nvs_open("rtbot", NVS_READWRITE, &handle) != ESP_OK) return false;
    esp_err_t error = forget ? nvs_erase_all(handle) : nvs_set_str(handle, "ssid", wifiSsid.c_str());
    if (!forget && error == ESP_OK) error = nvs_set_str(handle, "pass", wifiPassword.c_str());
    if (error == ESP_OK) error = nvs_commit(handle);
    nvs_close(handle);
    return error == ESP_OK;
}

static void sendDeviceStatus() {
    JsonDocument doc;
    doc["type"] = "device_status";
    doc["ssid"] = WiFi.SSID();
    doc["ip"] = WiFi.localIP().toString();
    doc["rssi"] = WiFi.RSSI();
    doc["savedNetwork"] = usingSaved;
    doc["storage"] = storageReady;
    doc["volume"] = speakerVolume;
    doc["brightness"] = M5.Display.getBrightness();
    String text;
    serializeJson(doc, text);
    socket.sendTXT(text);
}

static void sendWifiResult() {
    if (!wifiResult || !relayConnected) return;
    JsonDocument doc;
    doc["type"] = "wifi_result";
    doc["result"] = wifiResult;
    doc["ssid"] = wifiSsid;
    String text;
    serializeJson(doc, text);
    socket.sendTXT(text);
    wifiResult = nullptr;
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
        relayConnected = false;
        ready = false;
        stopAudio();
        if (!fault) status = "Relay disconnected";
    } else if (type == WStype_CONNECTED) {
        fault = false;
        relayConnected = true;
        status = "Connecting to AI";
        sendControl("hello");
        nextDeviceStatus = 0;
        if (trial == Trial::None) sendWifiResult();
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
                M5.Speaker.setVolume(speakerVolume);
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
        } else if (!strcmp(event, "device_config")) {
            if (doc["volume"].is<int>()) {
                speakerVolume = constrain(doc["volume"].as<int>(), 0, 255);
                if (output) M5.Speaker.setVolume(speakerVolume);
            }
            if (doc["brightness"].is<int>()) M5.Display.setBrightness(constrain(doc["brightness"].as<int>(), 0, 255));
            if (doc["nod"].is<bool>()) nodEnabled = doc["nod"].as<bool>();
            if (doc["nodAngle"].is<int>()) nodAmplitude = constrain(doc["nodAngle"].as<int>(), 0, 30) * 10;
            if (doc["nodPeriod"].is<int>()) nodPeriod = constrain(doc["nodPeriod"].as<int>(), 500, 10000);
            nextDeviceStatus = 0;
        } else if (!strcmp(event, "wifi_set") && trial == Trial::None && requested == Trial::None) {
            // Switch networks from loop(), not from inside the socket callback.
            const char *ssid = doc["ssid"] | "";
            const char *password = doc["password"] | "";
            if (doc["builtin"] | false) {
                requestedSsid = BOT_WIFI_SSID;
                requestedPassword = BOT_WIFI_PASSWORD;
                requested = Trial::Forget;
            } else if (*ssid && strlen(ssid) <= 32 && strlen(password) <= 64) {
                requestedSsid = ssid;
                requestedPassword = password;
                requested = Trial::Change;
            }
        } else if (!strcmp(event, "error")) {
            fail("Relay/API error; see relay");
        }
    }
}

static void startTrial(Trial kind, const String &ssid, const String &password) {
    previousSsid = wifiSsid;
    previousPassword = wifiPassword;
    previousSaved = usingSaved;
    wifiSsid = ssid;
    wifiPassword = password;
    trial = kind;
    trialUntil = millis() + 30000;
    ready = false;
    stopAudio();
    socket.disconnect();
    relayConnected = false;
    status = "Trying Wi-Fi";
    WiFi.disconnect();
    WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
}

static void updateTrial() {
    if (requested != Trial::None) {
        startTrial(requested, requestedSsid, requestedPassword);
        requested = Trial::None;
        requestedPassword = "";
    }
    if (trial == Trial::None) return;
    const bool reached = trial == Trial::Boot ? WiFi.status() == WL_CONNECTED : relayConnected;
    if (reached) {
        if (trial == Trial::Change) {
            usingSaved = storeWifi(false);
            wifiResult = !storageReady ? "storage_unavailable" : usingSaved ? "saved" : "connected_not_saved";
        } else if (trial == Trial::Forget) {
            wifiResult = storeWifi(true) ? "forgotten" : "storage_unavailable";
            usingSaved = false;
        }
        trial = Trial::None;
        previousPassword = "";
        sendWifiResult();
    } else if (int32_t(millis() - trialUntil) >= 0) {
        wifiResult = trial == Trial::Boot ? "saved_unavailable" : "reverted";
        wifiSsid = previousSsid;
        wifiPassword = previousPassword;
        usingSaved = previousSaved;
        previousPassword = "";
        trial = Trial::None;
        status = "Back to previous Wi-Fi";
        socket.disconnect();
        WiFi.disconnect();
        WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
    }
}

// StackChan body controller (I2C 0x6f); protocol from m5stack/StackChan-BSP.
// Only RGB pin 13 and LED RAM are changed; servo power/output is left alone.
// M5.begin() already enables the 5V expansion output that powers the LEDs.
static constexpr uint8_t BODY_ADDR = 0x6f, BODY_LIGHTS = 12;
static constexpr uint32_t BODY_I2C_HZ = 100000;
enum class Lights : uint8_t { Probing, Ready, Unavailable };
static Lights lights = Lights::Probing;
static uint8_t lightAttempts = 0, lightFailures = 0;
static uint32_t nextLightAt = 0;
static int32_t lightColor = -1;

// Low registers hold expander pins 0-7, high registers pins 8-15.
static bool bodyPinBit(uint8_t reg, uint8_t mask, bool set) {
    uint8_t value;
    if (!M5.In_I2C.readRegister(BODY_ADDR, reg, &value, 1, BODY_I2C_HZ)) return false;
    const uint8_t next = set ? value | mask : value & ~mask;
    return next == value || M5.In_I2C.writeRegister8(BODY_ADDR, reg, next, BODY_I2C_HZ);
}

static bool writeBodyLights(uint16_t color) {
    uint8_t bytes[BODY_LIGHTS * 2];  // RGB565, little endian
    for (size_t i = 0; i < BODY_LIGHTS; ++i) {
        bytes[2 * i] = color & 0xff;
        bytes[2 * i + 1] = color >> 8;
    }
    return M5.In_I2C.writeRegister(BODY_ADDR, 0x30, bytes, sizeof bytes, BODY_I2C_HZ) &&
           M5.In_I2C.writeRegister8(BODY_ADDR, 0x24, BODY_LIGHTS | 0x40, BODY_I2C_HZ);  // refresh
}

static bool initBodyLights() {
    uint8_t version = 0;
    if (!M5.In_I2C.readRegister(BODY_ADDR, 0x02, &version, 1, BODY_I2C_HZ) || !version || version == 0xff) return false;
    return bodyPinBit(0x04, 0x20, true) &&   // pin 13 (RGB): output direction
           bodyPinBit(0x0c, 0x20, false) &&  // no pull-down
           bodyPinBit(0x0a, 0x20, true) &&   // pull-up
           bodyPinBit(0x14, 0x20, false) &&  // push-pull
           M5.In_I2C.writeRegister8(BODY_ADDR, 0x24, BODY_LIGHTS, BODY_I2C_HZ) && writeBodyLights(0);
}

// Red while the microphone is muted, rainbow while speaking, otherwise off.
static void updateBodyLights() {
    const uint32_t now = millis();
    if (lights == Lights::Unavailable || int32_t(now - nextLightAt) < 0) return;
    nextLightAt = now + 50;
    if (lights == Lights::Probing) {
        // The body controller can boot slowly; give it about a second.
        if (initBodyLights()) {
            lights = Lights::Ready;
            lightColor = 0;
            Serial.println("[bot] body lights ready");
        } else if (++lightAttempts >= 6) {
            lights = Lights::Unavailable;
            Serial.println("[bot] body lights unavailable");
        } else nextLightAt = now + 200;
        return;
    }
    const BodyEffect effect = output ? BodyEffect::Speaking : muted ? BodyEffect::Muted : BodyEffect::Off;
    const uint16_t color = bodyColor(effect, now);
    if (color == lightColor) return;
    if (writeBodyLights(color)) {
        lightColor = color;
        lightFailures = 0;
    } else if (++lightFailures >= 3) {
        writeBodyLights(0);
        lights = Lights::Unavailable;
        Serial.println("[bot] body lights failed; disabled");
    } else nextLightAt = now + 1000;
}

// Pitch servo on the body's SCS bus (UART1, TX 6 / RX 7, 1 Mbaud). Only the
// pitch servo moves; yaw is never commanded. Like the official firmware, torque
// is released at rest so the head is not held.
enum class Head : uint8_t { Off, Powering, Resting, Nodding, Returning, Unavailable };
static Head headState = Head::Off;
static uint32_t headAt = 0, nodStart = 0, nextHeadAt = 0;

static void servoSend(const uint8_t *packet, size_t length) {
    while (Serial1.available()) Serial1.read();  // status replies are not needed
    Serial1.write(packet, length);
}

static void movePitch(int tenths, uint16_t timeMs) {
    uint8_t packet[16];
    servoSend(packet, scsGoalPosition(packet, PITCH_SERVO_ID, pitchRaw(pitchZero, tenths), timeMs));
}

static void pitchTorque(bool enabled) {
    uint8_t packet[16];
    servoSend(packet, scsTorque(packet, PITCH_SERVO_ID, enabled));
}

// Nod slowly while speaking; ease back to rest and release afterwards.
static void updateHead() {
    const uint32_t now = millis();
    if (lights != Lights::Ready || headState == Head::Unavailable || int32_t(now - nextHeadAt) < 0) return;
    nextHeadAt = now + 50;
    const bool wanted = nodEnabled && output;
    switch (headState) {
    case Head::Off:
        if (!wanted) return;
        // Expander pin 0 enables servo power (VM_EN): output, pull-up, high.
        if (!bodyPinBit(0x03, 0x01, true) || !bodyPinBit(0x0b, 0x01, false) ||
            !bodyPinBit(0x09, 0x01, true) || !bodyPinBit(0x05, 0x01, true)) {
            headState = Head::Unavailable;
            Serial.println("[bot] servo power unavailable; nodding disabled");
            return;
        }
        headState = Head::Powering;
        headAt = now + 250;
        return;
    case Head::Powering:
        if (int32_t(now - headAt) < 0) return;
        headState = Head::Resting;
        return;
    case Head::Resting:
        if (!wanted) return;
        pitchTorque(true);
        movePitch(0, 400);
        nodStart = now + 400;
        headState = Head::Nodding;
        return;
    case Head::Nodding:
        if (!wanted) {
            movePitch(0, 700);
            headAt = now + 900;
            headState = Head::Returning;
        } else if (int32_t(now - nodStart) >= 0) {
            movePitch(nodTenths(now - nodStart, nodAmplitude, nodPeriod), 80);
        }
        return;
    case Head::Returning:
        if (wanted) {
            nodStart = now;
            headState = Head::Nodding;
        } else if (int32_t(now - headAt) >= 0) {
            pitchTorque(false);
            headState = Head::Resting;
        }
        return;
    case Head::Unavailable:
        return;
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
    storageReady = bot_storage_init() == ESP_OK;
    nvs_handle_t servoSettings;
    if (storageReady && nvs_open("servo", NVS_READONLY, &servoSettings) == ESP_OK) {
        // The StackChan app's calibrated level position, if it saved one.
        int32_t zero;
        if (nvs_get_i32(servoSettings, "zero_pos_2", &zero) == ESP_OK && zero >= 0 && zero <= SERVO_RAW_MAX) pitchZero = zero;
        nvs_close(servoSettings);
    }
    Serial.printf("[bot] pitch zero=%d\n", pitchZero);
    Serial1.begin(1000000, SERIAL_8N1, 7, 6);
    String savedSsid, savedPassword;
    if (loadSavedWifi(savedSsid, savedPassword)) {
        // Fall back to the built-in network if the saved one is unavailable.
        previousSsid = wifiSsid;
        previousPassword = wifiPassword;
        wifiSsid = savedSsid;
        wifiPassword = savedPassword;
        usingSaved = true;
        trial = Trial::Boot;
        trialUntil = millis() + 30000;
    }
    WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
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
    updateTrial();
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
    updateBodyLights();
    updateHead();
    if (relayConnected && int32_t(millis() - nextDeviceStatus) >= 0) {
        sendDeviceStatus();
        nextDeviceStatus = millis() + 5000;
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
