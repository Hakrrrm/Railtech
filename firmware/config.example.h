/*
 * Copy to firmware/config.h (gitignored) and fill in real values.
 * Never commit config.h -- it holds credentials.
 */
#ifndef CONFIG_H
#define CONFIG_H

/* 2.4 GHz hotspot only -- the ESP32 cannot join a 5 GHz-only network.
 * Some phones default to 5 GHz-only; enable "Maximise Compatibility" /
 * the 2.4 GHz band explicitly. */
#define WIFI_SSID     "your-hotspot-ssid"
#define WIFI_PASSWORD "your-hotspot-password"

/* Bring-up broker: test.mosquitto.org is public and unauthenticated --
 * fine for bring-up, never for anything real (Build Plan Sec 10). Switch
 * to the credentialled TLS broker by Stage 7. */
#define MQTT_HOST "test.mosquitto.org"
#define MQTT_PORT 1883

/* Forms the topic lrv/{MQTT_FLEET}/{MQTT_LRV_ID}/events */
#define MQTT_LRV_ID "D07"
#define MQTT_FLEET  "splrt"

#endif /* CONFIG_H */
