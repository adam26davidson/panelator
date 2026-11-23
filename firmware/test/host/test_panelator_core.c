#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "panelator_core.h"
#include "unity.h"

#define SHA40 "0123456789abcdef0123456789abcdef01234567"

void setUp(void) {
}
void tearDown(void) {
}

static const char* const k_names[PC_RESET_COUNT] = {"unknown", "poweron",   "ext",      "sw",   "panic", "int_wdt", "task_wdt",
                                                    "wdt",     "deepsleep", "brownout", "sdio", "usb",   "jtag"};

static void test_reset_names(void) {
  for (int i = 0; i < PC_RESET_COUNT; i++) {
    TEST_ASSERT_EQUAL_STRING(k_names[i], pc_reset_name((pc_reset_reason_t)i));
  }
  TEST_ASSERT_EQUAL_STRING("unknown", pc_reset_name((pc_reset_reason_t)99));
  TEST_ASSERT_EQUAL_STRING("unknown", pc_reset_name((pc_reset_reason_t)-1));
}

static void test_banner_exact(void) {
  char buf[PC_LINE_MAX];
  pc_banner_t b = {SHA40, "v5.5.6", 16, 8, PC_RESET_POWERON};
  int n = pc_format_banner(buf, sizeof buf, &b);
  const char* want = "panelator boot sha=" SHA40 " idf=v5.5.6 flash_mb=16 psram_mb=8 reset=poweron";
  TEST_ASSERT_EQUAL_STRING(want, buf);
  TEST_ASSERT_EQUAL_INT((int)strlen(want), n);
}

static void test_status_exact(void) {
  char buf[PC_LINE_MAX];
  pc_status_t s = {SHA40, 15, 2, 214000, 8300000};
  int n = pc_format_status(buf, sizeof buf, &s);
  const char* want = "panelator status sha=" SHA40 " uptime_s=15 resets=2 free_heap=214000 free_psram=8300000";
  TEST_ASSERT_EQUAL_STRING(want, buf);
  TEST_ASSERT_EQUAL_INT((int)strlen(want), n);
}

static void test_status_unreadable_count(void) {
  char buf[PC_LINE_MAX];
  pc_status_t s = {SHA40, 0, -1, 0, 0};
  TEST_ASSERT_GREATER_THAN_INT(0, pc_format_status(buf, sizeof buf, &s));
  TEST_ASSERT_NOT_NULL(strstr(buf, " resets=-1 "));
}

static void test_maximal_values_fit(void) {
  char buf[PC_LINE_MAX];
  const char* sha = SHA40 "-dirty";
  pc_banner_t b = {sha, "v5.5.6-1234-gabcdef0123-dirty", UINT32_MAX, UINT32_MAX, PC_RESET_TASK_WDT};
  TEST_ASSERT_GREATER_THAN_INT(0, pc_format_banner(buf, sizeof buf, &b));
  pc_status_t s = {sha, UINT64_MAX, INT32_MIN, UINT32_MAX, UINT32_MAX};
  int n = pc_format_status(buf, sizeof buf, &s);
  TEST_ASSERT_GREATER_THAN_INT(0, n);
  TEST_ASSERT_LESS_THAN_INT((int)PC_LINE_MAX, n);
}

