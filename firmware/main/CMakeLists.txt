idf_component_register(SRCS "main.c" INCLUDE_DIRS "." REQUIRES panelator_core nvs_flash esp_psram esp_timer spi_flash esp_system heap)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
target_compile_definitions(${COMPONENT_LIB} PRIVATE PANELATOR_COMMIT="${PANELATOR_COMMIT}")
