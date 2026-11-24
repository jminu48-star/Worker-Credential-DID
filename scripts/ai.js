// 3단계 AI 판단 (Python 으로 학습한 ai/model.json 을 그대로 계산 — 프로그램 쪽은 Python 이 필요 없다)
//   - Isolation Forest: 숙련자와 얼마나 다른가 → 기준을 넘으면 "재교육 권고"
//   - 랜덤 포레스트: 미숙 / 위험 습관 중 어느 쪽에 가까운가 (참고용)
//   - z 점수: 어떤 행동이 숙련자보다 크게 벗어났는가 → 추천 교육 과정
// AI 는 권고만 한다. 배지 정지는 발급기관이 확인하고 결정한다 (오판으로 멀쩡한 작업자가 막히지 않게).
const fs = require("fs");
const path = require("path");

const STYLE_KO = { skilled: "숙련", novice: "미숙", risky: "위험 습관" };

function cFactor(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649015329) - (2 * (n - 1)) / n;
}

// scikit-learn 트리는 입력을 float32 로 바꿔서 비교한다 → 같은 결과를 내려고 Math.fround
function leaf(tree, x) {
  let node = 0, depth = 0;
  while (tree.l[node] !== -1) {
    node = Math.fround(x[tree.f[node]]) <= tree.t[node] ? tree.l[node] : tree.r[node];
    depth++;
  }
  return { node, depth };
}

class SkillModel {
  constructor(model) {
    this.m = model;
    this.names = model.features.map((f) => f.name);
  }
  static load(file = path.join(__dirname, "..", "ai", "model.json")) {
    return new SkillModel(JSON.parse(fs.readFileSync(file, "utf8")));
  }
  vector(features) {
    return this.names.map((n) => {
      if (typeof features[n] !== "number" || !Number.isFinite(features[n])) throw new Error(`특징 값이 없어요: ${n}`);
      return features[n];
    });
  }
  anomaly(x) {
    const F = this.m.iforest;
    let sum = 0;
    for (const t of F.trees) { const { node, depth } = leaf(t, x); sum += depth + cFactor(t.n[node]); }
    return Math.pow(2, -(sum / F.trees.length) / F.c);
  }
  proba(x) {
    const k = this.m.forest.classes.length, out = new Array(k).fill(0);
    for (const t of this.m.forest.trees) { const p = t.p[leaf(t, x).node]; for (let i = 0; i < k; i++) out[i] += p[i]; }
    return out.map((v) => v / this.m.forest.trees.length);
  }
  recommend(x) {
    const { mean, std } = this.m.baseline;
    return x.map((v, i) => ({ i, z: (v - mean[i]) / std[i] }))
      .filter((d) => d.z >= this.m.zCut).sort((a, b) => b.z - a.z)
      .map((d) => ({ feature: this.names[d.i], label: this.m.features[d.i].label, z: Math.round(d.z * 10) / 10, course: this.m.courses[this.names[d.i]] }));
  }
  analyze(features) {
    const x = this.vector(features);
    const anomaly = this.anomaly(x);
    const threshold = this.m.iforest.threshold;
    const p = this.proba(x);
    const classes = this.m.forest.classes;
    const proba = Object.fromEntries(classes.map((c, i) => [c, p[i]]));
    const type = classes[p.indexOf(Math.max(...p))];
    const recs = this.recommend(x);
    const courses = [...new Set(recs.map((r) => r.course))];
    return {
      anomaly, threshold, flagged: anomaly > threshold, proba, type, typeKo: STYLE_KO[type],
      recommendations: recs, courses,
    };
  }
}

module.exports = { SkillModel, STYLE_KO, cFactor };