static void test_tight_buffers_never_overflow(void) {
  pc_status_t s = {SHA40 "-dirty", UINT64_MAX, INT32_MAX, UINT32_MAX, UINT32_MAX};
  pc_banner_t b = {SHA40 "-dirty", "v5.5.6", 16, 8, PC_RESET_SW};
  char full[PC_LINE_MAX];
  int sn = pc_format_status(full, sizeof full, &s);
  int bn = pc_format_banner(full, sizeof full, &b);
  TEST_ASSERT_GREATER_THAN_INT(0, sn);
  TEST_ASSERT_GREATER_THAN_INT(0, bn);
  /* Exactly the line plus its terminator fits; one byte less is refused and left empty. */
  char* exact = malloc((size_t)sn + 1U);
  TEST_ASSERT_NOT_NULL(exact);
  TEST_ASSERT_EQUAL_INT(sn, pc_format_status(exact, (size_t)sn + 1U, &s));
  TEST_ASSERT_EQUAL_INT(-1, pc_format_status(exact, (size_t)sn, &s));
  TEST_ASSERT_EQUAL_STRING("", exact);
  free(exact);
  exact = malloc((size_t)bn + 1U);
  TEST_ASSERT_NOT_NULL(exact);
  TEST_ASSERT_EQUAL_INT(bn, pc_format_banner(exact, (size_t)bn + 1U, &b));
  TEST_ASSERT_EQUAL_INT(-1, pc_format_banner(exact, (size_t)bn, &b));
  TEST_ASSERT_EQUAL_STRING("", exact);
  free(exact);
  char one[1] = {'x'};
  TEST_ASSERT_EQUAL_INT(-1, pc_format_banner(one, 1, &b));
  TEST_ASSERT_EQUAL_INT(-1, pc_format_banner(NULL, 0, &b));
}

typedef struct {
  const char* stored;
  int32_t count;
  pc_reset_reason_t reason;
  bool write_sha;
  int32_t want;
} rule_case_t;

static void test_reset_rule_table(void) {
  const char* img = SHA40;
  const rule_case_t cases[] = {
      {NULL, 7, PC_RESET_POWERON, true, 0},       {NULL, 7, PC_RESET_PANIC, true, 0},
      {"deadbeef", 7, PC_RESET_POWERON, true, 0}, {"deadbeef", 7, PC_RESET_BROWNOUT, true, 0},
      {SHA40, 3, PC_RESET_POWERON, false, 3},     {SHA40, 3, PC_RESET_EXT, false, 3},
      {SHA40, 3, PC_RESET_SW, false, 3},          {SHA40, 3, PC_RESET_DEEPSLEEP, false, 3},
      {SHA40, 3, PC_RESET_SDIO, false, 3},        {SHA40, 3, PC_RESET_USB, false, 3},
      {SHA40, 3, PC_RESET_JTAG, false, 3},        {SHA40, 3, PC_RESET_PANIC, false, 4},
      {SHA40, 3, PC_RESET_INT_WDT, false, 4},     {SHA40, 3, PC_RESET_TASK_WDT, false, 4},
      {SHA40, 3, PC_RESET_WDT, false, 4},         {SHA40, 3, PC_RESET_BROWNOUT, false, 4},
      {SHA40, 3, PC_RESET_UNKNOWN, false, 4},     {SHA40, INT32_MAX, PC_RESET_PANIC, false, INT32_MAX},
  };
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    pc_reset_update_t u = pc_reset_rule(cases[i].stored, cases[i].count, img, cases[i].reason);
    TEST_ASSERT_EQUAL_MESSAGE(cases[i].write_sha, u.write_sha, "write_sha");
    TEST_ASSERT_EQUAL_INT32_MESSAGE(cases[i].want, u.resets, "resets");
  }
}

static void test_every_reason_is_covered_by_the_rule(void) {
  int counted = 0;
  for (int i = 0; i < PC_RESET_COUNT; i++) {
    pc_reset_update_t u = pc_reset_rule(SHA40, 0, SHA40, (pc_reset_reason_t)i);
    counted += (int)u.resets;
  }
  TEST_ASSERT_EQUAL_INT(6, counted);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_reset_names);
  RUN_TEST(test_banner_exact);
  RUN_TEST(test_status_exact);
  RUN_TEST(test_status_unreadable_count);
  RUN_TEST(test_maximal_values_fit);
  RUN_TEST(test_tight_buffers_never_overflow);
  RUN_TEST(test_reset_rule_table);
  RUN_TEST(test_every_reason_is_covered_by_the_rule);
  return UNITY_END();
}
