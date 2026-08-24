#include "imu_mpu6050.h"

#include <Arduino.h>
#include <Wire.h>

#define MPU6050_I2C_ADDR       0x68 /* AD0 tied low, the Qwiic module default */
#define MPU6050_REG_PWR_MGMT_1 0x6B
#define MPU6050_REG_ACCEL_XOUT_H 0x3B

static bool s_ready = false;

bool imu_mpu6050_init(int sda_pin, int scl_pin)
{
    s_ready = false;
    if (sda_pin < 0 || scl_pin < 0) {
        return false; /* pins_board.h QWIIC_I2C_*_PIN still -1 (unconfirmed) */
    }

    Wire.begin(sda_pin, scl_pin);

    Wire.beginTransmission(MPU6050_I2C_ADDR);
    Wire.write(MPU6050_REG_PWR_MGMT_1);
    Wire.write(0x00); /* clear sleep bit, default clock source */
    if (Wire.endTransmission() != 0) {
        return false;
    }

    s_ready = true;
    return true;
}

bool imu_mpu6050_read_accel(int16_t *ax, int16_t *ay, int16_t *az)
{
    if (!s_ready) {
        return false;
    }

    Wire.beginTransmission(MPU6050_I2C_ADDR);
    Wire.write(MPU6050_REG_ACCEL_XOUT_H);
    if (Wire.endTransmission(false) != 0) {
        return false;
    }

    if (Wire.requestFrom(MPU6050_I2C_ADDR, 6) != 6) {
        return false;
    }

    *ax = (int16_t)((Wire.read() << 8) | Wire.read());
    *ay = (int16_t)((Wire.read() << 8) | Wire.read());
    *az = (int16_t)((Wire.read() << 8) | Wire.read());
    return true;
}
