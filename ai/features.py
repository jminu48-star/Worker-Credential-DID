"""세션 하나(센서 기록) → 숫자 10개(특징)

모든 특징은 "클수록 위험하거나 서툰 쪽"이 되도록 정의했다. 그래야 재교육 추천을
"숙련자 평균보다 얼마나 큰가(z 점수)"로 단순하게 설명할 수 있다.
"""
import numpy as np

DT = 0.1
FEATURES = [
    ("harsh_accel_rate", "급가속 횟수/분"),
    ("harsh_brake_rate", "급제동 횟수/분"),
    ("sharp_turn_rate", "고속 회전 횟수/분 (좌우 가속도 1.5 m/s² 초과)"),
    ("speed_p95", "속도 상위 5% (m/s)"),
    ("turn_speed", "회전 중 평균 속도 (m/s)"),
    ("jerk_rms", "가가속도 RMS (m/s³) — 조작이 거친 정도"),
    ("steer_wobble", "직진 중 조향 흔들림 (rad/s, 표준편차)"),
    ("hesitation_rate", "짐을 들거나 내리지 않고 멈춘 횟수/분 — 머뭇거림"),
    ("raised_drive_ratio", "포크를 0.5 m 이상 올린 채 움직인 시간 비율"),
    ("idle_ratio", "작업 중 멈춰 있던 시간 비율"),
]
NAMES = [f[0] for f in FEATURES]

# 재교육 과정: 어떤 특징이 숙련자보다 크게 벗어나면 어떤 교육을 추천할지
COURSES = {
    "harsh_accel_rate": "부드러운 가감속 운전",
    "harsh_brake_rate": "부드러운 가감속 운전",
    "jerk_rms": "부드러운 가감속 운전",
    "sharp_turn_rate": "회전 구간 감속·전도 방지",
    "turn_speed": "회전 구간 감속·전도 방지",
    "speed_p95": "구내 제한속도 준수",
    "raised_drive_ratio": "적재물 높이·운반 자세",
    "steer_wobble": "기본 조작 실습 (조향·발진)",
    "hesitation_rate": "기본 조작 실습 (조향·발진)",
    "idle_ratio": "기본 조작 실습 (조향·발진)",
}


def _events(mask, min_gap_s=1.0):
    """조건이 참이 되는 순간을 센다 (1초 안에 다시 켜진 것은 같은 이벤트로)"""
    idx = np.flatnonzero(mask[1:] & ~mask[:-1]) + 1
    if mask[0]:
        idx = np.r_[0, idx]
    count, last = 0, -1e9
    for i in idx:
        if (i - last) * DT >= min_gap_s:
            count += 1
        last = i
    return count


def _hesitations(stopped, h, min_len_s=0.5):
    """멈춰 있던 구간 중 포크 높이가 거의 안 바뀐 구간 = 작업과 상관없는 정지"""
    count, i, n = 0, 0, len(stopped)
    while i < n:
        if stopped[i]:
            j = i
            while j < n and stopped[j]:
                j += 1
            if (j - i) * DT >= min_len_s and np.ptp(h[i:j]) < 0.1:
                count += 1
            i = j
        else:
            i += 1
    return count


def extract(sig):
    v, ax, ay, gz, h = (np.asarray(sig[k]) for k in ("v", "ax", "ay", "gz", "h"))
    minutes = len(v) * DT / 60
    speed = np.abs(v)
    moving = speed > 0.3
    turning = (np.abs(gz) > 0.3) & moving
    # 가속도 잡음을 줄이려고 0.3초 이동평균
    k = np.ones(3) / 3
    ax_s = np.convolve(ax, k, mode="same")
    ay_s = np.convolve(ay, k, mode="same")
    jerk = np.diff(ax_s) / DT
    gz_s = np.convolve(gz, np.ones(5) / 5, mode="same")
    straight = moving & (np.abs(gz_s) < 0.25)
    stopped = speed < 0.1
    return {
        "harsh_accel_rate": _events(ax_s > 2.2) / minutes,
        "harsh_brake_rate": _events(ax_s < -2.6) / minutes,
        "sharp_turn_rate": _events(np.abs(ay_s) > 1.5) / minutes,
        "speed_p95": float(np.percentile(speed, 95)),
        "turn_speed": float(speed[turning].mean()) if turning.any() else 0.0,
        "jerk_rms": float(np.sqrt(np.mean(jerk ** 2))),
        "steer_wobble": float(np.std(gz_s[straight])) if straight.sum() > 10 else 0.0,
        "hesitation_rate": _hesitations(stopped, h) / minutes,
        "raised_drive_ratio": float(np.mean((h > 0.5) & moving)),
        "idle_ratio": float(np.mean(stopped)),
    }


def matrix(rows):
    return np.array([[r["features"][n] for n in NAMES] for r in rows], dtype=float)
