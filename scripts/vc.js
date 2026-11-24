// 검증가능 자격증명(VC) 발급·검증 모듈 (2단계)
//
// 역할 나누기
//   - 체인(WorkerBadge): "지금 유효한가"(정지·만료)와 VC 지문(vcHash)만 저장 — 누구나 읽으므로 개인정보 없음
//   - VC(JSON 파일): 이름·자격번호·발급기관 같은 "내용". 작업자 지갑(또는 파일)에만 보관
//   - 연결고리: 체인의 vcHash == keccak256(VC 원문)  →  VC를 한 글자라도 바꾸면 체인과 안 맞음
//
// 형식: W3C VC Data Model 2.0 모양 + EIP-712 서명(EthereumEip712Signature2021 방식)
// DID: did:pkh:eip155:<체인ID>:<지갑주소>  (지갑 주소를 그대로 DID로 쓰는 방식 — 별도 등록 불필요)
const { ethers } = require("ethers");
const crypto = require("crypto");

const TYPE_KEYS = ["FORKLIFT", "CRANE", "HAZMAT", "SAFETY_EDU"];
const TYPE_NAMES = ["지게차 면허", "크레인 면허", "위험물 취급", "안전교육 이수"];

const EIP712_TYPES = {
  Credential: [
    { name: "id", type: "string" },
    { name: "subject", type: "address" },
    { name: "badgeType", type: "uint8" },
    { name: "validFrom", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "documentHash", type: "bytes32" }, // 서명 부분(proof)을 뺀 VC 전체의 지문
  ],
};

const didOf = (chainId, addr) => `did:pkh:eip155:${chainId}:${ethers.getAddress(addr)}`;
function parseDid(did) {
  const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(did || ""));
  if (!m) return null;
  return { chainId: Number(m[1]), address: ethers.getAddress(m[2]) };
}

// 키 순서를 정렬한 JSON — 같은 내용이면 누가 만들어도 같은 문자열(같은 해시)이 나오게
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const keccakJSON = (v) => ethers.keccak256(ethers.toUtf8Bytes(canonical(v)));

/** 체인에 올릴 지문: 서명까지 포함한 VC 원문 전체의 해시 */
const vcHash = (vc) => keccakJSON(vc);

const toSec = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const toISO = (sec) => new Date(Number(sec) * 1000).toISOString().replace(".000Z", "Z");

function domainOf(chainId, contract) {
  return { name: "WorkerBadge VC", version: "1", chainId: Number(chainId), verifyingContract: ethers.getAddress(contract) };
}

function messageOf(vc) {
  const { proof, ...unsigned } = vc;
  return {
    id: vc.id,
    subject: parseDid(vc.credentialSubject?.id)?.address ?? ethers.ZeroAddress,
    badgeType: TYPE_KEYS.indexOf(vc.credentialSubject?.badgeType),
    validFrom: toSec(vc.validFrom),
    validUntil: toSec(vc.validUntil),
    documentHash: keccakJSON(unsigned),
  };
}

/**
 * 발급기관이 VC를 만들고 서명한다. (체인 발급은 따로: badge.issue(worker, type, validUntil, vcHash(vc)))
 * @param claims 체인에는 안 올라가는 내용 — 이름, 자격번호, 발급기관 이름 등
 */
async function createVC({ issuerSigner, chainId, contract, worker, badgeType, validFrom, validUntil, claims = {}, id }) {
  const issuerAddr = await issuerSigner.getAddress();
  const vc = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: id || `urn:uuid:${crypto.randomUUID()}`, // 무작위 ID — 같은 내용이라도 해시를 추측할 수 없게
    type: ["VerifiableCredential", "WorkerQualificationCredential"],
    issuer: didOf(chainId, issuerAddr),
    validFrom: toISO(validFrom),
    validUntil: toISO(validUntil),
    credentialSubject: {
      id: didOf(chainId, worker),
      badgeType: TYPE_KEYS[badgeType],
      badgeName: TYPE_NAMES[badgeType],
      ...claims,
    },
    credentialStatus: {
      type: "WorkerBadgeOnChainStatus", // 유효 여부는 이 컨트랙트의 isValid 로 확인
      chainId: Number(chainId),
      contract: ethers.getAddress(contract),
    },
  };
  const domain = domainOf(chainId, contract);
  const signature = await issuerSigner.signTypedData(domain, EIP712_TYPES, messageOf(vc));
  vc.proof = {
    type: "EthereumEip712Signature2021",
    created: toISO(validFrom),
    proofPurpose: "assertionMethod",
    verificationMethod: `${vc.issuer}#blockchainAccountId`,
    eip712: { domain, primaryType: "Credential" },
    proofValue: signature,
  };
  return vc;
}

