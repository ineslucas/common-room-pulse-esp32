# Room Ecology Sensor

ESP32-based sensor that reads magnetic field (BMM150) and motion (OpenPIR), publishes data over MQTT to a cloud dashboard.

**Live dashboard:** [http://living.ines.systems](http://living.ines.systems)

## Hardware
- SparkFun ESP32 Thing Plus C
- Waveshare BMM150 3-Axis Magnetometer (I2C: SDA/SCL)
- SparkFun OpenPIR (Analog → GPIO34, Digital OUT → GPIO4)
- GC9A01A Round TFT Display (SPI: DC→15, CS→33, RST→27, SCK→18, MOSI→23)

## Architecture

```
ESP32 ──MQTT:1883──▶ Mosquitto (living.ines.systems)
                          │
                    Node.js logger → log.json
                          │
                    Nginx serves dashboard + log.json on port 80
```

## Getting Started (from your laptop)

### 1. Upload firmware to ESP32
1. Open `room_sensor/room_sensor.ino` in Arduino IDE
2. Set WiFi credentials in `room_sensor/arduino_secrets.h`:
   - Uncomment the network you're on (Home or Skool)
   - Comment out the other one
3. Install libraries via Library Manager if not already installed:
   - `ArduinoMqttClient`
   - `Adafruit GFX Library`
   - `Adafruit GC9A01A`
4. Select board: **SparkFun ESP32 Thing Plus C**
5. Upload. Serial Monitor at 115200 should show:
   ```
   Connected to SSID: ...
   Syncing NTP time... done!
   MQTT client ID: roomSensor-XXXXXX
   MQTT connected!
   Published: {"device":"RoomSensor",...}
   ```

### 2. Verify the server is healthy
SSH into the droplet and check:
```bash
ssh ines@living.ines.systems

# Check MQTT broker
sudo systemctl status mosquitto

# Check the logger service
sudo systemctl status mqtt-logger

# See the last 5 log entries
tail -5 /var/www/html/log.json

# Watch live messages arriving from the ESP32
mosquitto_sub -t "#" -v
```

### 3. Update dashboard files on the server
If you change `index.html`, `script.js`, or `style.css`:
```bash
# From your laptop — copy to /tmp first
scp index.html script.js style.css ines@living.ines.systems:/tmp/

# Then SSH in and move them (sudo needs a terminal)
ssh ines@living.ines.systems
sudo cp /tmp/index.html /tmp/script.js /tmp/style.css /var/www/html/
```

### 4. Copy files out of virtual server
```bash
# From my local machine
scp ines@living.ines.systems:/var/www/html/{log.json,index.html,script.js,style.css} .
```

## Debugging

### ESP32 not publishing
- **Check Serial Monitor** — is WiFi connected? Is MQTT connected?
- **MQTT connection failed?** → Check that port 1883 is open: `ssh ines@living.ines.systems "sudo ufw status"`
- **Upload MD5 error?** → Unplug/replug USB cable, try again
- **Wrong WiFi?** → Check `arduino_secrets.h` — only one SSID pair should be uncommented

### Dashboard not updating
- **Check the log file:** `ssh ines@living.ines.systems "tail -5 /var/www/html/log.json"`
- **Logger crashed?** → `ssh ines@living.ines.systems "sudo systemctl restart mqtt-logger"`
- **Mosquitto down?** → `ssh ines@living.ines.systems "sudo systemctl restart mosquitto"`
- **Nginx down?** → `ssh ines@living.ines.systems "sudo systemctl restart nginx"`

### Restart everything on the server
```bash
ssh ines@living.ines.systems
sudo systemctl restart mosquitto
sudo systemctl restart mqtt-logger
sudo systemctl restart nginx
```

### Browse files on the server
```bash
ssh ines@living.ines.systems

# List the web files served by Nginx
ls -la /var/www/html/

# Verify a file was updated (check the date)
ls -l /var/www/html/script.js

# Read a file's contents
head -20 /var/www/html/script.js

# Check the log file has data
tail -3 /var/www/html/log.json

# Check services are running
sudo systemctl status mqtt-logger
sudo systemctl status mosquitto
```

### Check server logs
```bash
# MQTT logger output
sudo journalctl -u mqtt-logger -f

# Mosquitto broker logs
sudo journalctl -u mosquitto -f

# Nginx access/error logs
sudo tail -f /var/log/nginx/error.log
```

## Files

| File | Purpose |
|------|---------|
| `room_sensor/room_sensor.ino` | ESP32 firmware — reads sensors, publishes MQTT, drives TFT |
| `room_sensor/arduino_secrets.h` | WiFi + MQTT broker credentials (gitignored) |
| `room_sensor/bmm150.*` | Bosch BMM150 magnetometer C driver |
| `index.html` | Dashboard HTML |
| `script.js` | Dashboard logic — polls log.json every 1s |
| `style.css` | Dashboard styling |
| `server/mqtt_logger.js` | Node.js MQTT subscriber → writes log.json |
| `server/mosquitto.conf` | Mosquitto config (anonymous access, port 1883) |
| `server/setup.sh` | Reference setup commands for the droplet |
| `claude.md` | Architecture decisions and deployment notes |
