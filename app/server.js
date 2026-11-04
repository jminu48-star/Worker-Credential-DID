// WorkerBadge 체험 프로그램 서버
// 실행: npm start  (내부적으로 npx hardhat run app/server.js)
// 컴퓨터 안에 가상 블록체인을 띄우고, 브라우저 화면(http://localhost:3000)에서 발급·장비 접근·공격을 해 볼 수 있다.
const hre = require("hardhat");
const { ethers } = hre;
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");
const crypto = require("crypto");
const { EquipmentVerifier, signChallenge } = require("../scripts/verifier");
const { createVC, verifyVC, vcHash } = require("../scripts/vc");
const { SkillModel } = require("../scripts/ai");
const phoneAI = require("../scripts/phone-ai");

// 3단계 AI: Python 으로 학습한 모델과 시연용 작업 세션(학습에 안 쓴 작업자의 것)
let AI = null;
try {
  AI = {
    model: SkillModel.load(),
    pool: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ai", "demo_sessions.json"), "utf8")).sessions,
    next: { skilled: 0, novice: 0, risky: 0 },
  };
} catch (e) { console.error("[AI 꺼짐] ai/model.json 을 읽지 못했어요:", e.message); }

const PORT = Number(process.env.PORT || 3000);

// 휴대폰에서 접속할 주소: 같은 와이파이의 PC 주소 (예: http://192.168.0.12:3000)
// 가상 어댑터(WSL·Hyper-V·VirtualBox 등) 주소는 휴대폰이 닿을 수 없어서 뒤로 미룬다
const VIRTUAL = /vethernet|virtual|vmware|vbox|wsl|hyper-v|loopback|bluetooth|docker|tailscale|zerotier|vpn/i;
function lanCandidates() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      let score = 0;
      if (/wi-?fi|wlan|wireless|무선/i.test(name)) score += 3;
      if (/ethernet|이더넷|en\d|eth\d/i.test(name) && !VIRTUAL.test(name)) score += 2;
      if (/^192\.168\./.test(a.address)) score += 2;
      if (/^172\.20\.10\./.test(a.address)) score += 3; // 아이폰 핫스팟
      if (/^10\./.test(a.address)) score += 1;
      if (VIRTUAL.test(name)) score -= 10;
      if (/^169\.254\./.test(a.address)) score -= 10; // 연결 안 된 어댑터
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
function lanIP() { return (lanCandidates()[0] || {}).address; }
// 주소는 요청 때마다 다시 찾는다 (프로그램을 켠 뒤에 와이파이·핫스팟에 연결해도 반영되게)
// 자동으로 고른 주소가 틀리면 관리자 화면에서 직접 입력할 수 있다 (data/settings.json 에 저장)
const SETTINGS_FILE = path.join(__dirname, "..", "data", "settings.json");
let manualBase = (() => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).phoneBase || ""; } catch { return ""; } })();
function publicBase() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  if (manualBase) return manualBase;
  const ip = lanIP();
  return `http://${ip || "localhost"}:${PORT}`;
}
const QR_ROTATE_MS = 30_000; // 장비 화면의 QR 은 30초마다 바뀐다 (사진 찍어 두고 나중에 쓰기 방지)
const DAY = 24 * 60 * 60;
const TYPES = ["지게차 면허", "크레인 면허", "위험물 취급", "안전교육 이수"];
const TYPE_KEYS = ["FORKLIFT", "CRANE", "HAZMAT", "SAFETY_EDU"];
const EQUIPMENT = [
  { id: "FL-001", type: "FORKLIFT", name: "지게차 1호기" },
  { id: "CR-001", type: "CRANE", name: "천장 크레인 1호기" },
  { id: "HZ-001", type: "HAZMAT", name: "위험물 저장소" },
];

let S; // 현재 상태 (배포·리셋 때 새로 만든다)

// ───────── 기록 저장 ─────────
// 가상 블록체인은 창을 닫으면 사라진다. 그래서 "무슨 일을 언제 했는지"(발급·정지·연장·시간 이동)를
// data/journal.json 에 적어 두고, 다시 켤 때 같은 시각에 같은 순서로 다시 실행해서 상태를 복원한다.
// 화면의 기록 목록은 data/events.json 에 그대로 저장한다.
const DATA_DIR = path.join(__dirname, "..", "data");
const JOURNAL_FILE = path.join(DATA_DIR, "journal.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const AI_FILE = path.join(DATA_DIR, "ai.json"); // AI 판단 기록 (체인 밖 — 원본 센서 데이터는 체인에 올리지 않는다)
const USAGE_FILE = path.join(DATA_DIR, "usage.json"); // 끝난 운용 기록 (누가·어떤 장비를·언제부터·얼마나)
const USAGE_CSV = path.join(DATA_DIR, "usage.csv");   // 같은 내용을 엑셀로 열 수 있게
const ACCESS_CSV = path.join(DATA_DIR, "access.csv"); // 모든 인증 시도 (허용·거부·사유·조회 시간) — 논문 측정용
const csvCell = (v) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function appendCSV(file, header, row) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "\ufeff" + header.join(",") + "\n"); // BOM: 엑셀에서 한글이 안 깨지게
  fs.appendFileSync(file, row.map(csvCell).join(",") + "\n");
}
const saveAI = () => saveJSON(AI_FILE, S.aiReviews);
const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const saveJSON = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
async function journal(op) {
  if (S.replaying) return;
  op.ts = await chainNow(); // 이 작업이 들어간 블록의 시각
  S.journal.push(op);
  saveJSON(JOURNAL_FILE, S.journal);
}

async function chainNow() { return (await ethers.provider.getBlock("latest")).timestamp; }

// 예전 시연 이름 → 팀원 이름 (저장된 기록 호환)
const OLD_KEYS = { cheolsu: "minwoo", minsu: "gyuseong", younghee: "taegyu", jiwon: "inseo" };
const OLD_NAMES = [["철수", "민우"], ["민수", "규성"], ["영희", "태규"], ["지원", "인서"]];
const renameText = (t) => OLD_NAMES.reduce((x, [a, b]) => x.split(a + "에게").join(b + "에게").split(a + "의").join(b + "의").split(a + " ").join(b + " ").split(a + "(").join(b + "(").split(a + "은").join(b + "은").split(a + "이").join(b + "이").split(a + "가").join(b + "가").split(a + "·").join(b + "·"), String(t));

