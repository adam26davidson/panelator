#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <AsyncUDP.h>
#include <ArduinoOTA.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include "config.h"

// ----- Pin mapping for ESP32-S3-N16R8 -----
#define R1_PIN  42
#define G1_PIN  41
#define B1_PIN  40
#define R2_PIN  2
#define G2_PIN  1
#define B2_PIN  39
#define A_PIN   45
#define B_PIN   48
#define C_PIN   47
#define D_PIN   21
#define E_PIN   14
#define CLK_PIN 12
#define LAT_PIN 11
#define OE_PIN  10

#define PANEL_RES_X 128
#define PANEL_RES_Y 64
#define PANEL_CHAIN 1
#define PANEL_PIXELS (PANEL_RES_X * PANEL_RES_Y)
#define FRAME_BYTES_MONO (PANEL_PIXELS / 8)  // 1-bit: 1 bit per pixel

// ============================================================
// Wire protocol (UDP)
// ============================================================
// Each UDP packet is one complete message. All multi-byte fields are
// little-endian (ESP32 native).
//
// Offset  Size  Field
// 0       2     magic       0x7075
// 2       1     version     0x01 = legacy, header ends at payloadLen
//                           0x02 = header carries a uint16 seq field
// 3       1     format      0x01 = MONO_1BIT
//                           0x02 = CMD_BRIGHTNESS
//                           (0x00 FULL_RGB565 retired — a full frame
//                           never fit one UDP datagram)
// 4       2     width       panel width in pixels (ignored for commands)
// 6       2     height      panel height in pixels (ignored for commands)
// 8       4     payloadLen  byte count of payload (excludes seq)
// 12      2     seq         v2 only — wrapping per-frame counter, used
//                           for loss/reorder diagnostics
// 12/14   ...   payload     (v1 at 12, v2 at 14)
//
// MONO_1BIT:      row-major, top→bottom, L→R, MSB first.   1024 bytes.
//                 v2 packet: 1038 bytes — fits one UDP datagram.
//                 Lit pixels use the panel's current foreground colour.
// CMD_BRIGHTNESS: single byte, 0..255. Does not count as a frame for
//                 stale detection; seq is ignored for commands.
// ============================================================

static const uint16_t UDP_PORT            = 7075;
static const uint16_t FRAME_MAGIC         = 0x7075;
static const uint8_t  FRAME_VERSION_V1    = 0x01;
static const uint8_t  FRAME_VERSION_V2    = 0x02;
static const uint8_t  FMT_MONO_1BIT       = 0x01;
static const uint8_t  FMT_CMD_BRIGHTNESS  = 0x02;

struct __attribute__((packed)) FrameHeader {
    uint16_t magic;
    uint8_t  version;
    uint8_t  format;
    uint16_t width;
    uint16_t height;
    uint32_t payloadLen;
};

struct __attribute__((packed)) FrameHeaderV2 {
    FrameHeader base;
    uint16_t    seq;
};

// ============================================================
// Globals
// ============================================================

static MatrixPanel_I2S_DMA* dma_display = nullptr;
static AsyncUDP udp;

// ---- Jitter buffer -----------------------------------------
// WiFi delivers frames in clumps (AP aggregation) with gaps up to
// ~100 ms even when the sender ticks cleanly; displaying on arrival
// copies that chaos straight to the panel. Instead the UDP task
// enqueues frames here and loop() releases them on a fixed 60 Hz
// clock (see the pacer below). 32 slots × ~1 KB ≈ 33 KB static RAM.
//
// Ring ops (including the 1 KB payload memcpy, ~4 µs from internal
// RAM) run inside the critical section: at 60 Hz the cost is
// negligible and it makes the two-task ring trivially correct —
// no reserved-slot states, no publish ordering to reason about.
static const int RING_FRAMES = 32;
struct FrameSlot {
    uint16_t seq;
    uint8_t  payload[FRAME_BYTES_MONO];
};
static FrameSlot ring[RING_FRAMES];
static uint8_t  ringHead  = 0;   // next slot the UDP task writes
static uint8_t  ringTail  = 0;   // next slot loop() reads
static uint8_t  ringCount = 0;
static portMUX_TYPE ringMux = portMUX_INITIALIZER_UNLOCKED;