/**
 * VC 검증. 단계별 결과를 돌려준다(화면·논문 표에 그대로 쓰기 좋게).
 * 1 형식 → 2 서명 → 3 이 컨트랙트용인지 → 4 발급 권한 → 5 체인 지문 일치 → 6 그 배지의 현재 상태
 * @param opts.fromBlock 로그 조회 시작 블록 (테스트넷에서는 배포 블록을 주면 빠름)
 */
async function verifyVC(vc, badge, opts = {}) {
  const steps = [];
  const add = (key, label, ok, detail) => { steps.push({ key, label, ok, detail }); return ok; };
  const finish = (extra = {}) => ({ ok: steps.every((s) => s.ok), steps, hash: safeHash(vc), ...extra });

  // 1. 형식
  const subj = parseDid(vc?.credentialSubject?.id);
  const iss = parseDid(vc?.issuer);
  const typeIdx = TYPE_KEYS.indexOf(vc?.credentialSubject?.badgeType);
  const formatOk = !!(vc && Array.isArray(vc.type) && vc.type.includes("VerifiableCredential") && subj && iss && typeIdx >= 0 && vc.proof?.proofValue && vc.proof?.eip712?.domain);
  if (!add("format", "형식 확인", formatOk, formatOk ? "VC 필수 항목이 모두 있음" : "필수 항목(발급자·대상자 DID·배지 종류·서명)이 빠졌거나 잘못됨")) return finish();

  // 2. 서명 → 서명한 사람 주소 복원
  let recovered = null;
  try { recovered = ethers.verifyTypedData(vc.proof.eip712.domain, EIP712_TYPES, messageOf(vc), vc.proof.proofValue); } catch {}
  const sigOk = !!recovered && recovered === iss.address;
  add("signature", "발급기관 서명", sigOk,
    sigOk ? `서명자 ${recovered} = VC에 적힌 발급자` : recovered ? `서명자(${short(recovered)})가 VC에 적힌 발급자(${short(iss.address)})와 다름 → 내용이 바뀌었거나 위조` : "서명을 해석할 수 없음");

  // 3. 이 컨트랙트·이 체인용 VC인가 (다른 배포본에서 만든 VC 재사용 방지)
  const addr = await badge.getAddress();
  const net = await badge.runner.provider.getNetwork();
  const d = vc.proof.eip712.domain;
  const domOk = String(d.verifyingContract).toLowerCase() === addr.toLowerCase() && Number(d.chainId) === Number(net.chainId)
    && Number(vc.credentialStatus?.chainId) === Number(net.chainId) && String(vc.credentialStatus?.contract).toLowerCase() === addr.toLowerCase();
  add("domain", "이 시스템용 VC", domOk, domOk ? `체인 ${net.chainId}, 컨트랙트 ${short(addr)}` : "다른 체인이나 다른 컨트랙트용으로 만든 VC");

  // 4. 서명자가 지금 발급 권한(ISSUER_ROLE)을 갖고 있는가
  const role = await badge.ISSUER_ROLE();
  const roleOk = !!recovered && (await badge.hasRole(role, recovered));
  add("issuerRole", "발급 권한 보유", roleOk, roleOk ? "서명자가 컨트랙트의 ISSUER_ROLE 보유"
    : !sigOk ? "서명이 내용과 맞지 않아 진짜 발급자를 확인할 수 없음" : "서명자에게 발급 권한이 없음 (아무나 만든 가짜 VC)");

  // 5. 이 VC의 지문이 체인에 기록돼 있는가 — 이 작업자에게 발급된 배지들 중 vcHash 가 같은 것을 찾는다
  //    (현재 배지만 보면, 재발급 후 옛 VC를 검사할 때 새 배지의 상태를 잘못 보여 주게 됨)
  const hash = safeHash(vc);
  const currentId = Number(await badge.badgeOf(subj.address, typeIdx));
  let tokenId = 0;
  if (currentId && (await badge.badges(currentId)).vcHash === hash) tokenId = currentId;
  if (!tokenId) {
    try {
      const logs = await badge.queryFilter(badge.filters.BadgeIssued(null, subj.address), opts.fromBlock ?? 0);
      const hit = logs.find((l) => l.args.vcHash === hash && Number(l.args.badgeType) === typeIdx);
      if (hit) tokenId = Number(hit.args.tokenId);
    } catch { /* 일부 RPC는 오래된 로그 조회를 막음 → 현재 배지 기준으로만 판단 */ }
  }
  let onchain = null;
  if (tokenId) {
    onchain = await badge.badges(tokenId);
    if ((await badge.ownerOf(tokenId)) !== subj.address) tokenId = 0;
  }
  add("anchor", "체인 지문 일치", !!tokenId,
    tokenId ? `배지 #${tokenId} 의 vcHash 와 일치`
      : currentId ? `체인에 이 VC의 지문이 없음 (현재 배지 #${currentId} 와도 다름) → 내용이 바뀌었거나 위조`
      : "이 작업자에게 해당 종류 배지가 발급된 기록이 없음");

  // 6. 그 배지가 지금 유효한가 (정지·만료는 체인이 기준 — VC 파일은 스스로 정지될 수 없으므로)
  let statusOk = false, statusDetail = "이 VC에 해당하는 배지가 없어 확인 불가";
  if (tokenId) {
    const now = (await badge.runner.provider.getBlock("latest")).timestamp;
    const replaced = currentId !== tokenId;
    statusOk = !replaced && (await badge.isValid(tokenId));
    statusDetail = onchain.revoked ? `발급기관이 정지한 배지${replaced && currentId ? ` (지금은 새 배지 #${currentId} 로 재발급됨 → 새 VC를 내야 함)` : ""}`
      : replaced ? `새 배지 #${currentId} 로 교체된 옛 VC`
      : Number(onchain.expiresAt) <= now ? `만료됨 (${toISO(onchain.expiresAt).slice(0, 10)})`
      : `유효 — 만료 ${toISO(onchain.expiresAt).slice(0, 10)}${Number(onchain.expiresAt) > toSec(vc.validUntil) + 60 ? " (체인에서 연장됨)" : ""}`;
  }
  add("status", "체인상 배지 유효", statusOk, statusDetail);

  return finish({ tokenId: tokenId || null, worker: subj.address, issuer: recovered });
}

// ───────── VP (검증가능 제시) ─────────
// 작업자가 휴대폰에 보관한 VC를 검증자에게 낼 때, "지금 이 VC의 주인이 직접 낸다"는 것을 휴대폰 지갑 서명으로 증명한다.
//   검증자가 일회용 질문(challenge)을 주고 → 휴대폰이 VC + 질문 + 검증자 이름에 서명 → 검증자가 확인
//   VC 파일만 복사해 간 사람은 작업자 개인 키가 없어서 VP를 만들 수 없다. 남이 낸 VP를 다시 내도 질문이 이미 쓰여 거부된다.
const VP_TYPES = {
  Presentation: [
    { name: "holder", type: "address" },
    { name: "challenge", type: "string" },
    { name: "domain", type: "string" },     // 검증자 이름 — 다른 검증자에게 그대로 다시 내는 것을 막음
    { name: "documentHash", type: "bytes32" }, // 서명 부분(proof)을 뺀 VP 전체(안의 VC 포함)의 지문
  ],
};
const vpDomainOf = (chainId) => ({ name: "WorkerBadge VP", version: "1", chainId: Number(chainId) });
function vpMessageOf(vp) {
  const { proof, ...unsigned } = vp || {};
  return {
    holder: parseDid(vp?.holder)?.address ?? ethers.ZeroAddress,
    challenge: String(proof?.challenge ?? ""),
    domain: String(proof?.domain ?? ""),
    documentHash: keccakJSON(unsigned),
  };
}
/** 휴대폰(작업자)이 VP를 만든다. 브라우저의 app/public/worker.html 도 똑같이 만든다 */
async function createVP({ holderSigner, chainId, vcs, challenge, domain, created }) {
  const holder = didOf(chainId, await holderSigner.getAddress());
  const vp = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiablePresentation"],
    holder,
    verifiableCredential: vcs,
  };
  const eip712 = { domain: vpDomainOf(chainId), primaryType: "Presentation" };
  const proof = { type: "EthereumEip712Signature2021", created: created || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    proofPurpose: "authentication", verificationMethod: `${holder}#blockchainAccountId`, challenge: String(challenge), domain: String(domain), eip712 };
  const signature = await holderSigner.signTypedData(eip712.domain, VP_TYPES, vpMessageOf({ ...vp, proof }));
  vp.proof = { ...proof, proofValue: signature };
  return vp;
}
/**
 * VP 검증: 형식 → 제시자 서명 → 일회용 질문 → 제시자 = VC 주인 → (VC마다) verifyVC 6단계
 * @param opts.challenge 검증자가 낸 질문 · opts.domain 검증자 이름 · opts.fresh {ok, detail} 질문이 아직 안 쓰였고 유효시간 안인지(서버가 판단)
 */
