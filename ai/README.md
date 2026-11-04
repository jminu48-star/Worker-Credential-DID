# ai/ — 3단계 AI 숙련도 감지

| 파일 | 하는 일 |
|---|---|
| `simulate.py` | 숙련·미숙·위험 습관 작업자의 지게차 센서 기록 시뮬레이터 |
| `features.py` | 세션 → 특징 10개, 특징별 재교육 과정 |
| `train.py` | 학습·평가·그림·모델 내보내기 (한 번에) |
| `model.json` | 프로그램이 쓰는 모델 (Isolation Forest + 랜덤 포레스트 + 숙련자 기준값) |
| `demo_sessions.json` | 프로그램 시연용 세션 36개 (시험용 작업자 — 학습에 안 씀) |
| `results/metrics.json` | 논문 표에 쓸 수치 |
| `phone_features.py` | **실측 실험**: 휴대폰 센서 기록 → 특징 7개 (`scripts/phone-ai.js` 와 같은 계산) |
| `phone_experiment.py` | **실측 실험** 분석 — 참가자 단위 교차검증 → `docs/phone-experiment.md`, `phone_model.json` |
| `phone_data/` | 휴대폰 '🧪 센서 실험' 화면에서 올린 실제 기록 (분석 전까지는 없음) |

```bash
pip install -r ai/requirements.txt
python ai/train.py
```

프로그램(`npm start`)은 Python 없이 동작해요. `scripts/ai.js` 가 `model.json` 을 그대로 계산해요.
결과 정리: `docs/ai-results.md`

## 휴대폰 센서 실측 실험 (시뮬레이션이 아닌 실제 센서로 검증)

1. `start.bat` 실행 → 휴대폰 작업자 앱 → **🧪 센서 실험**
2. 휴대폰을 카트·RC카에 붙이고 20초씩 **부드럽게 / 거칠게** 기록 (참가자마다 각각 10번 목표)
3. `python ai/phone_experiment.py` (또는 `npm run sensor:analyze`) → `docs/phone-experiment.md` 에 결과표·그림
4. 분석 뒤에는 `ai/phone_model.json` 이 생겨서, 새 기록을 올리자마자 휴대폰에 AI 판정이 떠요 (시연용)