// ---- Pacer -------------------------------------------------
// Fill-then-release: wait until TARGET_DEPTH frames are buffered,
// then release one every FRAME_PERIOD_US on our own clock. Empty ring
// at a deadline → hold the last frame (underrun). Depth creeping past
// TARGET_DEPTH + DEPTH_SLACK (sender clock running fast, or a burst
// after an outage) → drop oldest frames back down to TARGET_DEPTH.
// Sustained underrun (~0.5 s) → back to fill mode so a stream restart
// re-centers latency instead of running the buffer dry forever.
static const uint32_t FRAME_PERIOD_US = 16667;  // 60 Hz release
// ~200 ms added latency — rides out WiFi gaps twice as long as the
// worst measured (~100 ms). Latency is invisible on a dashboard;
// anything up to ~500 ms (depth 30) is acceptable per 2026-08-01.
static const uint8_t  TARGET_DEPTH    = 12;
static const uint8_t  DEPTH_SLACK     = 3;
static const uint16_t UNDERRUNS_TO_REFILL = 30;
static bool     pacing               = false;
static uint32_t nextReleaseUs        = 0;
static uint16_t consecutiveUnderruns = 0;

// Foreground colour for MONO_1BIT frames (RGB565).
static uint16_t fgColor = 0xFFFF;  // white

static volatile unsigned long lastFrameMs = 0;
static bool     isStale    = false;
static uint32_t frameCount = 0;   // frames displayed since boot

// ---- Per-5-second diagnostics ------------------------------
// Written by whichever task owns the event; read and reset by the
// loop() log tick. Increment/reset races can lose the odd count —
// acceptable for diagnostics, not worth a lock.
static uint32_t      rxTick        = 0;   // frames received this window
static uint32_t      dispTick      = 0;   // frames displayed this window
static unsigned long fpsWindowMs   = 0;
static unsigned long lastPacketUs  = 0;
static uint32_t      arrivalMaxUs  = 0;
static uint32_t      arrivalMinUs  = UINT32_MAX;
static uint32_t      burstCount    = 0;   // packets <8 ms after previous (clumped at 60 FPS)
static uint32_t      blitMaxUs     = 0;
static uint64_t      blitTotalUs   = 0;
static uint32_t      blitSamples   = 0;
static uint32_t      lostFrames    = 0;   // v2 seq gaps: sender skipped or WiFi lost
static uint32_t      reorders      = 0;   // v2 seq went backwards
static uint32_t      ringOverflows = 0;   // arrivals that evicted an unshown frame
static uint32_t      underruns     = 0;   // release ticks with an empty ring
static uint32_t      paceDrops     = 0;   // frames dropped to re-center depth

// v2 sequence tracking (UDP task only).
static uint16_t lastRxSeq = 0;
static bool     haveRxSeq = false;

static const unsigned long STALE_MS  = 60000;
static uint8_t        brightNormal   = 15;   // settable via CMD_BRIGHTNESS
static const uint8_t  BRIGHT_STALE   = 5;

// ============================================================
// Panel helpers
// ============================================================

// Blits write every pixel of the back buffer unconditionally, then
// flipDMABuffer() swaps. No clearScreen() — with double_buff=true
// clearScreen can blank rows in the currently-displayed buffer and
// produces visible row-band flicker during the scan.
//
// Batches runs of all-off (0x00) and all-on (0xFF) bytes into
// drawFastHLine calls; falls back to per-pixel only for mixed bytes.
// Measured 2026-08-01: 9.2 ms avg / 9.4 ms max per frame.
static void blitMono1Bit(const uint8_t* data) {
    const int bytesPerRow = PANEL_RES_X / 8;
    for (int y = 0; y < PANEL_RES_Y; y++) {
        const uint8_t* row = data + y * bytesPerRow;
        int  runStart = 0;
        int  runColor = -1;   // -1 = no run in progress

        for (int byteIdx = 0; byteIdx < bytesPerRow; byteIdx++) {
            uint8_t b = row[byteIdx];
            int baseX = byteIdx * 8;

            if (b == 0x00 || b == 0xFF) {
                int c = (b == 0xFF) ? fgColor : 0;
                if (runColor == c) continue;              // extend
                if (runColor != -1) {
                    dma_display->drawFastHLine(runStart, y,
                                               baseX - runStart, runColor);
                }
                runStart = baseX;
                runColor = c;
            } else {
                if (runColor != -1) {
                    dma_display->drawFastHLine(runStart, y,
                                               baseX - runStart, runColor);
                    runColor = -1;
                }
                for (int bit = 7; bit >= 0; bit--) {
                    uint16_t c = (b & (1 << bit)) ? fgColor : 0;
                    dma_display->drawPixel(baseX + (7 - bit), y, c);
                }
            }
        }
        if (runColor != -1) {
            dma_display->drawFastHLine(runStart, y,
                                       PANEL_RES_X - runStart, runColor);
        }
    }
    dma_display->flipDMABuffer();
}

