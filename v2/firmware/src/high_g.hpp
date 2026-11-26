#pragma once
#include <stdint.h>
#include <math.h>
#include <lsm6dsv320x_reg.h>

// Capture every high-g FIFO entry, retaining a signed vector at the largest norm.
class HighGWindow {
public:
    float latest[3] = {}, peak[3] = {};
    uint32_t peak_t_ms = 0;
    uint32_t samples = 0;
    bool valid = false, peak_valid = false, saturated = false;
    void push(const uint8_t data[6], uint32_t t_ms) {
        bool sat=false;
        for(unsigned i=0;i<3;i++) {
            const int16_t raw=(int16_t)((uint16_t)data[2*i]|((uint16_t)data[2*i+1]<<8));
            latest[i]=lsm6dsv320x_from_fs320_to_mg(raw)*0.00980665f;
            sat=sat||fabsf(latest[i])>=320.0f*0.98f*9.80665f;
        }
        const float norm2=latest[0]*latest[0]+latest[1]*latest[1]+latest[2]*latest[2];
        if(!peak_valid || norm2>peak[0]*peak[0]+peak[1]*peak[1]+peak[2]*peak[2]) {
            for(unsigned i=0;i<3;i++) peak[i]=latest[i];
            peak_t_ms=t_ms;
        }
        saturated=saturated||sat;valid=true;peak_valid=true;++samples;
    }
    uint8_t flags() const {return (valid?1:0)|(saturated?2:0)|(peak_valid?4:0);}
    void clearPeak() {peak_valid=false;saturated=false;}
};
