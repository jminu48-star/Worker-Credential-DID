const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { createVC, vcHash, createVP, verifyVP } = require("../scripts/vc");

// VP: 휴대폰에 보관한 VC를 작업자 본인이 서명해서 제시 (일회용 질문 + 검증자 이름)
const DAY = 24 * 60 * 60;
async function setup() {
  const [admin, worker, thief] = await ethers.getSigners();
  const badge = await (await ethers.getContractFactory("WorkerBadge")).deploy(admin.address);
  const now = await time.latest();
  const { chainId } = await ethers.provider.getNetwork();
  const vc = await createVC({ issuerSigner: admin, chainId, contract: await badge.getAddress(), worker: worker.address, badgeType: 0,
    validFrom: now, validUntil: now + 365 * DAY, claims: { name: "민우" } });
  await badge.issue(worker.address, 0, now + 365 * DAY, vcHash(vc));
  return { badge, admin, worker, thief, vc, chainId };
}
const failed = (r) => r.steps.filter((s) => !s.ok).map((s) => s.key);
const CH = "a1b2c3d4e5f60718293a4b5c6d7e8f90", DOM = "현장 감독관(예시)";

describe("VP (휴대폰 보관 VC 제시)", () => {
  it("VC 주인이 질문에 서명해 낸 VP는 모든 단계를 통과한다", async () => {
    const { badge, worker, vc, chainId } = await loadFixture(setup);
    const vp = await createVP({ holderSigner: worker, chainId, vcs: [vc], challenge: CH, domain: DOM });
    const r = await verifyVP(vp, badge, { challenge: CH, domain: DOM });
    expect(failed(r)).to.deep.equal([]);
    expect(r.ok).to.equal(true);
    expect(r.credentials[0].tokenId).to.equal(1);
  });
  it("VC 파일만 훔친 사람은 자기 키로 VP를 만들어도 거부된다 (제시자 ≠ VC 주인)", async () => {
    const { badge, thief, vc, chainId } = await loadFixture(setup);
    const vp = await createVP({ holderSigner: thief, chainId, vcs: [vc], challenge: CH, domain: DOM });
    expect(failed(await verifyVP(vp, badge, { challenge: CH, domain: DOM }))).to.include("holderIsSubject");
  });
  it("holder 를 VC 주인으로 바꿔 적어도 서명이 맞지 않아 거부된다", async () => {
    const { badge, thief, vc, chainId } = await loadFixture(setup);
    const vp = await createVP({ holderSigner: thief, chainId, vcs: [vc], challenge: CH, domain: DOM });
    vp.holder = vc.credentialSubject.id;
    expect(failed(await verifyVP(vp, badge, { challenge: CH, domain: DOM }))).to.include("holderSig");
  });
  it("다른 질문(또는 다른 검증자)에 낸 VP를 가져오면 거부된다", async () => {
    const { badge, worker, vc, chainId } = await loadFixture(setup);
    const vp = await createVP({ holderSigner: worker, chainId, vcs: [vc], challenge: CH, domain: DOM });
    expect(failed(await verifyVP(vp, badge, { challenge: "ffff" + CH.slice(4), domain: DOM }))).to.include("challenge");
    expect(failed(await verifyVP(vp, badge, { challenge: CH, domain: "다른 회사" }))).to.include("challenge");
    const used = await verifyVP(vp, badge, { challenge: CH, domain: DOM, fresh: { ok: false, detail: "이미 쓴 질문" } });
    expect(failed(used)).to.deep.equal(["challenge"]);
  });
  it("VP 안의 VC 내용을 바꾸면 제시자 서명과 VC 검증이 모두 깨진다", async () => {
    const { badge, worker, vc, chainId } = await loadFixture(setup);
    const vp = await createVP({ holderSigner: worker, chainId, vcs: [vc], challenge: CH, domain: DOM });
    vp.verifiableCredential[0].credentialSubject.name = "가짜";
    expect(failed(await verifyVP(vp, badge, { challenge: CH, domain: DOM }))).to.include.members(["holderSig", "credentials"]);
  });
  it("정지된 배지의 VC로 만든 VP는 서명이 맞아도 거부된다", async () => {
    const { badge, worker, vc, chainId } = await loadFixture(setup);
    await badge.revoke(1, "사고");
    const vp = await createVP({ holderSigner: worker, chainId, vcs: [vc], challenge: CH, domain: DOM });
    expect(failed(await verifyVP(vp, badge, { challenge: CH, domain: DOM }))).to.deep.equal(["credentials"]);
  });
});
