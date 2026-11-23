# One file for both builds: ESP-IDF registers the component; the host project (firmware/test/host)
# compiles panelator_core.c itself.
idf_component_register(SRCS "panelator_core.c" INCLUDE_DIRS "include")