static void showStatus(const char* l1,
                       const char* l2 = nullptr,
                       const char* l3 = nullptr,
                       const char* l4 = nullptr) {
    dma_display->clearScreen();
    dma_display->setTextSize(1);
    dma_display->setTextWrap(false);
    dma_display->setTextColor(dma_display->color565(80, 80, 80));
    const char* lines[] = { l1, l2, l3, l4 };
    int y = 4;
    for (int i = 0; i < 4; i++) {
        if (lines[i]) {
            dma_display->setCursor(2, y);
            dma_display->print(lines[i]);
        }
        y += 14;
    }
    dma_display->flipDMABuffer();
}

// ============================================================
// Frame processing
// ============================================================

// Handle a control message inline on whichever task received it.
// These are cheap (no pixel work) so there's no reason to defer them.
static void processControlMessage(const FrameHeader* h, const uint8_t* payload,
                                  size_t payloadAvail) {
    if (h->format != FMT_CMD_BRIGHTNESS) return;
    if (h->payloadLen != 1 || payloadAvail < 1) return;
    brightNormal = payload[0];
    if (!isStale) {
        dma_display->setBrightness8(brightNormal);
    }
    Serial.printf("[Cmd] Brightness -> %u\n", brightNormal);
}

// Blit a released frame and update stale bookkeeping. Runs on loop().
static void displayFrame(const uint8_t* payload) {
    unsigned long blitStartUs = micros();
    blitMono1Bit(payload);
    uint32_t blitDurUs = (uint32_t)(micros() - blitStartUs);
    if (blitDurUs > blitMaxUs) blitMaxUs = blitDurUs;
    blitTotalUs += blitDurUs;
    blitSamples++;

    lastFrameMs = millis();
    frameCount++;
    dispTick++;

    if (isStale) {
        isStale = false;
        dma_display->setBrightness8(brightNormal);
    }
}

// ============================================================
// AsyncUDP packet handler
// ============================================================
// Runs on the LwIP task — NOT the Arduino loop() thread. Validates
// the packet and enqueues the payload into the jitter buffer; loop()
// releases frames on its own clock. Blits (~9 ms) never run here —
// they'd starve the network stack. Control messages are handled
// inline. No Serial output on this task except rare command logs —
// a blocked UART would delay packet processing.
// ============================================================

static void onUdpPacket(AsyncUDPPacket& packet) {
    size_t len = packet.length();
    const uint8_t* data = packet.data();

    if (len < sizeof(FrameHeader)) return;
    const FrameHeader* h = reinterpret_cast<const FrameHeader*>(data);
    if (h->magic != FRAME_MAGIC) return;
    if (h->version != FRAME_VERSION_V1 && h->version != FRAME_VERSION_V2) return;

    const bool   v2         = (h->version == FRAME_VERSION_V2);
    const size_t headerSize = v2 ? sizeof(FrameHeaderV2) : sizeof(FrameHeader);
    if (len < headerSize) return;

    if (h->format == FMT_CMD_BRIGHTNESS) {
        processControlMessage(h, data + headerSize, len - headerSize);
        return;
    }

    if (h->format != FMT_MONO_1BIT) return;
    if (h->width != PANEL_RES_X || h->height != PANEL_RES_Y) return;
    if (h->payloadLen != FRAME_BYTES_MONO ||
        len < headerSize + FRAME_BYTES_MONO) return;

    // Sequence accounting. Forward gaps count as lost frames (sender
    // skips or WiFi loss — the sender never skips by design, so in
    // practice this is loss). Backward jumps are counted but the frame
    // is still enqueued and the tracker resynced: dropping "stale" seqs
    // would wedge the stream after a sender restart resets its counter.
    uint16_t seq;
    if (v2) {
        seq = reinterpret_cast<const FrameHeaderV2*>(data)->seq;
        if (haveRxSeq) {
            uint16_t gap = (uint16_t)(seq - lastRxSeq);
            if (gap == 0 || gap >= 0x8000) reorders++;
            else if (gap > 1)              lostFrames += gap - 1;
        }
    } else {
        seq = (uint16_t)(lastRxSeq + 1);   // synthesize for v1 — no loss stats
    }
    lastRxSeq = seq;
    haveRxSeq = true;

    portENTER_CRITICAL(&ringMux);
    if (ringCount == RING_FRAMES) {   // full — evict oldest, latest wins
        ringTail = (uint8_t)((ringTail + 1) % RING_FRAMES);
        ringCount--;
        ringOverflows++;
    }
    FrameSlot& slot = ring[ringHead];
    slot.seq = seq;
    memcpy(slot.payload, data + headerSize, FRAME_BYTES_MONO);
    ringHead = (uint8_t)((ringHead + 1) % RING_FRAMES);
    ringCount++;
    portEXIT_CRITICAL(&ringMux);

    rxTick++;

    // Per-packet arrival-delta tracking.
    unsigned long nowUs = micros();
    if (lastPacketUs != 0) {
        uint32_t delta = (uint32_t)(nowUs - lastPacketUs);
        if (delta > arrivalMaxUs) arrivalMaxUs = delta;
        if (delta < arrivalMinUs) arrivalMinUs = delta;
        if (delta < 8000)         burstCount++;
    }
    lastPacketUs = nowUs;
}

