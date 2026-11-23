/* The image's one job: boot, print the banner naming its commit, report health every few seconds.
 * All line text and the reset-count rule live in panelator_core; this file is the ESP-IDF glue. */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "panelator_core.h"

#define STATUS_PERIOD_MS 5000U
#define NVS_NAMESPACE "diag"
#define NVS_KEY_SHA "sha"
#define NVS_KEY_RESETS "resets"
#define SHA_BUF 64U
#define MB (1024U * 1024U)

static const char* const TAG = "panelator";

static pc_reset_reason_t map_reset_reason(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:
      return PC_RESET_POWERON;
    case ESP_RST_EXT:
      return PC_RESET_EXT;
    case ESP_RST_SW:
      return PC_RESET_SW;
    case ESP_RST_PANIC:
      return PC_RESET_PANIC;
    case ESP_RST_INT_WDT:
      return PC_RESET_INT_WDT;
    case ESP_RST_TASK_WDT:
      return PC_RESET_TASK_WDT;
    case ESP_RST_WDT:
      return PC_RESET_WDT;
    case ESP_RST_DEEPSLEEP:
      return PC_RESET_DEEPSLEEP;
    case ESP_RST_BROWNOUT:
      return PC_RESET_BROWNOUT;
    case ESP_RST_SDIO:
      return PC_RESET_SDIO;
    case ESP_RST_USB:
      return PC_RESET_USB;
    case ESP_RST_JTAG:
      return PC_RESET_JTAG;
    default:
      return PC_RESET_UNKNOWN;
  }
}

static void print_line(const char* line) {
  printf("%s\n", line);
  (void)fflush(stdout);
}

/* Applies the reset-count rule against NVS; returns the count to report, or -1 when NVS fails. */
static int32_t update_reset_count(pc_reset_reason_t reason) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    err = nvs_flash_erase();
    if (err == ESP_OK) {
      err = nvs_flash_init();
    }
  }
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "nvs init: %s", esp_err_to_name(err));
    return -1;
  }

  nvs_handle_t handle = 0;
  err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "nvs open: %s", esp_err_to_name(err));
    return -1;
  }

  int32_t result = -1;
  char stored[SHA_BUF] = {0};
  size_t stored_len = sizeof stored;
  const char* stored_sha = NULL;
  int32_t stored_resets = 0;

  err = nvs_get_str(handle, NVS_KEY_SHA, stored, &stored_len);
  if (err == ESP_OK) {
    stored_sha = stored;
  } else if (err != ESP_ERR_NVS_NOT_FOUND && err != ESP_ERR_NVS_INVALID_LENGTH) {
    ESP_LOGW(TAG, "nvs read sha: %s", esp_err_to_name(err));
    nvs_close(handle);
    return -1;
  }
  err = nvs_get_i32(handle, NVS_KEY_RESETS, &stored_resets);
  if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
    ESP_LOGW(TAG, "nvs read resets: %s", esp_err_to_name(err));
    nvs_close(handle);
    return -1;
  }
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    stored_resets = 0;
  }

  pc_reset_update_t update = pc_reset_rule(stored_sha, stored_resets, PANELATOR_COMMIT, reason);
  err = ESP_OK;
  if (update.write_sha) {
    err = nvs_set_str(handle, NVS_KEY_SHA, PANELATOR_COMMIT);
  }
  if (err == ESP_OK && (update.write_sha || update.resets != stored_resets)) {
    err = nvs_set_i32(handle, NVS_KEY_RESETS, update.resets);
  }
  if (err == ESP_OK) {
    err = nvs_commit(handle);
  }
  if (err == ESP_OK) {
    result = update.resets;
  } else {
    ESP_LOGW(TAG, "nvs write: %s", esp_err_to_name(err));
  }
  nvs_close(handle);
  return result;
}

static void status_task(void* arg) {
  const int32_t resets = (int32_t)(intptr_t)arg;
  char line[PC_LINE_MAX];
  for (;;) {
    pc_status_t status = {
        .sha = PANELATOR_COMMIT,
        .uptime_s = (uint64_t)(esp_timer_get_time() / 1000000),
        .resets = resets,
        .free_heap = (uint32_t)esp_get_free_heap_size(),
        .free_psram = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
    };
    if (pc_format_status(line, sizeof line, &status) > 0) {
      print_line(line);
    }
    vTaskDelay(pdMS_TO_TICKS(STATUS_PERIOD_MS));
  }
}

void app_main(void) {
  const pc_reset_reason_t reason = map_reset_reason(esp_reset_reason());

  uint32_t flash_bytes = 0;
  if (esp_flash_get_size(NULL, &flash_bytes) != ESP_OK) {
    flash_bytes = 0;
  }
  pc_banner_t banner = {
      .sha = PANELATOR_COMMIT,
      .idf_version = esp_get_idf_version(),
      .flash_mb = flash_bytes / MB,
      .psram_mb = (uint32_t)(esp_psram_get_size() / MB),
      .reason = reason,
  };
  char line[PC_LINE_MAX];
  if (pc_format_banner(line, sizeof line, &banner) > 0) {
    print_line(line);
  }

  const int32_t resets = update_reset_count(reason);
  if (xTaskCreate(status_task, "status", 4096, (void*)(intptr_t)resets, 1, NULL) != pdPASS) {
    ESP_LOGE(TAG, "status task not created");
  }
}
