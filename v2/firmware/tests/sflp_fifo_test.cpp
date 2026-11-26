#include "sflp_fifo.hpp"
#include <assert.h>
#include <stdio.h>

static void record(uint8_t out[6], uint16_t part, uint16_t a, uint16_t b)
{
    const uint16_t words[] = {part, a, b};
    for (unsigned i = 0; i < 3; ++i) {
        out[2*i] = words[i] & 255;
        out[2*i+1] = words[i] >> 8;
    }
}

static void pair(SflpQuaternion &decoder, uint16_t x, uint16_t y,
                 uint16_t z, uint16_t w, float q[4])
{
    uint8_t row[6];
    record(row, 0, x, y);
    assert(decoder.push(row, q) == 0);
    record(row, 1, z, w);
    assert(decoder.push(row, q) == 1);
}

int main()
{
    SflpQuaternion decoder;
    float q[4] = {};
    uint8_t row[6];
    // A second half alone must not emit an invented orientation.
    record(row, 1, 0, 0x3c00);
    assert(decoder.push(row, q) == 0);
    pair(decoder, 0, 0, 0, 0x3c00, q);
    assert(q[0] == 0 && q[1] == 0 && q[2] == 0 && q[3] == 1);

    // Signed binary16 +/-sin(30 deg), cos(30 deg): opposite 60 deg tilts.
    for (unsigned axis = 0; axis < 3; ++axis) {
        for (unsigned negative = 0; negative < 2; ++negative) {
            uint16_t xyz[3] = {};
            xyz[axis] = negative ? 0xb800 : 0x3800;
            pair(decoder, xyz[0], xyz[1], xyz[2], 0x3aee, q);
            const float sine = 2*q[axis]*q[3];
            assert(fabsf(sine - (negative ? -0.8660254f : 0.8660254f)) < 0.001f);
            assert(fabsf(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3] - 1) < 0.00001f);
        }
    }
    // 240 deg rotation: W is negative, not a positive square root.
    pair(decoder, 0x3aee, 0, 0, 0xb800, q);
    assert(q[3] < 0 && 2*q[0]*q[3] < -0.86f);
    // Every component has its own position, including mixed signs.
    pair(decoder, 0xb800, 0x3800, 0xb800, 0x3800, q);
    assert(q[0] == -0.5f && q[1] == 0.5f && q[2] == -0.5f && q[3] == 0.5f);

    // Repeated first halves resync to the most recent sample.
    record(row, 0, 0x3800, 0); assert(decoder.push(row, q) == 0);
    record(row, 0, 0xb800, 0); assert(decoder.push(row, q) == 0);
    record(row, 1, 0, 0x3aee); assert(decoder.push(row, q) == 1);
    assert(q[0] < 0);
    record(row, 1, 0, 0x3aee); assert(decoder.push(row, q) == 0);
    // A reset or malformed record must discard a partial sample.
    record(row, 0, 0x3800, 0); assert(decoder.push(row, q) == 0);
    decoder.reset();
    record(row, 1, 0, 0x3aee); assert(decoder.push(row, q) == 0);
    record(row, 0, 0, 0); assert(decoder.push(row, q) == 0);
    record(row, 1, 0, 0); assert(decoder.push(row, q) == -EBADMSG);
    record(row, 0, 0x7c00, 0); assert(decoder.push(row, q) == -EBADMSG);
    record(row, 0, 0x3800, 0); assert(decoder.push(row, q) == 0);
    record(row, 2, 0, 0); assert(decoder.push(row, q) == -EBADMSG);
    record(row, 1, 0, 0x3aee); assert(decoder.push(row, q) == 0);
    puts("SFLP FIFO: signed tilts, full quaternion, pairing and resync passed");
}
