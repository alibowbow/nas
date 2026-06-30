/* =====================================================================
 * kospi-night-worker.js — Cloudflare Worker  (rev: kospi-index multi-source)
 * 코스피200 야간선물 + 코스피 종합지수(도미넌스용)를 "브라우저에서" 쓸 수 있게
 * CORS를 붙여 JSON으로 내보냅니다.
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

    // 야간선물 + 코스피 종합지수를 병렬 수집 (지수는 삼전하닉 도미넌스 분모용)
    const [night, kospi] = await Promise.all([getNight(), fetchKospiIndex()]);

    const out = night.ok
      ? { ok: true, source: night.source, ...night.data }
      : { ok: false, error: "all night sources failed" };
    out.kospi = kospi.value;          // 코스피 종합지수 (도미넌스 분모)
    out.kospiSource = kospi.source;
    if (debug) { out.attempts = night.attempts; out.kospiAttempts = kospi.attempts; }

    return json(out, (night.ok || isFinite(kospi.value)) ? 200 : 502);
  },
};

// 야간선물: SOURCES를 위에서부터 시도, 첫 성공 반환
async function getNight() {
  const attempts = [];
  for (const src of SOURCES) {
    try {
      const data = await src.fn();
      const good = data && (isFinite(data.last) || isFinite(data.changePct));
      attempts.push({ source: src.name, ok: !!good, data });
      if (good) return { ok: true, source: src.name, data, attempts };
    } catch (e) {
      attempts.push({ source: src.name, ok: false, error: String((e && e.message) || e) });
    }
  }
  return { ok: false, source: null, data: {}, attempts };
}

// 코스피 종합지수(도미넌스 분모) — 야후/구글/네이버/대시보드 등 여러 경로를 순서대로 시도(특정 사이트 의존 X).
async function fetchKospiIndex() {
  const attempts = [];
  for (const src of KOSPI_SOURCES) {
    try {
      const v = await src.fn();
      const ok = isFinite(v) && v > 1500 && v < 25000;  // 코스피 종합지수 범위(선물 1401·KOSPI200 360 등 오인 차단)
      attempts.push({ source: src.name, ok, value: isFinite(v) ? v : null });
      if (ok) return { value: v, source: src.name, attempts };
    } catch (e) {
      attempts.push({ source: src.name, ok: false, error: String((e && e.message) || e) });
    }
  }
  return { value: NaN, source: null, attempts };
}

// 코스피 지수 소스 후보(위에서부터 시도, 하나 막혀도 다음으로 폴백)
const KOSPI_SOURCES = [
  // ① 야후 파이낸스 ^KS11(코스피 종합) — 구조화 JSON, 서버에서 가장 안정적
  { name: "yahoo", fn: async () => {
      const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?range=1d&interval=1d",
        { headers: { "User-Agent": UA } });
      const j = await r.json();
      const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      return num(meta && (meta.regularMarketPrice != null ? meta.regularMarketPrice : meta.previousClose));
    } },
  // ② 구글 파이낸스 — data-last-price 속성
  { name: "google", fn: async () => {
      const html = await (await fetch("https://www.google.com/finance/quote/KOSPI:KRX",
        { headers: { "User-Agent": UA } })).text();
      const m = html.match(/data-last-price="([\d.]+)"/);
      return m ? num(m[1]) : NaN;
    } },
  // ③ 네이버 모바일 basic
  { name: "naver-m", fn: async () => {
      const r = await fetch("https://m.stock.naver.com/api/index/KOSPI/basic",
        { headers: { "User-Agent": UA, Referer: "https://m.stock.naver.com/" } });
      const j = await r.json();
      return num(j && (j.closePrice != null ? j.closePrice : (j.nv != null ? j.nv : j.now)));
    } },
  // ④ 네이버 실시간 폴링 (result.areas[0].datas[0].nv, ×100 보정)
  { name: "naver-polling", fn: async () => {
      const r = await fetch("https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI",
        { headers: { "User-Agent": UA, Referer: "https://finance.naver.com/sise/sise_index.naver?code=KOSPI" } });
      const j = await r.json();
      const datas = (j && j.result && j.result.areas && j.result.areas[0] && j.result.areas[0].datas) || (j && j.datas) || [];
      const d = datas.find(x => x && (x.cd === "KOSPI" || x.nm === "코스피")) || datas[0];
      let nv = num(d && (d.nv != null ? d.nv : d.cv));
      if (isFinite(nv) && nv > 50000) nv = nv / 100;
      return nv;
    } },
  // ⑤ 대시보드(hangon) — 코스피 종합지수 표기(있으면)
  { name: "hangon", fn: async () => {
      const html = await (await fetch("https://www.hangon.co.kr/kospi-night-futures",
        { headers: { "User-Agent": UA } })).text();
      const m = html.match(/코스피\s*지수[\s\S]{0,60}?([\d,]{4,7}\.\d{1,2})/) ||
                html.match(/KOSPI(?!\s*200)[\s\S]{0,60}?([\d,]{4,7}\.\d{1,2})/i);
      return m ? num(m[1]) : NaN;
    } },
];

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
  { name: "hangon",     fn: () => fromDashboard("https://www.hangon.co.kr/kospi-night-futures") },
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
  // ⚠️ 앞자리 잘림 주의: 정수부를 3자리(\d{3})로 고정하면 "1408.50"에서 "408.50"만 잡혀
  //    맨 앞자리가 사라짐. → 정수부 1~4자리 + 천단위 콤마 허용(num()이 콤마 제거).
  const NUM = "([\\d,]{2,7}\\.\\d{1,2})";
  const m = html.match(new RegExp("(?:코스피\\s*200|코스피200|야간선물|kospi\\s*200|야간)[\\s\\S]{0,60}?" + NUM, "i")) ||
            html.match(new RegExp(NUM));
  if (!m) throw new Error("dashboard: 숫자 패턴 못 찾음");
  // 변동률(%)이 보이면 같이 (선택)
  const pm = html.match(/([+\-]?\d{1,2}\.\d{1,2})\s*%/);
  return {
    name: "코스피200 야간선물(대시보드)",
    last: num(m[1]),
    change: NaN,
    changePct: pm ? num(pm[1]) : NaN,
    session: "야간", time: nowKST(),
    raw: { url: u, matched: m[1], pct: pm ? pm[1] : null }, // ?debug=1 진단용
  };
}
