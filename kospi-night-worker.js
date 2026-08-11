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
 * KOSPI는 KRX 공개 메인 지표를 우선하고, 야간선물은 제한시간을 둔 다중 소스로
 * 병렬 조회합니다. 정규장 선물은 야간값으로 대체하지 않으며, ?debug=1 에서
 * 소스별 성공·실패와 배포 revision을 확인할 수 있습니다.
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

const SOURCE_TIMEOUT_MS = 2800;

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const debug = url.searchParams.get("debug") === "1";
    const wantKospi = url.searchParams.get("kospi") !== "0";
    const inSession = isNightSessionKST();
    const wantNight = inSession && url.searchParams.get("night") !== "0";

    // 코스피와 야간선물을 독립 요청할 수 있게 해 한쪽 지연이 다른 카드까지 막지 않게 한다.
    const [night, kospi] = await Promise.all([
      wantNight ? getNight() : Promise.resolve({ ok: false, source: null, data: {}, attempts: [] }),
      wantKospi ? fetchKospiIndex() : Promise.resolve({ value: NaN, change: NaN, pct: NaN, source: null, attempts: [] }),
    ]);

    const out = night.ok
      ? { ok: true, source: night.source, ...night.data }
      : { ok: false, error: wantNight ? "all night sources failed" : (inSession ? "night not requested" : "closed") };
    out.kospi = kospi.value;
    out.kospiChange = kospi.change;
    out.kospiPct = kospi.pct;
    out.kospiSource = kospi.source;
    out.revision = "2026-08-11.1";
    if (debug) {
      out.attempts = night.attempts;
      out.kospiAttempts = kospi.attempts;
      out.dashboardDebug = _dashDbg;
    }

    const hasRequestedData =
      (wantNight && night.ok) ||
      (wantKospi && isFinite(kospi.value)) ||
      (!wantNight && !wantKospi);
    return json(out, hasRequestedData ? 200 : 502);
  },
};

// 야간 세션(KST): 평일 18:00~익일 06:00. 그 외엔 야간선물 스크래핑 생략.
function isNightSessionKST() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", weekday: "short", hour12: false })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  if (h >= 18) return dow >= 1 && dow <= 5;   // 18:00~23:59 월~금
  if (h < 6)   return dow >= 2 && dow <= 6;    // 00:00~05:59 화~토(전날 세션 연장)
  return false;
}

// 야간선물: SOURCES를 위에서부터 시도, 첫 성공 반환
async function runSourceBatch(sources, normalize) {
  const results = await Promise.all(sources.map(async (src) => {
    try {
      return normalize(src.name, await src.fn());
    } catch (e) {
      return { source: src.name, ok: false, error: String((e && e.message) || e) };
    }
  }));
  return { results, hit: results.find((r) => r.ok) };
}

async function getNight() {
  // 실제 야간선물을 제공하는 두 대시보드를 먼저 병렬 확인하고, 둘 다 실패할 때만 마지막 폴백을 호출한다.
  const normalize = (source, data) => ({
    source,
    ok: !!(data && isFinite(data.last) && data.last > 50 && data.last < 5000),
    data,
  });
  const primary = await runSourceBatch(SOURCES.slice(0, 2), normalize);
  if (primary.hit) return { ok:true, source:primary.hit.source, data:primary.hit.data, attempts:primary.results };

  const fallback = await runSourceBatch(SOURCES.slice(2), normalize);
  const attempts = primary.results.concat(fallback.results);
  return fallback.hit
    ? { ok:true, source:fallback.hit.source, data:fallback.hit.data, attempts }
    : { ok:false, source:null, data:{}, attempts };
}

// 코스피 종합지수(도미넌스 분모) — 야후/구글/네이버/대시보드 등 여러 경로를 순서대로 시도(특정 사이트 의존 X).
async function fetchKospiIndex() {
  const normalize = (source, raw) => {
    const value = num(raw && typeof raw === "object" ? raw.value : raw);
    const change = num(raw && typeof raw === "object" ? raw.change : NaN);
    const pct = num(raw && typeof raw === "object" ? raw.pct : NaN);
    const ok = isFinite(value) && value > 1500 && value < 25000;
    return { source, ok, value:ok ? value : null, change, pct };
  };

  // KRX 공식 메인 + 네이버 구조화 API를 먼저 병렬 확인하고, 둘 다 실패할 때만 느린 폴백을 시작한다.
  const primary = await runSourceBatch(KOSPI_SOURCES.slice(0, 2), normalize);
  let attempts = primary.results, hit = primary.hit;
  if (!hit) {
    const fallback = await runSourceBatch(KOSPI_SOURCES.slice(2), normalize);
    attempts = attempts.concat(fallback.results);
    hit = fallback.hit;
  }
  return hit
    ? { value:hit.value, change:hit.change, pct:hit.pct, source:hit.source, attempts }
    : { value:NaN, change:NaN, pct:NaN, source:null, attempts };
}

