// 장비 단말(문지기) 역할 — 실제 지게차 대신 이 코드가 시동 허용/거부를 판단한다.
// 흐름: ① 일회용 challenge 발급 → ② 작업자 지갑 서명(EIP-712) → ③ 서명에서 주소 복원 → ④ 체인 조회 → ⑤ 로그
//
// 서명 방식: EIP-712 (구조화 서명, MetaMask 의 eth_signTypedData_v4)
//  - 지갑 화면에 "장비 / nonce / 만료 시각"이 항목별로 보여서 무엇에 서명하는지 알 수 있다
//  - 서명에 체인 ID 와 컨트랙트 주소(domain)가 들어가서, 다른 체인·다른 배포본에서 같은 서명을 쓸 수 없다
//  - 만료 시각이 서명 안에 들어가서, 서명을 고쳐 유효 시간을 늘릴 수 없다
const { ethers } = require("ethers");
const crypto = require("crypto");

const CHALLENGE_TTL_SEC = 60; // challenge 하나의 서명 유효 시간 (QR 은 30초마다 바뀌고, 바뀌기 직전에 찍은 사람도 서명할 여유)

const ACCESS_TYPES = {
  Access: [
    { name: "equipmentId", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
};

class EquipmentVerifier {
  /**
   * @param {import("ethers").Contract} badge  WorkerBadge 컨트랙트(읽기 전용이면 충분)
   * @param {string} equipmentId               장비 고유 번호 (예: "FL-001")
   * @param {string} equipmentType             장비 종류 (예: "FORKLIFT")
   */
  constructor(badge, equipmentId, equipmentType) {
    this.badge = badge;
    this.equipmentId = equipmentId;
    this.equipmentType = equipmentType;
    this.typeHash = ethers.id(equipmentType); // keccak256("FORKLIFT")
    this.pending = new Map(); // nonce -> { expiresAt(초) }
    this.logs = [];
    this._domain = null;
  }

  /** 서명 domain: 이 체인·이 컨트랙트 전용 */
  async domain() {
    if (!this._domain) {
      const net = await this.badge.runner.provider.getNetwork();
      this._domain = { name: "WorkerBadge Access", version: "1", chainId: Number(net.chainId), verifyingContract: await this.badge.getAddress() };
    }
    return this._domain;
  }

  /** ① 매번 다른 일회용 값 — 녹화해 둔 서명을 다시 쓰는 공격(재사용)을 막는다 */
  async createChallenge() {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [n, c] of this.pending) if (c.expiresAt < nowSec) this.pending.delete(n); // 만료된 것 정리
    const nonce = ethers.hexlify(crypto.randomBytes(32));
    const expiresAt = nowSec + CHALLENGE_TTL_SEC;
    this.pending.set(nonce, { expiresAt });
    const typedData = { domain: await this.domain(), types: ACCESS_TYPES, primaryType: "Access", message: { equipmentId: this.equipmentId, nonce, expiresAt } };
    return { nonce, expiresAt, typedData };
  }

  /** 서명할 데이터 다시 만들기 (휴대폰이 QR 의 nonce 로 요청할 때) */
  async typedDataFor(nonce) {
    const c = this.pending.get(nonce);
    if (!c) return null;
    return { domain: await this.domain(), types: ACCESS_TYPES, primaryType: "Access", message: { equipmentId: this.equipmentId, nonce, expiresAt: c.expiresAt } };
  }

  /** ③~⑤ 서명을 검사하고 체인에 물어본 뒤 결과를 돌려준다 */
  async verify(nonce, signature) {
    const c = this.pending.get(nonce);
    if (!c) return this.#log(null, false, "모르는 challenge 이거나 이미 사용됨(재사용 차단)");
    this.pending.delete(nonce); // 한 번 쓰면 성공·실패와 상관없이 바로 폐기
    if (Math.floor(Date.now() / 1000) > c.expiresAt) return this.#log(null, false, "challenge 만료");

    let worker;
    try {
      worker = ethers.verifyTypedData(await this.domain(), ACCESS_TYPES, { equipmentId: this.equipmentId, nonce, expiresAt: c.expiresAt }, signature);
    } catch {
      return this.#log(null, false, "서명 형식 오류");
    }

    const t0 = performance.now();
    const ok = await this.badge.isQualified(worker, this.typeHash); // view 호출 — 가스비 없음
    const ms = performance.now() - t0;
    return this.#log(worker, ok, ok ? "유효한 자격 확인" : "필요한 배지가 없거나 만료·폐기됨", ms);
  }

  #log(worker, allowed, reason, ms) {
    const entry = { time: new Date().toISOString(), equipmentId: this.equipmentId, worker, allowed, reason, lookupMs: ms };
    this.logs.push(entry);
    return entry;
  }
}

/** 지갑(ethers Signer)으로 challenge 에 서명 — MetaMask 라면 eth_signTypedData_v4 와 같다 */
const signChallenge = (signer, typedData) => signer.signTypedData(typedData.domain, typedData.types, typedData.message);

module.exports = { EquipmentVerifier, ACCESS_TYPES, signChallenge, CHALLENGE_TTL_SEC };
