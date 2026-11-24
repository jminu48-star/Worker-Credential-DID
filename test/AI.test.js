const { expect } = require("chai");
const path = require("path");
const { SkillModel } = require("../scripts/ai");
const demo = require("../ai/demo_sessions.json");
const metrics = require("../ai/results/metrics.json");

describe("AI 숙련도 판단 (3단계)", () => {
  const model = SkillModel.load();

  it("JS 계산 결과가 Python(scikit-learn) 결과와 같다 — 시연 세션 전부", () => {
    for (const s of demo.sessions) {
      const r = model.analyze(s.features);
      expect(r.anomaly, s.id).to.be.closeTo(s.py.anomaly, 1e-6);
      model.m.forest.classes.forEach((c, i) => expect(r.proba[c], s.id).to.be.closeTo(s.py.proba[i], 1e-6));
    }
  });

  it("기준값은 학습 때 정한 값(검증 숙련자 95번째 백분위)을 그대로 쓴다", () => {
    expect(model.m.iforest.threshold).to.be.closeTo(metrics.iforest.threshold, 1e-4);
  });

  it("위험 습관 세션은 대부분 재교육 권고, 숙련 세션은 대부분 통과", () => {
    const rate = (st) => { const ss = demo.sessions.filter((s) => s.style === st); return ss.filter((s) => model.analyze(s.features).flagged).length / ss.length; };
    expect(rate("risky")).to.be.at.least(0.8);
    expect(rate("skilled")).to.be.at.most(0.2);
  });

  it("권고에는 이유(특징·z 점수)와 교육 과정이 붙는다", () => {
    const s = demo.sessions.find((x) => x.style === "risky" && model.analyze(x.features).flagged);
    const r = model.analyze(s.features);
    expect(r.recommendations.length).to.be.greaterThan(0);
    expect(r.recommendations[0]).to.include.keys("feature", "label", "z", "course");
    expect(r.courses.length).to.be.greaterThan(0);
  });

  it("특징 값이 빠지면 판단하지 않고 오류를 낸다", () => {
    const f = { ...demo.sessions[0].features }; delete f.jerk_rms;
    expect(() => model.analyze(f)).to.throw("jerk_rms");
  });
});