async function setup(fresh = false) {
  const signers = await ethers.getSigners();
  const issuer = signers[0];
  // 시연용 작업자: 처음엔 가상 체인의 테스트 계정을 쓴다 (통합 화면에서 대신 서명·공격 시뮬레이션용).
  // 휴대폰으로 등록하면 그 작업자는 "휴대폰 지갑" 주소로 바뀌고, 서버는 더 이상 대신 서명할 수 없다 (개인 키는 휴대폰에만).
  const workers = [
    { key: "minwoo", name: "민우", signer: signers[1] },
    { key: "gyuseong", name: "규성", signer: signers[2] },
    { key: "taegyu", name: "태규", signer: signers[3] },
    { key: "inseo", name: "인서", signer: signers[4] },
  ].map((w) => ({ ...w, address: w.signer.address, phone: false }));
  const badge = await (await ethers.getContractFactory("WorkerBadge")).deploy(issuer.address);
  await badge.waitForDeployment();
  const verifiers = Object.fromEntries(EQUIPMENT.map((e) => [e.id, new EquipmentVerifier(badge, e.id, e.type)]));
  const attacker = signers[9]; // VC 위조 시뮬레이션용 — 발급 권한 없는 계정
  const { chainId } = await ethers.provider.getNetwork();
  S = { issuer, attacker, chainId, workers, badge, verifiers, vcs: {}, events: [], aiReviews: [], qr: {}, eqLast: {}, lastSig: null, journal: [], replaying: false,
    sessions: {}, usage: [], eqStyle: {}, wallets: new Map(), pair: newPairCode(), regs: [] };

  const saved = fresh ? [] : loadJSON(JOURNAL_FILE, []);
  if (saved.length) {
    // ── 이전 기록 복원: 같은 시각·같은 순서로 다시 실행 ──
    S.replaying = true;
    let failed = 0;
    for (const op of saved) {
      try {
        const now = await chainNow();
        if (op.ts > now) await hre.network.provider.send("evm_setNextBlockTimestamp", [op.ts]);
        if (OLD_KEYS[op.worker]) op.worker = OLD_KEYS[op.worker]; // 예전 이름 기록 호환
        if (op.op === "bind" && OLD_KEYS[op.key]) op.key = OLD_KEYS[op.key];
        if (op.op === "issue") await issue(op.worker, op.type, op.expiresAt, op.vc);
        else if (op.op === "addWorker") addWorker(op.key, op.name, op.address, op.faceId);
        else if (op.op === "bind") bindWorker(op.worker, op.address, op.faceId);
        else if (op.op === "face") W(op.worker).faceId = cleanFid(op.faceId);
        else if (op.op === "revoke") await revokeBadge(op.tokenId, op.reason);
        else if (op.op === "renew") await renewBadge(op.tokenId, op.newExpiresAt);
        else if (op.op === "time") { if (op.ts > now) await hre.network.provider.send("evm_mine"); }
      } catch (e) { failed++; console.error("[복원 실패]", op, e?.shortMessage || e?.message); }
    }
    S.journal = saved;
    S.events = loadJSON(EVENTS_FILE, []).map((e) => ({ ...e, text: renameText(e.text) }));
    const legacy = (r) => { if (OLD_KEYS[r.worker]) { r.worker = OLD_KEYS[r.worker]; const w = S.workers.find((x) => x.key === r.worker); if (w) r.workerName = w.name; } return r; };
    S.aiReviews = loadJSON(AI_FILE, []).map(legacy);
    S.usage = loadJSON(USAGE_FILE, []).map(legacy);
    S.replaying = false;
    // 창을 닫아 둔 동안 흐른 실제 시간도 반영 (그 사이 만료된 배지는 만료로 보임)
    const realNow = Math.floor(Date.now() / 1000);
    if (realNow > (await chainNow())) {
      await hre.network.provider.send("evm_setNextBlockTimestamp", [realNow]);
      await hre.network.provider.send("evm_mine");
    }
    addEvent("system", `이전 기록 ${saved.length - failed}건을 복원했어요${failed ? ` (실패 ${failed}건)` : ""}`);
    return;
  }

  // ── 처음 시작: 저장된 기록 없음 ──
  saveJSON(JOURNAL_FILE, []);
  saveJSON(EVENTS_FILE, []);
  saveJSON(AI_FILE, []);
  saveJSON(USAGE_FILE, []);
  for (const f of [USAGE_CSV, ACCESS_CSV]) { try { fs.unlinkSync(f); } catch {} }
  addEvent("system", `가상 블록체인에 WorkerBadge 컨트랙트 배포 (${await badge.getAddress()})`);
  // 시작 상태 — demo 와 같은 인물 설정
  const t = await chainNow();
  await issue("minwoo", 0, t + 365 * DAY);
  await issue("minwoo", 3, t + 365 * DAY);
  await issue("taegyu", 0, t + 3 * DAY);
  await issue("taegyu", 3, t + 365 * DAY);
  await issue("inseo", 0, t + 365 * DAY);
}

function addEvent(kind, text, extra = {}) {
  if (S.replaying) return;
  S.events.unshift({ id: S.events.length + 1, at: new Date().toISOString(), kind, text, ...extra });
  if (S.events.length > 300) S.events.pop();
  saveJSON(EVENTS_FILE, S.events);
}
const W = (key) => { const w = S.workers.find((x) => x.key === key); if (!w) throw new Error("모르는 작업자"); return w; };
const byAddr = (addr) => S.workers.find((w) => w.address.toLowerCase() === String(addr).toLowerCase());
const nameOf = (addr) => (byAddr(addr) || {}).name || "알 수 없음";
// 서버가 대신 서명하는 시뮬레이션은 테스트 계정 작업자만 가능 (휴대폰 지갑은 키가 휴대폰에만 있다)
const signerOf = (w) => { if (!w.signer) throw new Error(`${w.name}은(는) 휴대폰 지갑이라 이 화면에서 대신 서명할 수 없어요 — 개인 키가 휴대폰에만 있어요. 휴대폰으로 QR 인증해 주세요`); return w.signer; };
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "");
const fmtDate = (sec) => new Date(Number(sec) * 1000).toLocaleDateString("ko-KR");

function friendlyError(e) {
  const m = e?.shortMessage || e?.message || String(e);
  const map = [
    ["AlreadyHasActiveBadge", "이미 같은 종류의 유효한 배지가 있어요. 기한을 늘리려면 '연장'을 쓰세요."],
    ["InvalidExpiry", "만료일이 잘못됐어요 (지난 날짜이거나 기존보다 빨라요)."],
    ["BadgeAlreadyRevoked", "이미 정지된 배지예요."],
    ["BadgeNotFound", "없는 배지 번호예요."],
    ["Soulbound", "배지는 다른 사람에게 넘길 수 없어요 (Soulbound)."],
    ["AccessControlUnauthorizedAccount", "권한이 없는 계정이에요."],
  ];
  for (const [k, v] of map) if (m.includes(k)) return { code: k, message: v };
  return { code: "Error", message: m };
}

// VC 에 들어가는 "내용" — 체인에는 안 올라가고 작업자가 파일로 보관 (예시 값)
const ISSUING_BODY = ["자격 발급기관(예시)", "자격 발급기관(예시)", "자격 발급기관(예시)", "사내 안전교육팀(예시)"];
function claimsFor(w, type, extra) {
  const certSeq = Object.keys(S.vcs).length + 1;
  return {
    name: w.name,
    certificateNo: `${["FL", "CR", "HZ", "SE"][type]}-${new Date().getFullYear()}-${String(certSeq).padStart(4, "0")}`,
    issuingBody: ISSUING_BODY[type],
    ...(type === 3 ? { trainingHours: 16 } : {}),
    ...(extra || {}),
  };
}

async function issue(workerKey, type, expiresAt, savedVc, extraClaims) {
  const w = W(workerKey);
  // ① 발급기관이 VC(내용+서명)를 만든다 → ② 그 지문(vcHash)만 체인에 올린다
  const vc = savedVc || await createVC({
    issuerSigner: S.issuer, chainId: S.chainId, contract: await S.badge.getAddress(), worker: w.address,
    badgeType: type, validFrom: await chainNow(), validUntil: expiresAt, claims: claimsFor(w, type, extraClaims),
  });
  const r = await (await S.badge.issue(w.address, type, expiresAt, vcHash(vc))).wait();
  const id = Number(await S.badge.badgeOf(w.address, type));
  S.vcs[id] = vc;
  addEvent("issue", `${w.name}에게 '${TYPES[type]}' 배지 #${id} 발급 + VC 전달 (만료 ${fmtDate(expiresAt)})`, { gas: Number(r.gasUsed), tx: r.hash });
  await journal({ op: "issue", worker: workerKey, type, expiresAt, vc });
  return { tokenId: id, gas: Number(r.gasUsed) };
}

// ───────── VC 보기·검증·위조 체험 ─────────
function vcOf(tokenId) {
  const vc = S.vcs[tokenId];
  if (!vc) throw new Error("이 배지의 VC가 없어요 (이전 버전에서 만든 기록일 수 있어요)");
  return vc;
}
async function checkVC(vc, label) {
  const r = await verifyVC(vc, S.badge);
  const bad = r.steps.filter((s) => !s.ok).map((s) => s.label);
  addEvent(r.ok ? "allow" : "deny", `VC 검증${label ? ` (${label})` : ""}: ${r.ok ? "통과" : "실패 — " + bad.join(", ")}`);
  return { ...r, vc };
}
async function forgeVC(tokenId, kind) {
  const vc = structuredClone(vcOf(tokenId));
  if (kind === "name") { vc.credentialSubject.name = vc.credentialSubject.name + "(위조)"; return checkVC(vc, "이름 바꿔치기"); }
  if (kind === "expiry") {
    const d = new Date(vc.validUntil); d.setFullYear(d.getFullYear() + 10);
    vc.validUntil = d.toISOString().replace(".000Z", "Z"); return checkVC(vc, "만료일 10년 늘리기");
  }
  if (kind === "issuer") {
    // 발급 권한 없는 사람이 똑같은 내용으로 VC를 만들어 자기 키로 서명
    const fake = await createVC({
      issuerSigner: S.attacker, chainId: S.chainId, contract: await S.badge.getAddress(),
      worker: ethers.getAddress(vc.credentialSubject.id.split(":").pop()), badgeType: TYPE_KEYS.indexOf(vc.credentialSubject.badgeType),
      validFrom: Math.floor(new Date(vc.validFrom) / 1000), validUntil: Math.floor(new Date(vc.validUntil) / 1000),
      claims: (({ id, badgeType, badgeName, ...c }) => c)(vc.credentialSubject),
    });
    return checkVC(fake, "가짜 발급기관 서명");
  }
  throw new Error("모르는 위조 방법");
}

