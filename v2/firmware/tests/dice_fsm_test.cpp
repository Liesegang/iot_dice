#include "dice_fsm.hpp"
#include <cassert>
#include <cstdio>
#include <initializer_list>

static ImuSample sample(uint64_t t, float a=0, float w=0) {
    return {t,0,0,0,1,w,0,0,0,0,a};
}
int main() {
    for(uint64_t period : {8333ULL, 4167ULL, 10000ULL}) {
        DiceFsm f;
        uint64_t t=period;
        auto tick=[&](float a=0,float w=0) {auto s=sample(t,a,w);t+=period;return f.update(s);};
        for(int i=0;i<40;i++) assert(tick()==DiceFsm::Event::NONE);
        for(int trial=1;trial<=2;trial++) {
            tick(3,2);
            for(int i=0;i<12;i++) assert(tick(-9.81f,2)==DiceFsm::Event::NONE);
            assert(f.state()==DiceFsm::State::FREEFALL);
            assert(tick(40,2)==DiceFsm::Event::IMPACT);
            const auto impact=f.impact();
            assert(impact.throw_id==static_cast<uint32_t>(trial));
            const auto gap=(t-period)-impact.pre.t_us;
            assert(gap>=15000 && gap<15000+period);
            assert(impact.pre.az==-9.81f); // never seed from the shock
            assert(impact.vz<0);
            for(int i=0;i<8;i++) assert(tick(35,2)==DiceFsm::Event::NONE); // bounces do not retrigger
            int results=0;
            for(int i=0;i<100;i++) if(tick()==DiceFsm::Event::RESULT) {
                results++;assert(f.result().throw_id==impact.throw_id);
            }
            assert(results==1 && f.state()==DiceFsm::State::REST);
        }
        tick(4,1);
        for(int i=0;i<100;i++) assert(tick()==DiceFsm::Event::NONE); // placing by hand is not a throw
    }
    // High-g peak survives a low-g sample that missed/railed during a short shock.
    DiceFsm high;uint64_t t=10000;
    auto tick=[&](ImuSample s) {s.t_us=t;t+=10000;return high.update(s);};
    for(int i=0;i<40;i++) tick(sample(0));
    tick(sample(0,3,2));
    for(int i=0;i<12;i++) tick(sample(0,-9.81f,2));
    assert(high.state()==DiceFsm::State::FREEFALL);
    auto shock=sample(0,0,2);shock.laz=9.81f;shock.hpx=-900;shock.accel_flags=5;shock.high_peak_t_ms=t/1000;
    assert(tick(shock)==DiceFsm::Event::IMPACT);
    assert(high.impact().high_peak[0]==-900);
    assert(high.impact().pre.az==-9.81f);
    bool result=false;
    for(int i=0;i<100;i++) if(tick(sample(0))==DiceFsm::Event::RESULT) {
        result=true;assert(high.result().max_high_g>=900);
    }
    assert(result);
    puts("FSM: first collision only, timestamp lookback, matching throw IDs, multiple rates passed");
}