// ============================================================
// Setup & loop
// ============================================================

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("=== HUB75 Panel Receiver ===");

    // --- HUB75 panel ---
    HUB75_I2S_CFG::i2s_pins _pins = {
        R1_PIN, G1_PIN, B1_PIN,
        R2_PIN, G2_PIN, B2_PIN,
        A_PIN, B_PIN, C_PIN, D_PIN, E_PIN,
        LAT_PIN, OE_PIN, CLK_PIN
    };
    HUB75_I2S_CFG mxconfig(PANEL_RES_X, PANEL_RES_Y, PANEL_CHAIN, _pins);
    mxconfig.i2sspeed       = HUB75_I2S_CFG::HZ_8M;
    mxconfig.driver         = HUB75_I2S_CFG::FM6126A;
    mxconfig.clkphase       = false;
    mxconfig.latch_blanking = 3;
    mxconfig.double_buff    = true;

    dma_display = new MatrixPanel_I2S_DMA(mxconfig);
    if (!dma_display->begin()) {
        Serial.println("*** DMA display init failed ***");
        while (1) delay(1000);
    }
    dma_display->setBrightness8(brightNormal);
    dma_display->clearScreen();
    dma_display->flipDMABuffer();
    dma_display->clearScreen();

    showStatus("Connecting WiFi...", WIFI_SSID);

    // --- WiFi ---
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("Connecting to %s", WIFI_SSID);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    String ip = WiFi.localIP().toString();
    Serial.printf("\nConnected — IP %s\n", ip.c_str());

    // --- mDNS ---
    if (!MDNS.begin("hub75-panel")) {
        Serial.println("mDNS init failed");
    } else {
        Serial.println("mDNS: hub75-panel.local");
        MDNS.addService("hub75", "udp", UDP_PORT);
    }

    // --- OTA (ArduinoOTA, port 3232) ---
    // While an update is in flight, handle() blocks loop() — blits
    // stop and the panel shows progress; incoming frames pile into
    // the ring and overflow harmlessly. On success the chip reboots
    // into the other app slot and the pacer refills as usual.
    ArduinoOTA.setHostname("hub75-panel");
    ArduinoOTA.setPassword(OTA_PASSWORD);
    ArduinoOTA.onStart([]() {
        showStatus("OTA update...", "Receiving firmware");
    });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        static uint8_t lastPct = 255;
        uint8_t pct = (uint8_t)((uint64_t)progress * 100 / total);
        if (pct != lastPct && pct % 10 == 0) {
            lastPct = pct;
            char line[16];
            snprintf(line, sizeof(line), "%u%%", pct);
            showStatus("OTA update...", line);
        }
    });
    ArduinoOTA.onEnd([]() {
        showStatus("OTA update...", "Done - rebooting");
    });
    ArduinoOTA.onError([](ota_error_t err) {
        Serial.printf("[OTA] Error %u\n", (unsigned)err);
        showStatus("OTA failed", "Resuming stream...");
    });
    ArduinoOTA.begin();
    Serial.println("OTA ready (hostname hub75-panel, port 3232)");

    // --- UDP listener ---
    if (udp.listen(UDP_PORT)) {
        udp.onPacket(onUdpPacket);
        Serial.printf("UDP listening on :%u\n", UDP_PORT);
    } else {
        Serial.println("*** UDP listen failed ***");
    }

    // --- Waiting screen ---
    char ipLine[32];
    char portLine[32];
    snprintf(ipLine, sizeof(ipLine), "IP: %s", ip.c_str());
    snprintf(portLine, sizeof(portLine), "udp port: %u", UDP_PORT);
    showStatus("hub75-panel.local",
               ipLine,
               portLine,
               "Waiting for frames...");

    lastFrameMs = millis();
    fpsWindowMs = millis();
}

