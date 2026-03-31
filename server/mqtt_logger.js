/*
  MQTT → log.json Logger
  -----------------------
  I subscribe to ALL topics on the local Mosquitto broker
  and append each incoming message as a new line in log.json.

  This runs on the Digital Ocean droplet alongside Mosquitto and Nginx.
  The dashboard (served by Nginx) polls this same log.json file.

  I keep the log file from growing forever by trimming it to the
  last 1000 lines whenever it exceeds 1200 lines.

  Usage:
    node mqtt_logger.js

  Requires:
    npm install mqtt
*/

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

// I connect to the local Mosquitto broker (same machine)
const brokerUrl = 'mqtt://localhost:1883';
// I write to the same directory Nginx serves
const logFile = '/var/www/html/log.json';
// I keep 30 days of data: 30 days × 24h × 720 readings/hr ≈ 518,400 lines (~65MB)
const MAX_LINES = 520000;
const TRIM_THRESHOLD = 530000;

console.log('Connecting to MQTT broker at ' + brokerUrl);
const client = mqtt.connect(brokerUrl);

client.on('connect', function () {
  console.log('Connected to MQTT broker.');
  // I subscribe to all topics with the wildcard "#"
  client.subscribe('#', function (err) {
    if (err) {
      console.error('Subscribe error:', err);
    } else {
      console.log('Subscribed to all topics (#)');
    }
  });
});

client.on('message', function (topic, message) {
  const payload = message.toString();
  console.log('[' + topic + '] ' + payload);

  // I append each message as a new line in log.json
  // This matches the format the dashboard expects: one JSON object per line
  fs.appendFile(logFile, payload + '\n', function (err) {
    if (err) {
      console.error('Error writing to log.json:', err);
    }
  });

  // I periodically trim the file so it doesn't grow unbounded
  trimLogFile();
});

client.on('error', function (err) {
  console.error('MQTT error:', err);
});

// I trim the log file by keeping only the last MAX_LINES lines
function trimLogFile() {
  try {
    const stats = fs.statSync(logFile);
    // Only check line count if file is over ~10MB (rough heuristic)
    if (stats.size < 10000000) return;

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    if (lines.length > TRIM_THRESHOLD) {
      const trimmed = lines.slice(-MAX_LINES).join('\n') + '\n';
      fs.writeFileSync(logFile, trimmed);
      console.log('Trimmed log.json from ' + lines.length + ' to ' + MAX_LINES + ' lines');
    }
  } catch (e) {
    // File might not exist yet, that's fine
  }
}

console.log('MQTT logger started. Writing to ' + logFile);
