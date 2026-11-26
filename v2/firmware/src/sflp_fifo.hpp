#pragma once
#include <lsm6dsv320x_reg.h>
#include <errno.h>
#include <math.h>
#include <string.h>

// LSM6DSV320X SFLP FIFO: [0x0000, X, Y], then [0x0001, Z, W].
// All four components are signed IEEE-754 binary16, including W.
// ST reference: lsm6dsv320x_STdC/examples/lsm6dsv320x_read_fifo.c
class SflpQuaternion {
public:
    void reset() { have_xy_ = false; }

    // One output per pair. An orphan second record is discarded.
    int push(const uint8_t data[6], float xyzw[4])
    {
        const uint16_t part = word(data);
        if (part == 0) {
            x_ = half(word(data + 2));
            y_ = half(word(data + 4));
            have_xy_ = isfinite(x_) && isfinite(y_);
            return have_xy_ ? 0 : -EBADMSG;
        }
        if (part != 1) { reset(); return -EBADMSG; }
        if (!have_xy_) return 0;
        reset();
        const float z = half(word(data + 2));
        const float w = half(word(data + 4));
        const float norm2 = x_*x_ + y_*y_ + z*z + w*w;
        // A valid unit quaternion only differs by binary16 rounding.
        if (!isfinite(norm2) || norm2 < 0.5f || norm2 > 1.5f) return -EBADMSG;
        const float scale = 1.0f / sqrtf(norm2);
        xyzw[0] = x_*scale; xyzw[1] = y_*scale;
        xyzw[2] = z*scale; xyzw[3] = w*scale;
        return 1;
    }

private:
    static uint16_t word(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
    static float half(uint16_t value)
    {
        const uint32_t bits = lsm6dsv320x_from_f16_to_f32(value);
        float result;
        memcpy(&result, &bits, sizeof(result));
        return result;
    }
    float x_ = 0, y_ = 0;
    bool have_xy_ = false;
};
