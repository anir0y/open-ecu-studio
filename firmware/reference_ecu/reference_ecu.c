#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define REG32(address) (*(volatile uint32_t *)(address))

#define RCC_BASE 0x40023800u
#define RCC_AHB1ENR REG32(RCC_BASE + 0x30u)
#define RCC_APB1ENR REG32(RCC_BASE + 0x40u)

#define GPIOA_BASE 0x40020000u
#define GPIOA_MODER REG32(GPIOA_BASE + 0x00u)
#define GPIOA_AFRL REG32(GPIOA_BASE + 0x20u)
#define GPIOA_AFRH REG32(GPIOA_BASE + 0x24u)

#define USART2_BASE 0x40004400u
#define USART2_SR REG32(USART2_BASE + 0x00u)
#define USART2_DR REG32(USART2_BASE + 0x04u)
#define USART2_BRR REG32(USART2_BASE + 0x08u)
#define USART2_CR1 REG32(USART2_BASE + 0x0Cu)

#define CAN1_BASE 0x40006400u
#define CAN_MCR REG32(CAN1_BASE + 0x00u)
#define CAN_MSR REG32(CAN1_BASE + 0x04u)
#define CAN_TSR REG32(CAN1_BASE + 0x08u)
#define CAN_RF0R REG32(CAN1_BASE + 0x0Cu)
#define CAN_BTR REG32(CAN1_BASE + 0x1Cu)
#define CAN_TX0_TIR REG32(CAN1_BASE + 0x180u)
#define CAN_TX0_TDTR REG32(CAN1_BASE + 0x184u)
#define CAN_TX0_TDLR REG32(CAN1_BASE + 0x188u)
#define CAN_TX0_TDHR REG32(CAN1_BASE + 0x18Cu)
#define CAN_RX0_RIR REG32(CAN1_BASE + 0x1B0u)
#define CAN_RX0_RDTR REG32(CAN1_BASE + 0x1B4u)
#define CAN_RX0_RDLR REG32(CAN1_BASE + 0x1B8u)
#define CAN_RX0_RDHR REG32(CAN1_BASE + 0x1BCu)
#define CAN_FMR REG32(CAN1_BASE + 0x200u)
#define CAN_FM1R REG32(CAN1_BASE + 0x204u)
#define CAN_FS1R REG32(CAN1_BASE + 0x20Cu)
#define CAN_FFA1R REG32(CAN1_BASE + 0x214u)
#define CAN_FA1R REG32(CAN1_BASE + 0x21Cu)
#define CAN_FILTER0_FR1 REG32(CAN1_BASE + 0x240u)
#define CAN_FILTER0_FR2 REG32(CAN1_BASE + 0x244u)

#define CAN_MCR_INRQ (1u << 0)
#define CAN_MCR_SLEEP (1u << 1)
#define CAN_MSR_INAK (1u << 0)
#define CAN_TSR_TME0 (1u << 26)
#define CAN_RF0R_FMP0_MASK 0x3u
#define CAN_RF0R_RFOM0 (1u << 5)

#define WHEEL_SPEED_ID 0x181u
#define DYNAMICS_ID 0x182u
#define ESC_STATUS_ID 0x280u
#define UDS_REQUEST_ID 0x6A0u
#define UDS_RESPONSE_ID 0x6A8u

extern uint32_t _etext;
extern uint32_t _sdata;
extern uint32_t _edata;
extern uint32_t _sbss;
extern uint32_t _ebss;
extern uint32_t _estack;

void Reset_Handler(void);
static void Default_Handler(void);

__attribute__((section(".isr_vector"))) const uintptr_t vector_table[16] = {
    (uintptr_t)&_estack,
    (uintptr_t)Reset_Handler,
    (uintptr_t)Default_Handler,
    (uintptr_t)Default_Handler,
    (uintptr_t)Default_Handler,
    (uintptr_t)Default_Handler,
    (uintptr_t)Default_Handler,
    0,
    0,
    0,
    0,
    (uintptr_t)Default_Handler,
    (uintptr_t)Default_Handler,
    0,
    (uintptr_t)Default_Handler,
    (uintptr_t)Default_Handler,
};

static uint8_t session = 0x01u;

static void uart_write_char(char value)
{
    while ((USART2_SR & (1u << 7)) == 0u) {
    }
    USART2_DR = (uint32_t)(uint8_t)value;
}

