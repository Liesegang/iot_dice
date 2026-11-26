#pragma once

#include "imu_sample.hpp"

#include <stdint.h>

/*
 * Throw state machine running on every IMU sample.
 *
 *   REST ──motion──▶ MOVING ──|a_lin|≈g──▶ FREEFALL ──spike──▶ TUMBLING ──still──▶ REST
 *     ▲                 │                      │                                     │
 *     └────still────────┘◀──────accel leaves free-fall band without impact──────────┘
 *
 * While not at REST the world-frame translational velocity is integrated from
 * the gravity-removed linear acceleration rotated by the orientation
 * quaternion (a_world = R(q)·a_lin, valid through free fall as well).
 * The integration anchor (v = 0) is the last REST period, so the velocity at
 * impact includes the hand motion imparted before release.
 *
 * On IMPACT the caller gets the sample from a few entries back in the ring
 * buffer — the impact shock corrupts both the fusion and the accelerometer,
 * so the simulation must be seeded with the *pre*-impact state.
 */
class DiceFsm {
public:
    enum class State : uint8_t {
        REST     = 0,
        MOVING   = 1,
        FREEFALL = 2,
        TUMBLING = 3,
    };

    enum class Event : uint8_t {
        NONE,
        IMPACT,   /* first table contact detected — impact() is valid   */
        RESULT,   /* die settled after a throw    — result() is valid   */
    };

    struct ImpactInfo {
        ImuSample pre;        /* sample at least 15 ms before the spike, if available */
        float    vx, vy, vz;       /* world-frame velocity at that sample (m/s)       */
        uint16_t fall_ms;          /* free-fall duration up to impact                 */
        uint8_t  gyro_sat;         /* saturated gyro samples this throw (clamped 255) */
        uint8_t  acc_sat;          /* saturated accel samples this throw              */
        uint32_t t_ms;             /* impact time (uptime ms)                         */
        uint32_t throw_id;
        float high_peak[3];
        uint32_t high_peak_t_ms;
        uint8_t high_saturated;
    };

    struct ResultInfo {
        ImuSample rest;       /* settled orientation → ground-truth face label   */
        float    max_w;            /* peak |ω| during the throw (rad/s)               */
        float    max_a;            /* peak |a_lin| during the throw (m/s²)            */
        uint8_t  gyro_sat;
        uint8_t  acc_sat;
        uint32_t t_ms;
        uint32_t throw_id;
        float max_high_g;
        uint8_t high_sat;
    };

    Event update(const ImuSample &s);

    State state() const { return state_; }
    const ImpactInfo &impact() const { return impact_; }
    const ResultInfo &result() const { return result_; }
    void velocity(float v[3]) const { v[0] = vx_; v[1] = vy_; v[2] = vz_; }

private:
    /* ── thresholds ─────────────────────────────────────────────────────── */
    static constexpr float STILL_W        = 0.30f;   /* rad/s               */
    static constexpr float STILL_A        = 0.60f;   /* m/s²                */
    static constexpr uint32_t STILL_MS    = 300;     /* sustained stillness */
    static constexpr float G              = 9.81f;   /* m/s²                */
    static constexpr float FREEFALL_BAND  = 2.5f;    /* | |a|−g | < band    */
    static constexpr int   FREEFALL_N     = 3;       /* consecutive samples */
    static constexpr int   FREEFALL_EXIT_N = 5;      /* leave band → caught */
    static constexpr float IMPACT_A       = 20.0f;   /* m/s² spike          */
    /* LSM6DSV320X configured limits: gyro ±4000 dps, accel ±16 g.
     * Count samples just inside the rail as saturated. */
    static constexpr float GYRO_SAT       = 67.0f;   /* rad/s (≈3840 dps)   */
    static constexpr float ACC_SAT        = 150.0f;   /* m/s²  (≈15.3 g)      */
    static constexpr uint64_t PRE_IMPACT_US = 15000;

    static constexpr int RING_SIZE = 8;

    struct RingEntry {
        ImuSample s;
        float vx, vy, vz;
    };

    void resetThrowStats();
    void integrate(const ImuSample &s, float dt);
    static void rotateBodyToWorld(const ImuSample &s,
                                  float bx, float by, float bz,
                                  float *wx, float *wy, float *wz);

    State    state_       = State::REST;
    float    vx_ = 0, vy_ = 0, vz_ = 0;
    uint64_t prev_t_us_   = 0;
    uint64_t still_since_us_ = 0;     /* 0 = currently not still            */
    bool     have_prev_   = false;

    int      ff_count_    = 0;
    int      ff_exit_count_ = 0;
    uint64_t ff_start_us_ = 0;

    uint32_t gyro_sat_    = 0;
    uint32_t acc_sat_     = 0;
    float    max_w_       = 0;
    float    max_a_       = 0;
    float max_high_g_ = 0;
    uint32_t high_sat_ = 0;

    RingEntry ring_[RING_SIZE] = {};
    int       ring_head_ = 0;        /* next write position                 */
    int       ring_fill_ = 0;

    ImpactInfo impact_ = {};
    ResultInfo result_ = {};
    uint32_t throw_counter_ = 0;
};
