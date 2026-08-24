#ifndef IMU_STATE_H
#define IMU_STATE_H

#include <stdint.h>

/*
 * Pure stationary/moving classifier from raw accelerometer samples
 * (MPU6050, +-2g range, 16384 LSB/g -- see imu_mpu6050.c for the target
 * I2C driver that feeds this). No hardware/I2C I/O here.
 *
 * Method: track the min/max of the accel magnitude (deviation from
 * gravity is irrelevant to cancel out since we only need variation, not
 * orientation) over a rolling window; if that range stays under a
 * threshold for the whole window, the vehicle is stationary. Simple on
 * purpose -- an MVP gate for "should we even bother polling GNSS this
 * tick", not a ride-quality or vibration analysis.
 */

#define IMU_STATE_WINDOW_SAMPLES 8      /* ~8 s at 1 sample/s */
#define IMU_STATE_STILL_THRESHOLD_MG 60 /* accel magnitude range, milli-g */

typedef struct {
    int32_t  samples_mag_mg[IMU_STATE_WINDOW_SAMPLES]; /* ring buffer, |a| in milli-g */
    uint8_t  count;   /* number of valid samples so far (caps at window size) */
    uint8_t  next;    /* next ring-buffer write index */
    int      stationary; /* last computed classification */
} imu_state_t;

void imu_state_reset(imu_state_t *st);

/*
 * Feeds one raw accelerometer sample (LSB, +-2g/16384-LSB-per-g
 * convention) into the classifier and returns the updated stationary
 * (1) / moving (0) classification. Before the window fills for the
 * first time, returns 0 (moving) -- assume motion until proven still,
 * so GNSS polling is never suppressed prematurely on/after boot.
 */
int imu_state_update(imu_state_t *st, int16_t ax_raw, int16_t ay_raw, int16_t az_raw);

#endif /* IMU_STATE_H */
