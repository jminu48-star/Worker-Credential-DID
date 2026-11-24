// 예전 방식 호환용. 이제는 이 명령을 쓰세요:  npx hardhat badge:deploy --network sepolia
const hre = require("hardhat");
hre.run("badge:deploy").catch((e) => { console.error(e.message || e); process.exitCode = 1; });
