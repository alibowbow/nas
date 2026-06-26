# 코스피200 야간선물 보드 — 프록시(Cloudflare Worker) 설치

이 앱은 **브라우저 정적 페이지**라 `data.krx.co.kr`·네이버를 직접 불러오면 **CORS에 막힙니다.**
그래서 작은 프록시(Cloudflare Worker) 하나가 서버 입장에서 대신 받아와 CORS를 붙여 JSON으로 돌려줍니다.
**무료**이고 브로커 가입은 필요 없습니다(Cloudflare 무료 계정만).

---

## ⭐ GitHub 자동배포 (추천) — `wrangler.toml` 사용

저장소에 `wrangler.toml` 이 있으면 **GitHub에 푸시할 때마다 워커가 자동 배포**됩니다.
(매번 Edit code 복붙 안 해도 됨 — 워커 수정/푸시는 개발자가, 배포는 Cloudflare가 자동으로)

**1회 연결만 하면 끝:**

1. https://dash.cloudflare.com → **Workers & Pages** → **`soft-tooth-e523`** 워커 클릭
2. **Settings** 탭 → **Build**(또는 "Builds"/"CI/CD") 섹션 → **Connect**(Git 연결)
3. GitHub 인증 → 저장소 **`alibowbow/nas`** 선택 → 브랜치 **`main`**
4. Cloudflare가 루트의 `wrangler.toml` 을 자동 인식 → 빌드 명령 기본값(또는 `npx wrangler deploy`) → **Save**
5. 끝. 이후 `kospi-night-worker.js` 가 바뀐 채로 main에 푸시되면 **자동 배포**돼요.

> - `wrangler.toml` 의 `name = "soft-tooth-e523"` 이라 **URL이 그대로 유지**됩니다(앱 수정 불필요).
> - 기존 워커에 Git 연결 메뉴가 안 보이면: **Create application → Import a repository →
>   `alibowbow/nas`** 로 연결해도 됩니다. name이 같아서 **같은 워커(같은 URL)** 로 배포돼요.
> - 연결 후 혹시 URL이 바뀌면 알려주세요 — `index.html` 의 `KOSPI_NIGHT_PROXY_URL` 만 바꾸면 끝.

확인: **`https://soft-tooth-e523.alibowbow.workers.dev/?debug=1`** → JSON이 갱신됐는지 보기.

---

## 1) 워커 배포 (수동 — 대시보드 복붙)

1. https://dash.cloudflare.com → 가입/로그인 (무료)
2. 왼쪽 **Workers & Pages** → **Create application** → **Create Worker**
3. 이름 예: `kospi-night` → **Deploy** (기본 코드로 일단 배포)
4. **Edit code** 클릭 → 편집기 내용을 **전부 지우고**, 저장소의 `kospi-night-worker.js`
   내용을 **그대로 붙여넣기** → **Deploy**
5. 상단에 뜨는 주소 복사. 예: `https://kospi-night.<당신계정>.workers.dev`

> wrangler CLI가 익숙하면: `npm i -g wrangler` → `wrangler deploy kospi-night-worker.js` 도 됩니다.

---

## 2) 앱에 주소 연결

`index.html` 상단(설정 영역)의 빈 값을 채우세요:

```js
const KOSPI_NIGHT_PROXY_URL = "https://kospi-night.<당신계정>.workers.dev";
```

저장 → 커밋/푸시 → 코스피 탭을 열면 **코스피200 야간선물 보드**가 뜹니다.
(폴링 30초 간격 · 무료 한도 10만 req/일 대비 하루 ~2,880건이라 여유)

---

## 3) 잘 되는지 / 안 되면

- 브라우저로 **`https://<주소>/?debug=1`** 열기 → `attempts`에 각 소스가 뭘 받았는지 보입니다.
- `ok: true` 와 `last`(숫자)가 보이면 끝. 앱 보드에 그 값이 그대로 떠요.
- **전부 실패**하면(엔드포인트는 자주 바뀜) `kospi-night-worker.js`에서 아래만 손보면 됩니다:
  - **KRX**: KRX 야간시세 페이지에서 `F12 → Network → getJsonData.cmd` 요청을 보고
    `OTP_PARAMS`의 `bld`/`trdDd`/`prodId` 등을 실제 값으로 교체.
    (야간은 조회일을 **종료일=T+1**로 넣습니다. 예: 6/9 18:00~6/10 06:00 → `20260610`)
  - **대시보드**: `fromDashboard`의 정규식을 그 사이트 HTML에 맞게 조정.
  - 고치고 다시 **Deploy** 하면 앱은 수정 없이 바로 반영됩니다.

## 응답(JSON) 형식

프론트(`index.html`)는 아래 형태를 기대합니다(키 이름은 관대하게 처리 — `price/close/value`,
`pct/rate` 등도 인식):

```json
{
  "ok": true,
  "source": "KRX",
  "name": "KOSPI200 야간선물",
  "last": 345.20,
  "change": 1.35,
  "changePct": 0.39,
  "session": "야간",
  "time": "26. 6. 26. 오전 2:10"
}
```

## 참고/한계

- **지연·세션 데이터**입니다(초 단위 실시간 틱 아님). 야간선물 추이·종가엔 충분.
- 실시간 틱이 꼭 필요하면 한국투자증권(KIS)·LS증권 등 **무료 REST**가 정답이지만,
  계좌+앱키 발급이 필요해 "가입 없이"엔 맞지 않습니다.
- 야간장 시간은 평일 **18:00 ~ 익일 06:00 (KST)** 입니다. 그 외 시간엔 직전 세션 값이
  보이거나 `데이터 없음`이 뜰 수 있어요.
