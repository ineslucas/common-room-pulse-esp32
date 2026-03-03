/*
  Room Ecology Sensor
  -------------------------
  Hardware:
    - SparkFun ESP32 Thing Plus C (ARDUINO_ESP32_THING_PLUS_C)
    - Waveshare BMM150 3-Axis Magnetometer (I2C: SDA/SCL)
    - SparkFun OpenPIR (Analog → GPIO34, Digital OUT → GPIO4)

  Uses Bosch's low-level bmm150 C API (bmm150.c / bmm150.h)
  — NOT a wrapper library class.

  Sends a JSON payload over TCP every `interval` ms to a host server.

  Baudrate is 115120
*/

#include <WiFi.h>
#include "arduino_secrets.h"
#include "Arduino.h"
#include "Wire.h"
#include "bmm150.h"

// ── WiFi / Server ─────────────────────────────────────────────────────────────
WiFiClient client;
// const char server[]   = "192.168.1.96"; // HOME
  // To check IP Address: ipconfig getifaddr en0
const char server[]   = "10.23.10.121"; // Sandbox
const int  portNum    = 8080;
String     deviceName = "RoomSensor";

// ── Timing ────────────────────────────────────────────────────────────────────
const long interval = 5000;  // ms between readings
long       lastSend = 0;

// ── BMM150 (Bosch low-level API) ──────────────────────────────────────────────
#define I2C_ADDRESS BMM150_I2C_ADDRESS_CSB_HIGH_SDO_HIGH
static struct bmm150_dev dev;
static uint8_t dev_addr = I2C_ADDRESS;

// ── OpenPIR pins ──────────────────────────────────────────────────────────────
const int PIR_ANALOG_PIN  = 34;  // GPIO34 (ADC1_CH6) — GPIO26/A0 is ADC2 and unusable while WiFi is active
const int PIR_DIGITAL_PIN = 4;

// ─────────────────────────────────────────────────────────────────────────────
// BMM150 I2C callbacks (required by Bosch API)
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
void setup() {
  Serial.begin(115200);
  if (!Serial) delay(3000);

  pinMode(PIR_DIGITAL_PIN, INPUT);
  pinMode(PIR_ANALOG_PIN, INPUT);

  // ── WiFi ──
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print("Attempting to connect to SSID: ");
    Serial.println(SECRET_SSID);
    delay(1000);
  }
  Serial.print("Connected to SSID: ");
  Serial.println(SECRET_SSID);
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Signal Strength (dBm): ");
  Serial.println(WiFi.RSSI());

  if (!setupMagnetometer()) {
    Serial.println("Halting — check BMM150 wiring.");
    while (1) delay(1000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  // Reconnect TCP if dropped
  if (!client.connected()) {
    Serial.print("Connecting to server ");
    Serial.print(server); Serial.print(":"); Serial.println(portNum);
    if (!client.connect(server, portNum)) {
      Serial.println("Connection failed. Retrying in 2s...");
      delay(2000);
      return;
    }
    Serial.println("TCP connected.");
  }

  // Drain any incoming server message
  if (client.available()) {
    Serial.println("Server: " + client.readStringUntil('\n'));
  }

  // ── Timed sensor read + send ──
  long now = millis();
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
  // Magnitude gives a single "electromagnetic busyness" number
  float magMag = sqrt(magX * magX + magY * magY + magZ * magZ);

  // ── Read OpenPIR ──
  int  pirRaw    = analogRead(PIR_ANALOG_PIN); // 0–4095 (12-bit ADC)
  bool pirMotion = digitalRead(PIR_DIGITAL_PIN);

  // ── Build compact JSON ──
  String json = "{";
  json += "\"device\":\""   + deviceName + "\",";
  json += "\"ts\":"         + String(now) + ",";
  json += "\"mag\":{";
  json +=   "\"x\":"        + String(magX, 2) + ",";
  json +=   "\"y\":"        + String(magY, 2) + ",";
  json +=   "\"z\":"        + String(magZ, 2) + ",";
  json +=   "\"mag\":"      + String(magMag, 2);
  json += "},";
  json += "\"pir\":{";
  json +=   "\"raw\":"      + String(pirRaw) + ",";
  json +=   "\"motion\":"   + String(pirMotion ? "true" : "false");
  json += "}}";

  client.println(json);
  Serial.println("Sent: " + json);
}
