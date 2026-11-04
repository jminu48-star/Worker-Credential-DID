"""휴대폰 센서 기록 → 특징 7개 (scripts/phone-ai.js 와 같은 계산)

휴대폰을 어느 방향으로 붙여도 같게 나오도록 가속도·회전 속도의 '크기'만 쓴다.
samples: [[t(초), ax, ay, az (m/s², 중력 뺀 값), gx, gy, gz (°/s)], ...]
"""
import math
import numpy as np

HZ = 50
HARSH_ACC = 3.0     # m/s²
SHARP_TURN = 2.0    # rad/s
MIN_GAP_S = 0.5
FEATURES = [
    ("acc_p95", "흔들림 상위 5% (가속도 크기, m/s²)"),
    ("acc_rms", "가속도 크기 RMS (m/s²)"),
    ("jerk_rms", "가가속도 RMS (m/s³) — 조작이 거친 정도"),
    ("gyro_p95", "회전 속도 상위 5% (rad/s)"),
    ("gyro_rms", "회전 속도 RMS (rad/s)"),
    ("harsh_rate", "급가속·급제동 횟수/분 (3 m/s² 초과)"),
    ("sharp_turn_rate", "급회전 횟수/분 (2 rad/s 초과)"),
]
NAMES = [f[0] for f in FEATURES]
COURSES = {
    "acc_p95": "부드러운 가감속 운전", "acc_rms": "부드러운 가감속 운전", "jerk_rms": "부드러운 가감속 운전", "harsh_rate": "부드러운 가감속 운전",
    "gyro_p95": "회전 구간 감속·전도 방지", "gyro_rms": "회전 구간 감속·전도 방지", "sharp_turn_rate": "회전 구간 감속·전도 방지",
}


def resample(samples):
    rows = [r for r in samples if isinstance(r, (list, tuple)) and len(r) == 7 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in r)]
    rows.sort(key=lambda r: r[0])
    rows = [r for i, r in enumerate(rows) if i == 0 or r[0] != rows[i - 1][0]]
    if len(rows) < 10:
        raise ValueError("센서 기록이 너무 짧아요")
    s = np.array(rows, dtype=float)
    ts = s[:, 0]
    t0, t1 = ts[0], ts[-1]
    n = int(math.floor((t1 - t0) * HZ)) + 1
    t = t0 + np.arange(n) / HZ
    j = np.clip(np.searchsorted(ts, t, side="left") - 1, 0, len(ts) - 2)
    a, b = s[j], s[j + 1]
    den = b[:, 0] - a[:, 0]
    u = np.where(den == 0, 0.0, np.clip((t - a[:, 0]) / np.where(den == 0, 1, den), 0, 1))
    v = a + (b - a) * u[:, None]
    A = np.sqrt(v[:, 1] ** 2 + v[:, 2] ** 2 + v[:, 3] ** 2)
    W = np.sqrt(v[:, 4] ** 2 + v[:, 5] ** 2 + v[:, 6] ** 2) * (math.pi / 180)
    return A, W, (n - 1) / HZ


def pct(x, q):
    s = np.sort(x)
    h = (len(s) - 1) * q / 100
    lo, hi = int(math.floor(h)), int(math.ceil(h))
    return float(s[lo] + (s[hi] - s[lo]) * (h - lo))


def rms(x):
    return float(np.sqrt(np.mean(np.asarray(x) ** 2)))


def events(x, thr):
    count, last = 0, -1e9
    for i in range(len(x)):
        on = x[i] > thr
        was = i > 0 and x[i - 1] > thr
        if on and not was:
            if (i - last) / HZ >= MIN_GAP_S:
                count += 1
            last = i
    return count


def features(samples):
    A, W, seconds = resample(samples)
    J = np.diff(A) * HZ
    minutes = seconds / 60
    return {
        "acc_p95": pct(A, 95), "acc_rms": rms(A), "jerk_rms": rms(J),
        "gyro_p95": pct(W, 95), "gyro_rms": rms(W),
        "harsh_rate": events(A, HARSH_ACC) / minutes, "sharp_turn_rate": events(W, SHARP_TURN) / minutes,
        "seconds": seconds,
    }


if __name__ == "__main__":
    # JS(scripts/phone-ai.js)와 같은 값이 나오는지 비교할 기준 파일을 만든다 (test/PhoneAI.test.js)
    import json, os
    rng = np.random.default_rng(7)
    out = []
    for k, rough in enumerate([False, True]):
        t, rows = 0.0, []
        while t < 20:
            amp = 4.5 if rough else 0.8
            burst = rough and (int(t * 2) % 7 == 0)
            a = rng.normal(0, amp * (2.5 if burst else 1), 3)
            g = rng.normal(0, 150 if rough else 25, 3)
            rows.append([round(t, 4), *map(float, np.round(a, 4)), *map(float, np.round(g, 4))])
            if rng.random() < 0.02:
                rows.append(list(rows[-1]))  # 같은 시각이 두 번 들어온 경우
            t += 1 / 60 + rng.normal(0, 0.002)
        out.append({"label": "rough" if rough else "smooth", "samples": rows, "features": features(rows)})
    json.dump(out, open(os.path.join(os.path.dirname(__file__), "phone_parity.json"), "w", encoding="utf-8"), separators=(",", ":"))
    print({o["label"]: {k: round(v, 3) for k, v in o["features"].items()} for o in out})
