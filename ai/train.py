"""3단계 AI 실험: 학습 → 평가 → 그림 → 프로그램용 모델 내보내기

실행:  python ai/train.py        (프로젝트 폴더에서, 약 1분)
결과:  ai/model.json             체험 프로그램이 쓰는 모델 (Python 없이 JS 로 계산)
       ai/demo_sessions.json     프로그램 시연용 세션 (시험용 작업자의 것 — 학습에 안 씀)
       ai/results/metrics.json   논문 표에 쓸 수치
       docs/ai/*.png             그림

실험 설계
- 작업자 120명(스타일별 40명) × 10세션. 작업자 단위로 학습 60% / 검증 20% / 시험 20% 로 나눈다.
  (같은 사람의 세션이 학습과 시험에 함께 들어가면 점수가 부풀려지므로)
- 모델 A: Isolation Forest — 숙련자 세션만으로 학습. "평소 숙련자와 다른가"를 본다.
  현장에서는 미숙·위험 사례에 라벨을 달기 어렵기 때문에, 정상 데이터만으로 학습하는 방식을 주 모델로 쓴다.
  판단 기준(임계값)은 검증용 숙련자 세션의 95번째 백분위 = 숙련자를 잘못 잡는 비율 약 5%.
- 모델 B: 랜덤 포레스트 — 세 스타일 라벨로 학습. 미숙인지 위험 습관인지 유형을 알려 준다 (비교용·보조).
- 재교육 추천: 숙련자 평균 대비 z 점수가 2 이상인 특징 → 정해 둔 교육 과정.
"""
import json, os, sys, time
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from simulate import make_dataset, STYLES, DT
from features import extract, matrix, NAMES, FEATURES, COURSES
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import (precision_score, recall_score, f1_score, roc_auc_score,
                             confusion_matrix, classification_report)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "ai", "results")
FIG = os.path.join(ROOT, "docs", "ai")
SEED = 2026
Z_CUT = 2.0
STYLE_KO = {"skilled": "숙련", "novice": "미숙", "risky": "위험 습관"}


def split_operators(rows, rng):
    split = {}
    for st in STYLES:
        ops = sorted({r["operator"] for r in rows if r["style"] == st})
        rng.shuffle(ops)
        n = len(ops)
        for i, o in enumerate(ops):
            split[o] = "train" if i < n * 0.6 else "val" if i < n * 0.8 else "test"
    for r in rows:
        r["split"] = split[r["operator"]]


def c_factor(n):
    """Isolation Forest 의 평균 경로 길이 보정값 c(n)"""
    if n <= 1:
        return 0.0
    if n == 2:
        return 1.0
    return 2.0 * (np.log(n - 1.0) + np.euler_gamma) - 2.0 * (n - 1.0) / n


def export_iforest(iso):
    trees = []
    for est, feats in zip(iso.estimators_, iso.estimators_features_):
        t = est.tree_
        trees.append({
            "f": [int(feats[i]) if i >= 0 else -1 for i in t.feature],  # 원래 특징 번호로 바꿔 둔다
            "t": [float(x) for x in t.threshold],
            "l": [int(x) for x in t.children_left],
            "r": [int(x) for x in t.children_right],
            "n": [int(x) for x in t.n_node_samples],
        })
    return {"trees": trees, "c": float(c_factor(iso.max_samples_)), "maxSamples": int(iso.max_samples_)}


def export_forest(rf):
    trees = []
    for est in rf.estimators_:
        t = est.tree_
        val = t.value[:, 0, :]
        prob = val / np.maximum(val.sum(axis=1, keepdims=True), 1e-12)
        trees.append({
            "f": [int(x) for x in t.feature], "t": [float(x) for x in t.threshold],
            "l": [int(x) for x in t.children_left], "r": [int(x) for x in t.children_right],
            "p": [[round(float(x), 6) for x in row] for row in prob],
        })
    return {"trees": trees, "classes": [str(c) for c in rf.classes_]}


