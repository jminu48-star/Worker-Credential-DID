"""지게차 조작 센서 데이터 시뮬레이터 (3단계 AI 실험용)

실제 장비 데이터가 없어서, 작업 스타일별로 "그럴듯한" 센서 기록을 만든다.
- 10Hz, 한 세션 = 180초 (창고 안에서 짐 옮기기 반복)
- 채널: 속도 v(m/s), 전후 가속도 ax(m/s²), 좌우 가속도 ay(m/s²), 회전 각속도 gz(rad/s), 포크 높이 h(m)

작업 스타일 (정답 라벨 — 모델 학습 때 Isolation Forest 는 이 라벨을 보지 않는다)
- skilled : 숙련자. 부드러운 가감속, 회전 전 감속, 포크를 내리고 주행
- novice  : 미숙자. 머뭇거림(잦은 정지·출발), 조향 흔들림, 과한 보정
- risky   : 위험 습관. 과속, 급가속·급제동, 고속 회전, 포크를 올린 채 주행

작업자마다 성향 값을 따로 뽑고(같은 스타일이라도 사람마다 다름), 세션마다 조금씩 흔든다.
스타일끼리 분포가 겹치게 해서 "쉽게 다 맞히는" 데이터가 되지 않도록 했다.
"""
import numpy as np

DT = 0.1           # 10Hz
SESSION_SEC = 180  # 3분
STYLES = ["skilled", "novice", "risky"]

# 작업자 성향 분포: (평균, 표준편차) — 작업자마다 한 번 뽑는다
PROFILE = {
    #                   skilled       novice        risky
    "cruise":        [(2.0, 0.25), (1.45, 0.30), (2.75, 0.40)],  # 직진 목표 속도 m/s
    "turn_v":        [(1.0, 0.15), (0.90, 0.20), (1.70, 0.35)],  # 회전 중 목표 속도 m/s
    "acc_max":       [(1.0, 0.20), (1.40, 0.35), (2.00, 0.40)],  # 최대 가속 m/s²
    "brake_max":     [(1.4, 0.25), (2.00, 0.50), (2.50, 0.50)],  # 최대 감속 m/s²
    "gain":          [(0.8, 0.15), (1.40, 0.40), (1.50, 0.35)],  # 속도 맞추는 반응 세기
    "harsh_rate":    [(0.25, 0.20), (0.90, 0.50), (1.50, 0.70)], # 갑작스러운 급조작 횟수/분
    "steer_osc":     [(0.03, 0.02), (0.13, 0.05), (0.06, 0.03)], # 조향 흔들림 rad/s
    "hesitate_rate": [(0.3, 0.25), (1.80, 0.80), (0.40, 0.30)],  # 주행 중 머뭇거리는 정지 횟수/분
    "raised_prob":   [(0.04, 0.04), (0.15, 0.10), (0.30, 0.15)], # 포크를 올린 채 출발할 확률
    "lift_time":     [(3.0, 0.5), (6.0, 1.5), (2.5, 0.5)],       # 포크 올리기·내리기 시간 s
}
LOWER = {"cruise": 0.6, "turn_v": 0.4, "acc_max": 0.5, "brake_max": 0.6, "gain": 0.3,
         "harsh_rate": 0.0, "steer_osc": 0.0, "hesitate_rate": 0.0, "raised_prob": 0.0, "lift_time": 1.5}


def sample_operator(style, rng):
    i = STYLES.index(style)
    p = {}
    for k, dists in PROFILE.items():
        m, s = dists[i]
        p[k] = max(LOWER[k], rng.normal(m, s))
    p["raised_prob"] = min(p["raised_prob"], 0.9)
    return p


def _jitter(p, rng):
    """같은 사람이라도 날마다 조금씩 다르게"""
    q = dict(p)
    for k in q:
        q[k] = max(LOWER[k], q[k] * rng.normal(1.0, 0.08))
    q["raised_prob"] = min(q["raised_prob"], 0.9)
    return q


