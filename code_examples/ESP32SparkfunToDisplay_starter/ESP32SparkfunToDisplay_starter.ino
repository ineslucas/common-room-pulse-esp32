#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>
#include <SPI.h>

// Device Pin mapping
#define TFT_DC  15
#define TFT_CS  33
#define TFT_RST 27
// // SCL -> 18 (hardware SCK)
// // SDA -> 19 (hardware MOSI)

#define TFT_SCK 18
#define TFT_MOSI 23

Adafruit_GC9A01A tft(TFT_CS, TFT_DC, TFT_RST);

void setup() {
  Serial.begin(115200);
  delay(500);

  // Explicitly initialize SPI with pins
  SPI.begin(TFT_SCK, -1, TFT_MOSI, TFT_CS); // SCK, MISO (unused), MOSI, SS

  Serial.println("Starting...");
  tft.begin();
  Serial.println("tft.begin() done");

  uint16_t hotPink = tft.color565(255, 105, 180);
  uint16_t lightPink = tft.color565(255, 182, 193);


  // tft.fillScreen(GC9A01A_RED);
  tft.fillScreen(hotPink);
  tft.setTextColor(lightPink);
  // Serial.println("with light pink");

  // tft.fillScreen(GC9A01A_BLACK);
  tft.setCursor(40, 100);
  // tft.setTextColor(GC9A01A_WHITE);
  tft.setTextSize(3);
  tft.println("hello :)");
}

void loop() {}