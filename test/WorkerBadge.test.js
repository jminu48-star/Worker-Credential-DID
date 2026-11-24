const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { EquipmentVerifier, signChallenge } = require("../scripts/verifier");

const T = { FORKLIFT: 0, CRANE: 1, HAZMAT: 2, SAFETY_EDU: 3 };
const DAY = 24 * 60 * 60;
const FORKLIFT = ethers.id("FORKLIFT");

async function deploy() {
  const [admin, worker, other, issuer2] = await ethers.getSigners();
  const badge = await (await ethers.getContractFactory("WorkerBadge")).deploy(admin.address);
  const now = await time.latest();
  return { badge, admin, worker, other, issuer2, now };
}

describe("WorkerBadge", () => {
  describe("발급 (issue)", () => {
    it("발급기관이 배지를 발급하면 작업자가 소유하고 이벤트가 남는다", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      const vcHash = ethers.id("vc");
      await expect(badge.issue(worker.address, T.FORKLIFT, now + DAY, vcHash))
        .to.emit(badge, "BadgeIssued").withArgs(1, worker.address, T.FORKLIFT, now + DAY, vcHash)
        .and.to.emit(badge, "Locked").withArgs(1);
      expect(await badge.ownerOf(1)).to.equal(worker.address);
      expect(await badge.badgeOf(worker.address, T.FORKLIFT)).to.equal(1);
    });

    it("발급기관이 아니면 발급할 수 없다", async () => {
      const { badge, worker, other, now } = await loadFixture(deploy);
      await expect(badge.connect(other).issue(worker.address, T.FORKLIFT, now + DAY, ethers.ZeroHash))
        .to.be.revertedWithCustomError(badge, "AccessControlUnauthorizedAccount");
    });

    it("주소 0 과 이미 지난 만료일은 거부한다", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      await expect(badge.issue(ethers.ZeroAddress, T.FORKLIFT, now + DAY, ethers.ZeroHash))
        .to.be.revertedWithCustomError(badge, "ZeroAddress");
      await expect(badge.issue(worker.address, T.FORKLIFT, now, ethers.ZeroHash))
        .to.be.revertedWithCustomError(badge, "InvalidExpiry");
    });

    it("같은 종류의 유효한 배지가 있으면 중복 발급을 거부하고, 만료 후에는 재발급할 수 있다", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      await badge.issue(worker.address, T.FORKLIFT, now + DAY, ethers.ZeroHash);
      await expect(badge.issue(worker.address, T.FORKLIFT, now + 2 * DAY, ethers.ZeroHash))
        .to.be.revertedWithCustomError(badge, "AlreadyHasActiveBadge");
      await time.increase(2 * DAY);
      await expect(badge.issue(worker.address, T.FORKLIFT, (await time.latest()) + DAY, ethers.ZeroHash)).to.not.be.reverted;
    });

    it("관리자가 발급기관을 추가할 수 있다", async () => {
      const { badge, worker, issuer2, now } = await loadFixture(deploy);
      await badge.grantRole(await badge.ISSUER_ROLE(), issuer2.address);
      await expect(badge.connect(issuer2).issue(worker.address, T.CRANE, now + DAY, ethers.ZeroHash)).to.not.be.reverted;
    });
  });

  describe("양도 불가 (Soulbound)", () => {
    it("전송·승인 시도는 모두 거부된다", async () => {
      const { badge, worker, other, now } = await loadFixture(deploy);
      await badge.issue(worker.address, T.FORKLIFT, now + DAY, ethers.ZeroHash);
      await expect(badge.connect(worker).transferFrom(worker.address, other.address, 1)).to.be.revertedWithCustomError(badge, "Soulbound");
      await expect(badge.connect(worker)["safeTransferFrom(address,address,uint256)"](worker.address, other.address, 1)).to.be.revertedWithCustomError(badge, "Soulbound");
      await expect(badge.connect(worker).approve(other.address, 1)).to.be.revertedWithCustomError(badge, "Soulbound");
      await expect(badge.connect(worker).setApprovalForAll(other.address, true)).to.be.revertedWithCustomError(badge, "Soulbound");
      expect(await badge.locked(1)).to.equal(true);
    });

    it("ERC-5192 인터페이스를 지원한다고 알린다", async () => {
      const { badge } = await loadFixture(deploy);
      expect(await badge.supportsInterface("0xb45a3c0e")).to.equal(true);
    });
  });

  describe("폐기·갱신 (revoke / renew)", () => {
    it("폐기하면 즉시 무효가 되고, 폐기된 배지는 연장할 수 없다", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      await badge.issue(worker.address, T.FORKLIFT, now + DAY, ethers.ZeroHash);
      await expect(badge.revoke(1, "사고")).to.emit(badge, "BadgeRevoked").withArgs(1, worker.address, "사고");
      expect(await badge.isValid(1)).to.equal(false);
      await expect(badge.revoke(1, "중복")).to.be.revertedWithCustomError(badge, "BadgeAlreadyRevoked");
      await expect(badge.renew(1, now + 10 * DAY)).to.be.revertedWithCustomError(badge, "BadgeAlreadyRevoked");
    });

    it("연장은 기존보다 늦은 날짜로만 가능하다", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      await badge.issue(worker.address, T.FORKLIFT, now + 5 * DAY, ethers.ZeroHash);
      await expect(badge.renew(1, now + 3 * DAY)).to.be.revertedWithCustomError(badge, "InvalidExpiry");
      await expect(badge.renew(1, now + 30 * DAY)).to.emit(badge, "BadgeRenewed");
    });

    it("없는 배지는 BadgeNotFound", async () => {
      const { badge, now } = await loadFixture(deploy);
      await expect(badge.revoke(99, "x")).to.be.revertedWithCustomError(badge, "BadgeNotFound");
      await expect(badge.renew(99, now + DAY)).to.be.revertedWithCustomError(badge, "BadgeNotFound");
    });
  });

  describe("장비 접근 판단 (isQualified)", () => {
    it("지게차는 지게차 면허 + 안전교육이 둘 다 유효해야 한다", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      expect(await badge.isQualified(worker.address, FORKLIFT)).to.equal(false);
      await badge.issue(worker.address, T.FORKLIFT, now + 10 * DAY, ethers.ZeroHash);
      expect(await badge.isQualified(worker.address, FORKLIFT)).to.equal(false); // 교육 없음
      await badge.issue(worker.address, T.SAFETY_EDU, now + 2 * DAY, ethers.ZeroHash);
      expect(await badge.isQualified(worker.address, FORKLIFT)).to.equal(true);
      await time.increase(3 * DAY); // 교육 배지만 만료
      expect(await badge.isQualified(worker.address, FORKLIFT)).to.equal(false);
    });

    it("규칙이 없는 장비는 기본 거부, 관리자는 규칙을 바꿀 수 있다", async () => {
      const { badge, worker, other, now } = await loadFixture(deploy);
      const AGV = ethers.id("AGV");
      await badge.issue(worker.address, T.SAFETY_EDU, now + DAY, ethers.ZeroHash);
      expect(await badge.isQualified(worker.address, AGV)).to.equal(false);
      await expect(badge.connect(other).setRequirement(AGV, [T.SAFETY_EDU])).to.be.revertedWithCustomError(badge, "AccessControlUnauthorizedAccount");
      await expect(badge.setRequirement(AGV, [])).to.be.revertedWithCustomError(badge, "EmptyRequirement");
      await badge.setRequirement(AGV, [T.SAFETY_EDU]);
      expect(await badge.isQualified(worker.address, AGV)).to.equal(true);
    });
  });

  describe("장비 검증기 (오프체인 challenge-response)", () => {
    it("정상 서명은 허용, 같은 서명 재사용은 거부", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      await badge.issue(worker.address, T.FORKLIFT, now + DAY, ethers.ZeroHash);
      await badge.issue(worker.address, T.SAFETY_EDU, now + DAY, ethers.ZeroHash);
      const v = new EquipmentVerifier(badge, "FL-001", "FORKLIFT");
      const { nonce, typedData } = await v.createChallenge();
      const sig = await signChallenge(worker, typedData);
      expect((await v.verify(nonce, sig)).allowed).to.equal(true);
      expect((await v.verify(nonce, sig)).allowed).to.equal(false);
    });

    it("다른 장비용 challenge 에 대한 서명은 이 장비에서 통하지 않는다", async () => {
      const { badge, worker, now } = await loadFixture(deploy);
      await badge.issue(worker.address, T.FORKLIFT, now + DAY, ethers.ZeroHash);
      await badge.issue(worker.address, T.SAFETY_EDU, now + DAY, ethers.ZeroHash);
      const a = new EquipmentVerifier(badge, "FL-001", "FORKLIFT");
      const b = new EquipmentVerifier(badge, "FL-002", "FORKLIFT");
      const { nonce, typedData } = await a.createChallenge();
      const sig = await signChallenge(worker, typedData);
      expect((await b.verify(nonce, sig)).allowed).to.equal(false);
    });

    it("EIP-712: 다른 컨트랙트(배포본)용으로 만든 서명이나 만료 시각을 고친 서명은 통하지 않는다", async () => {
      const { badge, admin, worker, now } = await loadFixture(deploy);
      await badge.issue(worker.address, T.FORKLIFT, now + DAY, ethers.ZeroHash);
      await badge.issue(worker.address, T.SAFETY_EDU, now + DAY, ethers.ZeroHash);
      const v = new EquipmentVerifier(badge, "FL-001", "FORKLIFT");
      const other = await (await ethers.getContractFactory("WorkerBadge")).deploy(admin.address);

      const c1 = await v.createChallenge();
      const wrongDomain = { ...c1.typedData, domain: { ...c1.typedData.domain, verifyingContract: await other.getAddress() } };
      const r1 = await v.verify(c1.nonce, await signChallenge(worker, wrongDomain));
      expect(r1.allowed).to.equal(false);
      expect(r1.worker).to.not.equal(worker.address); // 엉뚱한 주소가 복원된다

      const c2 = await v.createChallenge();
      const longer = { ...c2.typedData, message: { ...c2.typedData.message, expiresAt: c2.expiresAt + 86400 } };
      expect((await v.verify(c2.nonce, await signChallenge(worker, longer))).allowed).to.equal(false);

      const c3 = await v.createChallenge();
      expect(c3.typedData.domain.verifyingContract).to.equal(await badge.getAddress());
      expect((await v.verify(c3.nonce, await signChallenge(worker, c3.typedData))).allowed).to.equal(true);
    });
  });
});
