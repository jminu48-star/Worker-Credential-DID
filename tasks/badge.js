// 테스트넷(Sepolia)·로컬 노드에서 쓰는 명령 모음
//   npx hardhat wallet                         --network sepolia   내 테스트 지갑 주소·잔액
//   npx hardhat badge:deploy                   --network sepolia   컨트랙트 배포 → deployments/sepolia.json
//   npx hardhat badge:issue --worker 0x.. --type 0 --days 365 --name 홍길동   --network sepolia
//   npx hardhat badge:verify --file vcs/sepolia-1.json                         --network sepolia
//   npx hardhat badge:status --worker 0x..     --network sepolia
//   npx hardhat badge:revoke --id 1 --reason 사고 / badge:renew --id 1 --days 365
//   npx hardhat badge:grant-issuer --account 0x..   (팀원에게 발급 권한 주기)
const { task, types } = require("hardhat/config");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEPLOY_DIR = path.join(ROOT, "deployments");
const VC_DIR = path.join(ROOT, "vcs"); // 개인정보가 든 VC 파일 — .gitignore 에 들어 있음
const DAY = 24 * 60 * 60;
const TYPE_KEYS = ["FORKLIFT", "CRANE", "HAZMAT", "SAFETY_EDU"];
const TYPE_NAMES = ["지게차 면허", "크레인 면허", "위험물 취급", "안전교육 이수"];

const explorer = (hre, kind, v) =>
  hre.network.name === "sepolia" ? `https://sepolia.etherscan.io/${kind}/${v}` : `(로컬 ${kind}) ${v}`;
const deployFile = (hre) => path.join(DEPLOY_DIR, `${hre.network.name}.json`);

async function getBadge(hre, address) {
  let addr = address;
  if (!addr) {
    try { addr = JSON.parse(fs.readFileSync(deployFile(hre), "utf8")).address; }
    catch { throw new Error(`배포 기록이 없어요. 먼저 'npx hardhat badge:deploy --network ${hre.network.name}' 를 실행하거나 --address 를 주세요.`); }
  }
  return hre.ethers.getContractAt("WorkerBadge", addr);
}
const checkAddr = (hre, a, what) => { if (!hre.ethers.isAddress(a)) throw new Error(`${what} 주소 형식이 아니에요: ${a}`); return hre.ethers.getAddress(a); };
const waitTx = async (hre, tx, label) => {
  console.log(`  ${label} 전송: ${explorer(hre, "tx", tx.hash)}\n  블록에 들어가길 기다리는 중... (Sepolia 는 10~30초)`);
  const r = await tx.wait();
  console.log(`  완료 — 블록 ${r.blockNumber}, 가스 ${r.gasUsed.toLocaleString()}`);
  return r;
};

task("wallet", "지금 쓰는 지갑 주소와 잔액").setAction(async (_, hre) => {
  const [me] = await hre.ethers.getSigners();
  const bal = await hre.ethers.provider.getBalance(me.address);
  const { chainId } = await hre.ethers.provider.getNetwork();
  console.log(`네트워크 ${hre.network.name} (체인 ID ${chainId})\n주소 ${me.address}\n잔액 ${hre.ethers.formatEther(bal)} ETH`);
  if (bal === 0n) console.log("→ 잔액이 0이에요. docs/sepolia-guide.md 의 '3. 테스트 ETH 받기'를 보세요.");
});

task("badge:deploy", "WorkerBadge 배포 (배포한 지갑 = 관리자 + 발급기관)").setAction(async (_, hre) => {
  await hre.run("compile", { quiet: true });
  const [me] = await hre.ethers.getSigners();
  console.log(`배포 계정 ${me.address} (이 지갑이 관리자가 됩니다)`);
  const badge = await (await hre.ethers.getContractFactory("WorkerBadge")).deploy(me.address);
  const tx = badge.deploymentTransaction();
  console.log(`  배포 전송: ${explorer(hre, "tx", tx.hash)}\n  기다리는 중...`);
  await badge.waitForDeployment();
  const r = await tx.wait();
  const address = await badge.getAddress();
  const { chainId } = await hre.ethers.provider.getNetwork();
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.writeFileSync(deployFile(hre), JSON.stringify({ network: hre.network.name, chainId: Number(chainId), address, admin: me.address,
    tx: tx.hash, block: r.blockNumber, gasUsed: Number(r.gasUsed), deployedAt: new Date().toISOString() }, null, 2));
  console.log(`\nWorkerBadge 주소 ${address}\n${explorer(hre, "address", address)}\n기록 저장: deployments/${hre.network.name}.json (배포 가스 ${r.gasUsed.toLocaleString()})`);
});

