// 휴대폰 데이터(LTE·5G)로도 QR 인증이 되게: 무료 Cloudflare 터널로 이 PC 프로그램에 인터넷 https 주소를 붙인 뒤 서버를 켠다.
// 실제 도입 때는 이 자리에 회사 서버(클라우드)의 고정 주소가 들어간다.
//   npm run phone   (start.bat 이 기본으로 이걸 실행)
// 인터넷 주소를 못 만들면(학교·회사 네트워크 등) 같은 와이파이 전용 모드로 그냥 켠다.
// 아이디어 출처: 팀원 factory-sbt 의 scripts/phone.js
const PORT = Number(process.env.PORT || 3000);
const TUNNEL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

async function openTunnel() {
  const fs = require("fs");
  const { Tunnel, bin, install } = require("cloudflared");
  if (!fs.existsSync(bin)) {
    console.log("  터널 프로그램(cloudflared)을 처음 한 번 내려받는 중… (1분 정도)");
    await install(bin);
  }
  console.log("  휴대폰용 인터넷 주소를 만드는 중… (10~30초)");
  const tunnel = Tunnel.quick(`http://localhost:${PORT}`);
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("40초 안에 인터넷 주소를 받지 못했어요")), 40_000);
    const check = (t) => { const m = String(t).match(TUNNEL_RE); if (m) { clearTimeout(timer); resolve(m[0]); } };
    tunnel.on("url", check); tunnel.on("stderr", check); tunnel.on("stdout", check);
    tunnel.on("exit", (code) => { clearTimeout(timer); reject(new Error(`터널 프로그램이 종료됐어요 (코드 ${code})`)); });
  });
  const stop = () => { try { tunnel.stop(); } catch {} process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  return url;
}

(async () => {
  if (!process.env.NO_TUNNEL && !process.env.PUBLIC_URL) {
    try {
      process.env.PUBLIC_URL = await openTunnel();
      console.log(`  🌐 인터넷 주소: ${process.env.PUBLIC_URL}  (창을 껐다 켜면 주소가 바뀌어요 — QR 은 자동으로 새 주소를 써요)`);
    } catch (e) {
      console.log(`  [!] ${e.message}. 같은 와이파이 전용 모드로 켭니다. (PC를 휴대폰 핫스팟에 연결하면 휴대폰에서 접속돼요)`);
    }
  }
  require("../app/server.js");
})();
