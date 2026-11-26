#!/bin/sh
set -eu
: "${STMEMSC_DRIVER_DIR:?Set to the SDK stmemsc/lsm6dsv320x_STdC/driver directory}"
test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_build=$(mktemp -d)
trap 'rm -rf "$test_build"' EXIT
cc -std=c99 -U__weak '-D__weak=__attribute__((weak))' -I"$STMEMSC_DRIVER_DIR" -c "$STMEMSC_DRIVER_DIR/lsm6dsv320x_reg.c" -o "$test_build/st.o"
c++ -std=c++17 -I"$STMEMSC_DRIVER_DIR" -I"$test_dir/../src" "$test_dir/sflp_fifo_test.cpp" "$test_build/st.o" -o "$test_build/sflp_fifo_test"
"$test_build/sflp_fifo_test"

c++ -std=c++17 -I"$test_dir/../src" "$test_dir/dice_fsm_test.cpp" "$test_dir/../src/dice_fsm.cpp" -o "$test_build/dice_fsm_test"
"$test_build/dice_fsm_test"
c++ -std=c++17 -I"$STMEMSC_DRIVER_DIR" -I"$test_dir/../src" "$test_dir/high_g_test.cpp" "$test_build/st.o" -o "$test_build/high_g_test"
"$test_build/high_g_test"
