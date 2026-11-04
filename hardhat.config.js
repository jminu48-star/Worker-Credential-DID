require("@nomicfoundation/hardhat-toolbox");
require("./tasks/badge"); // wallet, badge:deploy, badge:issue, badge:verify ... (tasks/badge.js)

// Sepolia 배포 때만 쓰는 값 — 개인키는 코드에 쓰지 말고 .env 파일에 (.env 는 git·공유 금지)
try { require("dotenv").config({ quiet: true }); } catch {}
const SEPOLIA_RPC_URL = (process.env.SEPOLIA_RPC_URL || "").trim();
let PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
if (PRIVATE_KEY && !PRIVATE_KEY.startsWith("0x")) PRIVATE_KEY = "0x" + PRIVATE_KEY; // MetaMask 에서 복사하면 0x 가 없음
if (PRIVATE_KEY && !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  console.warn("[!] .env 의 PRIVATE_KEY 형식이 이상해요 (16진수 64자리여야 함). Sepolia 설정을 건너뜁니다.");
  PRIVATE_KEY = "";
}

// 프로그램(app/server.js) 기록 복원용: 저장된 기록이 있으면 가상 블록체인을 첫 기록 직전 시각에서 시작한다
let initialDate;
try {
  const j = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "data", "journal.json"), "utf8"));
  if (j.length && j[0].ts) initialDate = new Date((j[0].ts - 60) * 1000).toISOString();
} catch {}

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: initialDate ? { initialDate } : {},
    ...(SEPOLIA_RPC_URL && PRIVATE_KEY
      ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [PRIVATE_KEY], chainId: 11155111 } }
      : {}),
  },
  gasReporter: { enabled: !!process.env.REPORT_GAS },
};

// 이 실습 환경은 컴파일러 다운로드 서버에 접속할 수 없어 npm 의 solc(solcjs)를 대신 쓴다.
// 일반 PC 에서는 이 블록이 없어도 Hardhat 이 컴파일러를 알아서 내려받는다.
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24" && process.env.USE_LOCAL_SOLC) {
    const compilerPath = require.resolve("solc/soljson.js");
    return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion: require("solc/package.json").version };
  }
  return runSuper();
});