task("badge:issue", "배지 발급 + 서명된 VC 파일 만들기")
  .addParam("worker", "작업자 지갑 주소 0x...")
  .addParam("type", "0 지게차 · 1 크레인 · 2 위험물 · 3 안전교육", undefined, types.int)
  .addOptionalParam("days", "유효 기간(일)", 365, types.int)
  .addOptionalParam("name", "작업자 이름 (VC 에만 들어가고 체인에는 안 올라감)", "")
  .addOptionalParam("cert", "자격번호", "")
  .addOptionalParam("org", "발급기관 이름", "")
  .addOptionalParam("address", "컨트랙트 주소 (생략하면 deployments 기록 사용)")
  .setAction(async (a, hre) => {
    const { createVC, vcHash } = require("../scripts/vc");
    if (!(a.type >= 0 && a.type <= 3)) throw new Error("--type 은 0~3 이에요");
    const worker = checkAddr(hre, a.worker, "작업자");
    const badge = await getBadge(hre, a.address);
    const [issuer] = await hre.ethers.getSigners();
    const { chainId } = await hre.ethers.provider.getNetwork();
    const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
    const validUntil = now + a.days * DAY;
    const claims = { ...(a.name && { name: a.name }), ...(a.cert && { certificateNo: a.cert }), ...(a.org && { issuingBody: a.org }) };

    // ① VC 만들기(오프체인 서명, 가스 없음) → ② 지문만 체인에 기록
    const vc = await createVC({ issuerSigner: issuer, chainId, contract: await badge.getAddress(), worker, badgeType: a.type, validFrom: now, validUntil, claims });
    const hash = vcHash(vc);
    console.log(`'${TYPE_NAMES[a.type]}' 배지 발급 → ${worker}\n  VC 지문 ${hash}`);
    await waitTx(hre, await badge.issue(worker, a.type, validUntil, hash), "발급");
    const tokenId = Number(await badge.badgeOf(worker, a.type));

    fs.mkdirSync(VC_DIR, { recursive: true });
    const file = path.join(VC_DIR, `${hre.network.name}-${tokenId}.json`);
    fs.writeFileSync(file, JSON.stringify(vc, null, 2));
    console.log(`\n배지 #${tokenId} 발급 완료\nVC 파일: ${path.relative(ROOT, file)}  ← 작업자에게 전달 (개인정보 포함: git 에 올리지 않기)`);
  });

task("badge:verify", "VC 파일 검증 (서명·발급 권한·체인 지문·현재 상태)")
  .addParam("file", "VC JSON 파일 경로")
  .addOptionalParam("address", "컨트랙트 주소 (생략하면 VC 안의 주소)")
  .setAction(async (a, hre) => {
    const { verifyVC } = require("../scripts/vc");
    const vc = JSON.parse(fs.readFileSync(path.resolve(a.file), "utf8"));
    const badge = await getBadge(hre, a.address || vc?.credentialStatus?.contract);
    let fromBlock = 0;
    try { fromBlock = JSON.parse(fs.readFileSync(deployFile(hre), "utf8")).block || 0; } catch {}
    const r = await verifyVC(vc, badge, { fromBlock });
    console.log(`VC 검증: ${a.file}`);
    r.steps.forEach((s, i) => console.log(`  ${s.ok ? "✓" : "✗"} ${i + 1}. ${s.label} — ${s.detail}`));
    console.log(r.ok ? "\n결과: ✅ 진짜 VC" : "\n결과: ❌ 믿을 수 없는 VC");
    if (!r.ok) process.exitCode = 1;
  });

task("badge:status", "작업자의 배지와 장비별 조작 가능 여부 (조회만, 가스 0)")
  .addParam("worker", "작업자 지갑 주소")
  .addOptionalParam("address", "컨트랙트 주소")
  .setAction(async (a, hre) => {
    const worker = checkAddr(hre, a.worker, "작업자");
    const badge = await getBadge(hre, a.address);
    const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
    console.log(`작업자 ${worker}`);
    for (let t = 0; t < 4; t++) {
      const id = Number(await badge.badgeOf(worker, t));
      if (!id) { console.log(`  - ${TYPE_NAMES[t]}: 없음`); continue; }
      const b = await badge.badges(id);
      const st = b.revoked ? "정지" : Number(b.expiresAt) <= now ? "만료" : `유효 (${Math.floor((Number(b.expiresAt) - now) / DAY)}일 남음)`;
      console.log(`  - ${TYPE_NAMES[t]}: 배지 #${id} ${st}`);
    }
    for (const eq of ["FORKLIFT", "CRANE", "HAZMAT"]) {
      console.log(`  ${eq.padEnd(8)} 조작 ${(await badge.isQualified(worker, hre.ethers.id(eq))) ? "가능 ✅" : "불가 ❌"}`);
    }
  });

task("badge:revoke", "배지 정지")
  .addParam("id", "배지 번호", undefined, types.int)
  .addOptionalParam("reason", "사유", "관리자 정지")
  .addOptionalParam("address", "컨트랙트 주소")
  .setAction(async (a, hre) => {
    const badge = await getBadge(hre, a.address);
    await waitTx(hre, await badge.revoke(a.id, a.reason), `배지 #${a.id} 정지`);
  });

task("badge:renew", "배지 연장 (지금 만료일 기준 + N일)")
  .addParam("id", "배지 번호", undefined, types.int)
  .addOptionalParam("days", "연장할 일수", 365, types.int)
  .addOptionalParam("address", "컨트랙트 주소")
  .setAction(async (a, hre) => {
    const badge = await getBadge(hre, a.address);
    const b = await badge.badges(a.id);
    const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
    const base = Math.max(Number(b.expiresAt), now);
    await waitTx(hre, await badge.renew(a.id, base + a.days * DAY), `배지 #${a.id} ${a.days}일 연장`);
  });

task("badge:grant-issuer", "다른 지갑에 발급 권한(ISSUER_ROLE) 주기 — 관리자만")
  .addParam("account", "권한을 줄 지갑 주소")
  .addOptionalParam("address", "컨트랙트 주소")
  .setAction(async (a, hre) => {
    const badge = await getBadge(hre, a.address);
    const acc = checkAddr(hre, a.account, "받을");
    await waitTx(hre, await badge.grantRole(await badge.ISSUER_ROLE(), acc), `${acc} 에 발급 권한 부여`);
  });

module.exports = { TYPE_KEYS };
