#include "imu_state.h"

#define MPU6050_LSB_PER_G 16384

static uint32_t isqrt_u64(uint64_t v)
{
    if (v == 0) {
        return 0;
    }
    uint64_t x = v;
    uint64_t y = (x + 1) / 2;
    while (y < x) {
        x = y;
        y = (x + v / x) / 2;
    }
    return (uint32_t)x;
}

void imu_state_reset(imu_state_t *st)
{
    st->count = 0;
    st->next = 0;
    st->stationary = 0;
    for (int i = 0; i < IMU_STATE_WINDOW_SAMPLES; i++) {
        st->samples_mag_mg[i] = 0;
    }
}

int imu_state_update(imu_state_t *st, int16_t ax_raw, int16_t ay_raw, int16_t az_raw)
{
    int64_t ax = ax_raw, ay = ay_raw, az = az_raw;
    uint64_t sum_sq = (uint64_t)(ax * ax + ay * ay + az * az);
    uint32_t mag_lsb = isqrt_u64(sum_sq);

    /* milli-g = mag_lsb * 1000 / LSB_PER_G */
    int32_t mag_mg = (int32_t)(((uint64_t)mag_lsb * 1000) / MPU6050_LSB_PER_G);

    st->samples_mag_mg[st->next] = mag_mg;
    st->next = (uint8_t)((st->next + 1) % IMU_STATE_WINDOW_SAMPLES);
    if (st->count < IMU_STATE_WINDOW_SAMPLES) {
        st->count++;
    }

    if (st->count < IMU_STATE_WINDOW_SAMPLES) {
        st->stationary = 0; /* window not full yet -- assume moving */
        return st->stationary;
    }

    int32_t min_mg = st->samples_mag_mg[0];
    int32_t max_mg = st->samples_mag_mg[0];
    for (int i = 1; i < IMU_STATE_WINDOW_SAMPLES; i++) {
        int32_t v = st->samples_mag_mg[i];
        if (v < min_mg) min_mg = v;
        if (v > max_mg) max_mg = v;
    }

    st->stationary = ((max_mg - min_mg) <= IMU_STATE_STILL_THRESHOLD_MG) ? 1 : 0;
    return st->stationary;
}
