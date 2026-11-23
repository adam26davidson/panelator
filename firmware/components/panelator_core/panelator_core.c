#include "panelator_core.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char* const k_reset_names[PC_RESET_COUNT] = {
    "unknown", "poweron", "ext", "sw", "panic", "int_wdt", "task_wdt", "wdt", "deepsleep", "brownout", "sdio", "usb", "jtag",
};

const char* pc_reset_name(pc_reset_reason_t reason) {
  if ((int)reason < 0 || (int)reason >= PC_RESET_COUNT) {
    return k_reset_names[PC_RESET_UNKNOWN];
  }
  return k_reset_names[reason];
}

bool pc_reset_counted(pc_reset_reason_t reason) {
  switch (reason) {
    case PC_RESET_PANIC:
    case PC_RESET_INT_WDT:
    case PC_RESET_TASK_WDT:
    case PC_RESET_WDT:
    case PC_RESET_BROWNOUT:
    case PC_RESET_UNKNOWN:
      return true;
    default:
      return false;
  }
}

static int finish(char* buf, size_t size, int written) {
  if (written < 0 || (size_t)written >= size) {
    buf[0] = '\0';
    return -1;
  }
  return written;
}

int pc_format_banner(char* buf, size_t size, const pc_banner_t* banner) {
  if (buf == NULL || size == 0U) {
    return -1;
  }
  if (banner == NULL || banner->sha == NULL || banner->idf_version == NULL) {
    buf[0] = '\0';
    return -1;
  }
  int n = snprintf(buf, size, "panelator boot sha=%s idf=%s flash_mb=%" PRIu32 " psram_mb=%" PRIu32 " reset=%s", banner->sha,
                   banner->idf_version, banner->flash_mb, banner->psram_mb, pc_reset_name(banner->reason));
  return finish(buf, size, n);
}

int pc_format_status(char* buf, size_t size, const pc_status_t* status) {
  if (buf == NULL || size == 0U) {
    return -1;
  }
  if (status == NULL || status->sha == NULL) {
    buf[0] = '\0';
    return -1;
  }
  int n = snprintf(buf, size, "panelator status sha=%s uptime_s=%" PRIu64 " resets=%" PRId32 " free_heap=%" PRIu32 " free_psram=%" PRIu32,
                   status->sha, status->uptime_s, status->resets, status->free_heap, status->free_psram);
  return finish(buf, size, n);
}

pc_reset_update_t pc_reset_rule(const char* stored_sha, int32_t stored_resets, const char* image_sha, pc_reset_reason_t reason) {
  pc_reset_update_t out = {false, stored_resets};
  if (stored_sha == NULL || strcmp(stored_sha, image_sha) != 0) {
    out.write_sha = true;
    out.resets = 0;
  } else if (pc_reset_counted(reason) && stored_resets < INT32_MAX) {
    out.resets = stored_resets + 1;
  }
  return out;
}
