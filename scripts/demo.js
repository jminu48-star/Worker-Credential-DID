// 1단계 데모: 배지 발급 → 장비 접근 허용·거부 시나리오
// 실행: npx hardhat run scripts/demo.js
const hre = require("hardhat");
const { ethers } = hre;
const { EquipmentVerifier, signChallenge } = require("./verifier");

const T = { FORKLIFT: 0, CRANE: 1, HAZMAT: 2, SAFETY_EDU: 3 };
const DAY = 24 * 60 * 60;
const vc = (s) => ethers.id(s); // 데모용 VC 해시 (실제는 서명된 VC JSON 의 해시)

async function now() { return (await ethers.provider.getBlock("latest")).timestamp; }

async function tryAccess(verifier, wallet) {
  const { nonce, typedData } = await verifier.createChallenge();
  const sig = await signChallenge(wallet, typedData);
  return { res: await verifier.verify(nonce, sig), nonce, sig };
}

async function main() {
  const [issuer, minwoo, minsu, younghee, jiwon] = await ethers.getSigners();
  const names = new Map([[minwoo.address, "민우"], [minsu.address, "민수"], [younghee.address, "영희"], [jiwon.address, "지원"]]);

  const Badge = await ethers.getContractFactory("WorkerBadge");
  const badge = await Badge.deploy(issuer.address);
  await badge.waitForDeployment();
  console.log(`\n배포 완료: WorkerBadge @ ${await badge.getAddress()}\n`);

  const t = await now();
  const gas = {};
  const rec = async (label, txp) => { const r = await (await txp).wait(); gas[label] = Number(r.gasUsed); };

  // 민우: 지게차 면허 + 안전교육 (1년)
  await rec("issue(발급)", badge.issue(minwoo.address, T.FORKLIFT, t + 365 * DAY, vc("민우-지게차-VC")));
  await badge.issue(minwoo.address, T.SAFETY_EDU, t + 365 * DAY, vc("민우-안전교육-VC"));
  // 영희: 둘 다 있지만 지게차 면허가 3일 뒤 만료
  await badge.issue(younghee.address, T.FORKLIFT, t + 3 * DAY, vc("영희-지게차-VC"));
  await badge.issue(younghee.address, T.SAFETY_EDU, t + 365 * DAY, vc("영희-안전교육-VC"));
  // 지원: 지게차 면허만 있고 안전교육 미이수
  await badge.issue(jiwon.address, T.FORKLIFT, t + 365 * DAY, vc("지원-지게차-VC"));
  // 민수: 아무것도 없음

  const forklift = new EquipmentVerifier(badge, "FL-001", "FORKLIFT");
  const rows = [];
  const push = (scenario, who, expect, res) =>
    rows.push({ 시나리오: scenario, 작업자: who, 기대: expect, 결과: res.allowed ? "✅ 시동 허용" : "❌ 시동 거부", 사유: res.reason, 판정: (res.allowed === (expect === "허용")) ? "PASS" : "FAIL" });

  // 1) 정상
  let r = await tryAccess(forklift, minwoo); push("1. 정상 작업자", "민우", "허용", r.res);
  // 2) 무자격
  push("2. 무자격자", "민수", "거부", (await tryAccess(forklift, minsu)).res);
  // 3) 안전교육 미이수
  push("3. 안전교육 미이수", "지원", "거부", (await tryAccess(forklift, jiwon)).res);
  // 4) 만료: 4일 뒤로 시간 이동
  push("4-a. 만료 전", "영희", "허용", (await tryAccess(forklift, younghee)).res);
  await hre.network.provider.send("evm_increaseTime", [4 * DAY]);
  await hre.network.provider.send("evm_mine");
  push("4-b. 만료 후(4일 경과)", "영희", "거부", (await tryAccess(forklift, younghee)).res);
  // 5) 재사용 공격: 1번에서 쓴 민우의 서명을 그대로 다시 제출
  push("5. 서명 재사용 공격", "민우(녹화본)", "거부", await forklift.verify(r.nonce, r.sig));
  // 6) 남의 지갑으로 서명 = 민수가 민우 challenge 에 자기 키로 서명
  { const { nonce, typedData } = await forklift.createChallenge(); const sig = await signChallenge(minsu, typedData);
    push("6. 다른 사람 키로 서명", "민수", "거부", await forklift.verify(nonce, sig)); }
  // 7) 폐기
  const fid = await badge.badgeOf(minwoo.address, T.FORKLIFT);
  await rec("revoke(폐기)", badge.revoke(fid, "안전수칙 위반 사고"));
  push("7. 배지 폐기 후", "민우", "거부", (await tryAccess(forklift, minwoo)).res);

  // 8) 양도 시도 — 컨트랙트가 거절해야 함
  const sid = await badge.badgeOf(minwoo.address, T.SAFETY_EDU);
  let transferBlocked = false;
  try { await badge.connect(minwoo).transferFrom(minwoo.address, minsu.address, sid); }
  catch (e) { transferBlocked = /Soulbound/.test(e.message); }
  rows.push({ 시나리오: "8. 배지 양도 시도", 작업자: "민우→민수", 기대: "거부", 결과: transferBlocked ? "❌ 전송 거절(Soulbound)" : "⚠ 전송됨", 사유: "SBT 는 다른 지갑으로 옮길 수 없음", 판정: transferBlocked ? "PASS" : "FAIL" });

  // 9) 갱신: 영희 재교육 후 연장
  const yid = await badge.badgeOf(younghee.address, T.FORKLIFT);
  // 만료된 배지는 renew 대신 새로 발급 (규칙: 유효하지 않으면 재발급 가능)
  await rec("issue(재발급)", badge.issue(younghee.address, T.FORKLIFT, (await now()) + 365 * DAY, vc("영희-지게차-재교육-VC")));
  push("9. 재교육 후 재발급", "영희", "허용", (await tryAccess(forklift, younghee)).res);
  const cid = await badge.badgeOf(minwoo.address, T.SAFETY_EDU);
  await rec("renew(연장)", badge.renew(cid, (await now()) + 730 * DAY));

  console.table(rows.map(({ 사유, ...x }) => x));
  console.log("\n사유:");
  rows.forEach((x) => console.log(`  ${x.시나리오}: ${x.사유}`));

  const lookups = forklift.logs.filter((l) => l.lookupMs !== undefined).map((l) => l.lookupMs);
  console.log(`\n가스 사용량(상태 변경 트랜잭션):`);
  Object.entries(gas).forEach(([k, v]) => console.log(`  ${k}: ${v.toLocaleString()} gas`));
  console.log(`  isQualified(조회): 0 gas (view 호출)`);
  console.log(`체인 조회 지연(로컬 노드): 평균 ${(lookups.reduce((a, b) => a + b, 0) / lookups.length).toFixed(2)} ms, n=${lookups.length}`);

  const fails = rows.filter((x) => x.판정 !== "PASS").length;
  console.log(`\n결과: ${rows.length - fails}/${rows.length} PASS`);
  if (fails) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