async function revokeBadge(tokenId, reason) {
  const r = await (await S.badge.revoke(tokenId, reason)).wait();
  addEvent("revoke", `배지 #${tokenId} 정지 — 사유: ${reason}`, { gas: Number(r.gasUsed) });
  await journal({ op: "revoke", tokenId, reason });
  return { gas: Number(r.gasUsed) };
}

async function renewBadge(tokenId, newExpiresAt, days) {
  const r = await (await S.badge.renew(tokenId, newExpiresAt)).wait();
  addEvent("renew", `배지 #${tokenId} ${days ? days + "일 " : ""}연장 (만료 ${fmtDate(newExpiresAt)})`, { gas: Number(r.gasUsed) });
  await journal({ op: "renew", tokenId, newExpiresAt });
  return { gas: Number(r.gasUsed) };
}

async function listBadges() {
  const logs = await S.badge.queryFilter(S.badge.filters.BadgeIssued());
  const now = await chainNow();
  const out = [];
  for (const l of logs) {
    const id = Number(l.args.tokenId);
    const b = await S.badge.badges(id);
    const owner = await S.badge.ownerOf(id);
    const current = Number(await S.badge.badgeOf(owner, b.badgeType)) === id;
    const expired = Number(b.expiresAt) <= now;
    out.push({
      tokenId: id, worker: nameOf(owner), workerKey: (byAddr(owner) || {}).key,
      type: Number(b.badgeType), typeName: TYPES[Number(b.badgeType)], expiresAt: Number(b.expiresAt),
      revoked: b.revoked, expired, valid: !b.revoked && !expired, current, vcHash: short(b.vcHash), hasVc: !!S.vcs[id],
      daysLeft: Math.floor((Number(b.expiresAt) - now) / DAY),
    });
  }
  return out.sort((a, b) => b.tokenId - a.tokenId);
}

async function access(workerKey, equipmentId, signerKey) {
  const eq = EQUIPMENT.find((e) => e.id === equipmentId);
  if (!eq) throw new Error("모르는 장비");
  const claimed = W(workerKey);
  const signer = signerKey ? W(signerKey) : claimed; // 공격: 다른 사람이 서명
  const v = S.verifiers[equipmentId];

  const { nonce, typedData } = await v.createChallenge();         // ① challenge
  const signature = await signChallenge(signerOf(signer), typedData); // ② 지갑 서명 (EIP-712)
  const res = await v.verify(nonce, signature);                  // ③~⑤ 검증·조회·로그
  S.lastSig = { equipmentId, nonce, signature, workerKey: signer.key };

  const reqs = (await S.badge.requirementsOf(ethers.id(eq.type))).map(Number);
  const checks = [];
  if (res.worker) for (const t of reqs) checks.push({ type: t, typeName: TYPES[t], ok: await S.badge.hasValidBadge(res.worker, t) });

  const who = res.worker ? nameOf(res.worker) : "-";
  const label = signerKey && signerKey !== workerKey ? `${claimed.name}(이)라고 주장, 실제 서명자 ${who}` : who;
  addEvent(res.allowed ? "allow" : "deny", `${eq.name}: ${label} → ${res.allowed ? "시동 허용" : "시동 거부"} (${res.reason})`);
  return {
    equipment: eq, claimed: claimed.name, allowed: res.allowed, reason: res.reason,
    steps: { nonce, message: `EIP-712 · 장비 ${equipmentId} · 만료 ${new Date(typedData.message.expiresAt * 1000).toLocaleTimeString("ko-KR")}`, signature: short(signature), recovered: res.worker, recoveredName: who, lookupMs: res.lookupMs },
    checks,
  };
}

// ───────── 3분할: 장비 화면의 바뀌는 QR → 휴대폰 서명 → 체인 조회 (발급기관은 매번 끼지 않는다) ─────────
function EQ(id) { const e = EQUIPMENT.find((x) => x.id === id); if (!e) throw new Error("모르는 장비"); return e; }
async function currentQR(eqId) {
  EQ(eqId);
  const now = Date.now();
  let q = S.qr[eqId];
  if (!q || q.used || now - q.at > QR_ROTATE_MS) {
    const { nonce } = await S.verifiers[eqId].createChallenge(); // 1분 동안 유효, 한 번 쓰면 폐기
    q = S.qr[eqId] = { nonce, at: now, used: false };
  }
  return { nonce: q.nonce, url: `${publicBase()}/worker#s=${eqId}.${q.nonce}`, rotatesInMs: QR_ROTATE_MS - (now - q.at) };
}
// 휴대폰이 보낸 얼굴 확인 결과 (값만 — 얼굴 사진·특징값은 오지 않는다). 휴대폰 지갑 작업자는 이게 있어야 시동
const faceReport = (f) => f && typeof f === "object"
  ? { ok: f.ok === true, live: f.live === true, fid: cleanFid(f.fid), dist: Number.isFinite(+f.dist) ? Math.round(+f.dist * 1000) / 1000 : null } : null;
async function accessBySignature(eqId, nonce, signature, faceIn) {
  const eq = EQ(eqId);
  if (S.qr[eqId] && S.qr[eqId].nonce === nonce) S.qr[eqId].used = true; // 쓰인 QR 은 바로 새것으로
  const res = await S.verifiers[eqId].verify(String(nonce), String(signature));
  const reqs = (await S.badge.requirementsOf(ethers.id(eq.type))).map(Number);
  const checks = [];
  if (res.worker) for (const t of reqs) checks.push({ type: t, typeName: TYPES[t], ok: await S.badge.hasValidBadge(res.worker, t) });
  const who = res.worker ? nameOf(res.worker) : "-";
  const wk = res.worker ? (byAddr(res.worker) || {}).key : null;
  const ai = wk ? S.aiReviews.find((r) => r.worker === wk && r.status === "pending") : null; // 참고 표시만 (시동은 막지 않음)
  let allowed = res.allowed, reason = res.reason, session = null, busy = null;
  const face = faceReport(faceIn), w0 = wk ? W(wk) : null;
  if (allowed && w0 && w0.phone && !(face && face.ok && face.live)) {
    allowed = false;
    reason = !face ? "휴대폰 얼굴 확인 결과가 없어요 — 작업자 앱에서 얼굴 확인 후 서명하세요" : !face.live ? "고개 돌림(사진이 아닌 실제 사람) 확인이 안 됐어요" : "등록된 얼굴과 달라요";
  } else if (allowed && w0 && w0.phone && face.fid !== w0.faceId) {
    allowed = false;
    reason = w0.faceId ? "발급기관이 승인한 얼굴 등록본이 아니에요 (휴대폰에서 얼굴을 새로 등록함) — 발급기관 승인 필요" : "얼굴 등록이 아직 승인되지 않았어요 — 발급기관 승인 필요";
  }
  // 한 장비는 한 사람만: 다른 사람이 쓰는 중이면 자격이 있어도 보류
  const active = S.sessions[eqId];
  if (allowed && active && active.worker !== wk) {
    allowed = false; busy = publicSession(active);
    reason = `${active.workerName} 님이 ${new Date(active.startedAt).toLocaleTimeString("ko-KR")}부터 사용 중 — 작업이 끝난 뒤 다시 인증하세요`;
  } else if (allowed) {
    session = active && active.worker === wk ? active : (S.sessions[eqId] = { id: crypto.randomBytes(5).toString("hex"), eq: eqId, equipment: eq.name, worker: wk, workerName: who, startedAt: Date.now() });
  }
  const missing = checks.filter((c) => !c.ok).map((c) => c.typeName);
  const result = { at: Date.now(), equipment: eq, allowed, reason, worker: res.worker, workerName: who, checks, missing,
    advice: missing.length ? `발급기관(관리자)에게 '${missing.join("', '")}' 배지 발급이나 재교육을 요청하세요` : null,
    lookupMs: res.lookupMs, face, aiPending: ai ? { id: ai.id, courses: ai.courses } : null, busy, session: publicSession(session) };
  S.eqLast[eqId] = result;
  addEvent(allowed ? "allow" : "deny", `[휴대폰 QR] ${eq.name}: ${who} → ${allowed ? "시동 허용 · 운용 시작" : busy ? "보류 (다른 작업자 사용 중)" : "시동 거부"} (${reason})${face ? ` · 얼굴 ${face.ok && face.live ? "일치" : "불일치"}${face.dist != null ? " " + face.dist : ""}` : ""}`);
  appendCSV(ACCESS_CSV, ["time", "equipmentId", "equipment", "worker", "name", "result", "reason", "lookupMs"],
    [new Date().toISOString(), eqId, eq.name, res.worker || "", who, allowed ? "ALLOW" : busy ? "BUSY" : "DENY", reason, res.lookupMs != null ? res.lookupMs.toFixed(2) : ""]);
  return result;
}

