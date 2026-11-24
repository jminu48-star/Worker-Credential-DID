// 휴대폰 센서 실측 실험 (AI 검증용)
//   휴대폰을 카트·RC카에 붙이고 "부드럽게 / 거칠게" 움직인 기록 → 특징 7개 → Isolation Forest
//   ai/phone_features.py 와 똑같이 계산한다 (test/PhoneAI.test.js 가 두 결과를 비교)
//   휴대폰을 어떤 방향으로 붙여도 같게 나오도록, 가속도·회전 속도의 "크기"만 쓴다
const fs = require("fs");
const path = require("path");

const HZ = 50;            // 휴대폰마다 샘플 간격이 달라서 50Hz 로 맞춘다
const HARSH_ACC = 3.0;    // m/s² — 급가속·급제동·충격 (약 0.3g)
const SHARP_TURN = 2.0;   // rad/s — 급회전 (약 115°/s)
const MIN_GAP_S = 0.5;    // 0.5초 안에 다시 넘은 것은 같은 이벤트

const FEATURES = [
  ["acc_p95", "흔들림 상위 5% (가속도 크기, m/s²)"],
  ["acc_rms", "가속도 크기 RMS (m/s²)"],
  ["jerk_rms", "가가속도 RMS (m/s³) — 조작이 거친 정도"],
  ["gyro_p95", "회전 속도 상위 5% (rad/s)"],
  ["gyro_rms", "회전 속도 RMS (rad/s)"],
  ["harsh_rate", "급가속·급제동 횟수/분 (3 m/s² 초과)"],
  ["sharp_turn_rate", "급회전 횟수/분 (2 rad/s 초과)"],
];
const NAMES = FEATURES.map((f) => f[0]);
const COURSES = {
  acc_p95: "부드러운 가감속 운전", acc_rms: "부드러운 가감속 운전", jerk_rms: "부드러운 가감속 운전", harsh_rate: "부드러운 가감속 운전",
  gyro_p95: "회전 구간 감속·전도 방지", gyro_rms: "회전 구간 감속·전도 방지", sharp_turn_rate: "회전 구간 감속·전도 방지",
};

// samples: [[t(초), ax, ay, az (m/s², 중력 뺀 값), gx, gy, gz (°/s)], ...]
function resample(samples) {
  const s = samples.filter((r) => Array.isArray(r) && r.length === 7 && r.every(Number.isFinite)).sort((a, b) => a[0] - b[0])
    .filter((r, i, arr) => i === 0 || r[0] !== arr[i - 1][0]); // 같은 시각이 두 번이면 앞의 것만
  if (s.length < 10) throw new Error("센서 기록이 너무 짧아요");
  const t0 = s[0][0], t1 = s[s.length - 1][0];
  const n = Math.floor((t1 - t0) * HZ) + 1;
  const A = new Array(n), W = new Array(n);
  const D2R = Math.PI / 180;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / HZ;
    while (j < s.length - 2 && s[j + 1][0] < t) j++;
    const a = s[j], b = s[j + 1];
    const u = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    const v = (k) => a[k] + (b[k] - a[k]) * u;
    A[i] = Math.hypot(v(1), v(2), v(3));
    W[i] = Math.hypot(v(4), v(5), v(6)) * D2R;
  }
  return { A, W, seconds: (n - 1) / HZ };
}
// numpy.percentile 의 기본(linear) 방식과 같게
function pct(x, q) {
  const s = [...x].sort((a, b) => a - b);
  const h = (s.length - 1) * q / 100, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}
const rms = (x) => Math.sqrt(x.reduce((t, v) => t + v * v, 0) / x.length);
function events(x, thr) {
  let count = 0, last = -1e9;
  for (let i = 0; i < x.length; i++) {
    const on = x[i] > thr, was = i > 0 && x[i - 1] > thr;
    if (on && !was) { if ((i - last) / HZ >= MIN_GAP_S) count++; last = i; }
  }
  return count;
}
function features(samples) {
  const { A, W, seconds } = resample(samples);
  const J = []; for (let i = 1; i < A.length; i++) J.push((A[i] - A[i - 1]) * HZ);
  const minutes = seconds / 60;
  return {
    acc_p95: pct(A, 95), acc_rms: rms(A), jerk_rms: rms(J),
    gyro_p95: pct(W, 95), gyro_rms: rms(W),
    harsh_rate: events(A, HARSH_ACC) / minutes, sharp_turn_rate: events(W, SHARP_TURN) / minutes,
    seconds,
  };
}

const MODEL_FILE = path.join(__dirname, "..", "ai", "phone_model.json");
// 판정: '부드럽게' 기록의 평균·표준편차 기준으로 몇 표준편차(z) 벗어났는지 (log 로 바꾼 크기 특징 5개 중 최댓값)
// 실측 기록이 10개 안팎이라 Isolation Forest 보다 이쪽이 안정적이었다 (docs/phone-experiment.md)
class PhoneModel {
  constructor(m) { this.m = m; }
  static load(file = MODEL_FILE) { return fs.existsSync(file) ? new PhoneModel(JSON.parse(fs.readFileSync(file, "utf8"))) : null; }
  z(f) {
    const { mean, std } = this.m.baseline;
    return this.m.use.map((n, i) => (Math.log1p(f[n]) - mean[i]) / std[i]);
  }
  analyze(f) {
    const z = this.z(f);
    const anomaly = Math.max(...z), threshold = this.m.threshold;
    const recs = z.map((v, i) => ({ i, z: v })).filter((d) => d.z >= this.m.zCut).sort((a, b) => b.z - a.z)
      .map((d) => { const n = this.m.use[d.i]; return { feature: n, label: this.m.features[d.i].label, z: Math.round(d.z * 10) / 10, course: COURSES[n] }; });
    return { anomaly, threshold, flagged: anomaly > threshold, recommendations: recs, courses: [...new Set(recs.map((r) => r.course))],
      method: "숙련 기준 z 점수", trainedOn: this.m.trainedOn };
  }
}

module.exports = { HZ, FEATURES, NAMES, COURSES, features, resample, PhoneModel, MODEL_FILE };
