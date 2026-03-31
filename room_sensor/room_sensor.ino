/*
  Room Ecology Sensor — MQTT Edition
  -------------------------
  Hardware:
    - SparkFun ESP32 Thing Plus C (ARDUINO_ESP32_THING_PLUS_C)
    - Waveshare BMM150 3-Axis Magnetometer (I2C: SDA/SCL)
    - SparkFun OpenPIR (Analog → GPIO34, Digital OUT → GPIO4)

  Uses Bosch's low-level bmm150 C API (bmm150.c / bmm150.h)
  — NOT a wrapper library class.

  I'm publishing a JSON payload over MQTT every `interval` ms
  to an MQTT broker running on my Digital Ocean droplet.
  The broker is Mosquitto on living.ines.systems:1883.

  Libraries used:
    - WiFi.h         — ESP32 WiFi connectivity
    - ArduinoMqttClient.h — MQTT client (from Arduino Library Manager)
    - Wire.h         — I2C for BMM150

  Adapted from Tom Igoe's ArduinoMqttClientTouchReadESP32 example:
  https://github.com/tigoe/mqtt-examples

  Baudrate is 115200
*/

#include <WiFi.h>
#include <ArduinoMqttClient.h>
#include <ESPping.h>          // For pinging devices on the local network to count them
#include "arduino_secrets.h"
#include "Arduino.h"
#include "Wire.h"
#include "bmm150.h"
#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>
#include <SPI.h>

// ── WiFi + MQTT ──────────────────────────────────────────────────────────────
WiFiClient wifi;                    // I use a plain WiFi connection (no SSL needed for now)
MqttClient mqttClient(wifi);        // My MQTT client wraps the WiFi connection

// I'm pointing at my own Mosquitto broker on Digital Ocean:
char broker[] = SECRET_MQTT_BROKER;
int  port     = 1883;
char topic[]  = "roomsensor";       // I publish all my sensor data to this single topic
String clientID = "roomSensor-";    // I'll make this unique with my MAC address below

String deviceName = "RoomSensor";

// ── Timing ────────────────────────────────────────────────────────────────────
const long interval = 5000;  // ms between readings — I send data every 5 seconds
long       lastSend = 0;

// ── WiFi Device Scan ─────────────────────────────────────────────────────────
// Scanning the local subnet every 20 minutes to count how many devices are online.
// Only scanning when connected to the home network (MyAltice 540c8b).
// The cached count gets included in every 5-second MQTT payload between scans.
const char*  HOME_SSID = "MyAltice 540c8b";     // The SSID that means "Home"
const long   SCAN_INTERVAL = 1200000;            // 20 minutes in ms
long         lastScanTime = -1200000;            // Force a scan on first loop by starting "expired"
int          cachedDeviceCount = -1;             // -1 means "no scan yet" or "not on home network"

// ── TFT Display colors ──────────────────────────────────────────────────────
// I precompute my colors so I don't recalculate them every frame.
uint16_t colBg;         // dark background
uint16_t colRing;       // outer ring color (hot pink)
uint16_t colText;       // light pink text
uint16_t colMotion;     // motion indicator color
uint16_t colClear;      // no-motion indicator color

// ── BMM150 (Bosch low-level API) ──────────────────────────────────────────────
#define I2C_ADDRESS BMM150_I2C_ADDRESS_CSB_HIGH_SDO_HIGH
static struct bmm150_dev dev;
static uint8_t dev_addr = I2C_ADDRESS;

// ── OpenPIR pins ──────────────────────────────────────────────────────────────
const int PIR_ANALOG_PIN  = 34;  // GPIO34 (ADC1_CH6) — GPIO26/A0 is ADC2 and unusable while WiFi is active
const int PIR_DIGITAL_PIN = 4;

// Pins for TFT Display
#define TFT_DC  15
#define TFT_CS  33
#define TFT_RST 27
#define TFT_SCK 18
#define TFT_MOSI 23

Adafruit_GC9A01A tft(TFT_CS, TFT_DC, TFT_RST);