def simulate_session(op, rng, seconds=SESSION_SEC):
    p = _jitter(op, rng)
    n = int(seconds / DT)
    v = np.zeros(n); ax = np.zeros(n); gz = np.zeros(n); h = np.zeros(n)

    # 작업 단계를 순서대로 쌓는다: (종류, 값)
    plan = []
    while len(plan) < 400:
        plan += [("drive", rng.uniform(8, 25)), ("turn", rng.choice([-1, 1])), ("drive", rng.uniform(4, 12)),
                 ("stop", None), ("lift", rng.uniform(1.0, 2.0)), ("lower", None), ("reverse", rng.uniform(2, 4)),
                 ("turn", rng.choice([-1, 1]))]

    t = 0; vel = 0.0; height = 0.15; travel_h = 0.15
    R = rng.uniform(2.0, 3.0)  # 회전 반경 m
    harsh_left = 0; harsh_a = 0.0
    phase_i = 0; remain = None; carry_raised = False
    osc_f = rng.uniform(0.4, 0.9); osc_ph = rng.uniform(0, 6.28)
    pause_left = 0

    while t < n and phase_i < len(plan):
        kind, val = plan[phase_i]
        if remain is None:  # 단계 시작
            if kind in ("drive", "reverse"):
                remain = val
                # 포크를 올린 채 출발하는 습관
                carry_raised = rng.random() < p["raised_prob"]
            elif kind == "turn":
                remain = R * np.pi / 2
            elif kind == "stop":
                remain = 0.0
            elif kind == "lift":
                remain = val
            elif kind == "lower":
                remain = travel_h

        target_v, yaw = 0.0, 0.0
        done = False
        if kind == "drive":
            target_v = p["cruise"]
            # 남은 거리가 짧으면 감속 (숙련자는 일찍, 위험 습관은 늦게)
            if remain < vel ** 2 / (2 * max(p["brake_max"] * 0.8, 0.3)) + 0.3:
                # 정지 직전에는 0.3 m/s 로 천천히 다가간다 (속도가 0에 수렴해 영원히 도착 못 하는 일 방지)
                target_v = 0.3 if plan[phase_i + 1][0] == "stop" else p["turn_v"]
        elif kind == "reverse":
            target_v = -min(1.2, p["cruise"] * 0.6)
        elif kind == "turn":
            target_v = p["turn_v"]
            yaw = val * abs(vel) / R
        elif kind == "stop":
            target_v = 0.0
            done = abs(vel) < 0.05
        elif kind in ("lift", "lower"):
            target_v = 0.0
            goal = val if kind == "lift" else travel_h
            rate = (1.5 / p["lift_time"]) * DT
            if abs(vel) < 0.1:
                height += np.clip(goal - height, -rate, rate)
            done = abs(height - goal) < 0.02

        # 머뭇거림: 주행 중 갑자기 멈칫
        if kind == "drive" and pause_left == 0 and rng.random() < p["hesitate_rate"] / 60 * DT:
            pause_left = int(rng.uniform(0.8, 2.5) / DT)  # 완전히 멈춘 뒤 이만큼 서 있다
        if pause_left > 0:
            target_v = 0.0
            if abs(vel) < 0.08:
                pause_left -= 1

        # 포크를 올린 채 주행 (위험): 주행 동안 높이 유지
        if kind in ("drive", "reverse", "turn") and carry_raised:
            height += np.clip(1.0 - height, -0.05, 0.05)
        elif kind in ("drive", "reverse", "turn"):
            height += np.clip(travel_h - height, -0.05, 0.05)

        # 속도 제어 + 급조작 이벤트
        a = p["gain"] * (target_v - vel)
        a = float(np.clip(a, -p["brake_max"], p["acc_max"]))
        if harsh_left == 0 and kind in ("drive", "turn") and rng.random() < p["harsh_rate"] / 60 * DT:
            harsh_left = int(0.5 / DT)
            harsh_a = 3.2 if (vel < p["cruise"] * 0.8 and rng.random() < 0.5) else -3.4
        if harsh_left > 0:
            a = harsh_a; harsh_left -= 1
        vel = vel + a * DT
        if kind != "reverse":
            vel = max(vel, 0.0)

        # 조향 흔들림 (주행 중에만)
        if abs(vel) > 0.2:
            yaw += p["steer_osc"] * np.sin(2 * np.pi * osc_f * t * DT + osc_ph)

        v[t] = vel; ax[t] = a; gz[t] = yaw; h[t] = height
        dist = abs(vel) * DT
        if kind in ("drive", "reverse", "turn"):
            remain -= dist
            done = remain <= 0
        if done:
            phase_i += 1; remain = None
        t += 1

    # 센서 잡음
    ay = v * gz
    return {
        "v": v + rng.normal(0, 0.03, n),
        "ax": ax + rng.normal(0, 0.15, n),
        "ay": ay + rng.normal(0, 0.08, n),
        "gz": gz + rng.normal(0, 0.02, n),
        "h": np.clip(h + rng.normal(0, 0.01, n), 0, None),
    }


def make_dataset(n_per_style=40, sessions_per_op=10, seed=2026):
    """작업자 120명 × 10세션 = 1200 세션"""
    rng = np.random.default_rng(seed)
    rows = []
    op_id = 0
    for style in STYLES:
        for _ in range(n_per_style):
            op = sample_operator(style, rng)
            for s in range(sessions_per_op):
                rows.append({"operator": op_id, "style": style, "session": s, "signals": simulate_session(op, rng)})
            op_id += 1
    return rows