void loop() {
    ArduinoOTA.handle();

    uint32_t nowUs = micros();

    // Fill phase: hold off until the jitter buffer reaches target
    // depth, then start the release clock.
    if (!pacing && ringCount >= TARGET_DEPTH) {
        pacing        = true;
        nextReleaseUs = nowUs;
    }

    if (pacing && (int32_t)(nowUs - nextReleaseUs) >= 0) {
        static uint8_t blitCopy[FRAME_BYTES_MONO];
        bool have = false;

        portENTER_CRITICAL(&ringMux);
        if (ringCount > TARGET_DEPTH + DEPTH_SLACK) {
            // Depth crept up (fast sender clock or a post-outage
            // burst) — shed oldest frames back to target latency.
            while (ringCount > TARGET_DEPTH) {
                ringTail = (uint8_t)((ringTail + 1) % RING_FRAMES);
                ringCount--;
                paceDrops++;
            }
        }
        if (ringCount > 0) {
            memcpy(blitCopy, ring[ringTail].payload, FRAME_BYTES_MONO);
            ringTail = (uint8_t)((ringTail + 1) % RING_FRAMES);
            ringCount--;
            have = true;
        }
        portEXIT_CRITICAL(&ringMux);

        if (have) {
            displayFrame(blitCopy);
            consecutiveUnderruns = 0;
        } else {
            underruns++;
            if (++consecutiveUnderruns >= UNDERRUNS_TO_REFILL) {
                // Stream paused — go back to fill mode so the restart
                // re-centers buffer depth instead of running dry.
                pacing               = false;
                consecutiveUnderruns = 0;
            }
        }

        nextReleaseUs += FRAME_PERIOD_US;
        // Fell more than a period behind (blit overrun, WiFi task
        // starvation): resync instead of bursting to catch up.
        if ((int32_t)(micros() - nextReleaseUs) > (int32_t)FRAME_PERIOD_US) {
            nextReleaseUs = micros() + FRAME_PERIOD_US;
        }
    }

    // Diagnostics log every 5 seconds — on loop(), so a slow UART
    // never blocks the UDP task.
    unsigned long nowMs = millis();
    if (nowMs - fpsWindowMs >= 5000) {
        float winSec  = (float)(nowMs - fpsWindowMs) / 1000.0f;
        uint32_t blitAvgUs = blitSamples
                           ? (uint32_t)(blitTotalUs / blitSamples) : 0;
        Serial.printf(
            "[UDP] rx=%.1f disp=%.1f fps depth=%u | "
            "lost=%u reord=%u ovf=%u pace=%u und=%u | "
            "arrive=%u-%u us burst=%u | blit avg=%u max=%u us | total=%u\n",
            (float)rxTick / winSec, (float)dispTick / winSec,
            (unsigned)ringCount,
            (unsigned)lostFrames, (unsigned)reorders,
            (unsigned)ringOverflows, (unsigned)paceDrops,
            (unsigned)underruns,
            (unsigned)(arrivalMinUs == UINT32_MAX ? 0 : arrivalMinUs),
            (unsigned)arrivalMaxUs,
            (unsigned)burstCount,
            (unsigned)blitAvgUs, (unsigned)blitMaxUs,
            (unsigned)frameCount);
        fpsWindowMs   = nowMs;
        rxTick        = 0;
        dispTick      = 0;
        lostFrames    = 0;
        reorders      = 0;
        ringOverflows = 0;
        paceDrops     = 0;
        underruns     = 0;
        arrivalMinUs  = UINT32_MAX;
        arrivalMaxUs  = 0;
        burstCount    = 0;
        blitMaxUs     = 0;
        blitTotalUs   = 0;
        blitSamples   = 0;
    }

    // Stale detection.
    if (!isStale && millis() - lastFrameMs > STALE_MS) {
        isStale = true;
        dma_display->setBrightness8(BRIGHT_STALE);
        Serial.println("[Stale] No frames for 60 s — dimming panel");
    }

    // WiFi reconnect.
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WiFi] Lost — reconnecting");
        showStatus("WiFi lost...", "Reconnecting");
        WiFi.reconnect();
        unsigned long t = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) {
            delay(500);
        }
        if (WiFi.status() == WL_CONNECTED) {
            String newIp = WiFi.localIP().toString();
            Serial.printf("[WiFi] Reconnected — IP %s\n", newIp.c_str());
        }
    }

    // 1 ms tick: release deadlines land within ±1 ms of the 16.67 ms
    // grid, and the LwIP / UDP task, WiFi stack, and watchdog get time.
    delay(1);
}