// ─────────────────────────────────────────────────────────────────────────────
// BMM150 I2C callbacks (required by Bosch API)
// These three functions let the Bosch C driver talk to my I2C bus.
// ─────────────────────────────────────────────────────────────────────────────
void bmm150_user_delay_us(uint32_t period_us, void *intf_ptr) {
  delayMicroseconds(period_us);
}

int8_t bmm150_user_i2c_reg_write(uint8_t reg_addr, uint8_t *reg_data,
                                  uint32_t length, void *intf_ptr) {
  Wire.beginTransmission(I2C_ADDRESS);
  Wire.write(reg_addr);
  for (uint32_t i = 0; i < length; i++) Wire.write(reg_data[i]);
  Wire.endTransmission();
  return 0;
}

int8_t bmm150_user_i2c_reg_read(uint8_t reg_addr, uint8_t *reg_data,
                                 uint32_t length, void *intf_ptr) {
  Wire.beginTransmission(I2C_ADDRESS);
  Wire.write(reg_addr);
  if (Wire.endTransmission() != 0) return -1;
  Wire.requestFrom((uint8_t)I2C_ADDRESS, (uint8_t)length);
  for (uint32_t i = 0; i < length && Wire.available(); i++) {
    reg_data[i] = Wire.read();
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// I initialize the BMM150 magnetometer: normal power mode, high accuracy preset.
// Returns false if the sensor isn't wired up correctly.
// ─────────────────────────────────────────────────────────────────────────────
bool setupMagnetometer() {
  Wire.begin();  // SDA=21, SCL=22 on ESP32 Thing Plus C

  dev.intf     = BMM150_I2C_INTF;
  dev.intf_ptr = &dev_addr;
  dev.read     = bmm150_user_i2c_reg_read;
  dev.write    = bmm150_user_i2c_reg_write;
  dev.delay_us = bmm150_user_delay_us;

  int8_t rslt = bmm150_init(&dev);
  if (rslt != BMM150_OK) {
    Serial.print("[BMM150] Init failed, error: ");
    Serial.println(rslt);
    return false;
  }
  Serial.print("[BMM150] Chip ID: ");
  Serial.println(dev.chip_id);

  // Normal power mode
  struct bmm150_settings settings;
  settings.pwr_mode = BMM150_POWERMODE_NORMAL;
  rslt = bmm150_set_op_mode(&settings, &dev);
  if (rslt != BMM150_OK) {
    Serial.print("[BMM150] set_op_mode failed: "); Serial.println(rslt);
    return false;
  }

  // High accuracy preset (more averaging = less noise)
  settings.preset_mode = BMM150_PRESETMODE_HIGHACCURACY;
  rslt = bmm150_set_presetmode(&settings, &dev);
  if (rslt != BMM150_OK) {
    Serial.print("[BMM150] set_presetmode failed: "); Serial.println(rslt);
    return false;
  }

  Serial.println("[BMM150] Ready.");
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// I try each known WiFi network in order. For each one, I attempt to connect
// for a few seconds before moving on to the next. Returns true once connected.
// I also use this for reconnection in loop() — it cycles through all networks.
// ─────────────────────────────────────────────────────────────────────────────
bool connectToWiFi() {
  WiFi.disconnect();
  delay(100);

  for (int n = 0; n < NUM_NETWORKS; n++) {
    Serial.print("Trying WiFi: ");
    Serial.println(WIFI_SSIDS[n]);

    WiFi.begin(WIFI_SSIDS[n], WIFI_PASSES[n]);

    // I wait up to 8 seconds per network before giving up and trying the next
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 16) {
      delay(500);
      Serial.print(".");
      attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println();
      Serial.print("Connected to: ");
      Serial.println(WIFI_SSIDS[n]);
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
      Serial.print("Signal (dBm): ");
      Serial.println(WiFi.RSSI());
      return true;
    }

    Serial.println(" failed.");
  }

  Serial.println("No known WiFi networks found.");
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// I connect to the MQTT broker. If it fails, I print the error code and return false.
// On success, I subscribe to my own topic so I could receive commands later if needed.
// ─────────────────────────────────────────────────────────────────────────────
boolean connectToBroker() {
  Serial.print("Connecting to MQTT broker: ");
  Serial.print(broker);
  Serial.print(":");
  Serial.println(port);

  if (!mqttClient.connect(broker, port)) {
    Serial.print("MQTT connection failed. Error code: ");
    Serial.println(mqttClient.connectError());
    return false;
  }

  Serial.println("MQTT connected!");
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  if (!Serial) delay(3000);

  pinMode(PIR_DIGITAL_PIN, INPUT);
  pinMode(PIR_ANALOG_PIN, INPUT);

  // ── TFT Display ──
  // I initialize SPI explicitly because the ESP32 Thing Plus C
  // doesn't use the default MOSI pin for this display.
  SPI.begin(TFT_SCK, -1, TFT_MOSI, TFT_CS);
  tft.begin();  // <-- THIS was missing! Display won't work without it.
  tft.setRotation(0);

  // I set up my color palette to match the dashboard's dark pink theme.
  colBg     = tft.color565(40, 0, 20);      // very dark magenta
  colRing   = tft.color565(255, 105, 180);   // hot pink
  colText   = tft.color565(243, 179, 255);   // light pink (same as dashboard)
  colMotion = tft.color565(255, 105, 180);   // hot pink for motion
  colClear  = tft.color565(100, 60, 80);     // muted for no motion

  // I show a boot message while WiFi connects.
  tft.fillScreen(colBg);
  tft.setTextColor(colText);
  tft.setTextSize(2);
  tft.setCursor(50, 100);
  tft.println("connecting");
  tft.setCursor(70, 125);
  tft.println("wifi...");

  // ── WiFi ──
  // I try all known networks until one connects.
  // No more commenting/uncommenting — just plug in anywhere.
  while (!connectToWiFi()) {
    Serial.println("Retrying all networks in 5s...");
    delay(5000);
  }

  // ── NTP Time Sync ──
  // I sync the ESP32's clock with an NTP server so my timestamps
  // are real wall-clock time, not millis-since-boot.
  // configTime(gmtOffset_sec, daylightOffset_sec, ntpServer)
  configTime(-5 * 3600, 3600, "pool.ntp.org");  // EST with DST
  Serial.print("Syncing NTP time");
  struct tm timeinfo;
  int attempts = 0;
  while (!getLocalTime(&timeinfo) && attempts < 10) {
    Serial.print(".");
    delay(500);
    attempts++;
  }
  if (attempts < 10) {
    Serial.println(" done!");
    Serial.print("Current time: ");
    Serial.println(&timeinfo, "%Y-%m-%d %H:%M:%S");
  } else {
    Serial.println(" failed — timestamps will use millis() fallback.");
  }

  // ── MQTT Client ID ──
  // I make my client ID unique by appending my MAC address.
  // This way multiple devices won't collide on the broker.
  byte mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++) {
    clientID += String(mac[i], HEX);
  }
  mqttClient.setId(clientID);
  Serial.println("MQTT client ID: " + clientID);

  // ── Magnetometer ──
  if (!setupMagnetometer()) {
    Serial.println("Halting — check BMM150 wiring.");
    while (1) delay(1000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I draw a simple visualization on the round TFT:
//   - A filled circle in the center whose radius scales with magnetic magnitude
//   - The magnitude value as text
//   - A colored ring around the edge that turns bright pink on motion
// The GC9A01A is 240x240 pixels, center at (120, 120).
// ─────────────────────────────────────────────────────────────────────────────
void updateDisplay(float mag, float x, float y, float z, bool motion) {
  // I clear the screen each frame. On a small display at 5s intervals this is fine.
  tft.fillScreen(colBg);

  // I draw a motion-indicator ring around the edge of the round display.
  uint16_t ringColor = motion ? colMotion : colClear;
  for (int r = 119; r >= 115; r--) {
    tft.drawCircle(120, 120, r, ringColor);
  }

  // I map magnetic magnitude to a circle radius.
  // Typical indoor readings are 20–80 µT; I cap at 200 µT for the visual.
  int radius = map(constrain((int)mag, 0, 200), 0, 200, 8, 80);
  tft.fillCircle(120, 120, radius, colRing);

  // I show the magnitude number centered on the circle.
  // For large circles I use dark text, for small ones light text.
  if (radius > 30) {
    tft.setTextColor(colBg);
  } else {
    tft.setTextColor(colText);
  }
  tft.setTextSize(3);
  // I center the text roughly: each char is ~18px wide at size 3.
  String magStr = String((int)mag);
  int textW = magStr.length() * 18;
  tft.setCursor(120 - textW / 2, 112);
  tft.print(magStr);

  // I show the unit label below the circle.
  tft.setTextColor(colText);
  tft.setTextSize(1);
  tft.setCursor(108, 145 + radius / 2);
  tft.print("uT");

  // I show X/Y/Z values at the bottom of the display.
  tft.setTextSize(1);
  tft.setTextColor(colText);
  tft.setCursor(30, 210);
  tft.print("X:");
  tft.print((int)x);
  tft.setCursor(90, 210);
  tft.print("Y:");
  tft.print((int)y);
  tft.setCursor(150, 210);
  tft.print("Z:");
  tft.print((int)z);

  // I show motion status at the top.
  tft.setCursor(80, 20);
  tft.setTextSize(2);
  tft.setTextColor(motion ? colMotion : colClear);
  tft.print(motion ? "MOTION" : "clear");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanning the local subnet to count reachable devices via ICMP ping.
// Using the ESP32's own IP and subnet mask to figure out the network range
// automatically — no hardcoded subnet needed.
// Each host gets 1 ping with a short timeout so the full sweep stays fast.
// A /24 subnet (254 hosts) at ~50ms timeout ≈ 13 seconds worst case.
// This only runs when connected to the home network (MyAltice 540c8b).
// ─────────────────────────────────────────────────────────────────────────────
int scanNetworkDevices() {
  IPAddress localIP = WiFi.localIP();
  IPAddress subnet  = WiFi.subnetMask();

  // Computing the network address and broadcast address from my IP and mask.
  // e.g., IP 192.168.1.96 with mask 255.255.255.0 → network 192.168.1.0, broadcast 192.168.1.255
  uint32_t ip   = (uint32_t)localIP;
  uint32_t mask = (uint32_t)subnet;
  uint32_t net  = ip & mask;          // network address (first in range)
  uint32_t bcast = net | ~mask;       // broadcast address (last in range)

  // Counting how many hosts are in this subnet, skipping network and broadcast addresses.
  // On a /24 that's 254 hosts; on a /16 it could be 65534 — capping at 254
  // to keep scan time reasonable on any subnet.
  uint32_t firstHost = net + 1;
  uint32_t lastHost  = bcast - 1;
  if (lastHost - firstHost > 254) {
    // Limiting to the first 254 addresses if the subnet is larger than /24
    lastHost = firstHost + 253;
  }

  Serial.println("[SCAN] Starting network device scan...");
  Serial.print("[SCAN] Subnet: ");
  Serial.print(IPAddress(net));
  Serial.print(" / ");
  Serial.println(IPAddress(mask));

  int count = 0;

  for (uint32_t host = firstHost; host <= lastHost; host++) {
    IPAddress target(host);

    // Skipping my own IP — already know this device is online
    if (target == localIP) continue;

    // Sending 1 ping with a short timeout (50ms).
    // Ping.ping() returns true if the host responds.
    if (Ping.ping(target, 1)) {
      count++;
      Serial.print("[SCAN] Found: ");
      Serial.println(target);
    }
  }

  // Adding 1 for this ESP32 itself — it's a device on the network too.
  count += 1;

  Serial.print("[SCAN] Total devices found: ");
  Serial.println(count);

  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Determining which network label to use based on the current SSID.
// Returns "Home" when connected to MyAltice 540c8b, "Sandbox" for anything else.
// ─────────────────────────────────────────────────────────────────────────────
String getNetworkLabel() {
  String ssid = WiFi.SSID();
  if (ssid == HOME_SSID) {
    return "Home";
  }
  return "Sandbox";
}

// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  // I reconnect to WiFi if the connection dropped (e.g. moved locations, router rebooted).
  // connectToWiFi() cycles through all known networks automatically.
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected. Scanning known networks...");
    if (!connectToWiFi()) {
      delay(5000);
      return;
    }
  }

  // I reconnect to the MQTT broker if needed
  if (!mqttClient.connected()) {
    connectToBroker();
    // If connection failed, wait a bit and try again next loop
    if (!mqttClient.connected()) {
      delay(2000);
      return;
    }
  }

  // I call poll() to keep the MQTT connection alive and process incoming messages
  mqttClient.poll();

  // ── WiFi device scan (every 20 minutes, home network only) ──────────────
  // Checking if it's time to rescan. On the home network, running a ping sweep
  // to count devices. On other networks, just resetting the count to -1.
  long now = millis();
  if (now - lastScanTime >= SCAN_INTERVAL) {
    lastScanTime = now;
    if (getNetworkLabel() == "Home") {
      cachedDeviceCount = scanNetworkDevices();
    } else {
      // Not on home network — no scan, just mark as unavailable
      cachedDeviceCount = -1;
    }
  }

  // ── Timed sensor read + publish ──
  if (now - lastSend < interval) return;
  lastSend = now;

  // ── Read BMM150 ──
  struct bmm150_mag_data mag_data;
  int8_t rslt = bmm150_read_mag_data(&mag_data, &dev);
  if (rslt != BMM150_OK) {
    Serial.print("[BMM150] Read error: "); Serial.println(rslt);
    return;
  }
  float magX = (float)mag_data.x; // µT
  float magY = (float)mag_data.y;
  float magZ = (float)mag_data.z;
  // Magnitude gives me a single "electromagnetic busyness" number
  float magMag = sqrt(magX * magX + magY * magY + magZ * magZ);

  // ── Read OpenPIR ──
  int  pirRaw    = analogRead(PIR_ANALOG_PIN); // 0–4095 (12-bit ADC)
  bool pirMotion = digitalRead(PIR_DIGITAL_PIN);

  // ── Update the TFT display with current readings ──
  updateDisplay(magMag, magX, magY, magZ, pirMotion);

  // ── Build compact JSON ──
  // I use real UTC epoch time from NTP if available, otherwise fall back to millis().
  // The dashboard will detect epoch timestamps (> 1 billion) and format them nicely.
  unsigned long timestamp;
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    time_t epochTime;
    time(&epochTime);
    timestamp = (unsigned long)epochTime;
  } else {
    timestamp = now;  // fallback to millis if NTP hasn't synced
  }

  String json = "{";
  json += "\"device\":\""   + deviceName + "\",";
  json += "\"ts\":"         + String(timestamp) + ",";
  json += "\"mag\":{";
  json +=   "\"x\":"        + String(magX, 2) + ",";
  json +=   "\"y\":"        + String(magY, 2) + ",";
  json +=   "\"z\":"        + String(magZ, 2) + ",";
  json +=   "\"mag\":"      + String(magMag, 2);
  json += "},";
  json += "\"pir\":{";
  json +=   "\"raw\":"      + String(pirRaw) + ",";
  json +=   "\"motion\":"   + String(pirMotion ? "true" : "false");
  json += "},";
  // Appending network info: which WiFi network and how many devices are on it.
  // "network" is "Home" or "Sandbox". "wifi_devices" is the count from the last
  // scan, or -1 if not on the home network / no scan has run yet.
  json += "\"network\":\""  + getNetworkLabel() + "\",";
  json += "\"wifi_devices\":" + String(cachedDeviceCount);
  json += "}";

  // ── Publish to MQTT ──
  // I use beginMessage/print/endMessage — same pattern as Tom Igoe's examples.
  mqttClient.beginMessage(topic);
  mqttClient.print(json);
  mqttClient.endMessage();

  Serial.println("Published: " + json);
}
