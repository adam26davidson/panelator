cmake_minimum_required(VERSION 3.16)
project(panelator_host_tests C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_compile_options(-Wall -Wextra -Werror -fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer)
add_link_options(-fsanitize=address,undefined)

enable_testing()

add_library(unity STATIC third_party/unity/unity.c)
target_include_directories(unity PUBLIC third_party/unity)
# The vendored library is not ours to hold to our warnings.
target_compile_options(unity PRIVATE -Wno-error)

# Every portable component: no ESP-IDF header, compiled here with the host compiler.
add_library(panelator_core STATIC ../../components/panelator_core/panelator_core.c)
target_include_directories(panelator_core PUBLIC ../../components/panelator_core/include)

add_executable(test_panelator_core test_panelator_core.c)
target_link_libraries(test_panelator_core PRIVATE panelator_core unity)
add_test(NAME panelator_core COMMAND test_panelator_core)
