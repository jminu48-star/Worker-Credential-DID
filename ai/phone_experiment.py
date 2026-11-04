"""휴대폰 센서 실측 실험 분석 — "시뮬레이션 말고 실제 센서로도 AI가 거친 운전을 잡는가?"

데이터: ai/phone_data/*.json  (휴대폰 작업자 앱의 '🧪 센서 실험' 화면에서 기록)
판정:   '부드럽게' 기록의 평균·표준편차를 기준으로, 새 기록이 몇 표준편차(z) 벗어났는지 본다
        (가속도·회전 속도 크기 5개를 log 로 바꾼 뒤 z 의 최댓값 = 이상 점수).
        기준선 = '부드럽게' 기록을 처음 보는 기록처럼 매긴 점수의 95번째 백분위.
        ※ Isolation Forest 는 학습 기록이 적을 때(10개 안팎) 점수가 거칠어서 비교용으로만 같이 계산한다.
        ※ '급가속 횟수' 같은 횟수 특징은 계속 흔들리면 한 번으로 세어져서(문턱을 넘은 채 유지) 판정에서 뺐다.
평가:   참가자 2명 이상 → 한 명을 통째로 빼고 학습 → 뺀 사람 판정 (Leave-One-Participant-Out)
        참가자 1명     → 기록을 5묶음으로 나눠 교차검증 (사람이 바뀌어도 되는지는 증명 못 함)
결과:   docs/phone-experiment.md, docs/ai/phone_*.png, ai/results/phone_metrics.json
        ai/phone_model.json — 프로그램이 '작업 종료' 때와 센서 실험 화면에서 바로 판정할 때 씀

실행:   python ai/phone_experiment.py
"""
import argparse
import datetime as dt
import glob
import json
import os
import sys

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(__file__))
from phone_features import COURSES, FEATURES, NAMES, features  # noqa: E402

SEED = 2026
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LABEL_KO = {"smooth": "부드럽게", "rough": "거칠게"}
USE = ["acc_p95", "acc_rms", "jerk_rms", "gyro_p95", "gyro_rms"]  # 판정에 쓰는 특징 (크기 기반)
UI = [NAMES.index(n) for n in USE]
LABEL = dict(FEATURES)