def recommend(x, mu, sd):
    z = (x - mu) / sd
    out = []
    for i in np.argsort(-z):
        if z[i] < Z_CUT:
            break
        out.append({"feature": NAMES[i], "z": round(float(z[i]), 2), "course": COURSES[NAMES[i]]})
    return out


def binary_metrics(y, pred, score):
    return {
        "precision": round(precision_score(y, pred), 3), "recall": round(recall_score(y, pred), 3),
        "f1": round(f1_score(y, pred), 3), "auc": round(roc_auc_score(y, score), 3),
        "false_alarm_rate": round(float(np.mean(pred[y == 0])), 3),
    }


def main():
    t0 = time.time()
    rng = np.random.default_rng(SEED)
    rows = make_dataset(n_per_style=40, sessions_per_op=10, seed=SEED)
    for r in rows:
        r["features"] = extract(r["signals"])
    split_operators(rows, rng)
    S = {k: [r for r in rows if r["split"] == k] for k in ("train", "val", "test")}
    X = {k: matrix(v) for k, v in S.items()}
    Y = {k: np.array([r["style"] for r in v]) for k, v in S.items()}
    print(f"세션 {len(rows)}개 생성·특징 추출 {time.time() - t0:.1f}s  (학습 {len(S['train'])} / 검증 {len(S['val'])} / 시험 {len(S['test'])})")

    # ── 모델 A: Isolation Forest (숙련자만 학습) ──
    skilled_tr = X["train"][Y["train"] == "skilled"]
    iso = IsolationForest(n_estimators=100, max_samples=min(256, len(skilled_tr)), random_state=SEED).fit(skilled_tr)
    anom = {k: -iso.score_samples(X[k]) for k in X}  # 클수록 이상
    thr = float(np.percentile(anom["val"][Y["val"] == "skilled"], 95))
    yb = (Y["test"] != "skilled").astype(int)
    pred_a = (anom["test"] > thr).astype(int)
    m_a = binary_metrics(yb, pred_a, anom["test"])
    m_a["recall_by_style"] = {st: round(float(np.mean(pred_a[Y["test"] == st])), 3) for st in STYLES}

    # 최근 3세션 평균으로 판단하면? (한 번의 실수로 정지당하지 않게)
    agg_y, agg_pred, agg_score = [], [], []
    test_rows = S["test"]
    for op in sorted({r["operator"] for r in test_rows}):
        idx = [i for i, r in enumerate(test_rows) if r["operator"] == op]
        idx.sort(key=lambda i: test_rows[i]["session"])
        for j in range(2, len(idx)):
            sc = float(np.mean(anom["test"][idx[j - 2:j + 1]]))
            agg_score.append(sc); agg_pred.append(int(sc > thr)); agg_y.append(int(test_rows[idx[j]]["style"] != "skilled"))
    m_a3 = binary_metrics(np.array(agg_y), np.array(agg_pred), np.array(agg_score))

    # ── 모델 B: 랜덤 포레스트 (라벨 사용, 유형 분류) ──
    Xtv = np.vstack([X["train"], X["val"]]); Ytv = np.r_[Y["train"], Y["val"]]
    rf = RandomForestClassifier(n_estimators=60, max_depth=6, class_weight="balanced", random_state=SEED).fit(Xtv, Ytv)
    pred_b = rf.predict(X["test"])
    cm = confusion_matrix(Y["test"], pred_b, labels=STYLES)
    m_b = {
        "macro_f1": round(f1_score(Y["test"], pred_b, average="macro"), 3),
        "accuracy": round(float(np.mean(pred_b == Y["test"])), 3),
        "confusion": {"labels": STYLES, "matrix": cm.tolist()},
        "binary": binary_metrics(yb, (pred_b != "skilled").astype(int), 1 - rf.predict_proba(X["test"])[:, list(rf.classes_).index("skilled")]),
        "importance": {n: round(float(v), 3) for n, v in sorted(zip(NAMES, rf.feature_importances_), key=lambda x: -x[1])},
    }

    # ── 재교육 추천 ──
    # 숙련자 기준값. 숙련자는 급회전이 거의 0이라 표준편차가 아주 작아서, 한 번만 나와도 z 가 폭발한다.
    # 그래서 표준편차에 바닥값(전체 학습 데이터 표준편차의 25%)을 둔다.
    mu = skilled_tr.mean(axis=0)
    sd = np.maximum(skilled_tr.std(axis=0), 0.25 * X["train"].std(axis=0)) + 1e-6
    course_count = {st: {} for st in STYLES}
    for x, st, a in zip(X["test"], Y["test"], anom["test"]):
        if a <= thr:
            continue
        rec = recommend(x, mu, sd)
        top = rec[0]["course"] if rec else "(뚜렷한 원인 없음)"
        course_count[st][top] = course_count[st].get(top, 0) + 1

    metrics = {
        "dataset": {"sessions": len(rows), "operators": 120, "session_sec": 180, "hz": int(1 / DT),
                    "split": {k: len(v) for k, v in S.items()}},
        "iforest": {"threshold": round(thr, 4), "per_session": m_a, "rolling3": m_a3},
        "random_forest": m_b,
        "recommendation_top_course_by_style": course_count,
        "feature_means": {st: {n: round(float(X["test"][Y["test"] == st][:, i].mean()), 3) for i, n in enumerate(NAMES)} for st in STYLES},
    }
    os.makedirs(OUT, exist_ok=True)
    json.dump(metrics, open(os.path.join(OUT, "metrics.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps({"IF 세션 단위": m_a, "IF 3세션 평균": m_a3, "RF macro F1": m_b["macro_f1"], "RF 이진": m_b["binary"]}, ensure_ascii=False, indent=1))
    print(classification_report(Y["test"], pred_b, labels=STYLES, digits=3))

    # ── 프로그램용 모델 내보내기 ──
    model = {
        "version": 1, "createdBy": "ai/train.py", "seed": SEED,
        "features": [{"name": n, "label": l} for n, l in FEATURES], "courses": COURSES,
        "baseline": {"mean": mu.round(5).tolist(), "std": sd.round(5).tolist()}, "zCut": Z_CUT,
        "iforest": {**export_iforest(iso), "threshold": thr},
        "forest": export_forest(rf),
        "note": "시뮬레이션 데이터로 학습한 실험용 모델 — 실제 장비 데이터로 다시 학습해야 함",
    }
    json.dump(model, open(os.path.join(ROOT, "ai", "model.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    # 시연용 세션: 시험용 작업자(학습에 안 쓴 사람)의 세션, 스타일별 12개
    demo = []
    drng = np.random.default_rng(SEED + 1)
    for st in STYLES:
        idx = [i for i, r in enumerate(test_rows) if r["style"] == st]
        for i in drng.choice(idx, 12, replace=False):
            r = test_rows[i]; sig = r["signals"]
            feats = {n: round(float(r["features"][n]), 5) for n in NAMES}
            xr = np.array([[feats[n] for n in NAMES]])  # 저장한(반올림한) 값으로 다시 계산 → JS 결과와 비교용
            demo.append({
                "id": f"{st}-{r['operator']}-{r['session']}", "style": st, "features": feats,
                "py": {"anomaly": round(float(-iso.score_samples(xr)[0]), 8),
                       "proba": [round(float(p), 8) for p in rf.predict_proba(xr)[0]]},
                "trace": {k: [round(float(x), 2) for x in sig[k][::5]] for k in ("v", "ay", "h")},  # 2Hz 로 줄임
            })
    json.dump({"hz": 2, "sessions": demo}, open(os.path.join(ROOT, "ai", "demo_sessions.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))

    figures(metrics, anom, Y, thr, X, mu, sd)
    print(f"완료 {time.time() - t0:.1f}s → ai/model.json, ai/demo_sessions.json, ai/results/metrics.json, docs/ai/")


def figures(metrics, anom, Y, thr, X, mu, sd):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    for name in ("Malgun Gothic", "Noto Sans CJK KR", "Noto Sans CJK JP", "AppleGothic", "NanumGothic"):
        if any(name in f.name for f in font_manager.fontManager.ttflist):
            plt.rcParams["font.family"] = name; break
    plt.rcParams["axes.unicode_minus"] = False
    os.makedirs(FIG, exist_ok=True)
    col = {"skilled": "#1E7B4C", "novice": "#1F6F8B", "risky": "#B8382C"}

    # 1) 이상 점수 분포 + 기준선
    fig, ax = plt.subplots(figsize=(7, 3.6), dpi=150)
    bins = np.linspace(min(anom["test"]), max(anom["test"]), 40)
    for st in STYLES:
        ax.hist(anom["test"][Y["test"] == st], bins=bins, alpha=0.55, color=col[st], label=STYLE_KO[st])
    ax.axvline(thr, color="#1B222C", ls="--", lw=1.2)
    ax.text(thr, ax.get_ylim()[1] * 0.92, "  재교육 권고 기준", fontsize=9)
    ax.set_xlabel("이상 점수 (Isolation Forest, 클수록 숙련자와 다름)"); ax.set_ylabel("세션 수")
    ax.set_title("시험용 작업자 세션의 이상 점수", fontsize=11); ax.legend(frameon=False, loc="upper left")
    for s in ("top", "right"): ax.spines[s].set_visible(False)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "anomaly_hist.png")); plt.close(fig)

    # 2) 혼동 행렬 (랜덤 포레스트)
    cm = np.array(metrics["random_forest"]["confusion"]["matrix"])
    fig, ax = plt.subplots(figsize=(4.2, 3.6), dpi=150)
    ax.imshow(cm, cmap="Greys")
    labels = [STYLE_KO[s] for s in STYLES]
    ax.set_xticks(range(3)); ax.set_xticklabels(labels); ax.set_yticks(range(3)); ax.set_yticklabels(labels)
    ax.set_xlabel("예측"); ax.set_ylabel("실제"); ax.set_title(f"유형 분류 (macro F1 {metrics['random_forest']['macro_f1']})", fontsize=11)
    for i in range(3):
        for j in range(3):
            ax.text(j, i, cm[i, j], ha="center", va="center", color="white" if cm[i, j] > cm.max() / 2 else "#1B222C", fontsize=11)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "confusion.png")); plt.close(fig)

    # 3) 스타일별 특징 z 점수 (숙련자 대비)
    z = np.array([((X["test"][Y["test"] == st].mean(axis=0)) - mu) / sd for st in STYLES])
    fig, ax = plt.subplots(figsize=(7, 3.8), dpi=150)
    y = np.arange(len(NAMES)); w = 0.38
    ax.barh(y - w / 2, z[1], w, color=col["novice"], label="미숙")
    ax.barh(y + w / 2, z[2], w, color=col["risky"], label="위험 습관")
    ax.axvline(Z_CUT, color="#1B222C", ls="--", lw=1)
    ax.set_yticks(y); ax.set_yticklabels([l.split(" (")[0].split(" —")[0] for _, l in FEATURES], fontsize=8.5); ax.invert_yaxis()
    ax.set_xlabel("숙련자 평균보다 몇 표준편차 큰가 (z)"); ax.set_title("어떤 행동이 숙련자와 다른가 → 재교육 과정 선택", fontsize=11)
    ax.legend(frameon=False, loc="lower right")
    for s in ("top", "right"): ax.spines[s].set_visible(False)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "feature_z.png")); plt.close(fig)


if __name__ == "__main__":
    main()
