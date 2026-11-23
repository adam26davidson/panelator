/* Portable logic of the firmware: the console lines and the reset-count rule.
 * Includes no ESP-IDF header, so it builds and is tested on the host. */
#ifndef PANELATOR_CORE_H
#define PANELATOR_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* A line is never longer than this, terminator included (the longest commit is 40 hex + "-dirty"). */
#define PC_LINE_MAX 256U

/* The reset reasons, in the component's own numbering (the glue maps esp_reset_reason_t). */
typedef enum {
  PC_RESET_UNKNOWN = 0,
  PC_RESET_POWERON,
  PC_RESET_EXT,
  PC_RESET_SW,
  PC_RESET_PANIC,
  PC_RESET_INT_WDT,
  PC_RESET_TASK_WDT,
  PC_RESET_WDT,
  PC_RESET_DEEPSLEEP,
  PC_RESET_BROWNOUT,
  PC_RESET_SDIO,
  PC_RESET_USB,
  PC_RESET_JTAG,
  PC_RESET_COUNT
} pc_reset_reason_t;

/* The lower-case name of a reason; "unknown" for a value out of range. */
const char* pc_reset_name(pc_reset_reason_t reason);

/* True for the reasons the firmware did not choose: they count as unexpected resets. */
bool pc_reset_counted(pc_reset_reason_t reason);

typedef struct {
  const char* sha;
  const char* idf_version;
  uint32_t flash_mb;
  uint32_t psram_mb;
  pc_reset_reason_t reason;
} pc_banner_t;

typedef struct {
  const char* sha;
  uint64_t uptime_s;
  int32_t resets; /* -1 when the count could not be read or written */
  uint32_t free_heap;
  uint32_t free_psram;
} pc_status_t;

/* Both write one line without a newline into buf (size bytes, terminator included) and return its
 * length, or -1 when it does not fit; buf then holds an empty string. They never write past size. */
int pc_format_banner(char* buf, size_t size, const pc_banner_t* banner);
int pc_format_status(char* buf, size_t size, const pc_status_t* status);

typedef struct {
  bool write_sha; /* the stored sha must be replaced by the image's */
  int32_t resets; /* the count to store */
} pc_reset_update_t;

/* The rule of the unexpected-reset count. stored_sha is NULL when missing. */
pc_reset_update_t pc_reset_rule(const char* stored_sha, int32_t stored_resets, const char* image_sha, pc_reset_reason_t reason);

#ifdef __cplusplus
}
#endif

#endif
