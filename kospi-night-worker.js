/* =====================================================================
 * kospi-night-worker.js — Cloudflare Worker
 * 코스피200 야간선물 값을 "브라우저에서" 쓸 수 있게 CORS를 붙여 JSON으로 내보냅니다.
 *
 * 왜 필요한가:
 *   index.html은 정적(브라우저) 앱이라 data.krx.co.kr·네이버를 직접 fetch하면
 *   CORS에 막힙니다. 이 워커가 서버 입장에서 대신 받아와 Access-Control-Allow-Origin을
 *   붙여 돌려주므로, 앱이 이 워커 주소만 fetch하면 됩니다.
 *
 * 배포:  WORKER_SETUP.md 참고 (대시보드 붙여넣기 or wrangler)
 * 사용:  배포된 주소를 index.html 의 KOSPI_NIGHT_PROXY_URL 에 넣으세요.
 * 디버그: 브라우저로  https://<주소>/?debug=1  → 각 소스가 뭘 받았는지 확인.
 *
 * ⚠️ 엔드포인트/HTML 구조는 자주 바뀝니다. ?debug=1 로 보고 아래 SOURCES의
 *    bld/파라미터·정규식만 조금 손보면 됩니다(프론트는 그대로 동작).
 * ===================================================================== */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const debug = new URL(req.url).searchParams.get("debug") === "1";
    const attempts = [];

    for (const src of SOURCES) {
      try {
        const data = await src.fn();
        const good = data && (isFinite(data.last) || isFinite(data.changePct));
        attempts.push({ source: src.name, ok: !!good, data });
        if (good) {
          const out = { ok: true, source: src.name, ...data };
          if (debug) out.attempts = attempts;
          return json(out);
        }
      } catch (e) {
        attempts.push({ source: src.name, ok: false, error: String((e && e.message) || e) });
      }
    }
    return json({ ok: false, error: "all sources failed", attempts }, 502);
  },
};

/* ---------- helpers ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
const num = (x) => {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  const n = parseFloat(String(x).replace(/[, %]/g, ""));
  return isFinite(n) ? n : NaN;
};
function nowKST() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short",
  }).format(new Date());
}

/* ---------- 소스 (위에서부터 시도, 첫 성공을 반환) ---------- */
const SOURCES = [
  { name: "KRX",        fn: fromKRX },
  { name: "Naver",      fn: fromNaver },
  { name: "nightkospi", fn: () => fromDashboard("https://nightkospi.com/") },
  { name: "sonmul",     fn: () => fromDashboard("https://sonmul.co.kr/") },
];

/* ① KRX 정보데이터시스템 — OTP 2단계 (회원가입 불필요, 가장 공식적)
 *   야간선물 정확한 bld/파라미터는 KRX 야간시세 페이지에서 F12 → Network →
 *   getJsonData.cmd 요청을 그대로 복사해 아래 OTP_PARAMS에 채우는 게 제일 확실합니다. */
const OTP_PARAMS = {
  bld: "dbms/MDC/STAT/standard/MDCSTAT12501", // (예시) 선물 시세 — 실제 값으로 교체 권장
  locale: "ko_KR",
  // trdDd: "야간은 종료일(T+1)로",  prodId / mktId 등은 F12에서 확인
};
async function fromKRX() {
  const headers = { "User-Agent": UA, Referer: "https://data.krx.co.kr/" };
  const otp = await (
    await fetch(
      "https://data.krx.co.kr/comm/fileDn/GenerateOTP/generate.cmd?" +
        new URLSearchParams(OTP_PARAMS),
      { headers }
    )
  ).text();

  const r = await fetch("https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: "code=" + encodeURIComponent(otp),
  });
  const j = await r.json();
  const rows = j.output || j.OutBlock_1 || j.block1 || [];
  if (!rows.length) throw new Error("KRX: no rows (bld/params 확인 필요)");

  // KOSPI200 최근월물로 보이는 행을 우선 선택
  const row =
    rows.find((x) => /KOSPI\s*200|코스피\s*200/i.test(JSON.stringify(x))) || rows[0];

  const last = num(row.TDD_CLSPRC || row.CLSPRC || row.PRES_PRC || row.LAST_PRC || row.PRC);
  const change = num(row.CMPPREVDD_PRC || row.PRC_CHG || row.CHG);
  const changePct = num(row.FLUC_RT || row.CMPPREVDD_RT || row.CHG_RT);
  return {
    name: "KOSPI200 야간선물",
    last, change, changePct,
    session: "야간", time: nowKST(), raw: row,
  };
}

/* ② 네이버 비공식 — 야간선물 계약이 안 잡히면 코스피200 '지수'로라도 폴백 표시 */
async function fromNaver() {
  const r = await fetch("https://api.stock.naver.com/index/.KS200/basic", {
    headers: { "User-Agent": UA, Referer: "https://m.stock.naver.com/" },
  });
  const j = await r.json();
  const last = num(j.closePrice || j.nv || j.now);
  const change = num(j.compareToPreviousClosePrice || j.change);
  const changePct = num(j.fluctuationsRatio || j.rate);
  return {
    name: "코스피200 지수(폴백)",
    last, change, changePct,
    session: "지수", time: nowKST(), raw: j,
  };
}

/* ③ 공개 대시보드 HTML에서 숫자 추출 (구조 바뀌면 깨질 수 있음 — ?debug=1로 보정) */
async function fromDashboard(u) {
  const html = await (await fetch(u, { headers: { "User-Agent": UA, Referer: u } })).text();
  // 코스피200 야간선물은 보통 250~450 사이의 'NNN.NN' 형태. 가장 먼저 보이는 걸 채택.
  const m = html.match(/(?:코스피|kospi|야간)[^0-9]{0,40}?(\d{3}\.\d{1,2})/i) ||
            html.match(/(\d{3}\.\d{2})/);
  if (!m) throw new Error("dashboard: 숫자 패턴 못 찾음");
  // 변동률이 보이면 같이 (선택)
  const pm = html.match(/([+\-]?\d{1,2}\.\d{1,2})\s*%/);
  return {
    name: "코스피200 야간선물(대시보드)",
    last: num(m[1]),
    change: NaN,
    changePct: pm ? num(pm[1]) : NaN,
    session: "야간", time: nowKST(), raw: u,
  };
}