// ───────── 운용 세션: 인증 → 사용 중 → 작업 종료(휴대폰) / 작업자 이탈(좌석 센서) → 기록 + AI 자동 분석 ─────────
const publicSession = (x) => x && { id: x.id, eq: x.eq, equipment: x.equipment, worker: x.worker, workerName: x.workerName, startedAt: x.startedAt };
const BY_KO = { phone: "휴대폰에서 작업 종료", equipment: "장비 화면에서 종료", seat: "작업자 이탈 (좌석 센서)", admin: "관리자가 종료" };
// 작업 중 휴대폰이 기록한 실제 센서 값으로 AI 분석 (ai/phone_model.json — python ai/phone_experiment.py 로 만듦)
async function aiAnalyzePhone(workerKey, f, pm, extra = {}) {
  const w = W(workerKey);
  const r = pm.analyze(f);
  const review = {
    id: (S.aiReviews.at(0)?.id || 0) + 1, at: await chainNow(), worker: workerKey, workerName: w.name,
    input: "phone-sensor", anomaly: r.anomaly, threshold: r.threshold, flagged: r.flagged,
    type: null, typeKo: "휴대폰 센서 (유형 분류 없음)", proba: {}, recommendations: r.recommendations, courses: r.courses,
    status: r.flagged ? "pending" : "ok", source: "auto", sensorSeconds: Math.round(f.seconds), method: r.method, ...extra,
  };
  S.aiReviews.unshift(review);
  if (S.aiReviews.length > 100) S.aiReviews.pop();
  saveAI();
  addEvent(r.flagged ? "ai" : "allow", `[작업 종료 후 자동 · 📡 휴대폰 센서 ${review.sensorSeconds}초] ${extra.equipment || ""} AI 분석: ${w.name} → ${r.flagged
    ? `재교육 권고 (z ${r.anomaly.toFixed(1)} > 기준 ${r.threshold.toFixed(1)}) · 추천 ${r.courses.join(", ") || "-"}`
    : `정상 범위 (z ${r.anomaly.toFixed(1)}, 기준 ${r.threshold.toFixed(1)})`}`);
  return review;
}
function sensorOf(sensor) {
  if (!sensor || !Array.isArray(sensor.samples) || sensor.samples.length < 100) return null;
  const samples = sensor.samples.slice(-40000).map((r) => (Array.isArray(r) ? r.slice(0, 7).map(Number) : []));
  try { const f = phoneAI.features(samples); return f.seconds >= 8 ? { f, samples } : { short: true, seconds: f.seconds }; } catch { return null; }
}

async function endSession(eqId, by, sensor = null) {
  const eq = EQ(eqId);
  const x = S.sessions[eqId];
  if (!x) throw new Error("지금 이 장비를 쓰는 사람이 없어요");
  delete S.sessions[eqId];
  if (S.qr[eqId]) S.qr[eqId].used = true; // 끝나면 새 QR
  const endedAt = Date.now();
  const rec = { id: x.id, eq: eqId, equipment: eq.name, worker: x.worker, workerName: x.workerName, startedAt: x.startedAt, endedAt,
    durationSec: Math.max(1, Math.round((endedAt - x.startedAt) / 1000)), endedBy: by, aiReviewId: null };
  // 이번 작업의 센서 기록을 AI 가 자동으로 분석
  //   휴대폰이 작업 중 센서를 기록해 보냈고 실측 모델이 있으면 → 그 실제 기록으로
  //   아니면 → 장비 화면에서 고른 운전 방식의 시험용(시뮬레이션) 기록으로
  let review = null, aiSource = null, aiNote = null;
  const pm = currentPhoneModel(), sx = sensorOf(sensor);
  if (sx && sx.f && pm) {
    review = await aiAnalyzePhone(x.worker, sx.f, pm, { usageId: rec.id, equipment: eq.name, durationSec: rec.durationSec });
    rec.aiReviewId = review.id; rec.aiFlagged = review.flagged; aiSource = "phone";
    try { // 실제 작업 센서 기록도 남겨 둔다 (나중에 학습·검증용)
      const dir = path.join(DATA_DIR, "session-sensor"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify({ usageId: rec.id, worker: x.worker, name: x.workerName, equipment: eq.name,
        startedAt: x.startedAt, endedAt, review: review.id, source: String(sensor.source || ""), samples: sx.samples }));
    } catch {}
  } else if (AI) {
    aiSource = "simulated";
    aiNote = !sensor ? "휴대폰 센서 기록이 없어서 장비 화면에서 고른 시험용 기록으로 분석했어요"
      : !pm ? "휴대폰 센서 판정 모델이 아직 없어서(python ai/phone_experiment.py) 시험용 기록으로 분석했어요"
      : sx && sx.short ? `센서 기록이 ${sx.seconds.toFixed(0)}초뿐이라(8초 이상 필요) 시험용 기록으로 분석했어요` : "센서 기록을 읽지 못해 시험용 기록으로 분석했어요";
    const style = S.eqStyle[eqId] || "skilled";
    review = (await aiAnalyze(x.worker, style, { source: "auto", usageId: rec.id, equipment: eq.name, durationSec: rec.durationSec })).review;
    rec.aiReviewId = review.id; rec.aiFlagged = review.flagged;
  }
  rec.aiSource = aiSource;
  S.usage.unshift(rec);
  if (S.usage.length > 300) S.usage.pop();
  saveJSON(USAGE_FILE, S.usage);
  appendCSV(USAGE_CSV, ["equipmentId", "equipment", "worker", "name", "startedAt", "endedAt", "durationSec", "endedBy", "aiReviewId", "aiResult"],
    [eqId, eq.name, W(x.worker).address, x.workerName, new Date(x.startedAt).toISOString(), new Date(endedAt).toISOString(), rec.durationSec, by,
      review ? review.id : "", review ? (review.flagged ? "재교육 권고" : "정상") : ""]);
  addEvent(by === "seat" ? "deny" : "system", `${eq.name}: ${x.workerName} 운용 종료 (${Math.floor(rec.durationSec / 60)}분 ${rec.durationSec % 60}초, ${BY_KO[by] || by})`);
  S.eqLast[eqId] = { at: endedAt, ended: true, equipment: eq, workerName: x.workerName, durationSec: rec.durationSec, endedBy: by,
    ai: review && { id: review.id, flagged: review.flagged, anomaly: review.anomaly, courses: review.courses, source: aiSource } };
  return { usage: rec, aiSource, aiNote, review: review && { id: review.id, flagged: review.flagged, anomaly: review.anomaly, threshold: review.threshold,
    courses: review.courses, recommendations: review.recommendations, sensorSeconds: review.sensorSeconds || null } };
}

// ───────── 외부(휴대폰·인터넷) 접속 보호 ─────────
// 인터넷 주소(터널)나 와이파이로 들어온 요청은 "작업자용" 기능만 쓸 수 있다. 발급·정지·리셋 같은 관리 기능은 이 PC에서만.
const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
  && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
// 휴대폰 연결 코드: 관리자 화면에 보이는 6자리. 휴대폰이 등록을 요청하려면 이 코드를 넣어야 한다 (QR 주소만 알아서는 요청 불가)
function newPairCode() { return { code: String(crypto.randomInt(0, 1e6)).padStart(6, "0"), exp: Date.now() + 10 * 60_000 }; }
function pairCode() { if (Date.now() > S.pair.exp) S.pair = newPairCode(); return S.pair; }

