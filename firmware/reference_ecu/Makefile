TOOLCHAIN_PREFIX ?= arm-none-eabi-
CC := $(TOOLCHAIN_PREFIX)gcc

BUILD_DIR := build
ELF := $(BUILD_DIR)/reference_ecu.elf

CFLAGS := -mcpu=cortex-m4 -mthumb -Os -ffreestanding -fno-builtin \
	-ffunction-sections -fdata-sections -Wall -Wextra -Werror
LDFLAGS := -nostdlib -Wl,--gc-sections -Wl,-Map,$(BUILD_DIR)/reference_ecu.map \
	-T linker.ld

.PHONY: all clean

all: $(ELF)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(ELF): reference_ecu.c linker.ld | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(LDFLAGS) reference_ecu.c -o $@

clean:
	rm -f $(BUILD_DIR)/reference_ecu.elf \
		$(BUILD_DIR)/reference_ecu.map