static void uart_write(const char *text)
{
    while (*text != '\0') {
        uart_write_char(*text++);
    }
}

static void peripherals_init(void)
{
    RCC_AHB1ENR |= (1u << 0);
    RCC_APB1ENR |= (1u << 17) | (1u << 25);

    GPIOA_MODER &= ~((3u << (2u * 2u)) | (3u << (3u * 2u)) |
                     (3u << (11u * 2u)) | (3u << (12u * 2u)));
    GPIOA_MODER |= (2u << (2u * 2u)) | (2u << (3u * 2u)) |
                   (2u << (11u * 2u)) | (2u << (12u * 2u));
    GPIOA_AFRL &= ~((0xFu << (2u * 4u)) | (0xFu << (3u * 4u)));
    GPIOA_AFRL |= (7u << (2u * 4u)) | (7u << (3u * 4u));
    GPIOA_AFRH &= ~((0xFu << ((11u - 8u) * 4u)) |
                    (0xFu << ((12u - 8u) * 4u)));
    GPIOA_AFRH |= (9u << ((11u - 8u) * 4u)) |
                  (9u << ((12u - 8u) * 4u));

    USART2_BRR = 0x16Du;
    USART2_CR1 = (1u << 13) | (1u << 3);
}

static bool can_wait_for(uint32_t mask, bool set)
{
    for (uint32_t attempt = 0; attempt < 2000000u; ++attempt) {
        if (((CAN_MSR & mask) != 0u) == set) {
            return true;
        }
    }
    return false;
}

static bool can_init(void)
{
    CAN_MCR &= ~CAN_MCR_SLEEP;
    CAN_MCR |= CAN_MCR_INRQ;
    if (!can_wait_for(CAN_MSR_INAK, true)) {
        return false;
    }

    // 42 MHz APB1 clock, 500 kbit/s: prescaler 6, BS1 11 tq, BS2 2 tq.
    CAN_BTR = (1u << 20) | (10u << 16) | 5u;

    // Filter banks 0..26 belong to CAN1; accept the synthetic UDS request ID.
    CAN_FMR = (CAN_FMR & ~(0x3Fu << 8)) | (27u << 8) | 1u;
    CAN_FM1R |= 1u;
    CAN_FS1R |= 1u;
    CAN_FFA1R &= ~1u;
    CAN_FILTER0_FR1 = (UDS_REQUEST_ID << 5) << 16;
    CAN_FILTER0_FR2 = (UDS_REQUEST_ID << 5) << 16;
    CAN_FA1R |= 1u;
    CAN_FMR &= ~1u;

    CAN_MCR &= ~CAN_MCR_INRQ;
    return can_wait_for(CAN_MSR_INAK, false);
}

static uint32_t pack_word(const uint8_t *data)
{
    return (uint32_t)data[0] | ((uint32_t)data[1] << 8) |
           ((uint32_t)data[2] << 16) | ((uint32_t)data[3] << 24);
}

static bool can_send(uint16_t identifier, const uint8_t data[8])
{
    for (uint32_t attempt = 0; attempt < 500000u; ++attempt) {
        if ((CAN_TSR & CAN_TSR_TME0) != 0u) {
            CAN_TX0_TDTR = 8u;
            CAN_TX0_TDLR = pack_word(data);
            CAN_TX0_TDHR = pack_word(data + 4);
            CAN_TX0_TIR = ((uint32_t)identifier << 21) | 1u;
            return true;
        }
    }
    return false;
}

static bool can_receive(uint16_t *identifier, uint8_t data[8])
{
    if ((CAN_RF0R & CAN_RF0R_FMP0_MASK) == 0u) {
        return false;
    }

    const uint32_t low = CAN_RX0_RDLR;
    const uint32_t high = CAN_RX0_RDHR;
    *identifier = (uint16_t)((CAN_RX0_RIR >> 21) & 0x7FFu);
    const uint8_t length = (uint8_t)(CAN_RX0_RDTR & 0xFu);
    for (uint8_t index = 0; index < 4u; ++index) {
        data[index] = (uint8_t)(low >> (index * 8u));
        data[index + 4u] = (uint8_t)(high >> (index * 8u));
    }
    CAN_RF0R |= CAN_RF0R_RFOM0;
    return length == 8u;
}

