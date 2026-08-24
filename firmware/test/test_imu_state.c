/*
 * Host test for imu_state.c.
 * Build: gcc -o test_imu_state test_imu_state.c imu_state.c && ./test_imu_state
 */
#include <assert.h>
#include <stdio.h>

#include "imu_state.h"

/* 1 g on the Z axis, +-2g/16384 LSB convention -- board lying flat and
 * still on a desk. */
#define STILL_Z 16384

static void test_window_not_full_assumes_moving(void)
{
    imu_state_t st;
    imu_state_reset(&st);
    for (int i = 0; i < IMU_STATE_WINDOW_SAMPLES - 1; i++) {
        int s = imu_state_update(&st, 0, 0, STILL_Z);
        assert(s == 0);
    }
    printf("[ok] before the window fills, classifier defaults to moving\n");
}

static void test_perfectly_still_classified_stationary(void)
{
    imu_state_t st;
    imu_state_reset(&st);
    int s = 0;
    for (int i = 0; i < IMU_STATE_WINDOW_SAMPLES; i++) {
        s = imu_state_update(&st, 0, 0, STILL_Z);
    }
    assert(s == 1);
    printf("[ok] a constant 1g-on-Z window is classified stationary\n");
}

static void test_sustained_variation_classified_moving(void)
{
    imu_state_t st;
    imu_state_reset(&st);
    int s = 0;
    /* Alternate between 1g and ~1.3g magnitude -- well past the still
     * threshold -- for the whole window. */
    for (int i = 0; i < IMU_STATE_WINDOW_SAMPLES; i++) {
        int16_t z = (i % 2 == 0) ? STILL_Z : (int16_t)(STILL_Z + 5000);
        s = imu_state_update(&st, 0, 0, z);
    }
    assert(s == 0);
    printf("[ok] sustained accel variation is classified moving\n");
}

static void test_becomes_stationary_after_motion_settles(void)
{
    imu_state_t st;
    imu_state_reset(&st);
    /* Fill the window with clear motion first. */
    for (int i = 0; i < IMU_STATE_WINDOW_SAMPLES; i++) {
        int16_t z = (i % 2 == 0) ? STILL_Z : (int16_t)(STILL_Z + 8000);
        imu_state_update(&st, 0, 0, z);
    }
    /* Now feed enough still samples to flush the moving samples out of
     * the ring buffer. */
    int s = 0;
    for (int i = 0; i < IMU_STATE_WINDOW_SAMPLES; i++) {
        s = imu_state_update(&st, 0, 0, STILL_Z);
    }
    assert(s == 1);
    printf("[ok] classifier recovers to stationary once motion samples age out\n");
}

int main(void)
{
    test_window_not_full_assumes_moving();
    test_perfectly_still_classified_stationary();
    test_sustained_variation_classified_moving();
    test_becomes_stationary_after_motion_settles();

    printf("all tests passed\n");
    return 0;
}