// 연습용 지갑: Hardhat 가상 체인의 공개된 테스트 계정 키 (누구나 아는 값 — 실제로는 휴대폰 지갑 안에만 있어야 함)
// ───────── 작업자 등록: 휴대폰이 자기 지갑을 만들고 → 서명으로 "이 주소의 주인"임을 증명 → 발급기관이 본인 확인 후 승인 ─────────
// 서버는 작업자의 개인 키를 만들지도, 보지도 않는다. 휴대폰이 보내는 것은 주소와 서명뿐.
const REG_MESSAGE = (name, address, ts) => `WorkerBadge 작업자 등록\n이름: ${name}\n지갑 주소: ${address}\n시각: ${ts}`;
// faceId: 휴대폰이 얼굴을 등록할 때 만든 무작위 번호 (얼굴 자체가 아니라 "어느 등록본인지"만 가리킴).
// 발급기관이 승인한 faceId 와 다른 얼굴 등록본으로는 시동이 안 된다 → 휴대폰을 빌려 남의 얼굴로 바꿔 등록해도 소용없음
const cleanFid = (f) => (typeof f === "string" && /^[0-9a-f]{16}$/.test(f) ? f : null);
function addWorker(key, name, address, faceId = null) {
  if (byAddr(address)) throw new Error("이미 등록된 지갑이에요");
  const w = { key, name, address: ethers.getAddress(address), signer: null, phone: true, faceId: cleanFid(faceId) };
  S.workers.push(w);
  return w;
}
function bindWorker(key, address, faceId = null) {
  const w = W(key);
  if (byAddr(address)) throw new Error("이미 다른 작업자에 연결된 지갑이에요");
  w.address = ethers.getAddress(address); w.signer = null; w.phone = true; w.faceId = cleanFid(faceId);
  return w;
}
// 로그인 토큰은 8시간(한 근무 시간) 뒤 만료 — 휴대폰은 401 을 받으면 지갑 서명으로 자동 재로그인한다
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MIN || 480) * 60_000;
function issueToken(address) {
  const token = crypto.randomBytes(18).toString("hex");
  const now = Date.now();
  for (const [k, t] of S.wallets) if (now - t.at > TOKEN_TTL_MS) S.wallets.delete(k); // 만료된 토큰 청소
  S.wallets.set(token, { address: ethers.getAddress(address), at: now });
  return token;
}
// 연결 코드 대입 막기: 같은 IP 가 10분 안에 5번 틀리면 10분 차단, 전체가 10분 안에 30번 틀리면 휴대폰 등록 5분 잠금 + 코드 교체
const PAIR_FAILS = new Map(); // ip → [틀린 시각…]
let pairFailAll = [], pairLockUntil = 0;
function pairGuard(ip) {
  const now = Date.now(), win = 10 * 60_000;
  if (now < pairLockUntil) throw Object.assign(new Error(`연결 코드 시도가 너무 많아 휴대폰 등록을 잠시 막았어요 (${Math.ceil((pairLockUntil - now) / 60000)}분 뒤 다시)`), { status: 429 });
  const mine = (PAIR_FAILS.get(ip) || []).filter((t) => now - t < win);
  PAIR_FAILS.set(ip, mine);
  if (mine.length >= 5) throw Object.assign(new Error(`연결 코드를 5번 틀려서 ${Math.ceil((mine[0] + win - now) / 60000)}분 동안 막혔어요`), { status: 429 });
}
function pairFailed(ip) {
  const now = Date.now(), win = 10 * 60_000;
  PAIR_FAILS.get(ip).push(now);
  pairFailAll = pairFailAll.filter((t) => now - t < win); pairFailAll.push(now);
  if (PAIR_FAILS.get(ip).length === 5) addEvent("deny", `⚠ 연결 코드 5번 틀림 (${ip}) — 10분 차단`);
  if (pairFailAll.length >= 30) {
    pairLockUntil = now + 5 * 60_000; pairFailAll = []; S.pair = newPairCode();
    addEvent("deny", "⚠ 연결 코드 대입 공격 의심 (10분 안에 30번 틀림) — 휴대폰 등록 5분 잠금, 코드 교체");
  }
}
const clientIP = (req) => String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?");
async function registerRequest(b, local, ip = "?") {
  const name = String(b.name || "").trim().slice(0, 20);
  if (!ethers.isAddress(b.address)) throw new Error("지갑 주소 형식이 아니에요");
  const address = ethers.getAddress(b.address);
  const ts = Number(b.ts);
  if (!ts || Math.abs(Date.now() - ts) > 5 * 60_000) throw new Error("등록 요청 시각이 맞지 않아요. 휴대폰 시계를 확인하고 다시 시도하세요");
  let signer;
  try { signer = ethers.verifyMessage(REG_MESSAGE(name, address, ts), String(b.signature)); } catch { signer = null; }
  if (signer !== address) throw Object.assign(new Error("서명이 지갑 주소와 맞지 않아요 (그 지갑의 주인만 등록할 수 있어요)"), { status: 403 });
  const faceId = cleanFid(b.faceId);
  const known = byAddr(address);
  if (known) { // 이미 등록된 휴대폰 → 다시 로그인. 얼굴을 새로 등록했으면 발급기관 승인 요청을 만든다
    if (faceId && faceId !== known.faceId && !S.regs.some((r) => r.kind === "face" && r.address === address && r.faceId === faceId && r.status === "pending")) {
      for (const r of S.regs) if (r.kind === "face" && r.address === address && r.status === "pending") r.status = "replaced";
      const reg = { id: (S.regs.at(-1)?.id || 0) + 1, kind: "face", name: known.name, address, at: Date.now(), status: "pending", via: local ? "이 PC" : "휴대폰",
        face: true, faceId, worker: known.key, match: known.key, firstFace: !known.faceId };
      S.regs.push(reg);
      addEvent(known.faceId ? "deny" : "system", `${known.name} 휴대폰: ${known.faceId ? "얼굴 정보를 새로 등록함 — 다른 사람일 수 있어 발급기관 확인 필요" : "얼굴 등록"} → 승인 대기`);
    }
    return { token: issueToken(address), status: "approved", name: known.name };
  }
  if (!name) throw new Error("이름을 입력해 주세요");
  if (!local) {
    pairGuard(ip);
    const p = pairCode();
    const given = Buffer.from(String(b.code || "").trim().padEnd(6).slice(0, 6)), want = Buffer.from(p.code);
    if (!crypto.timingSafeEqual(given, want)) {
      pairFailed(ip);
      const left = 5 - PAIR_FAILS.get(ip).length;
      throw Object.assign(new Error(`연결 코드가 틀렸어요. PC 관리자 화면의 6자리 코드를 넣어 주세요${left > 0 ? ` (남은 시도 ${left}번)` : ""}`), { status: 403 });
    }
    S.pair = newPairCode(); // 한 번 쓴 코드는 바로 바뀐다
  }
  let reg = S.regs.find((r) => r.address === address && r.status === "pending");
  if (reg && faceId && reg.faceId !== faceId) { reg.faceId = faceId; reg.face = true; }
  if (!reg) {
    reg = { id: (S.regs.at(-1)?.id || 0) + 1, name, address, at: Date.now(), status: "pending", via: local ? "이 PC" : "휴대폰",
      face: !!faceId, faceId, // 휴대폰에 얼굴을 등록했는지 (얼굴 데이터는 휴대폰에만 있고 서버로 오지 않는다)
      match: (S.workers.find((w) => w.name === name) || {}).key || null };
    S.regs.push(reg);
    addEvent("system", `작업자 등록 요청: ${name} (${address.slice(0, 6)}…${address.slice(-4)}, ${reg.via}) — 발급기관 확인 필요`);
  }
  return { token: issueToken(address), status: "pending", name };
}
async function registerDecide(id, action, workerKey) {
  const reg = S.regs.find((r) => r.id === Number(id));
  if (!reg || reg.status !== "pending") throw new Error("처리할 등록 요청이 없어요");
  if (action === "reject") { reg.status = "rejected"; addEvent("deny", `${reg.kind === "face" ? "얼굴 등록" : "작업자 등록"} 거절: ${reg.name}`); return { reg }; }
  if (action === "face") { // 이미 등록된 휴대폰의 얼굴 등록본 승인
    const w = W(reg.worker);
    if (w.address !== reg.address) throw new Error("그 휴대폰은 더 이상 이 작업자에 연결돼 있지 않아요");
    w.faceId = reg.faceId;
    await journal({ op: "face", worker: w.key, faceId: reg.faceId });
    reg.status = "approved";
    addEvent("system", `${w.name} 휴대폰 얼굴 등록 승인 — 이제 이 얼굴로만 시동 서명 가능`);
    return { reg };
  }
  if (action === "new") {
    let key = "w" + crypto.randomBytes(3).toString("hex");
    addWorker(key, reg.name, reg.address, reg.faceId);
    await journal({ op: "addWorker", key, name: reg.name, address: reg.address, faceId: reg.faceId });
    reg.status = "approved"; reg.worker = key;
    addEvent("system", `새 작업자 등록: ${reg.name} 📱 (${reg.address.slice(0, 6)}…${reg.address.slice(-4)}) — 이제 이 주소로 배지를 발급하세요`);
    return { reg };
  }
  if (action === "link") {
    // 기존 작업자의 지갑을 휴대폰 지갑으로 교체: 배지는 양도할 수 없으니(SBT) 옛 주소 배지를 정지하고 새 주소로 재발급
    const w = W(workerKey || reg.match);
    const old = w.address;
    const now = await chainNow();
    const keep = (await listBadges()).filter((x) => x.workerKey === w.key && x.current && x.valid);
    bindWorker(w.key, reg.address, reg.faceId);
    await journal({ op: "bind", worker: w.key, address: reg.address, faceId: reg.faceId });
    for (const x of keep) {
      await revokeBadge(x.tokenId, "휴대폰 지갑 교체 — 새 주소로 재발급");
      await issue(w.key, x.type, Math.max(x.expiresAt, now + DAY), null, { reissuedFrom: x.tokenId });
    }
    reg.status = "approved"; reg.worker = w.key;
    addEvent("system", `${w.name}의 지갑을 휴대폰 지갑으로 교체 (${old.slice(0, 6)}… → ${reg.address.slice(0, 6)}…) · 배지 ${keep.length}개 재발급`);
    return { reg, reissued: keep.length };
  }
  throw new Error("모르는 처리 방법이에요");
}
function walletOf(token) {
  const t = token && S.wallets.get(String(token));
  if (t && Date.now() - t.at > TOKEN_TTL_MS) S.wallets.delete(String(token));
  if (!t || Date.now() - t.at > TOKEN_TTL_MS) throw Object.assign(new Error("로그인이 만료됐어요"), { status: 401 });
  return t;
}
function workerOfToken(token) {
  const { address } = walletOf(token);
  const w = byAddr(address);
  if (!w) throw Object.assign(new Error("아직 발급기관이 등록을 승인하지 않았어요"), { status: 409 });
  return w;
}
async function me(token) {
  const { address } = walletOf(token);
  const w = byAddr(address);
  if (!w) {
    const reg = [...S.regs].reverse().find((r) => r.address === address);
    return { registered: false, address, status: reg ? reg.status : "none", name: reg && reg.name };
  }
  const worker = w.key;
  const badges = (await listBadges()).filter((b) => b.workerKey === worker);
  const active = Object.values(S.sessions).filter((x) => x.worker === worker).map(publicSession);
  const faceReq = S.regs.find((r) => r.kind === "face" && r.address === w.address && r.status === "pending");
  return { registered: true, worker, name: w.name, address: w.address, faceId: w.faceId || null, facePending: faceReq ? faceReq.faceId : null, types: TYPES, badges, active,
    ai: S.aiReviews.filter((r) => r.worker === worker).slice(0, 10), usage: S.usage.filter((u) => u.worker === worker).slice(0, 10),
    chainDate: new Date((await chainNow()) * 1000).toLocaleString("ko-KR") };
}

