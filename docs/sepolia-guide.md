# Sepolia 테스트넷에 올리기 — 처음부터 따라 하기

**Sepolia**는 이더리움 연습용 네트워크예요. 진짜 이더리움과 똑같이 동작하지만, 쓰는 ETH는 무료로 받는 가짜 돈이에요.
여기에 올리면 **누구나 Etherscan(블록 탐색기)에서 우리 컨트랙트와 발급 기록을 볼 수 있어서** 발표·논문 증거로 쓰기 좋아요.

걸리는 시간: 처음이면 30분 정도

---

## 1. MetaMask 테스트 지갑 만들기 (10분)

1. Chrome에서 **metamask.io**에 들어가 확장 프로그램을 설치하세요. 주소가 진짜 metamask.io인지 꼭 확인하세요(가짜 사이트가 많아요).
2. **새 지갑 만들기**를 누르고, 비밀번호를 정하세요.
3. **비밀 복구 구문(단어 12개)** 은 종이에 적어 두세요. 사진을 찍거나 카톡으로 보내지 마세요.
4. 이미 MetaMask에 진짜 돈이 든 지갑이 있다면, 그 지갑은 쓰지 마세요. **계정 추가**로 수업용 계정을 따로 만드세요.

**계정을 2개 만들어 두세요.**

| 계정 | 역할 | ETH 필요? |
|---|---|---|
| 계정 1 | **발급기관(관리자)** — 배포하고 배지를 발급 | 필요 |
| 계정 2 | **작업자** — 배지를 받는 사람 | 필요 없음 |

## 2. Sepolia 네트워크 보이게 하기

1. MetaMask 왼쪽 위의 **네트워크 선택**을 누르세요.
2. **테스트 네트워크 표시**를 켜세요.
3. **Sepolia**를 고르세요.

## 3. 테스트 ETH 받기 (Faucet)

계정 1 주소(0x로 시작)를 복사해서 아래 중 한 곳에 넣으세요.

| 사이트 | 필요한 것 | 메모 |
|---|---|---|
| **Google Cloud Web3 Faucet**<br>cloud.google.com/application/web3/faucet/ethereum/sepolia | Google 계정 | 하루 1번, 약 0.05 ETH |
| **Alchemy Faucet**<br>alchemy.com/faucets/ethereum-sepolia | Alchemy 무료 가입 | 진짜 이더리움 지갑에 소량의 잔액을 요구할 때가 있어요 |

- 한 번만 받아도 배포 1번 + 발급 수십 번은 보통 충분해요. 배포 약 210만 gas, 발급 약 15만 gas가 들어요.
- 1~2분 뒤 MetaMask에 잔액이 보이면 성공이에요.
- Faucet 조건은 자주 바뀌어요. 안 되면 "Sepolia faucet"으로 검색해서 다른 곳을 쓰세요.

## 4. `.env` 파일 만들기 (개인키 넣기)

1. 프로젝트 폴더에서 `.env.example`을 복사하고, 이름을 **`.env`** 로 바꾸세요.
   - 메모장으로 저장할 때는 "파일 형식"을 **모든 파일**로 고르세요. 그래야 `.env.txt`가 되지 않아요.
2. MetaMask에서 **계정 1**을 고르고 **계정 세부 정보 → 개인 키 보기**에서 개인키를 복사하세요.
3. `.env`의 `PRIVATE_KEY=` 뒤에 붙여 넣으세요. `0x`는 없어도 돼요.

```
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
PRIVATE_KEY=여기에붙여넣기
```

> ⚠ **`.env`는 절대 다른 사람에게 보내거나 git에 올리지 마세요.** 이 키를 가진 사람은 우리 컨트랙트의 관리자가 돼요.
> 이미 `.gitignore`에 들어 있어서 git에는 안 올라가요. 대신 **폴더를 zip으로 묶어서 보낼 때는 직접 빼야 해요.**

RPC(블록체인 접속 주소)가 느리거나 오류가 나면 Alchemy나 Infura에 무료로 가입하세요. Sepolia용 주소를 받아서 `SEPOLIA_RPC_URL`을 바꾸면 돼요.

## 5. 명령 실행

