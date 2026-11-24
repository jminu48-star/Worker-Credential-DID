const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { features, NAMES } = require("../scripts/phone-ai");

describe("휴대폰 센서 실측 실험 (AI 검증)", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ai", "phone_parity.json"), "utf8"));
  it("JS 특징 계산이 Python(ai/phone_features.py)과 같다 — 휴대폰 기록을 프로그램이 바로 판정할 수 있게", () => {
    for (const c of cases) {
      const js = features(c.samples);
      for (const n of [...NAMES, "seconds"]) expect(js[n]).to.be.closeTo(c.features[n], 1e-9, `${c.label} ${n}`);
    }
  });
  it("거칠게 기록은 부드럽게 기록보다 급가속·급회전·가가속도가 크다", () => {
    const [s, r] = cases.map((c) => features(c.samples));
    for (const n of ["acc_p95", "jerk_rms", "gyro_p95", "harsh_rate"]) expect(r[n]).to.be.greaterThan(s[n]);
  });
  it("형식이 이상한 기록(너무 짧음)은 거부한다", () => {
    expect(() => features([[0, 0, 0, 0, 0, 0, 0]])).to.throw();
  });
});

describe("휴대폰 센서 판정 모델 (ai/phone_model.json)", () => {
  const { PhoneModel } = require("../scripts/phone-ai");
  const m = PhoneModel.load();
  (m ? it : it.skip)("JS 판정 점수가 Python 분석 결과와 같다", () => {
    for (const c of m.m.check) expect(m.analyze(c.features).anomaly).to.be.closeTo(c.score, 1e-9);
  });
  (m ? it : it.skip)("'거칠게' 기록은 기준을 넘고 '부드럽게' 기록은 넘지 않는다", () => {
    const [s, r] = m.m.check.map((c) => m.analyze(c.features));
    expect(s.flagged).to.equal(false); expect(r.flagged).to.equal(true);
  });
});