async function replay() {
  if (!S.lastSig) throw new Error("먼저 한 번 장비 접근을 시도해 주세요");
  const { equipmentId, nonce, signature, workerKey } = S.lastSig;
  const eq = EQUIPMENT.find((e) => e.id === equipmentId);
  const res = await S.verifiers[equipmentId].verify(nonce, signature);
  addEvent(res.allowed ? "allow" : "deny", `[공격] ${eq.name}: ${W(workerKey).name}의 지난 서명 재사용 → ${res.allowed ? "통과(!)" : "차단"} (${res.reason})`);
  return { equipment: eq, allowed: res.allowed, reason: res.reason, steps: { nonce, signature: short(signature) } };
}

async function transfer(fromKey, toKey, tokenId) {
  const from = W(fromKey), to = W(toKey);
  try {
    await (await S.badge.connect(signerOf(from)).transferFrom(from.address, to.address, tokenId)).wait();
    addEvent("deny", `[공격] 배지 #${tokenId} ${from.name}→${to.name} 전송 성공 (!)`);
    return { blocked: false };
  } catch (e) {
    const fe = friendlyError(e);
    addEvent("deny", `[공격] 배지 #${tokenId} ${from.name}→${to.name} 전송 시도 → 차단 (${fe.code})`);
    return { blocked: true, ...fe };
  }
}

// ───────── 3단계: AI 숙련도 판단 → 발급기관 확인 → 정지 → 재교육 → 재발급 ─────────
function aiReview(id) {
  const r = S.aiReviews.find((x) => x.id === Number(id));
  if (!r) throw new Error("없는 AI 판단 기록이에요");
  return r;
}
async function aiAnalyze(workerKey, style, extra = {}) {
  if (!AI) throw new Error("AI 모델이 없어요 (ai/model.json)");
  const w = W(workerKey);
  const list = AI.pool.filter((s) => s.style === style);
  if (!list.length) throw new Error("모르는 작업 방식이에요");
  const sess = list[AI.next[style]++ % list.length]; // 같은 세션이 연달아 나오지 않게 돌아가며
  const r = AI.model.analyze(sess.features);
  const review = {
    id: (S.aiReviews.at(0)?.id || 0) + 1, at: await chainNow(), worker: workerKey, workerName: w.name,
    sessionId: sess.id, input: style, anomaly: r.anomaly, threshold: r.threshold, flagged: r.flagged,
    type: r.type, typeKo: r.typeKo, proba: r.proba, recommendations: r.recommendations, courses: r.courses,
    status: r.flagged ? "pending" : "ok", source: "manual", ...extra,
  };
  S.aiReviews.unshift(review);
  if (S.aiReviews.length > 100) S.aiReviews.pop();
  saveAI();
  const pre = extra.source === "auto" ? `[작업 종료 후 자동] ${extra.equipment || ""} ` : "";
  addEvent(r.flagged ? "ai" : "allow", r.flagged
    ? `${pre}AI 분석: ${w.name} 작업 기록 → 재교육 권고 (이상 점수 ${r.anomaly.toFixed(3)} > 기준 ${r.threshold.toFixed(3)}) · 추천 ${r.courses.join(", ") || "-"}`
    : `${pre}AI 분석: ${w.name} 작업 기록 → 정상 범위 (이상 점수 ${r.anomaly.toFixed(3)})`);
  return { review, trace: sess.trace, hz: 2, features: sess.features, labels: AI.model.m.features };
}
async function aiDecide(id, action) {
  const r = aiReview(id);
  if (r.status === "ok") throw new Error("정상 범위로 나온 기록이라 처리할 게 없어요");
  if (r.status !== "pending") throw new Error("이미 처리한 권고예요");
  const w = W(r.worker);
  if (action === "dismiss") {
    r.status = "dismissed"; saveAI();
    addEvent("system", `AI 권고 #${r.id} (${w.name}) → 발급기관이 오판으로 처리 — 배지 유지`);
    return { review: r };
  }
  if (action !== "suspend") throw new Error("모르는 처리 방법이에요");
  // 국가 자격(면허)은 회사가 정지할 수 없으므로, 사내 안전교육 배지를 정지 → 모든 장비 시동이 막힌다
  const tokenId = Number(await S.badge.badgeOf(w.address, 3));
  if (!tokenId || !(await S.badge.isValid(tokenId))) throw new Error(`${w.name}에게 유효한 안전교육 배지가 없어요 (이미 장비를 쓸 수 없는 상태)`);
  const res = await revokeBadge(tokenId, `AI 재교육 권고 확인 (#${r.id}): ${r.courses.join(", ") || "숙련도 부족"}`);
  r.status = "suspended"; r.revokedTokenId = tokenId; saveAI();
  return { review: r, gas: res.gas };
}
async function aiRetrain(id) {
  const r = aiReview(id);
  if (r.status !== "suspended") throw new Error("정지된 권고만 재교육 처리할 수 있어요");
  const { tokenId, gas } = await issue(r.worker, 3, (await chainNow()) + 365 * DAY, null,
    { retrainingCourses: r.courses, aiReviewId: r.id });
  r.status = "retrained"; r.reissuedTokenId = tokenId; saveAI();
  addEvent("system", `AI 권고 #${r.id}: ${r.workerName} 재교육 이수 → 안전교육 배지 #${tokenId} 재발급`);
  return { review: r, tokenId, gas };
}

async function state() {
  const now = await chainNow();
  return {
    contract: await S.badge.getAddress(), chainTime: now, chainDate: new Date(now * 1000).toLocaleString("ko-KR"),
    issuer: S.issuer.address,
    workers: S.workers.map((w) => ({ key: w.key, name: w.name, address: w.address, phone: w.phone, face: !!w.faceId })),
    registrations: S.regs.filter((r) => r.status === "pending").map(({ token, ...r }) => r),
    types: TYPES, equipment: EQUIPMENT, badges: await listBadges(), events: S.events,
    sessions: Object.values(S.sessions).map(publicSession), usage: S.usage.slice(0, 30), eqStyle: S.eqStyle,
    pair: pairCode(), internet: /^https:/.test(publicBase()),
    eqLast: S.eqLast, phoneBase: publicBase(), lan: !/localhost/.test(publicBase()), manualBase,
    lanOthers: lanCandidates().map((c) => ({ base: `http://${c.address}:${PORT}`, name: c.name })).filter((c) => c.base !== publicBase()),
    ai: AI ? { enabled: true, reviews: S.aiReviews.slice(0, 30), threshold: AI.model.m.iforest.threshold, note: AI.model.m.note } : { enabled: false },
  };
}