폴더의 주소창에 `cmd`를 입력하고 Enter를 누르세요. 그 폴더에서 **명령 프롬프트**가 열려요.
PowerShell에서 `npm.ps1` 오류가 나면 cmd를 쓰세요.

### ① 지갑 확인

```
npm run sepolia:wallet
```

`체인 ID 11155111`과 잔액이 보이면 준비 끝이에요.

### ② 배포 (1번만)

```
npm run sepolia:deploy
```

- 주소와 Etherscan 링크가 나오고, `deployments/sepolia.json`에 저장돼요.
- 이 지갑(계정 1)이 관리자이자 발급기관이에요.

### ③ 배지 발급 + VC 만들기

계정 2(작업자) 주소를 넣으세요. `--` 뒤에 옵션을 적어요.

```
npm run sepolia:issue -- --worker 0x작업자주소 --type 3 --days 365 --name "홍길동"
npm run sepolia:issue -- --worker 0x작업자주소 --type 0 --days 365 --name "홍길동" --cert "FL-2026-0001"
```

- 종류 번호: `0` 지게차 · `1` 크레인 · `2` 위험물 · `3` 안전교육
- 서명된 VC 파일이 `vcs/sepolia-<배지번호>.json`에 생겨요. **이 파일을 작업자에게 주는 거예요.**
- 이름은 VC 파일에만 들어가고, 체인에는 지문(해시)만 올라가요.

### ④ 확인

```
npm run sepolia:status -- --worker 0x작업자주소
npm run sepolia:verify -- --file vcs/sepolia-1.json
```

`status`는 장비별로 조작 가능 여부를 보여 줘요. `verify`는 VC의 6단계 검증 결과를 보여 줘요.

### ⑤ 그 밖의 명령

```
npx hardhat badge:revoke --id 1 --reason "사고" --network sepolia
npx hardhat badge:renew --id 1 --days 365 --network sepolia
npx hardhat badge:grant-issuer --account 0x팀원주소 --network sepolia
```

`grant-issuer`는 팀원에게 발급 권한을 주는 명령이에요.

## 6. Etherscan에서 보기 (발표·논문 증거)

`https://sepolia.etherscan.io/address/<컨트랙트주소>`에 들어가세요.

| 탭 | 볼 수 있는 것 |
|---|---|
| Transactions | 배포·발급·정지 기록과 가스비 |
| Events | `BadgeIssued`·`BadgeRevoked` 이벤트 — vcHash만 있고 이름은 없는 것 확인 |

논문 표에 넣을 것: 컨트랙트 주소, 각 tx 해시, 가스 사용량, 블록 확정까지 걸린 시간

## 7. 문제 해결

| 이런 오류가 나면 | 이렇게 하세요 |
|---|---|
| `HH100: Network sepolia doesn't exist` | `.env`가 없거나 이름이 `.env.txt`예요. 아니면 `PRIVATE_KEY`가 비어 있어요. |
| `PRIVATE_KEY 형식이 이상해요` | 개인키를 다시 복사하세요. 16진수 64자리여야 해요. 복구 구문(단어 12개)을 넣으면 안 돼요. |
| `insufficient funds` | 테스트 ETH가 부족해요. 3번으로 돌아가세요. |
| `AccessControlUnauthorizedAccount` | 배포한 지갑이 아닌 다른 지갑으로 실행했어요. |
| `배포 기록이 없어요` | ② 배포를 먼저 하세요. 다른 컴퓨터라면 `deployments/sepolia.json`을 복사해 오세요. |
| 오래 기다려도 안 끝남 / timeout | RPC를 Alchemy·Infura 주소로 바꾸세요. |
| `AlreadyHasActiveBadge` | 같은 종류의 유효한 배지가 이미 있어요. 연장(renew)을 쓰세요. |

## 8. 보안 체크

- [ ] 수업용으로 새로 만든 지갑만 쓴다
- [ ] `.env`는 공유·업로드하지 않는다. zip으로 보낼 때도 뺀다
- [ ] `vcs/` 폴더(이름이 든 VC)도 git에 올리지 않는다. 이미 `.gitignore`에 있다
- [ ] 체인에는 이름·주민번호를 넣지 않는다. 지금 코드는 해시만 넣는다
