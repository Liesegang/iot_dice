#include "dice_fsm.hpp"

#include <math.h>

/* ── helpers ────────────────────────────────────────────────────────────── */

void DiceFsm::rotateBodyToWorld(const BNO085::Sample &s,
                                float bx, float by, float bz,
                                float *wx, float *wy, float *wz)
{
    /* v_world = q · v_body · q⁻¹ */
    const float qx = s.qx, qy = s.qy, qz = s.qz, qw = s.qw;

    /* t = 2 (q_vec × v) */
    const float tx = 2.0f * (qy * bz - qz * by);
    const float ty = 2.0f * (qz * bx - qx * bz);
    const float tz = 2.0f * (qx * by - qy * bx);

    /* v' = v + qw·t + q_vec × t */
    *wx = bx + qw * tx + (qy * tz - qz * ty);
    *wy = by + qw * ty + (qz * tx - qx * tz);
    *wz = bz + qw * tz + (qx * ty - qy * tx);
}

void DiceFsm::integrate(const BNO085::Sample &s, float dt)
{
    /* a_lin is body-frame and gravity-removed → R(q)·a_lin is the true
     * world-frame acceleration, including the −g of free fall. */
    float awx, awy, awz;
    rotateBodyToWorld(s, s.ax, s.ay, s.az, &awx, &awy, &awz);
    vx_ += awx * dt;
    vy_ += awy * dt;
    vz_ += awz * dt;
}

void DiceFsm::resetThrowStats()
{
    gyro_sat_ = 0;
    acc_sat_  = 0;
    max_w_    = 0;
    max_a_    = 0;
}

static inline uint8_t clamp_u8(uint32_t v)
{
    return v > 255 ? 255 : (uint8_t)v;
}

/* ── update ─────────────────────────────────────────────────────────────── */

DiceFsm::Event DiceFsm::update(const BNO085::Sample &s)
{
    const float w_norm = sqrtf(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz);
    const float a_norm = sqrtf(s.ax * s.ax + s.ay * s.ay + s.az * s.az);

    float dt = 0.0f;
    if (have_prev_) {
        dt = (float)(s.t_us - prev_t_us_) * 1e-6f;
        if (dt < 0.0f || dt > 0.05f) dt = 0.0f;   /* gap → skip integration */
    }
    prev_t_us_ = s.t_us;
    have_prev_ = true;

    /* ── stillness tracking (shared by all states) ── */
    const bool still = (w_norm < STILL_W) && (a_norm < STILL_A);
    if (still) {
        if (still_since_us_ == 0) still_since_us_ = s.t_us;
    } else {
        still_since_us_ = 0;
    }
    const bool settled = still_since_us_ != 0 &&
                         (s.t_us - still_since_us_) >= (uint64_t)STILL_MS * 1000;

    /* ── saturation / peak tracking while a throw is in progress ── */
    if (state_ != State::REST) {
        const bool gsat = fabsf(s.wx) > GYRO_SAT || fabsf(s.wy) > GYRO_SAT ||
                          fabsf(s.wz) > GYRO_SAT;
        if (gsat) gyro_sat_++;
        if (a_norm > ACC_SAT) acc_sat_++;
        if (w_norm > max_w_) max_w_ = w_norm;
        if (a_norm > max_a_) max_a_ = a_norm;
        integrate(s, dt);
    }

    /* ── ring buffer of recent state (for pre-impact lookback) ── */
    ring_[ring_head_] = { s, vx_, vy_, vz_ };
    const int written = ring_head_;
    ring_head_ = (ring_head_ + 1) % RING_SIZE;
    if (ring_fill_ < RING_SIZE) ring_fill_++;

    Event ev = Event::NONE;

    switch (state_) {

    case State::REST:
        vx_ = vy_ = vz_ = 0.0f;
        if (!still) {
            state_ = State::MOVING;
            resetThrowStats();
            ff_count_ = 0;
        }
        break;

    case State::MOVING:
        if (settled) {
            /* picked up and put back down — not a throw */
            state_ = State::REST;
            vx_ = vy_ = vz_ = 0.0f;
            break;
        }
        /* free-fall: linear accel (gravity-removed) has norm ≈ g */
        if (fabsf(a_norm - G) < FREEFALL_BAND) {
            if (++ff_count_ >= FREEFALL_N) {
                state_        = State::FREEFALL;
                ff_start_us_  = s.t_us - (uint64_t)(FREEFALL_N - 1) * (dt > 0 ? (uint64_t)(dt * 1e6f) : 2500);
                ff_exit_count_ = 0;
            }
        } else {
            ff_count_ = 0;
        }
        break;

    case State::FREEFALL:
        if (a_norm > IMPACT_A) {
            /* ── first table contact ── */
            int back = PRE_IMPACT_BACK;
            if (back > ring_fill_ - 1) back = ring_fill_ - 1;
            const RingEntry &pre =
                ring_[(written - back + RING_SIZE) % RING_SIZE];

            impact_.pre      = pre.s;
            impact_.vx       = pre.vx;
            impact_.vy       = pre.vy;
            impact_.vz       = pre.vz;
            impact_.fall_ms  = (uint16_t)((s.t_us - ff_start_us_) / 1000);
            impact_.gyro_sat = clamp_u8(gyro_sat_);
            impact_.acc_sat  = clamp_u8(acc_sat_);
            impact_.t_ms     = (uint32_t)(s.t_us / 1000);

            state_ = State::TUMBLING;
            ev = Event::IMPACT;
        } else if (fabsf(a_norm - G) >= FREEFALL_BAND) {
            /* left the free-fall band without a spike → caught in hand */
            if (++ff_exit_count_ >= FREEFALL_EXIT_N) {
                state_    = State::MOVING;
                ff_count_ = 0;
            }
        } else {
            ff_exit_count_ = 0;
        }
        break;

    case State::TUMBLING:
        if (settled) {
            result_.rest     = s;
            result_.max_w    = max_w_;
            result_.max_a    = max_a_;
            result_.gyro_sat = clamp_u8(gyro_sat_);
            result_.acc_sat  = clamp_u8(acc_sat_);
            result_.t_ms     = (uint32_t)(s.t_us / 1000);

            state_ = State::REST;
            vx_ = vy_ = vz_ = 0.0f;
            ev = Event::RESULT;
        }
        break;
    }

    return ev;
}