def load(data_dir):
    rows = []
    for f in sorted(glob.glob(os.path.join(data_dir, "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        if d.get("label") not in LABEL_KO:
            continue
        try:
            feat = features(d["samples"])
        except ValueError:
            continue
        if feat["seconds"] < 8:
            continue
        rows.append({"file": os.path.basename(f), "participant": d.get("participant") or "?", "label": d["label"],
                     "x": [feat[n] for n in NAMES], "f": feat, "seconds": feat["seconds"], "device": d.get("device", "")})
    return rows


# ── 주 판정: 숙련(부드럽게) 기준 z 점수 ──
def zfit(X):
    L = np.log1p(np.asarray(X, dtype=float)[:, UI])
    sd = L.std(axis=0, ddof=1) if len(L) > 1 else np.ones(L.shape[1])
    return {"mean": L.mean(axis=0), "std": np.where(sd < 1e-6, 1e-6, sd)}


def zall(m, X):
    return (np.log1p(np.asarray(X, dtype=float)[:, UI]) - m["mean"]) / m["std"]


def zscore(m, X):
    return zall(m, X).max(axis=1)


# ── 비교용: Isolation Forest ──
def iffit(X):
    return IsolationForest(n_estimators=200, max_samples=min(256, len(X)), random_state=SEED).fit(np.asarray(X))


def ifscore(m, X):
    return -m.score_samples(np.asarray(X))


def groups_of(rows):
    people = sorted({r["participant"] for r in rows})
    if len(people) >= 2:
        return {r["file"]: r["participant"] for r in rows}, "참가자 단위 (Leave-One-Participant-Out)", True
    order = np.random.default_rng(SEED).permutation(len(rows))
    return {rows[i]["file"]: f"묶음{k % 5 + 1}" for k, i in enumerate(order)}, "기록 5묶음 교차검증 (참가자 1명 — 사람 단위 검증은 아직 못 함)", False


def oof_threshold(train_rows, grp, fit, score):
    gs = sorted({grp[r["file"]] for r in train_rows})
    if len(gs) < 2:
        X = [r["x"] for r in train_rows]
        return float(np.percentile(score(fit(X), X), 95))
    oof = []
    for g in gs:
        tr = [r["x"] for r in train_rows if grp[r["file"]] != g]
        te = [r["x"] for r in train_rows if grp[r["file"]] == g]
        if len(tr) >= 3 and te:
            oof += list(score(fit(tr), te))
    return float(np.percentile(oof, 95))


def metrics(y, pred, s):
    y, pred = np.asarray(y), np.asarray(pred)
    tp, fp = int(((pred == 1) & (y == 1)).sum()), int(((pred == 1) & (y == 0)).sum())
    fn, tn = int(((pred == 0) & (y == 1)).sum()), int(((pred == 0) & (y == 0)).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    auc = float(roc_auc_score(y, s)) if len(set(y.tolist())) == 2 else None
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(prec, 3), "recall": round(rec, 3), "f1": round(f1, 3),
            "fpr": round(fp / (fp + tn), 3) if fp + tn else None, "auc": round(auc, 3) if auc is not None else None}


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(max(0, c - h), 3), round(min(1, c + h), 3))


def evaluate(rows, grp, fit, score, keep=False):
    sm = [r for r in rows if r["label"] == "smooth"]
    y, pred, s, per = [], [], [], []
    for g in sorted({grp[r["file"]] for r in rows}):
        train = [r for r in sm if grp[r["file"]] != g]
        test = [r for r in rows if grp[r["file"]] == g]
        if len(train) < 4 or not test:
            continue
        m = fit([r["x"] for r in train])
        thr = oof_threshold(train, grp, fit, score)
        sc = score(m, [r["x"] for r in test])
        yy = [1 if r["label"] == "rough" else 0 for r in test]
        pp = [1 if v > thr else 0 for v in sc]
        y += yy; pred += pp; s += list(sc)
        if keep:
            for r, v, p_ in zip(test, sc, pp):
                r["score"], r["flag"], r["thr"] = float(v), p_, thr
        per.append({"group": g, "n": len(test), "threshold": round(thr, 3), **metrics(yy, pp, sc)})
    return metrics(y, pred, s), per


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(ROOT, "ai", "phone_data"))
    ap.add_argument("--out", default=ROOT, help="결과를 쓸 폴더 (기본: 프로젝트)")
    a = ap.parse_args()
    rows = load(a.data)
    sm = [r for r in rows if r["label"] == "smooth"]
    ro = [r for r in rows if r["label"] == "rough"]
    print(f"기록 {len(rows)}개 (부드럽게 {len(sm)} · 거칠게 {len(ro)}) · 참가자 {sorted({r['participant'] for r in rows})}")
    if len(sm) < 6 or len(ro) < 3:
        sys.exit("기록이 부족해요: 부드럽게 6개 이상, 거칠게 3개 이상 필요해요 (권장: 참가자마다 각각 10개)")

    grp, scheme, by_person = groups_of(rows)
    m, per = evaluate(rows, grp, zfit, zscore, keep=True)
    m_if, _ = evaluate(rows, grp, iffit, ifscore)
    rec_ci, fpr_ci = wilson(m["tp"], m["tp"] + m["fn"]), wilson(m["fp"], m["fp"] + m["tn"])

    # 프로그램용 모델: '부드럽게' 전체로 기준을 잡는다
    base = zfit([r["x"] for r in sm])
    thr_all = oof_threshold(sm, grp, zfit, zscore)
    check = [{"features": r["f"], "score": float(zscore(base, [r["x"]])[0])} for r in (sm[:1] + ro[:1])]
    model = {"kind": "phone-sensor", "method": "zmax-log1p", "use": USE,
             "features": [{"name": n, "label": LABEL[n]} for n in USE], "courses": COURSES,
             "baseline": {"mean": base["mean"].tolist(), "std": base["std"].tolist()}, "threshold": thr_all, "zCut": 2.0,
             "trainedOn": {"smooth": len(sm), "participants": len({r["participant"] for r in sm}),
                           "at": dt.datetime.now().strftime("%Y-%m-%d %H:%M")}, "check": check}
    os.makedirs(os.path.join(a.out, "ai", "results"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "docs", "ai"), exist_ok=True)
    json.dump(model, open(os.path.join(a.out, "ai", "phone_model.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    zr = zall(base, [r["x"] for r in ro]).mean(axis=0).tolist()
    out = {"scheme": scheme, "by_person": by_person, "sessions": len(rows), "smooth": len(sm), "rough": len(ro),
           "participants": sorted({r["participant"] for r in rows}), "method": "숙련 기준 z 점수 (log, 최댓값)",
           "overall": m, "recall_ci95": rec_ci, "fpr_ci95": fpr_ci, "per_group": per, "iforest_comparison": m_if,
           "rough_mean_z": dict(zip(USE, [round(v, 1) for v in zr])), "model_threshold": round(thr_all, 3),
           "score_range": {"smooth_max": round(max(r["score"] for r in rows if r["label"] == "smooth"), 2),
                           "rough_min": round(min(r["score"] for r in rows if r["label"] == "rough"), 2)}}
    json.dump(out, open(os.path.join(a.out, "ai", "results", "phone_metrics.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    figures(rows, zr, a.out)
    report(out, rows, a.out)
    print(json.dumps({"z점수": m, "IF 비교": m_if, "점수 범위": out["score_range"]}, ensure_ascii=False))


def figures(rows, z, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    for name in ["Malgun Gothic", "AppleGothic", "NanumGothic", "Noto Sans CJK KR", "Noto Sans KR"]:
        if any(name in f.name for f in font_manager.fontManager.ttflist):
            plt.rcParams["font.family"] = name
            break
    plt.rcParams["axes.unicode_minus"] = False
    scored = [r for r in rows if "score" in r]
    fig, ax = plt.subplots(figsize=(7, 3.2), dpi=150)
    for k, (lab, col) in enumerate([("smooth", "#1F6F8B"), ("rough", "#C0392B")]):
        v = [r["score"] for r in scored if r["label"] == lab]
        jitter = np.random.default_rng(k).uniform(-0.15, 0.15, len(v))
        ax.scatter(v, np.full(len(v), k) + jitter, s=30, color=col, alpha=0.85, label=f"{LABEL_KO[lab]} ({len(v)}개)")
    thr = float(np.median([r["thr"] for r in scored]))
    ax.axvline(thr, color="#1B222C", ls="--", lw=1)
    ts = [r["thr"] for r in scored]
    ax.text(thr, 1.45, f" 판단 기준 z = {thr:.1f} (중앙값 · 묶음마다 {min(ts):.1f}~{max(ts):.1f})", fontsize=8, va="bottom")
    ax.set_xscale("symlog", linthresh=2)
    ticks = [t for t in [-2, 0, 2, 5, 10, 20, 50, 100] if t <= max(r["score"] for r in scored) * 1.3]
    ax.set_xticks(ticks, [str(t) for t in ticks])
    ax.set_yticks([0, 1], [LABEL_KO["smooth"], LABEL_KO["rough"]])
    ax.set_ylim(-0.5, 1.7)
    ax.set_xlabel("이상 점수 = '부드럽게' 평균에서 몇 표준편차 벗어났나 (z, 처음 보는 기록 기준)")
    for sp in ["top", "right"]:
        ax.spines[sp].set_visible(False)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "docs", "ai", "phone_scores.png"))
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 2.8), dpi=150)
    labels = [LABEL[n].split(" (")[0] for n in USE]
    ax.barh(labels[::-1], z[::-1], color=["#C0392B" if v >= 2 else "#8A93A0" for v in z[::-1]])
    ax.axvline(2, color="#1B222C", ls="--", lw=1)
    ax.set_xlabel("'거칠게' 평균이 '부드럽게' 기준보다 몇 표준편차 큰가 (z, log 기준)")
    for sp in ["top", "right"]:
        ax.spines[sp].set_visible(False)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "docs", "ai", "phone_feature_z.png"))
    plt.close(fig)


def report(o, rows, out):
    m, mi = o["overall"], o["iforest_comparison"]
    per = "\n".join(f"| {p['group']} | {p['n']} | {p['threshold']} | {p['recall']} | {p['fpr']} |" for p in o["per_group"])
    zs = sorted(o["rough_mean_z"].items(), key=lambda kv: -kv[1])
    ztab = "\n".join(f"| {LABEL[k]} | {v} |" for k, v in zs)
    who = "" if o["by_person"] else "\n> ⚠ **참가자가 1명**이라 \"처음 보는 사람에게도 통하는가\"는 아직 증명하지 못했어요. 팀원 기록을 더하면 같은 명령으로 사람 단위 검증이 돼요.\n"
    md = f"""# 휴대폰 센서 실측 실험 — 실제 센서로도 AI가 거친 운전을 잡는가

> **실제 휴대폰 센서로 기록한 데이터**로 만든 결과예요 (시뮬레이션 아님). 분석: {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}
> 다시 만들기: `python ai/phone_experiment.py`
{who}
## 실험 방법

- 휴대폰을 카트·RC카에 고정하고 같은 코스를 20초씩 움직였어요. **부드럽게** = 천천히 출발·정지·회전, **거칠게** = 급출발·급정지·급회전.
- 휴대폰 가속도(중력 제외)와 회전 속도를 약 60Hz로 기록하고, 방향에 상관없게 **크기**만 써서 특징을 뽑았어요.
- **판정**: '부드럽게' 기록의 평균·표준편차를 기준으로, 새 기록이 몇 표준편차(z) 벗어났는지 봐요. 가속도·회전 속도 특징 5개를 log로 바꾼 뒤 z의 **최댓값**이 이상 점수예요.
- **평가**: {o['scheme']}. 뺀 쪽은 학습에 안 쓰고, 기준선은 '부드럽게' 기록을 처음 보는 기록처럼 매긴 점수의 95번째 백분위예요.
- 기록 {o['sessions']}개 (부드럽게 {o['smooth']} · 거칠게 {o['rough']}) · 참가자 {len(o['participants'])}명 ({', '.join(o['participants'])})

## 결과 — 처음 보는 기록으로 판정

| 방법 | 재현율 (거칠게를 잡음) | 오판율 (부드럽게를 거칠게로) | 정밀도 | F1 | AUC |
|---|---|---|---|---|---|
| **숙련 기준 z 점수 (채택)** | **{m['recall']}** (95% 구간 {o['recall_ci95'][0]}~{o['recall_ci95'][1]}) | **{m['fpr']}** (95% 구간 {o['fpr_ci95'][0]}~{o['fpr_ci95'][1]}) | {m['precision']} | {m['f1']} | {m['auc']} |
| Isolation Forest (비교) | {mi['recall']} | {mi['fpr']} | {mi['precision']} | {mi['f1']} | {mi['auc']} |

점수 범위: 부드럽게 최대 z = {o['score_range']['smooth_max']} · 거칠게 최소 z = {o['score_range']['rough_min']}

![이상 점수](ai/phone_scores.png)

| 뺀 쪽 | 기록 수 | 기준 z | 재현율 | 오판율 |
|---|---|---|---|---|
{per}

**왜 Isolation Forest가 아니라 z 점수인가**: 시뮬레이션에서는 학습 기록이 수백 개라 Isolation Forest가 잘 동작했지만, 실측은 '부드럽게' 기록이 10개 안팎이에요. 나무 깊이가 3단계 정도밖에 안 돼서 점수가 거칠고, 처음 보는 '부드럽게' 기록도 쉽게 튀어 보여요(오판율 {mi['fpr']}). 기록이 적을 때는 평균·표준편차 기준이 더 안정적이에요.

**판정에서 뺀 특징**: '급가속·급제동 횟수', '급회전 횟수'는 계속 세게 흔들리면 문턱을 넘은 채 유지돼서 한 번으로 세어져요. 실제로 '거칠게'가 '부드럽게'보다 횟수가 적게 나와서 판정에서 뺐어요 (화면에는 참고로 보여 줌).

## 어떤 행동이 달랐나 (거칠게 평균의 z)

| 특징 | z |
|---|---|
{ztab}

![특징별 z](ai/phone_feature_z.png)

## 한계

- '거칠게'는 참가자가 **일부러 연기한** 운전이고, 이번 기록은 차이가 매우 커요(가속도 상위 5%가 2~5g). 실제 미숙 운전은 이보다 훨씬 덜 거칠어서 더 어려워요 → 다음엔 '조금 서툴게' 기록도 모아야 해요.
- 카트·RC카는 지게차가 아니에요. 속도·포크 높이는 휴대폰으로 잴 수 없어서 뺐어요 — 실제 장비에서는 차량 센서(CAN·텔레매틱스)로 보완해야 해요.
- 기록 수가 적어서 위 95% 구간이 넓어요. 수치보다 "실제 센서에서도 같은 흐름(기록 → 판정 → 재교육 권고)이 동작한다"는 근거로 써야 해요.
"""
    open(os.path.join(out, "docs", "phone-experiment.md"), "w", encoding="utf-8").write(md)


if __name__ == "__main__":
    main()