// 코스피 지수 소스 후보

// 코스피 지수 소스 후보(위에서부터 시도, 하나 막혀도 다음으로 폴백)
// 중소·개인 대시보드(국내 실시간, 클플 차단 없음) 우선 → 다음/야후는 폴백.
// DASHBOARD_URLS에 '실시간 코스피 종합지수'를 보여주는 사이트를 추가하면 됨.
const DASHBOARD_KOSPI_URLS = [
  "https://apt2.me/global_index.jsp",
  "https://www.hangon.co.kr/kospi",
  "https://www.hangon.co.kr/kospi-night-futures",
  "https://sonmul.co.kr/",
  "https://nightkospi.com/",
];
let _dashDbg = [];

async function fetchKospiDashboard() {
  const checks = await Promise.all(DASHBOARD_KOSPI_URLS.map(async (u) => {
    const info = { url: u };
    try {
      const res = await fetchTimed(u, { headers: { "User-Agent": UA, Referer: u } });
      info.status = res.status;
      if (!res.ok) throw new Error("HTTP " + res.status);
      const html = await res.text();
      info.len = html.length;
      info.hasKospi = /코스피|KOSPI/i.test(html);
      const re = /(?:코스피|KOSPI)(?!\s*200)[\s\S]{0,160}?([\d,]{4,7}\.\d{1,2})/ig;
      let m, found = null;
      while ((m = re.exec(html)) !== null) {
        if (!info.firstMatch) info.firstMatch = m[1];
        const v = num(m[1]);
        if (v > 1500 && v < 25000) { found = v; break; }
      }
      info.found = found;
      return info;
    } catch (e) {
      info.error = String((e && e.message) || e);
      return info;
    }
  }));
  _dashDbg = checks;
  const hit = checks.find((x) => isFinite(x.found));
  return hit ? { value: hit.found, change: NaN, pct: NaN } : { value: NaN, change: NaN, pct: NaN };
}

const KOSPI_SOURCES = [
  // ① KRX 공식 메인 지표. 통계 OTP가 아닌 공개 메인 보드라 인증 없이 현재 코스피를 반환한다.
  { name: "KRX", fn: async () => {
      const r = await fetchTimed("https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Referer": "https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/plain, */*",
        },
        body: "bld=" + encodeURIComponent("dbms/MDC/MAIN/MDCMAIN00101"),
      });
      if (!r.ok) throw new Error("KRX main HTTP " + r.status);
      const text = await r.text();
      const j = JSON.parse(text);
      const rows = Array.isArray(j && j.output) ? j.output : [];
      const row = rows.find((x) =>
        String(x && x.IND_TP_CD || "") === "1" &&
        String(x && x.IDX_IND_CD || "") === "001" &&
        String(x && x.IDX_IND_NM || "").trim() === "코스피" &&
        String(x && x.IDX_IND_ENG_NM || "").trim().toUpperCase() === "KOSPI"
      );
      if (!row) throw new Error("KRX main: KOSPI row missing");
      const dir = String(row.FLUC_TP_CD || "");
      return {
        value: num(row.PRSNT_IDX),
        change: signedByCode(row.CMPPREVDD_IDX, dir, ["2", "5"]),
        pct: signedByCode(row.IDX_FLUC_RT, dir, ["2", "5"]),
      };
    } },
  // ② 네이버 모바일 지수 API.
  { name: "Naver", fn: async () => {
      const r = await fetchTimed("https://m.stock.naver.com/api/index/KOSPI/basic", {
        headers: { "User-Agent": UA, "Referer": "https://m.stock.naver.com/" },
      });
      if (!r.ok) throw new Error("Naver KOSPI HTTP " + r.status);
      const j = await r.json();
      const code = j && j.compareToPreviousPrice && j.compareToPreviousPrice.code;
      return {
        value: num(j && (j.closePrice != null ? j.closePrice : j.closePriceRaw)),
        change: signedByCode(j && (j.compareToPreviousClosePrice != null ? j.compareToPreviousClosePrice : j.compareToPreviousClosePriceRaw), code, ["4", "5"]),
        pct: signedByCode(j && (j.fluctuationsRatio != null ? j.fluctuationsRatio : j.fluctuationsRatioRaw), code, ["4", "5"]),
      };
    } },
  // ③ 다음 금융.
  { name: "Daum", fn: async () => {
      const r = await fetchTimed("https://finance.daum.net/api/quotes/KOSPI?summary=false&changeStatistics=true", {
        headers: { "User-Agent": UA, "Referer": "https://finance.daum.net/domestic/kospi", "x-requested-with": "XMLHttpRequest" },
      });
      if (!r.ok) throw new Error("Daum KOSPI HTTP " + r.status);
      const j = await r.json();
      return {
        value: num(j && (j.tradePrice != null ? j.tradePrice : (j.basePrice != null ? j.basePrice : j.currentPrice))),
        change: num(j && (j.changePrice != null ? j.changePrice : j.change)),
        pct: num(j && (j.changeRate != null ? Number(j.changeRate) * 100 : j.fluctuationsRatio)),
      };
    } },
  // ④ Yahoo ^KS11.
  { name: "Yahoo", fn: async () => {
      const r = await fetchTimed("https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?range=1d&interval=1d", {
        headers: { "User-Agent": UA, "Referer": "https://finance.yahoo.com/" },
      });
      if (!r.ok) throw new Error("Yahoo KOSPI HTTP " + r.status);
      const j = await r.json();
      const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      const value = num(meta && (meta.regularMarketPrice != null ? meta.regularMarketPrice : meta.previousClose));
      const prev = num(meta && (meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose));
      const change = isFinite(value) && isFinite(prev) ? value - prev : NaN;
      return { value, change, pct: isFinite(change) && prev > 0 ? change / prev * 100 : NaN };
    } },
  // ⑤ 마지막 폴백: 공개 대시보드. 병렬·제한시간으로만 확인한다.
  { name: "dashboard", fn: fetchKospiDashboard },
];

