const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { createVC, verifyVC, vcHash } = require("../scripts/vc");

const DAY = 24 * 60 * 60;
const FORKLIFT = 0;

async function setup() {
  const [admin, worker, attacker, other] = await ethers.getSigners();
  const badge = await (await ethers.getContractFactory("WorkerBadge")).deploy(admin.address);
  const now = await time.latest();
  const { chainId } = await ethers.provider.getNetwork();
  const contract = await badge.getAddress();
  const make = (signer = admin, over = {}) => createVC({
    issuerSigner: signer, chainId, contract, worker: worker.address, badgeType: FORKLIFT,
    validFrom: now, validUntil: now + 365 * DAY, claims: { name: "홍길동", certificateNo: "FL-2026-0001" }, ...over,
  });
  const vc = await make();
  await badge.issue(worker.address, FORKLIFT, now + 365 * DAY, vcHash(vc));
  return { badge, admin, worker, attacker, other, vc, make, now, chainId, contract };
}
const failed = (r) => r.steps.filter((s) => !s.ok).map((s) => s.key);

describe("VC (2단계)", () => {
  it("발급기관이 서명하고 체인에 지문을 남긴 VC는 모든 단계를 통과한다", async () => {
    const { badge, vc, admin } = await loadFixture(setup);
    const r = await verifyVC(vc, badge);
    expect(r.ok).to.equal(true);
    expect(r.issuer).to.equal(admin.address);
    expect(r.tokenId).to.equal(1);
  });

  it("체인에는 개인정보가 없고 지문(해시)만 있다", async () => {
    const { badge, vc } = await loadFixture(setup);
    const b = await badge.badges(1);
    expect(b.vcHash).to.equal(vcHash(vc));
    expect(JSON.stringify(b.toObject(), (k, v) => (typeof v === "bigint" ? v.toString() : v))).to.not.include("홍길동");
  });

  it("이름 한 글자만 바꿔도 서명과 체인 지문이 모두 깨진다", async () => {
    const { badge, vc } = await loadFixture(setup);
    const forged = structuredClone(vc);
    forged.credentialSubject.name = "홍길순";
    expect(failed(await verifyVC(forged, badge))).to.include.members(["signature", "anchor", "status"]);
  });

  it("만료일을 늘리는 위조도 잡힌다", async () => {
    const { badge, vc, now } = await loadFixture(setup);
    const forged = structuredClone(vc);
    forged.validUntil = new Date((now + 3650 * DAY) * 1000).toISOString();
    expect(failed(await verifyVC(forged, badge))).to.include.members(["signature", "anchor"]);
  });

  it("발급 권한 없는 사람이 서명한 VC는 거부된다", async () => {
    const { badge, attacker, make } = await loadFixture(setup);
    const fake = await make(attacker);
    const r = await verifyVC(fake, badge);
    expect(r.ok).to.equal(false);
    expect(failed(r)).to.include.members(["issuerRole", "anchor"]);
    expect(failed(r)).to.not.include("signature"); // 서명 자체는 맞지만 권한이 없다
  });

  it("다른 컨트랙트용으로 만든 VC는 거부된다", async () => {
    const { badge, admin, worker, now, chainId } = await loadFixture(setup);
    const other = await (await ethers.getContractFactory("WorkerBadge")).deploy(admin.address);
    const vc2 = await createVC({ issuerSigner: admin, chainId, contract: await other.getAddress(), worker: worker.address,
      badgeType: FORKLIFT, validFrom: now, validUntil: now + DAY });
    expect(failed(await verifyVC(vc2, badge))).to.include("domain");
  });

  it("체인에서 정지하면 VC 파일이 그대로여도 무효가 된다", async () => {
    const { badge, vc } = await loadFixture(setup);
    await badge.revoke(1, "사고");
    const r = await verifyVC(vc, badge);
    expect(failed(r)).to.deep.equal(["status"]);
  });

  it("만료되면 무효, 체인에서 연장하면 같은 VC로 다시 유효", async () => {
    const { badge, vc, now } = await loadFixture(setup);
    await time.increaseTo(now + 366 * DAY);
    expect(failed(await verifyVC(vc, badge))).to.deep.equal(["status"]);
    await badge.renew(1, now + 800 * DAY);
    const r = await verifyVC(vc, badge);
    expect(r.ok).to.equal(true);
    expect(r.steps.at(-1).detail).to.include("연장");
  });

  it("재발급되면 예전 VC는 더 이상 통하지 않는다", async () => {
    const { badge, vc, make, worker, now } = await loadFixture(setup);
    await badge.revoke(1, "재교육");
    const vc2 = await make();
    await badge.issue(worker.address, FORKLIFT, now + 365 * DAY, vcHash(vc2));
    const old = await verifyVC(vc, badge);
    expect(failed(old)).to.deep.equal(["status"]);      // 지문은 옛 배지 #1 과 맞지만
    expect(old.tokenId).to.equal(1);                     // 새 배지(#2)가 아니라 옛 배지를 기준으로 판단
    expect(old.steps.at(-1).detail).to.include("정지");
    expect(old.steps.at(-1).detail).to.include("#2");
    expect((await verifyVC(vc2, badge)).ok).to.equal(true);
  });
});
