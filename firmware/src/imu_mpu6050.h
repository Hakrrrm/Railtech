#ifndef IMU_MPU6050_H
#define IMU_MPU6050_H

#include <stdbool.h>
#include <stdint.h>

/*
 * Target-only I2C driver for the MPU6050 on the Qwiic port (Stage 5).
 * No host-testable logic lives here -- classification is in
 * imu_state.c/.h, which this just feeds. Not compiled for host tests
 * (Arduino Wire.h dependency), same split as seq_store's NVS half.
 */

#ifdef __cplusplus
extern "C" {
#endif

/* Inits I2C on the given pins and wakes the MPU6050 out of sleep.
 * Returns false (and leaves the device unused) if sda_pin/scl_pin are
 * negative (unconfirmed, see pins_board.h) or the device doesn't ACK. */
bool imu_mpu6050_init(int sda_pin, int scl_pin);

/* Reads one raw accelerometer sample (+-2g/16384 LSB-per-g). Returns
 * false on an I2C read failure -- caller should skip this tick rather
 * than feed garbage into imu_state_update(). */
bool imu_mpu6050_read_accel(int16_t *ax, int16_t *ay, int16_t *az);

#ifdef __cplusplus
}
#endif

#endif /* IMU_MPU6050_H */