// ───────── HTTP ─────────
// 휴대폰·인터넷에서도 쓸 수 있는 기능 (나머지는 이 PC에서만)
// ───────── 휴대폰 센서 실측 실험 (AI 검증용) ─────────
// 휴대폰 작업자 앱의 '🧪 센서 실험' 화면이 20초 기록을 올린다 → ai/phone_data/ 에 저장 (python ai/phone_experiment.py 가 분석)
// 분석으로 ai/phone_model.json 이 생기면, 올린 기록을 그 자리에서 판정해서 돌려준다
const SENSOR_DIR = path.join(__dirname, "..", "ai", "phone_data");
let phoneModel = { mtime: 0, m: null };
function currentPhoneModel() {
  try {
    const st = fs.statSync(phoneAI.MODEL_FILE);
    if (st.mtimeMs !== phoneModel.mtime) phoneModel = { mtime: st.mtimeMs, m: phoneAI.PhoneModel.load() };
  } catch { phoneModel = { mtime: 0, m: null }; }
  return phoneModel.m;
}
function sensorFiles() {
  try { return fs.readdirSync(SENSOR_DIR).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
}
function sensorStats(address) {
  const by = {}; let mine = 0;
  for (const f of sensorFiles()) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SENSOR_DIR, f), "utf8"));
      const k = d.participant || "?"; by[k] = by[k] || { smooth: 0, rough: 0 }; by[k][d.label] = (by[k][d.label] || 0) + 1;
      if (d.wallet === address) mine++;
    } catch {}
  }
  return { participants: by, total: sensorFiles().length, mine, model: currentPhoneModel() ? currentPhoneModel().m.trainedOn : null };
}
function sensorUpload(b) {
  const { address } = walletOf(b.token);
  const label = b.label === "smooth" || b.label === "rough" ? b.label : null;
  if (!label) throw new Error("운전 방식(부드럽게/거칠게)을 골라 주세요");
  const participant = String(b.participant || "").trim().slice(0, 20);
  if (!participant) throw new Error("참가자 이름을 넣어 주세요");
  if (!Array.isArray(b.samples) || b.samples.length < 100 || b.samples.length > 6000) throw new Error("센서 기록 길이가 맞지 않아요 (100~6000개)");
  const samples = b.samples.map((r) => (Array.isArray(r) ? r.slice(0, 7).map(Number) : []));
  const f = phoneAI.features(samples); // 형식이 이상하면 여기서 오류
  if (f.seconds < 8) throw new Error("기록이 8초보다 짧아요. 다시 기록해 주세요");
  fs.mkdirSync(SENSOR_DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const rec = { id, participant, label, recordedAt: new Date().toISOString(), wallet: address,
    device: String(b.device || "").slice(0, 80), source: String(b.source || "").slice(0, 40), hz: Number(b.hz) || null, samples };
  fs.writeFileSync(path.join(SENSOR_DIR, id + ".json"), JSON.stringify(rec));
  const m = currentPhoneModel();
  addEvent("system", `🧪 센서 실험 기록: ${participant} · ${label === "smooth" ? "부드럽게" : "거칠게"} · ${f.seconds.toFixed(1)}초`);
  return { id, features: f, ai: m ? m.analyze(f) : null, stats: sensorStats(address) };
}
function sensorUndo(b) {
  const { address } = walletOf(b.token);
  for (const f of sensorFiles().reverse()) {
    const p = path.join(SENSOR_DIR, f);
    let d; try { d = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    if (d.wallet !== address) continue;
    if (Date.now() - Date.parse(d.recordedAt) > 10 * 60_000) throw new Error("10분이 지난 기록은 여기서 지울 수 없어요");
    const bin = path.join(SENSOR_DIR, "_discarded"); fs.mkdirSync(bin, { recursive: true });
    fs.renameSync(p, path.join(bin, f)); // 실수로 잘못 기록한 것 — 분석에서만 빠지고 파일은 남는다
    return { removed: d.id, stats: sensorStats(address) };
  }
  throw new Error("지울 기록이 없어요");
}

const PUBLIC_ROUTES = new Set(["GET /api/eq/state", "POST /api/eq/challenge", "POST /api/eq/verify", "POST /api/register",
  "POST /api/me", "POST /api/me/vc", "POST /api/session/end", "POST /api/sensor/upload", "POST /api/sensor/stats", "POST /api/sensor/undo"]);
const routes = {
  "GET /api/state": async () => state(),
  "POST /api/issue": async (b) => issue(b.worker, Number(b.type), (await chainNow()) + Number(b.days) * DAY),
  "POST /api/revoke": async (b) => revokeBadge(Number(b.tokenId), b.reason || "관리자 정지"),
  "POST /api/renew": async (b) => {
    const cur = await S.badge.badges(Number(b.tokenId));
    const base = Math.max(Number(cur.expiresAt), await chainNow());
    return renewBadge(Number(b.tokenId), base + Number(b.days) * DAY, Number(b.days));
  },
  "POST /api/time": async (b) => {
    await hre.network.provider.send("evm_increaseTime", [Number(b.days) * DAY]);
    await hre.network.provider.send("evm_mine");
    addEvent("system", `시간 ${b.days}일 앞으로 이동 (가상 블록체인 시각)`);
    await journal({ op: "time", days: Number(b.days) });
    return {};
  },
  "POST /api/access": async (b) => access(b.worker, b.equipment, b.signer),
  "POST /api/replay": async () => replay(),
  "POST /api/transfer": async (b) => transfer(b.from, b.to, Number(b.tokenId)),
  "POST /api/reset": async () => { await setup(true); return {}; },
  "POST /api/vc": async (b) => { const vc = vcOf(Number(b.tokenId)); return { vc, hash: vcHash(vc) }; },
  "POST /api/vc/verify": async (b) => {
    let vc = b.vc;
    if (typeof vc === "string") { try { vc = JSON.parse(vc); } catch { throw new Error("JSON 형식이 아니에요 (괄호·따옴표를 확인하세요)"); } }
    return checkVC(vc, b.label);
  },
  "POST /api/vc/forge": async (b) => forgeVC(Number(b.tokenId), b.kind),
  "GET /api/eq/state": async (_, q) => ({ equipment: EQ(q.get("eq")), qr: await currentQR(q.get("eq")), last: S.eqLast[q.get("eq")] || null,
    session: publicSession(S.sessions[q.get("eq")]), style: S.eqStyle[q.get("eq")] || "skilled", internet: /^https:/.test(publicBase()),
    chainDate: new Date((await chainNow()) * 1000).toLocaleString("ko-KR"), equipmentList: EQUIPMENT }),
  "POST /api/eq/challenge": async (b) => {
    const eq = EQ(b.eq);
    const td = await S.verifiers[b.eq].typedDataFor(String(b.nonce));
    return { equipment: eq, typedData: td, valid: !!td, busy: publicSession(S.sessions[b.eq]) };
  },
  "POST /api/eq/verify": async (b) => accessBySignature(b.eq, b.nonce, b.signature, b.face),
  "POST /api/eq/style": async (b) => {
    EQ(b.eq);
    if (!["skilled", "novice", "risky"].includes(b.style)) throw new Error("모르는 운전 방식이에요");
    S.eqStyle[b.eq] = b.style; return { style: b.style };
  },
  "POST /api/session/end": async (b, _, req) => {
    const x = S.sessions[b.eq];
    if (!isLocal(req)) { // 휴대폰: 이 작업을 시작한 사람만 끝낼 수 있다
      const w = workerOfToken(b.token);
      if (!x || x.worker !== w.key) throw Object.assign(new Error("이 작업을 시작한 작업자만 종료할 수 있어요"), { status: 403 });
      return endSession(b.eq, "phone", b.sensor || null);
    }
    if (b.token) { const w = workerOfToken(b.token); if (x && x.worker === w.key) return endSession(b.eq, "phone"); }
    return endSession(b.eq, ["equipment", "seat", "admin"].includes(b.by) ? b.by : "equipment");
  },
  "POST /api/me": async (b) => me(b.token),
  "POST /api/me/vc": async (b) => {
    const worker = workerOfToken(b.token).key;
    const badge = (await listBadges()).find((x) => x.tokenId === Number(b.tokenId));
    if (!badge || badge.workerKey !== worker) throw Object.assign(new Error("내 배지의 VC만 볼 수 있어요"), { status: 403 });
    const vc = vcOf(Number(b.tokenId)); return { vc, hash: vcHash(vc) };
  },
  "POST /api/net/base": async (b) => {
    const v = String(b.base || "").trim().replace(/\/$/, "");
    if (v && !/^https?:\/\/[\w.-]+(:\d+)?$/.test(v)) throw new Error("주소 형식이 아니에요 (예: http://192.168.0.12:3000)");
    manualBase = v; saveJSON(SETTINGS_FILE, { phoneBase: v });
    for (const k of Object.keys(S.qr)) S.qr[k].used = true; // 장비 QR 을 새 주소로 다시 만든다
    return { phoneBase: publicBase() };
  },
  "POST /api/register": async (b, _, req) => registerRequest(b, isLocal(req), clientIP(req)),
  "POST /api/register/decide": async (b) => registerDecide(b.id, b.action, b.worker),
  "POST /api/ai/analyze": async (b) => aiAnalyze(b.worker, b.style),
  "POST /api/ai/decide": async (b) => aiDecide(b.id, b.action),
  "POST /api/ai/retrain": async (b) => aiRetrain(b.id),
  "POST /api/sensor/upload": async (b) => sensorUpload(b),
  "POST /api/sensor/stats": async (b) => sensorStats(walletOf(b.token).address),
  "POST /api/sensor/undo": async (b) => sensorUndo(b),
};

// node_modules/ethers/dist/ethers.umd.min.js 찾기 (ethers 패키지 폴더까지 거슬러 올라감)
const ETHERS_UMD = (() => {
  try {
    let d = path.dirname(require.resolve("ethers"));
    while (path.basename(d) !== "ethers" && path.dirname(d) !== d) d = path.dirname(d);
    const f = path.join(d, "dist", "ethers.umd.min.js");
    return fs.existsSync(f) ? f : null;
  } catch { return null; }
})();
// 얼굴 인식 (휴대폰 브라우저 안에서만 실행): @vladmandic/face-api 와 모델 3개
const FACE_DIR = (() => {
  for (let d = __dirname; path.dirname(d) !== d; d = path.dirname(d)) {
    const f = path.join(d, "node_modules", "@vladmandic", "face-api");
    if (fs.existsSync(path.join(f, "dist", "face-api.js"))) return f;
  }
  return null;
})();
const FACE_MODELS = new Set(["tiny_face_detector_model", "face_landmark_68_model", "face_recognition_model"]
  .flatMap((m) => [m + "-weights_manifest.json", m + ".bin"]));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

// ───────── 다른 사이트가 이 서버를 몰래 부르는 것 막기 ─────────
// ① CSRF: 관리자 PC 브라우저로 연 악성 사이트가 localhost:3000 에 발급·정지 요청을 보내는 공격
//    → POST 는 JSON 형식만 받고(다른 사이트는 사전 확인(CORS) 없이 JSON 을 못 보냄), 요청 출처(Origin)가 이 서버 주소여야 함
// ② DNS 리바인딩: 악성 도메인을 127.0.0.1 로 바꿔 "같은 출처"인 척하는 공격 → 이 PC 접속은 주소창이 localhost 일 때만
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const hostOf = (h) => { try { return new URL("http://" + h).hostname; } catch { return ""; } };
function allowedOrigins(req) {
  const set = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`]);
  try { set.add(new URL(publicBase()).origin); } catch {}
  if (req.headers.host) { set.add("http://" + req.headers.host); set.add("https://" + req.headers.host); }
  return set;
}
function blockForeign(req, res, isApi) {
  const no = (code, msg) => { res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: msg, code })); return true; };
  if (isLocal(req) && !LOCAL_HOSTS.has(hostOf(req.headers.host || ""))) return no("BAD_HOST", "이 PC에서는 http://localhost 주소로 열어 주세요");
  if (isApi && req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins(req).has(origin)) {
      addEvent("deny", `⚠ 다른 사이트(${String(origin).slice(0, 60)})에서 온 요청 차단: ${req.url}`);
      return no("BAD_ORIGIN", "다른 사이트에서 보낸 요청이라 막았어요");
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return no("BAD_TYPE", "JSON 요청만 받아요");
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  if (blockForeign(req, res, !!routes[key])) return;
  if (routes[key]) {
    if (!PUBLIC_ROUTES.has(key) && !isLocal(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "관리 기능은 이 PC(localhost)에서만 쓸 수 있어요", code: "LOCAL_ONLY" }));
    }
    let body = "", tooBig = false;
    req.on("data", (c) => { if (tooBig) return; body += c; if (body.length > 3_000_000) { tooBig = true; body = ""; } });
    req.on("end", async () => {
      try {
        if (tooBig) throw Object.assign(new Error("요청이 너무 커요"), { status: 413 });
        const data = await routes[key](body ? JSON.parse(body) : {}, url.searchParams, req);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const fe = friendlyError(e);
        res.writeHead(e.status || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: fe.message, code: fe.code }));
      }
    });
    return;
  }
  // 화면 3개 + 시연용 통합 화면
  const PAGES = { "/": "index.html", "/admin": "index.html", "/equipment": "equipment.html", "/worker": "worker.html", "/sensor": "sensor.html" };
  if ((url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/index.html") && !isLocal(req)) {
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    return res.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p style="font:16px sans-serif;padding:20px">관리자 화면은 이 PC에서만 열 수 있어요. 휴대폰은 <a href="/worker">작업자 앱</a>을 쓰세요.</p>');
  }
  if (url.pathname === "/vendor/ethers.js") { // 휴대폰에서 서명할 때 쓰는 ethers (인터넷 없이도 동작하게 로컬에서 제공)
    if (!ETHERS_UMD) { res.writeHead(404); return res.end("ethers not found"); }
    res.writeHead(200, { "Content-Type": MIME[".js"] });
    return fs.createReadStream(ETHERS_UMD).pipe(res);
  }
  if (url.pathname === "/vendor/face-api.js" || url.pathname.startsWith("/vendor/face-models/")) {
    const name = path.basename(url.pathname);
    const f = !FACE_DIR ? null : name === "face-api.js" ? path.join(FACE_DIR, "dist", "face-api.js") : FACE_MODELS.has(name) ? path.join(FACE_DIR, "model", name) : null;
    if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end("face model not found — npm install 을 다시 실행하세요"); }
    res.writeHead(200, { "Content-Type": name.endsWith(".js") ? MIME[".js"] : name.endsWith(".json") ? "application/json" : "application/octet-stream", "Cache-Control": "public, max-age=604800" });
    return fs.createReadStream(f).pipe(res);
  }
  const file = path.join(__dirname, "public", PAGES[url.pathname] || url.pathname);
  if (!file.startsWith(path.join(__dirname, "public")) || !fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// 예상 못 한 오류가 나도 서버가 꺼지지 않게 — 오류는 창에 출력만
process.on("uncaughtException", (e) => console.error("[오류]", e?.message || e));
process.on("unhandledRejection", (e) => console.error("[오류]", e?.message || e));
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`\n[!] ${PORT}번 포트를 이미 쓰는 중이에요. 이미 열린 WorkerBadge 창이 있으면 닫고 다시 실행하세요.\n`);
  else console.error("[서버 오류]", e.message);
  process.exit(1);
});

(async () => {
  await setup();
  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  WorkerBadge 체험 프로그램 실행 중 → ${url}`);
    console.log(`    관리자 ${url}/admin · 장비 화면 ${url}/equipment · 작업자 앱(휴대폰) ${publicBase()}/worker`);
    if (/localhost/.test(publicBase())) console.log("    [!] 이 PC의 와이파이 주소를 못 찾았어요. 와이파이(또는 휴대폰 핫스팟)에 연결한 뒤 관리자 화면을 새로고침하세요.");
    if (/^https:/.test(publicBase())) console.log(`    🌐 인터넷 주소 사용 중 — 휴대폰 데이터(LTE·5G)로도 접속돼요`);
    else console.log(`    휴대폰은 PC와 같은 와이파이에 연결하세요. Windows 방화벽 창이 뜨면 '허용'을 누르세요. (인터넷 주소를 못 만든 상태 — 같은 와이파이나 휴대폰 핫스팟에서만 접속돼요)`);
    console.log(`    휴대폰 연결 코드: ${pairCode().code} (관리자 화면에도 보여요)`);
    console.log(`  끝내려면 이 창에서 Ctrl + C\n`);
    if (!process.env.NO_BROWSER) {
      const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
  await new Promise(() => {}); // 서버가 계속 돌도록 대기
})().catch((e) => { console.error(e); process.exitCode = 1; });