async function verifyVP(vp, badge, opts = {}) {
  const steps = [];
  const add = (key, label, ok, detail) => { steps.push({ key, label, ok, detail }); return ok; };
  const holder = parseDid(vp?.holder);
  const vcs = Array.isArray(vp?.verifiableCredential) ? vp.verifiableCredential : [];
  const net = await badge.runner.provider.getNetwork();
  const formatOk = !!(vp && Array.isArray(vp.type) && vp.type.includes("VerifiablePresentation") && holder && vcs.length > 0 && vcs.length <= 8
    && vp.proof?.proofValue && vp.proof?.eip712?.domain && holder.chainId === Number(net.chainId));
  if (!add("vpFormat", "VP 형식", formatOk, formatOk ? `제시자 DID와 VC ${vcs.length}개` : "VP 필수 항목(제시자 DID·VC·서명)이 빠졌거나 다른 체인용")) return { ok: false, steps, credentials: [] };

  let recovered = null;
  try { recovered = ethers.verifyTypedData(vp.proof.eip712.domain, VP_TYPES, vpMessageOf(vp), vp.proof.proofValue); } catch {}
  const domOk = Number(vp.proof.eip712.domain.chainId) === Number(net.chainId) && vp.proof.eip712.domain.name === "WorkerBadge VP";
  const sigOk = !!recovered && recovered === holder.address && domOk;
  add("holderSig", "제시자(작업자 휴대폰) 서명", sigOk, sigOk ? `서명자 ${short(recovered)} = 제시자 DID — 개인 키를 가진 본인이 냄`
    : recovered ? `서명자(${short(recovered)})가 제시자(${short(holder.address)})와 다름 → VP 내용이 바뀌었거나 남의 VC` : "서명을 해석할 수 없음");

  const chOk = !!opts.challenge && String(vp.proof.challenge) === String(opts.challenge) && String(vp.proof.domain) === String(opts.domain ?? vp.proof.domain);
  const fresh = opts.fresh || { ok: true, detail: "" };
  add("challenge", "일회용 질문 확인", chOk && fresh.ok,
    !chOk ? "검증자가 낸 질문·검증자 이름과 다름 (다른 곳에 낸 VP를 가져옴)" : !fresh.ok ? fresh.detail : `질문 ${String(opts.challenge).slice(0, 8)}… 일치 · 검증자 '${vp.proof.domain}'${fresh.detail ? " · " + fresh.detail : ""}`);

  const mine = vcs.every((vc) => parseDid(vc?.credentialSubject?.id)?.address === holder.address);
  add("holderIsSubject", "제시자 = VC 주인", mine, mine ? "모든 VC의 대상자 DID가 제시자와 같음" : "남의 VC가 섞여 있음 (VC 파일만 복사해 온 경우)");

  const credentials = [];
  for (const vc of vcs) credentials.push(await verifyVC(vc, badge, opts));
  const allVc = credentials.every((c) => c.ok);
  add("credentials", "안의 VC 검증 (6단계씩)", allVc, credentials.map((c, i) => `VC ${i + 1}${c.tokenId ? ` (배지 #${c.tokenId})` : ""}: ${c.ok ? "통과" : "실패 — " + c.steps.filter((x) => !x.ok).map((x) => x.label).join(", ")}`).join(" · "));
  return { ok: steps.every((s) => s.ok), steps, credentials, holder: holder.address };
}

function safeHash(vc) { try { return vcHash(vc); } catch { return null; } }
function short(h) { return h ? `${String(h).slice(0, 8)}…${String(h).slice(-6)}` : ""; }

module.exports = { createVC, verifyVC, vcHash, canonical, didOf, parseDid, TYPE_KEYS, TYPE_NAMES, EIP712_TYPES, createVP, verifyVP, VP_TYPES, vpDomainOf, vpMessageOf, keccakJSON };