/* ---------- helpers ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
async function fetchTimed(input, init = {}, timeoutMs = SOURCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
const num = (x) => {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  const n = parseFloat(String(x).replace(/[, %]/g, ""));
  return isFinite(n) ? n : NaN;
};
function signedByCode(value, code, downCodes) {
  const n = num(value);
  if (!isFinite(n)) return NaN;
  if (n < 0) return n;
  return downCodes.includes(String(code || "")) ? -Math.abs(n) : n;
}
function nowKST() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short",
  }).format(new Date());
}
/* ---------- 소스

/* ---------- 소스 (위에서부터 시도, 첫 성공을 반환) ---------- */
const SOURCES = [
  { name: "sonmul",     fn: () => fromDashboard("https://sonmul.co.kr/") },
  { name: "hangon",     fn: () => fromDashboard("https://www.hangon.co.kr/kospi-night-futures") },
  { name: "nightkospi", fn: () => fromDashboard("https://nightkospi.com/") },
];

/* 공개 대시보드

/* ③ 공개 대시보드 HTML에서 숫자 추출 (구조 바뀌면 깨질 수 있음 — ?debug=1로 보정) */
async function fromDashboard(u) {
  const res = await fetchTimed(u, { headers: { "User-Agent": UA, Referer: u } });
  if (!res.ok) throw new Error("dashboard HTTP " + res.status);
  const html = await res.text();

  // 보이는 텍스트의 '야간선물 → 가격 → 등락률' 묶음만 허용한다.
  // 페이지 첫 숫자를 임의 채택하지 않아 주간선물·버전번호 오인을 막는다.
  const visible = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#43;|&plus;/gi, "+")
    .replace(/&#45;|&minus;/gi, "-")
    .replace(/\s+/g, " ")
    .trim();

  const label = /(?:KOSPI\s*200\s*(?:NIGHT|야간선물)|코스피\s*200\s*야간선물|코스피\s*야간선물)/i;
  const lm = label.exec(visible);
  if (!lm) throw new Error("dashboard: 야간선물 라벨 없음");
  const context = visible.slice(lm.index, lm.index + 900);
  const priceRe = /(?:\d{1,3}(?:,\d{3})+|\d{2,4})\.\d{1,2}/g;
  let pm, priceMatch = null;
  while ((pm = priceRe.exec(context)) !== null) {
    const v = num(pm[0]);
    if (v > 50 && v < 5000 && context.slice(pm.index + pm[0].length, pm.index + pm[0].length + 2).indexOf("%") < 0) {
      priceMatch = pm;
      break;
    }
  }
  if (!priceMatch) throw new Error("dashboard: 야간선물 가격 없음");

  const tail = context.slice(priceMatch.index + priceMatch[0].length, priceMatch.index + priceMatch[0].length + 180);
  const pctMatch = tail.match(/([+\-]?\d{1,3}(?:\.\d{1,3})?)\s*%/);
  const beforePct = pctMatch ? tail.slice(0, pctMatch.index) : tail;
  const changeMatch = beforePct.match(/([+\-]\s*(?:\d{1,3}(?:,\d{3})+|\d{1,4})(?:\.\d{1,2})?)/);

  return {
    name: "KOSPI200 야간선물",
    last: num(priceMatch[0]),
    change: changeMatch ? num(changeMatch[1].replace(/\s+/g, "")) : NaN,
    changePct: pctMatch ? num(pctMatch[1]) : NaN,
    session: "KRX 야간",
    time: nowKST(),
    raw: { url: u, matched: priceMatch[0], change: changeMatch ? changeMatch[1] : null, pct: pctMatch ? pctMatch[1] : null },
  };
}
