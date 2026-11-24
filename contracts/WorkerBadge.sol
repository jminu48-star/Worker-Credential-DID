// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice ERC-5192 최소 Soulbound 인터페이스 — 이 토큰이 잠겨(양도 불가) 있는지 알려 준다
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);
    function locked(uint256 tokenId) external view returns (bool);
}

/// @title WorkerBadge — 작업자 자격·안전교육 이수를 양도 불가 배지(SBT)로 발급하고,
///        장비 종류별로 "이 사람이 조작해도 되는가"를 조회해 주는 컨트랙트
/// @dev 개인정보는 저장하지 않는다. 체인에는 배지 종류·만료일·폐기 여부·VC 해시만 둔다.
///      (블록체인 데이터는 private 변수까지 누구나 읽을 수 있으므로)
contract WorkerBadge is ERC721, AccessControl, IERC5192 {
    // ───────────── 역할 ─────────────
    /// @notice 배지를 발급·폐기·갱신할 수 있는 발급기관(예: 자격 기관, 사내 안전팀)
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    // ───────────── 데이터 ─────────────
    enum BadgeType { FORKLIFT, CRANE, HAZMAT, SAFETY_EDU }

    struct Badge {
        BadgeType badgeType; // 배지 종류
        uint64 expiresAt;    // 만료 시각(초). 며칠~년 단위 판단이라 block.timestamp 오차는 무시 가능
        bool revoked;        // 폐기(정지) 여부
        bytes32 vcHash;      // 오프체인 검증가능 자격증명(VC) 원문의 해시 — 원문은 체인에 올리지 않음
    }

    uint256 private _nextId = 1;
    mapping(uint256 => Badge) public badges;
    /// @notice 작업자별·종류별 "현재" 배지 번호 (0 = 없음)
    mapping(address => mapping(BadgeType => uint256)) public badgeOf;
    /// @notice 장비 종류(예: keccak256("FORKLIFT")) → 조작에 필요한 배지 목록
    mapping(bytes32 => BadgeType[]) private _requirements;

    // ───────────── 에러 (문자열보다 가스가 싸다) ─────────────
    error ZeroAddress();
    error InvalidExpiry(uint64 expiresAt);
    error AlreadyHasActiveBadge(address worker, BadgeType badgeType, uint256 tokenId);
    error BadgeNotFound(uint256 tokenId);
    error BadgeAlreadyRevoked(uint256 tokenId);
    error Soulbound(); // 양도·승인 시도
    error EmptyRequirement();

    // ───────────── 이벤트 (상태가 바뀔 때마다 기록) ─────────────
    event BadgeIssued(uint256 indexed tokenId, address indexed worker, BadgeType badgeType, uint64 expiresAt, bytes32 vcHash);
    event BadgeRevoked(uint256 indexed tokenId, address indexed worker, string reason);
    event BadgeRenewed(uint256 indexed tokenId, address indexed worker, uint64 newExpiresAt);
    event RequirementSet(bytes32 indexed equipmentType, BadgeType[] required);

    constructor(address admin) ERC721("Worker Qualification Badge", "WQB") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);

        // 기본 규칙: 장비 면허 + 안전교육 이수가 둘 다 유효해야 조작 가능
        BadgeType[] memory forklift = new BadgeType[](2);
        forklift[0] = BadgeType.FORKLIFT; forklift[1] = BadgeType.SAFETY_EDU;
        _setRequirement(keccak256("FORKLIFT"), forklift);

        BadgeType[] memory crane = new BadgeType[](2);
        crane[0] = BadgeType.CRANE; crane[1] = BadgeType.SAFETY_EDU;
        _setRequirement(keccak256("CRANE"), crane);

        BadgeType[] memory hazmat = new BadgeType[](2);
        hazmat[0] = BadgeType.HAZMAT; hazmat[1] = BadgeType.SAFETY_EDU;
        _setRequirement(keccak256("HAZMAT"), hazmat);
    }

    // ═════════════ 발급기관 기능 ═════════════

    /// @notice 배지 발급. 같은 종류의 유효한 배지가 이미 있으면 거부(연장은 renew 사용)
    function issue(address worker, BadgeType badgeType, uint64 expiresAt, bytes32 vcHash)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 tokenId)
    {
        // Checks
        if (worker == address(0)) revert ZeroAddress();
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt);
        uint256 current = badgeOf[worker][badgeType];
        if (current != 0 && _isValid(current)) revert AlreadyHasActiveBadge(worker, badgeType, current);

        // Effects
        tokenId = _nextId++;
        badges[tokenId] = Badge(badgeType, expiresAt, false, vcHash);
        badgeOf[worker][badgeType] = tokenId;

        // 발행: _safeMint 대신 _mint — 받는 쪽 코드를 호출하지 않아 재진입 지점이 없다
        _mint(worker, tokenId);

        emit Locked(tokenId);
        emit BadgeIssued(tokenId, worker, badgeType, expiresAt, vcHash);
    }

    /// @notice 배지 폐기(정지). 사고·부정·자격 취소 시
    function revoke(uint256 tokenId, string calldata reason) external onlyRole(ISSUER_ROLE) {
        address worker = _requireExists(tokenId);
        Badge storage b = badges[tokenId];
        if (b.revoked) revert BadgeAlreadyRevoked(tokenId);
        b.revoked = true;
        emit BadgeRevoked(tokenId, worker, reason);
    }

    /// @notice 만료일 연장(재교육 이수 등). 폐기된 배지는 연장 불가 — 새로 발급해야 함
    function renew(uint256 tokenId, uint64 newExpiresAt) external onlyRole(ISSUER_ROLE) {
        address worker = _requireExists(tokenId);
        Badge storage b = badges[tokenId];
        if (b.revoked) revert BadgeAlreadyRevoked(tokenId);
        if (newExpiresAt <= block.timestamp || newExpiresAt <= b.expiresAt) revert InvalidExpiry(newExpiresAt);
        b.expiresAt = newExpiresAt;
        emit BadgeRenewed(tokenId, worker, newExpiresAt);
    }

    /// @notice 장비 종류별 필요 배지 설정 (관리자만)
    function setRequirement(bytes32 equipmentType, BadgeType[] calldata required)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setRequirement(equipmentType, required);
    }

    // ═════════════ 조회 (view — 밖에서 부르면 가스비 없음) ═════════════

    /// @notice 이 배지가 지금 유효한가 (존재 + 미폐기 + 미만료)
    function isValid(uint256 tokenId) external view returns (bool) {
        return _isValid(tokenId);
    }

    /// @notice 작업자가 해당 종류의 유효한 배지를 가졌는가
    function hasValidBadge(address worker, BadgeType badgeType) public view returns (bool) {
        uint256 id = badgeOf[worker][badgeType];
        return id != 0 && _isValid(id);
    }

    /// @notice 장비 단말이 시동 전에 부르는 함수: 이 작업자가 이 장비를 조작해도 되는가
    function isQualified(address worker, bytes32 equipmentType) external view returns (bool) {
        BadgeType[] storage req = _requirements[equipmentType];
        if (req.length == 0) return false; // 규칙이 없는 장비는 기본 거부
        for (uint256 i = 0; i < req.length; i++) {   // 길이는 관리자가 정한 2~3개 — 무한 증가 없음
            if (!hasValidBadge(worker, req[i])) return false;
        }
        return true;
    }

    function requirementsOf(bytes32 equipmentType) external view returns (BadgeType[] memory) {
        return _requirements[equipmentType];
    }

    /// @inheritdoc IERC5192
    function locked(uint256 tokenId) external view returns (bool) {
        _requireExists(tokenId);
        return true; // 모든 배지는 항상 잠김(양도 불가)
    }

    // ═════════════ 양도 불가(Soulbound) 처리 ═════════════

    /// @dev 발행(from=0)만 허용하고 작업자 간 이동은 모두 거부
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @dev 승인 자체를 막아 "대리 전송" 시도도 원천 차단
    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return interfaceId == 0xb45a3c0e /* ERC-5192 */ || super.supportsInterface(interfaceId);
    }

    // ═════════════ 내부 함수 ═════════════

    function _isValid(uint256 tokenId) internal view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        Badge storage b = badges[tokenId];
        return !b.revoked && b.expiresAt > block.timestamp;
    }

    function _requireExists(uint256 tokenId) internal view returns (address owner) {
        owner = _ownerOf(tokenId);
        if (owner == address(0)) revert BadgeNotFound(tokenId);
    }

    function _setRequirement(bytes32 equipmentType, BadgeType[] memory required) internal {
        if (required.length == 0) revert EmptyRequirement();
        delete _requirements[equipmentType];
        for (uint256 i = 0; i < required.length; i++) {
            _requirements[equipmentType].push(required[i]);
        }
        emit RequirementSet(equipmentType, required);
    }
}
