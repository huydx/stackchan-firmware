#include <M5Unified.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <atomic>
#include <nvs.h>
#include <driver/uart.h>
#include "playback_pool.h"
#include "body_lights.h"
#include "head_nod.h"
#include "face_track.h"
#include "face_camera.h"
#include "face_display.h"
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
// Start muted after every boot or reflash; tap the screen to unmute.
static bool ready = false, output = false, outputDone = false, muted = true;
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
static int pitchZero = PITCH_DEFAULT_ZERO, yawZero = YAW_DEFAULT_ZERO;
static bool trackEnabled = true, reverseX = false, reverseY = false, frameInFlight = false;
static uint32_t frameSentAt = 0, lookUntil = 0;
// Gaze of the snapshot in flight, of the latest face result, and of a look test.
static Gaze frameGaze, faceGaze, lookGaze;
static char servoTestLog[400] = "";
static bool servoTestPending = false;
static uint32_t servoTestUntil = 0;

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

static void addHeadStatus(JsonDocument &doc);

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
    doc["camera"] = faceCameraState();
    doc["cameraStackFree"] = faceCameraStackFree();
    addHeadStatus(doc);
    // Why the robot last started, to diagnose crashes without the USB port.
    static const char *const reasons[] = {"unknown", "power_on", "external", "software", "panic", "interrupt_watchdog",
                                          "task_watchdog", "watchdog", "deep_sleep", "brownout", "sdio", "usb", "jtag"};
    const unsigned reason = unsigned(esp_reset_reason());
    doc["reset"] = reason < sizeof reasons / sizeof *reasons ? reasons[reason] : "unknown";
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
            if (doc["track"].is<bool>()) faceCameraSetEnabled(trackEnabled = doc["track"].as<bool>());
            if (doc["reverseX"].is<bool>()) reverseX = doc["reverseX"].as<bool>();
            if (doc["reverseY"].is<bool>()) reverseY = doc["reverseY"].as<bool>();
            nextDeviceStatus = 0;
        } else if (!strcmp(event, "face")) {
            frameInFlight = false;
            if (doc["found"] | false) {
                faceGaze = frameGaze;
                faceCameraSetFace(doc["x"] | 0.0f, doc["y"] | 0.0f);
            }
        } else if (!strcmp(event, "servo_test")) {
            servoTestPending = true;
            servoTestUntil = millis() + 8000;
            strlcpy(servoTestLog, "pending", sizeof servoTestLog);
        } else if (!strcmp(event, "look")) {
            // Point the head for a few seconds (dashboard direction check).
            lookGaze.yaw = clampInt(doc["yaw"] | 0, -TRACK_YAW_LIMIT, TRACK_YAW_LIMIT);
            lookGaze.pitch = clampInt(doc["pitch"] | 0, 0, TRACK_PITCH_LIMIT);
            lookUntil = millis() + 4000;
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

static bool bodyPinReadsHigh() {  // expander pin 0 output (VM_EN)
    uint8_t value;
    return M5.In_I2C.readRegister(BODY_ADDR, 0x05, &value, 1, BODY_I2C_HZ) && (value & 0x01);
}

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

// Head servos on the body's SCS bus (UART1, TX 6 / RX 7, 1 Mbaud): pitch
// nods while speaking. With face tracking on, the head searches for a face
// while a conversation is active, then keeps it centered in the camera image.
// Yaw is only commanded when tracking is on. Like the official firmware,
// torque is released at rest so the head is not held.
enum class Servos : uint8_t { Off, Powering, Ready, Unavailable };
static Servos servos = Servos::Off;
static bool torqueOn = false;
static Gaze gazeTarget, gazeNow;
static Search search;
static uint8_t centeredHits = 0, offCenterHits = 0;
enum class Track : uint8_t { Resting, Searching, Centering, Locked, GivingUp };
static Track track = Track::Searching;  // look around once after boot
static uint32_t trackSince = 0, gaveUpAt = 0;

static void setTrack(Track next, uint32_t now) {
    track = next;
    trackSince = now;
    if (next == Track::Centering) centeredHits = offCenterHits = 0;
}
static int sentYaw = INT32_MIN, sentPitch = INT32_MIN;
static float nodScale = 0;
static uint32_t servoAt = 0, nodStart = 0, nextHeadAt = 0, lastFaceAt = 0, restingSince = 0, torqueFailingSince = 0;
static int servoPowerCycles = 0;
// Face tracking state for the dashboard: the mode name and the last sighting.
static const char *headMode = "resting";
static float lastFaceX = 0, lastFaceY = 0;
static uint32_t nextHeadReport = 0;

// Like StackChan-BSP, drive UART1 through the ESP-IDF driver and wait for
// each servo's status reply before the next packet: the bus is half duplex,
// and a packet sent during a reply collides with it and is lost.
static constexpr uart_port_t SERVO_UART = UART_NUM_1;

static bool servoBusBegin() {
    uart_config_t config = {};
    config.baud_rate = 1000000;
    config.data_bits = UART_DATA_8_BITS;
    config.parity = UART_PARITY_DISABLE;
    config.stop_bits = UART_STOP_BITS_1;
    config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    config.source_clk = UART_SCLK_APB;
    return uart_driver_install(SERVO_UART, 1024, 1024, 0, nullptr, 0) == ESP_OK &&
           uart_param_config(SERVO_UART, &config) == ESP_OK &&
           uart_set_pin(SERVO_UART, 6, 7, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) == ESP_OK;
}

// Sends one packet and collects the reply: 6 bytes for writes, 8 for a
// two-byte read. Returns the number of reply bytes received.
static size_t servoTransact(const uint8_t *packet, size_t length, uint8_t *reply, size_t replyLength) {
    uart_flush_input(SERVO_UART);
    uart_write_bytes(SERVO_UART, packet, length);
    uart_wait_tx_done(SERVO_UART, pdMS_TO_TICKS(5));
    // Idle servos answer within a few milliseconds (2 ms was too short);
    // moving ones may not answer at all.
    const int received = uart_read_bytes(SERVO_UART, reply, replyLength, pdMS_TO_TICKS(6));
    return received > 0 ? received : 0;
}

static char lastWriteReply[40] = "", lastReadReply[40] = "";

static void hexBytes(char *out, size_t size, const uint8_t *data, size_t length) {
    out[0] = 0;
    for (size_t i = 0; i < length && 3 * i + 3 < size; ++i) snprintf(out + 3 * i, 4, "%02x ", data[i]);
}

// Returns true when the servo acknowledged the write without an error.
static bool servoSend(const uint8_t *packet, size_t length) {
    uint8_t reply[6];
    const size_t received = servoTransact(packet, length, reply, sizeof reply);
    hexBytes(lastWriteReply, sizeof lastWriteReply, reply, received);
    return received == sizeof reply && reply[0] == 0xff && reply[1] == 0xff && reply[2] == packet[2] && reply[4] == 0;
}

static void moveServo(uint8_t id, int raw, uint16_t timeMs) {
    uint8_t packet[16];
    servoSend(packet, scsGoalPosition(packet, id, raw, timeMs));
}

// Torque counts as on only when the servos acknowledge it: a command sent
// while a servo is still booting is silently lost, and without torque every
// position command is ignored. Callers retry until this returns true.
static bool setTorque(bool enabled) {
    uint8_t packet[16];
    bool acknowledged = servoSend(packet, scsTorque(packet, PITCH_SERVO_ID, enabled));
    if (trackEnabled || !enabled) acknowledged &= servoSend(packet, scsTorque(packet, YAW_SERVO_ID, enabled));
    torqueOn = enabled && acknowledged;
    sentYaw = sentPitch = INT32_MIN;
    return acknowledged;
}

// Servo read-back for diagnostics: proves bus, power and servo respond.
static int servoPosition[2] = {-1, -1};  // yaw, pitch raw positions
static int supplyMillivolts = -1, supplyMilliamps = 0, vmEnable = -1, servoRxBytes = -1;
static uint32_t nextServoRead = 0;
static int servoVolts[2] = {-1, -1};  // tenths of a volt, from each servo
static bool extOutput = false;
static int vbusMillivolts = -1, extRetries = 0;

// Reads one byte register; returns -1 without a valid reply (FF FF id 03 err value checksum).
static int readServoByte(uint8_t id, uint8_t address) {
    const uint8_t request[8] = {0xff, 0xff, id, 4, 0x02, address, 1, uint8_t(~uint8_t(id + 4 + 0x02 + address + 1))};
    uint8_t reply[7];
    if (servoTransact(request, sizeof request, reply, sizeof reply) != sizeof reply) return -1;
    if (reply[0] != 0xff || reply[1] != 0xff || reply[2] != id || reply[3] != 3) return -1;
    return uint8_t(~uint8_t(reply[2] + reply[3] + reply[4] + reply[5])) == reply[6] ? reply[5] : -1;
}

static int readServoPosition(uint8_t id) {
    uint8_t packet[8], reply[8];
    const size_t length = servoTransact(packet, scsReadPosition(packet, id), reply, sizeof reply);
    servoRxBytes = length;
    hexBytes(lastReadReply, sizeof lastReadReply, reply, length);
    return scsParsePosition(reply, length, id);
}

// Self-test (admin API): servo settings, then a small pitch move, logged.

static int readServoWord(uint8_t id, uint8_t address) {
    const uint8_t request[8] = {0xff, 0xff, id, 4, 0x02, address, 2, uint8_t(~uint8_t(id + 4 + 0x02 + address + 2))};
    uint8_t reply[8];
    if (servoTransact(request, sizeof request, reply, sizeof reply) != sizeof reply) return -1;
    if (reply[0] != 0xff || reply[1] != 0xff || reply[2] != id || reply[3] != 4) return -1;
    if (uint8_t(~uint8_t(reply[2] + reply[3] + reply[4] + reply[5] + reply[6])) != reply[7]) return -1;
    return reply[5] << 8 | reply[6];
}

static void testLog(const char *format, ...) {
    const size_t used = strlen(servoTestLog);
    va_list args;
    va_start(args, format);
    vsnprintf(servoTestLog + used, sizeof servoTestLog - used, format, args);
    va_end(args);
}

static void runServoTest() {
    servoTestPending = false;
    servoTestLog[0] = 0;
    // Power-cycle the servos (VM_EN off, then on) to clear any latched fault.
    const bool off = bodyPinBit(0x05, 0x01, false);
    delay(600);
    const bool on = bodyPinBit(0x05, 0x01, true);
    delay(1500);  // the servos take about a second to boot
    testLog("cycle %d%d ", int(off), int(on));
    for (uint8_t id = 1; id <= 2; ++id) {
        testLog("| id%d lim %d..%d tq %d pos %d v %d t %d ", id, readServoWord(id, 9), readServoWord(id, 11),
            readServoByte(id, 40), readServoWord(id, 56), readServoByte(id, 62), readServoByte(id, 63));
    }
    uint8_t packet[16], reply[6];
    const int start = readServoWord(PITCH_SERVO_ID, 56);
    size_t got = servoTransact(packet, scsTorque(packet, PITCH_SERVO_ID, true), reply, sizeof reply);
    testLog("| torque-on reply %d err %d ", int(got), got == 6 ? reply[4] : -1);
    const int goal = start >= 0 ? start + 30 : pitchZero + 30;
    got = servoTransact(packet, scsGoalPosition(packet, PITCH_SERVO_ID, goal, 500), reply, sizeof reply);
    testLog("goal %d reply %d err %d ", goal, int(got), got == 6 ? reply[4] : -1);
    // Position every 100 ms: a run of -1 right after the move starts means a brownout reset.
    testLog("-> ");
    for (int i = 0; i < 15; ++i) {
        delay(100);
        testLog("%d ", readServoWord(PITCH_SERVO_ID, 56));
    }
    testLog("tq %d ", readServoByte(PITCH_SERVO_ID, 40));
    servoTransact(packet, scsGoalPosition(packet, PITCH_SERVO_ID, start >= 0 ? start : pitchZero, 500), reply, sizeof reply);
    delay(700);
    testLog("back %d", readServoWord(PITCH_SERVO_ID, 56));
    servoTransact(packet, scsTorque(packet, PITCH_SERVO_ID, false), reply, sizeof reply);
    torqueOn = false;
    sentYaw = sentPitch = INT32_MIN;
    Serial.printf("[bot] servo test: %s\n", servoTestLog);
}

static void readServos() {
    if (servos != Servos::Ready || int32_t(millis() - nextServoRead) < 0) return;
    nextServoRead = millis() + 3000;
    servoPosition[0] = readServoPosition(YAW_SERVO_ID);
    servoPosition[1] = readServoPosition(PITCH_SERVO_ID);
    // The body's 5V comes from the CoreS3 boost output. M5Unified skips enabling
    // it at boot when USB already drives the bus, and nothing re-enables it
    // when that changes, which leaves the servos unpowered: keep it on.
    extOutput = M5.Power.getExtOutput();
    vbusMillivolts = int(M5.Power.getVBUSVoltage());
    if (!extOutput) {
        ++extRetries;
        M5.Power.setExtOutput(true);  // refused by M5Unified when unsafe
        extOutput = M5.Power.getExtOutput();
    }
    servoVolts[0] = readServoByte(YAW_SERVO_ID, 62);  // PRESENT_VOLTAGE
    servoVolts[1] = readServoByte(PITCH_SERVO_ID, 62);
    // Body INA226 (0x41, 10 mOhm shunt): supply voltage and current.
    uint8_t value[2];
    if (M5.In_I2C.readRegister(0x41, 0x02, value, 2, BODY_I2C_HZ)) supplyMillivolts = (value[0] << 8 | value[1]) * 5 / 4;
    if (M5.In_I2C.readRegister(0x41, 0x01, value, 2, BODY_I2C_HZ)) supplyMilliamps = int16_t(value[0] << 8 | value[1]) / 4;
    // Expander pin 0 (VM_EN): direction and output bits as the controller reports them.
    uint8_t direction, level;
    if (M5.In_I2C.readRegister(BODY_ADDR, 0x03, &direction, 1, BODY_I2C_HZ) &&
        M5.In_I2C.readRegister(BODY_ADDR, 0x05, &level, 1, BODY_I2C_HZ)) vmEnable = (direction & 1) << 1 | (level & 1);
}

static void addHeadStatus(JsonDocument &doc) {
    static const char *const bodyStates[] = {"probing", "ready", "unavailable"};
    static const char *const servoStates[] = {"off", "powering", "ready", "unavailable"};
    doc["body"] = bodyStates[int(lights)];
    doc["servos"] = servoStates[int(servos)];
    doc["servoYaw"] = servoPosition[0];
    doc["servoPitch"] = servoPosition[1];
    doc["commandYaw"] = sentYaw == INT32_MIN ? -1 : sentYaw;
    doc["commandPitch"] = sentPitch == INT32_MIN ? -1 : sentPitch;
    doc["supplyMv"] = supplyMillivolts;
    doc["supplyMa"] = supplyMilliamps;
    doc["vmEnable"] = vmEnable;
    doc["powerCycles"] = servoPowerCycles;
    doc["servoRxBytes"] = servoRxBytes;
    doc["writeReply"] = lastWriteReply;
    doc["servoVoltsYaw"] = servoVolts[0];
    doc["extOutput"] = extOutput;
    doc["servoTest"] = servoTestLog;
    doc["vbusMv"] = vbusMillivolts;
    doc["extRetries"] = extRetries;
    doc["servoVoltsPitch"] = servoVolts[1];
    doc["readReply"] = lastReadReply;
}

static void updateHead() {
    const uint32_t now = millis();
    if (servoTestPending && servos == Servos::Ready) runServoTest();
    // Hold still around a self-test, but let a pending one power the servos.
    if (!servoTestPending && int32_t(servoTestUntil - now) > 0) {
        headMode = "testing";
        return;
    }
    if (lights == Lights::Unavailable || servos == Servos::Unavailable) headMode = "unavailable";
    if (lights != Lights::Ready || servos == Servos::Unavailable || int32_t(now - nextHeadAt) < 0) return;
    nextHeadAt = now + 50;

    // Tracking states: search up to 20 s, center a found face for 5-10 s,
    // stay locked on while it is there, search again when it is gone, and
    // give up (back to the home pose) when a search finds nothing.
    const bool voice = output || microphonePeak.exchange(0) > 1500;
    float x, y;
    uint32_t age;
    if (trackEnabled && faceCameraLatest(x, y, age) && age < 1000 && now - age != lastFaceAt) {
        // Center each new sighting, measured from where the snapshot was taken.
        lastFaceAt = now - age;
        lastFaceX = x;
        lastFaceY = y;
        gazeTarget = gazeToward(faceGaze, x, y, reverseX, reverseY);
        if (fabsf(x) <= 0.1f && fabsf(y) <= 0.1f) {
            offCenterHits = 0;
            ++centeredHits;
        } else if (fabsf(x) > 0.18f || fabsf(y) > 0.18f) {
            centeredHits = 0;
            ++offCenterHits;
        }
        if (track != Track::Centering && track != Track::Locked) setTrack(Track::Centering, now);
    }
    const bool settled = gazeNow.yaw == gazeTarget.yaw && gazeNow.pitch == gazeTarget.pitch;
    // Missed detections are normal (about three snapshots a second, blurred
    // while turning): the face is gone only after 3 s and once settled.
    const bool faceGone = now - lastFaceAt > 3000 && settled;
    const uint32_t inState = now - trackSince;
    if (!trackEnabled) {
        if (track != Track::Resting) setTrack(Track::Resting, now);
    } else if (track == Track::Resting) {
        // A new conversation starts a search, but not right after giving up.
        if (voice && (!gaveUpAt || now - gaveUpAt > 30000)) setTrack(Track::Searching, now);
    } else if (track == Track::Searching) {
        if (inState > 20000) {
            gaveUpAt = now;
            setTrack(Track::GivingUp, now);
        }
    } else if (track == Track::Centering) {
        // Keep centering for 5-10 s even through missed detections, then lock.
        if ((inState >= 5000 && centeredHits >= 2) || inState >= 10000) setTrack(Track::Locked, now);
    } else if (track == Track::Locked) {
        if (faceGone) setTrack(Track::Searching, now);
    } else if (track == Track::GivingUp) {
        if (!gazeNow.yaw && !gazeNow.pitch) setTrack(Track::Resting, now);
    }

    const bool looking = int32_t(lookUntil - now) > 0;
    const bool searching = !looking && track == Track::Searching;
    if (looking) gazeTarget = lookGaze;
    else if (track == Track::Resting || track == Track::GivingUp || searching) gazeTarget = Gaze();
    const bool speaking = nodEnabled && output;
    if (speaking && nodScale == 0) nodStart = now;
    nodScale = speaking ? min(1.0f, nodScale + 0.1f) : max(0.0f, nodScale - 0.1f);
    const bool active = looking || track != Track::Resting || servoTestPending || nodScale > 0 || gazeNow.yaw || gazeNow.pitch;
    static const char *const trackNames[] = {"resting", "searching", "centering", "locked", "givingup"};
    headMode = !trackEnabled && !looking ? "off"
             : servos == Servos::Off || servos == Servos::Powering ? (active ? "waking" : "resting")
             : looking ? "look" : trackNames[int(track)];

    if (servos == Servos::Off) {
        if (!active) return;
        // Expander pin 0 enables servo power (VM_EN): output, pull-up, then
        // off and on again. A servo can be left unresponsive by an earlier
        // session, and an ESP32 reset alone does not cut servo power.
        if (!bodyPinBit(0x03, 0x01, true) || !bodyPinBit(0x0b, 0x01, false) ||
            !bodyPinBit(0x09, 0x01, true) || !bodyPinBit(0x05, 0x01, false)) {
            servos = Servos::Unavailable;
            Serial.println("[bot] servo power unavailable; head movement disabled");
            return;
        }
        ++servoPowerCycles;
        servos = Servos::Powering;
        servoAt = now + 600;
        return;
    }
    if (servos == Servos::Powering) {
        if (int32_t(now - servoAt) < 0) return;
        if (!torqueOn && !(bodyPinReadsHigh())) {
            bodyPinBit(0x05, 0x01, true);  // power back on
            servoAt = now + 1500;          // the servos take about a second to boot
            return;
        }
        servos = Servos::Ready;
        torqueFailingSince = 0;
    }
    if (!active) {
        // Release once the head has been back at rest for a second.
        if (!restingSince) restingSince = now;
        if (torqueOn && now - restingSince > 1000) setTorque(false);
        return;
    }
    restingSince = 0;
    if (!torqueOn && !setTorque(true)) {
        // Retried each tick; if the servos stay silent, power-cycle them.
        if (!torqueFailingSince) torqueFailingSince = now;
        if (now - torqueFailingSince > 3000) {
            Serial.println("[bot] servos not responding; power-cycling them");
            servos = Servos::Off;
        }
        return;
    }
    torqueFailingSince = 0;
    if (searching) {
        gazeNow = searchStep(gazeNow, search);  // 12 degrees per second
    } else {
        gazeNow.yaw = approach(gazeNow.yaw, gazeTarget.yaw, 20);  // at most 40 degrees per second
        gazeNow.pitch = approach(gazeNow.pitch, gazeTarget.pitch, 20);
    }
    faceCameraSetGaze(gazeNow.yaw, gazeNow.pitch);
    const int nod = int(nodScale * nodTenths(now - nodStart, nodAmplitude, nodPeriod));
    const int pitch = pitchRaw(pitchZero, gazeNow.pitch + nod);
    if (pitch != sentPitch) moveServo(PITCH_SERVO_ID, sentPitch = pitch, 100);
    if (trackEnabled) {
        const int yaw = yawRaw(yawZero, gazeNow.yaw);
        if (yaw != sentYaw) moveServo(YAW_SERVO_ID, sentYaw = yaw, 100);
    }
}

// Hand the current state to the face task, which owns the display.
static void publishFace() {
    static String previousStatus, previousExpression;
    if (status != previousStatus || expression != previousExpression) {
        previousStatus = status;
        previousExpression = expression;
        Serial.printf("[bot] state=%s expression=%s\n", status.c_str(), expression.c_str());
    }
    FaceView view;
    strlcpy(view.status, status.c_str(), sizeof view.status);
    strlcpy(view.expression, expression.c_str(), sizeof view.expression);
    view.mouth = mouth;
    view.speaking = output;
    view.ready = ready;
    view.muted = muted;
    float x, y;
    uint32_t age;
    if (trackEnabled && faceCameraLatest(x, y, age) && age < 1500) {
        // A face on the camera's right is on the screen's left, seen from the front.
        view.looking = true;
        view.lookX = reverseX ? x : -x;
        view.lookY = reverseY ? -y : y;
    }
    faceDisplayUpdate(view);
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
    faceDisplayBegin();
    // Before any audio: camera setup borrows the internal I2C bus briefly.
    faceCameraBegin();
    micQueue = xQueueCreate(8, sizeof(MicFrame));
    micLock = xSemaphoreCreateMutex();
    if (!micQueue || !micLock || xTaskCreate(captureTask, "bot_capture", 4096, nullptr, 2, nullptr) != pdPASS) {
        status = "Audio allocation failed";
        publishFace();
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
        if (nvs_get_i32(servoSettings, "zero_pos_1", &zero) == ESP_OK && zero >= 0 && zero <= SERVO_RAW_MAX) yawZero = zero;
        nvs_close(servoSettings);
    }
    Serial.printf("[bot] servo zero yaw=%d pitch=%d\n", yawZero, pitchZero);
    if (!servoBusBegin()) Serial.println("[bot] servo bus unavailable");
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
    readServos();
    // Live tracking state for the dashboard, a few times a second.
    if (relayConnected && int32_t(millis() - nextHeadReport) >= 0) {
        nextHeadReport = millis() + 300;
        JsonDocument doc;
        doc["type"] = "head";
        doc["mode"] = headMode;
        doc["yaw"] = gazeNow.yaw;
        doc["pitch"] = gazeNow.pitch;
        doc["targetYaw"] = gazeTarget.yaw;
        doc["targetPitch"] = gazeTarget.pitch;
        doc["nod"] = nodScale > 0;
        doc["torque"] = torqueOn;
        doc["faceAge"] = lastFaceAt ? int32_t(millis() - lastFaceAt) : -1;
        String text;
        serializeJson(doc, text);
        socket.sendTXT(text);
    }
    // One camera snapshot in flight at a time; the relay replies with any face.
    if (relayConnected && trackEnabled && (!frameInFlight || millis() - frameSentAt > 2000)) {
        uint8_t *frame;
        size_t frameLength;
        if (faceCameraTakeFrame(frame, frameLength, frameGaze.yaw, frameGaze.pitch)) {
            socket.sendBIN(frame, frameLength);
            free(frame);
            frameInFlight = true;
            frameSentAt = millis();
        }
    }
    if (relayConnected && int32_t(millis() - nextDeviceStatus) >= 0) {
        sendDeviceStatus();
        nextDeviceStatus = millis() + 5000;
    }
    if (int32_t(millis() - nextDraw) >= 0) {
        publishFace();
        nextDraw = millis() + 40;
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
