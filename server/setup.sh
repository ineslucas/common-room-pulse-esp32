#!/bin/bash
# ============================================================
# Digital Ocean Droplet Setup for Room Ecology Sensor
# Run this on living.ines.systems via SSH
#
# This script installs and configures:
#   1. Mosquitto MQTT Broker (port 1883)
#   2. Node.js + MQTT logger (writes to log.json)
#   3. Nginx web server (serves dashboard on port 80)
#
# I run each section manually — this is a reference, not meant
# to be executed blindly as one script.
# ============================================================

# ── Step 1: Update system ─────────────────────────────────────
sudo apt update && sudo apt upgrade -y

# ── Step 2: Install Mosquitto MQTT Broker ─────────────────────
sudo apt install -y mosquitto mosquitto-clients

# I copy my custom config that allows anonymous connections:
sudo cp mosquitto.conf /etc/mosquitto/conf.d/custom.conf

# I restart mosquitto to pick up the new config:
sudo systemctl restart mosquitto
sudo systemctl enable mosquitto

# I verify it's running:
sudo systemctl status mosquitto
# I can test with: mosquitto_pub -t "test" -m "hello" and mosquitto_sub -t "#"

# ── Step 3: Install Node.js ──────────────────────────────────
sudo apt install -y nodejs npm

# I check versions:
node --version
npm --version

# ── Step 4: Set up the MQTT logger ───────────────────────────
# I create a directory for the logger:
sudo mkdir -p /opt/mqtt-logger
sudo cp mqtt_logger.js /opt/mqtt-logger/
cd /opt/mqtt-logger
sudo npm install mqtt

# I make sure the log file directory exists and is writable:
sudo mkdir -p /var/www/html
sudo touch /var/www/html/log.json
sudo chown www-data:www-data /var/www/html/log.json
# I also let my node process write to it:
sudo chmod 666 /var/www/html/log.json

# I test the logger manually first:
# node /opt/mqtt-logger/mqtt_logger.js
# (Ctrl+C to stop once I see it's working)

# I create a systemd service so the logger runs automatically:
sudo tee /etc/systemd/system/mqtt-logger.service > /dev/null <<EOF
[Unit]
Description=MQTT to JSON Logger
After=mosquitto.service network.target

[Service]
ExecStart=/usr/bin/node /opt/mqtt-logger/mqtt_logger.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mqtt-logger
sudo systemctl start mqtt-logger
sudo systemctl status mqtt-logger

# ── Step 5: Install Nginx ─────────────────────────────────────
sudo apt install -y nginx

# I copy my dashboard files to the web root:
# (scp these from your laptop first — see below)
# scp index.html script.js style.css root@living.ines.systems:/var/www/html/

# Nginx default config already serves /var/www/html/ on port 80.
# I just need to make sure it's running:
sudo systemctl enable nginx
sudo systemctl start nginx

# ── Step 6: Open firewall ports ───────────────────────────────
# I need port 1883 for MQTT and port 80 for HTTP:
sudo ufw allow 1883
sudo ufw allow 80
sudo ufw allow 22  # SSH — don't lock myself out!
sudo ufw enable

# ── Step 7: Copy dashboard files from laptop ─────────────────
# Run this FROM YOUR LAPTOP (not on the server):
#
# cd /Users/ineslucas/code/ineslucas/connected-devices/Device1Project/main_combo_code
# scp index.html script.js style.css root@living.ines.systems:/var/www/html/
# scp server/mqtt_logger.js root@living.ines.systems:/opt/mqtt-logger/
# scp server/mosquitto.conf root@living.ines.systems:/tmp/mosquitto-custom.conf
# ssh root@living.ines.systems "sudo cp /tmp/mosquitto-custom.conf /etc/mosquitto/conf.d/custom.conf"

# ── Step 8: Test everything ───────────────────────────────────
# On the server, I publish a test message:
mosquitto_pub -t "roomsensor" -m '{"device":"Test","ts":0,"mag":{"x":1,"y":2,"z":3,"mag":3.74},"pir":{"raw":100,"motion":false}}'

# Then I check that log.json got the message:
cat /var/www/html/log.json

# And I open http://living.ines.systems in my browser to see the dashboard!

echo "Setup complete! Your dashboard should be live at http://living.ines.systems"
