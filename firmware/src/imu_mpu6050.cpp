#include "imu_mpu6050.h"

#include <Arduino.h>
#include <Wire.h>

/* Wire1, not Wire: this board's Qwiic-I2C connector is wired to the
 * ESP32-S3's second I2C peripheral -- confirmed by two independent
 * team reference sketches (QWIIC_I2C_Scan.ino, QwiicImu5Hz.ino), both
 * of which call Wire1.begin(QWIIC_SDA_PIN, QWIIC_SCL_PIN) for this
 * exact connector. Wire (the default instance) is reserved on this
 * board for repurposing the separate Qwiic-UART connector's TX/RX
 * pins as a second I2C bus, which this driver doesn't use. */

#define MPU6050_I2C_ADDR         0x68 /* AD0 tied low, the Qwiic module default */
#define MPU6050_REG_PWR_MGMT_1   0x6B
#define MPU6050_REG_ACCEL_CONFIG 0x1C
#define MPU6050_REG_GYRO_CONFIG  0x1B
#define MPU6050_REG_ACCEL_XOUT_H 0x3B

static bool s_ready = false;

static bool write_register(uint8_t reg, uint8_t value)
{
    Wire1.beginTransmission(MPU6050_I2C_ADDR);
    Wire1.write(reg);
    Wire1.write(value);
    return Wire1.endTransmission() == 0;
}

bool imu_mpu6050_init(int sda_pin, int scl_pin)
{
    s_ready = false;
    if (sda_pin < 0 || scl_pin < 0) {
        return false; /* pins_board.h QWIIC_I2C_*_PIN misconfigured */
    }

    Wire1.begin(sda_pin, scl_pin);
    Wire1.setClock(400000);
    Wire1.setTimeOut(50);

    Wire1.beginTransmission(MPU6050_I2C_ADDR);
    if (Wire1.endTransmission() != 0) {
        return false; /* nothing ACKing at 0x68 -- not connected */
    }

    if (!write_register(MPU6050_REG_PWR_MGMT_1, 0x00)) {
        return false; /* clear sleep bit, default clock source */
    }
    delay(100);

    if (!write_register(MPU6050_REG_ACCEL_CONFIG, 0x00)) { /* +-2g */
        return false;
    }
    if (!write_register(MPU6050_REG_GYRO_CONFIG, 0x00)) { /* +-250 deg/s, unused here but harmless */
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

    Wire1.beginTransmission(MPU6050_I2C_ADDR);
    Wire1.write(MPU6050_REG_ACCEL_XOUT_H);
    if (Wire1.endTransmission(false) != 0) {
        return false;
    }

    if (Wire1.requestFrom((int)MPU6050_I2C_ADDR, 6, (int)true) != 6) {
        return false;
    }

    *ax = (int16_t)((Wire1.read() << 8) | Wire1.read());
    *ay = (int16_t)((Wire1.read() << 8) | Wire1.read());
    *az = (int16_t)((Wire1.read() << 8) | Wire1.read());
    return true;
}
