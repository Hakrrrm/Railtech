/*
 * Host test for boot_counter.c.
 * Build: gcc -DSEQ_STORE_HOST_STUB -o test_boot_counter test_boot_counter.c \
 *            boot_counter.c && ./test_boot_counter
 */
#include <assert.h>
#include <stdio.h>

#include "boot_counter.h"

static void test_first_boot_returns_one(void)
{
    const char *path = "/tmp/boot_counter_test_first.nvs";
    remove(path);
    boot_counter_host_set_backing_file(path);

    assert(boot_counter_next() == 1);
    printf("[ok] first-ever boot returns 1, not 0\n");

    remove(path);
    boot_counter_host_set_backing_file(NULL);
}

static void test_counter_survives_simulated_reboots(void)
{
    const char *path = "/tmp/boot_counter_test_persist.nvs";
    remove(path);
    boot_counter_host_set_backing_file(path);

    assert(boot_counter_next() == 1);

    /* Simulate a reboot by dropping this handle and re-pointing at the
     * same backing file, same as seq_store's persistence test. */
    boot_counter_host_set_backing_file(NULL);
    boot_counter_host_set_backing_file(path);
    assert(boot_counter_next() == 2);

    boot_counter_host_set_backing_file(NULL);
    boot_counter_host_set_backing_file(path);
    assert(boot_counter_next() == 3);
    printf("[ok] boot counter increments across simulated reboots (1, 2, 3)\n");

    remove(path);
    boot_counter_host_set_backing_file(NULL);
}

static void test_no_backing_file_always_returns_one(void)
{
    boot_counter_host_set_backing_file(NULL);
    assert(boot_counter_next() == 1);
    assert(boot_counter_next() == 1);
    printf("[ok] with no backing file configured, counter is inert and returns 1\n");
}

int main(void)
{
    test_first_boot_returns_one();
    test_counter_survives_simulated_reboots();
    test_no_backing_file_always_returns_one();

    printf("all tests passed\n");
    return 0;
}