static void uds_respond(const uint8_t request[8], bool intervention)
{
    uint8_t response[8] = {0};
    const uint8_t length = request[0] & 0x0Fu;
    const uint8_t service = request[1];

    if ((request[0] >> 4) != 0u || length == 0u || length > 7u) {
        return;
    }

    if (service == 0x10u && length == 2u &&
        (request[2] == 0x01u || request[2] == 0x03u)) {
        session = request[2];
        const uint8_t payload[6] = {0x50u, session, 0x00u, 0x32u, 0x01u, 0xF4u};
        response[0] = 6u;
        for (size_t index = 0; index < sizeof(payload); ++index) {
            response[index + 1u] = payload[index];
        }
    } else if (service == 0x3Eu && length == 2u) {
        response[0] = 2u;
        response[1] = 0x7Eu;
        response[2] = request[2] & 0x7Fu;
    } else if (service == 0x22u && length == 3u && request[2] == 0xF1u &&
               request[3] == 0xA0u) {
        const uint8_t payload[5] = {0x62u, 0xF1u, 0xA0u, 0x01u, 0x00u};
        response[0] = 5u;
        for (size_t index = 0; index < sizeof(payload); ++index) {
            response[index + 1u] = payload[index];
        }
    } else if (service == 0x22u && length == 3u && request[2] == 0xF1u &&
               request[3] == 0xA1u) {
        const uint8_t payload[5] = {
            0x62u, 0xF1u, 0xA1u, intervention ? 1u : 0u, session};
        response[0] = 5u;
        for (size_t index = 0; index < sizeof(payload); ++index) {
            response[index + 1u] = payload[index];
        }
    } else {
        response[0] = 3u;
        response[1] = 0x7Fu;
        response[2] = service;
        response[3] = 0x11u;
    }

    (void)can_send(UDS_RESPONSE_ID, response);
}

static void delay(void)
{
    for (volatile uint32_t count = 0; count < 90000u; ++count) {
        __asm volatile("nop");
    }
}

static void run_reference_ecu(void)
{
    uint8_t counter = 0u;
    uint16_t phase = 0u;

    uart_write("OPEN-ECU: boot\n");
    if (!can_init()) {
        uart_write("OPEN-ECU: CAN init failed\n");
        while (true) {
        }
    }
    uart_write("OPEN-ECU: CAN ready\n");

    while (true) {
        const bool intervention = phase >= 20u && phase < 60u;
        const uint16_t nominal = 4000u;
        const uint16_t rear_left = intervention ? 3000u : nominal;
        const uint8_t wheel_speed[8] = {
            (uint8_t)(nominal >> 8), (uint8_t)nominal,
            (uint8_t)(nominal >> 8), (uint8_t)nominal,
            (uint8_t)(rear_left >> 8), (uint8_t)rear_left,
            (uint8_t)(nominal >> 8), (uint8_t)nominal};
        const uint16_t pressure = intervention ? 600u : 0u;
        const uint8_t dynamics[8] = {
            0x01u, 0xF4u, 0x00u, 0x4Bu,
            (uint8_t)(pressure >> 8), (uint8_t)pressure,
            intervention ? 1u : 0u, counter};
        const uint8_t status[8] = {1u, 0u, intervention ? 1u : 0u, counter,
                                   0u, 0u, 0u, 0u};

        (void)can_send(WHEEL_SPEED_ID, wheel_speed);
        (void)can_send(DYNAMICS_ID, dynamics);
        if ((counter % 4u) == 0u) {
            (void)can_send(ESC_STATUS_ID, status);
        }

        uint16_t received_id = 0u;
        uint8_t received[8] = {0};
        while (can_receive(&received_id, received)) {
            if (received_id == UDS_REQUEST_ID) {
                uds_respond(received, intervention);
            }
        }

        ++counter;
        phase = (uint16_t)((phase + 1u) % 90u);
        delay();
    }
}

void Reset_Handler(void)
{
    uint32_t *source = &_etext;
    for (uint32_t *destination = &_sdata; destination < &_edata;) {
        *destination++ = *source++;
    }
    for (uint32_t *destination = &_sbss; destination < &_ebss;) {
        *destination++ = 0u;
    }

    peripherals_init();
    run_reference_ecu();
}

static void Default_Handler(void)
{
    while (true) {
    }
}

