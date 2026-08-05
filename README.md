# 제주 렌터카 특가

여러 판매처의 제주 렌터카 특가를 모아 비교하고, **원 사이트 상품 페이지로 연결**하는 웹앱.

**예약을 받지 않는다.** 사용자가 특가를 고르면 그 상품을 파는 사이트로 보내고 끝이다.
예약·결제·취소는 전부 판매처에서 이루어진다.

- 사용자 화면: 특가 검색·필터·상세 → 「예약하러 가기」로 판매처 이동
- 관리자 화면(`/admin.html`): 송출 클릭 통계, 딜 관리, 수집 소스 제어, 수집 로그
- **개인정보를 일절 수집하지 않는다.** 회원가입·로그인·예약폼이 없고,
  송출 집계에도 IP·User-Agent·쿠키를 남기지 않는다.

이 구조의 이점: 개인정보 유출 위험이 원천적으로 없고, 판매처와 경쟁하지 않고
트래픽을 보내주는 관계라 법적 마찰면도 작다.

스택: Node.js 22 · Express 5 · better-sqlite3 · 빌드 없는 바닐라 프론트엔드 · Docker

## 핵심: 딥링크

이 앱의 산출물은 결국 **상품별 딥링크** 하나다. 링크가 없는 딜은 존재 의미가 없다.

| 소스 | 링크 형식 |
|---|---|
| 돌하루팡 | `/cars/reservation?productDetailId={id}&optionIndex=0&startDate=..&endDate=..` |
| 제주속으로 | 예약 폼 URL (`carno={id}` 포함) |

```
GET /go/:dealId  →  클릭 1건 집계 후 302 로 판매처 이동
```

`/go` 는 **DB에 저장된 딜의 URL로만** 보내고, 스킴(https)과 호스트를 화이트리스트로 다시 검증한다.
사용자가 넘긴 URL은 절대 따라가지 않는다(오픈 리다이렉트 방어).
새 소스를 붙이면 `src/routes/go.js` 의 `ALLOWED_HOSTS` 에 호스트를 추가해야 한다.

돌하루팡 링크는 `ptnid` 제휴 추적 파라미터를 지원한다.
파트너 계약을 맺으면 `DOLHARUPANG_PARTNER_ID` 환경변수만 넣으면 수수료가 연결된다.

---

## 빠른 시작

```bash
npm install
npm run seed        # 샘플 딜 48건 (데모용 — 딥링크가 없어 송출 불가)
npm run seed -- clear   # 샘플 딜 삭제. 운영에는 넣지 말 것
npm start           # http://localhost:3000
```

관리자: `http://localhost:3000/admin.html` · 기본 비밀번호 `jeju2026`
(**배포 전 반드시 `ADMIN_PASSWORD` 를 바꿀 것**)

```bash
npm test            # 테스트 34개
npm run collect     # 수집기 1회 실행
```

### Docker

```bash
docker compose up -d --build     # 호스트 3008 → 컨테이너 3000
```

---

## ⚠️ 먼저 읽어야 할 것 — 데이터 수집의 현실

이 앱은 크롤링을 전제로 설계됐지만, **조사 결과 크롤링만으로는 데이터를 채울 수 없다.**
그대로 옮기지 말고 아래를 근거로 판단하라.

### 1. robots.txt 실제 조회 결과 (직접 취득해 확인함)

| 도메인 | robots.txt | 비고 |
|---|---|---|
| jejussok.com | `User-agent: * / Allow: /` | 전체 허용 |
| dolharupang.com | `Allow: /` | ClaudeBot·GPTBot 등 AI 크롤러도 명시 허용 |
| jejurorentcar.com | `Allow: /` | |
| jejuonecar.net | `Allow: /` | |
| carmore.kr | `Allow: /` + 관리자 경로 다수 `Disallow` | `/partners/` 금지 |
| jejupass.com | `Disallow: /mypage/` | 나머지 허용 |
| jarrent.com | `Disallow: /rent/confirm.php, /pg/` | |
| www.jrcoop.co.kr | `/rsv/`, `/_CZ_reservation/` 등 금지 | 예약 경로 차단 |
| jejurentcar.co.kr | `User-agent: *` 에 `Allow: /.well-known/...` 만 | 해석 주의 |
| jejuangeltour.com | BaiDuSpider·MJ12bot 등 차단, `*` 블록 없음 | |
| happyrent.co.kr | **404 — robots.txt 없음** | 규칙 없음 = 허용 |
| jejuokrent.co.kr | **TLS 인증서 오류로 확인 불가** | |

### 2. CSR 사이트도 내부 JSON API 는 호출된다 — 주력 수집원

**돌하루팡(dolharupang.com)** 은 Next.js CSR 이라 HTML 에 가격이 없다.
하지만 화면을 그리려고 내부 REST API 를 부르고, 그 엔드포인트는 브라우저 없이도 응답한다.

```
GET /api/cars?startDate=YYYY-MM-DDTHH:mm:ss&endDate=...
→ { data: { items: [ { name, type, fuelType, capacity, offers: [
     { companyName, productDetailId, pricing: { salePrice, originalPrice },
       eligibility: { minimumAge, minimumCareer }, availableQuantity } ] } ] } }
```

**요청 한 번에 차종 440여 개 · 업체별 상품 1,200여 건**이 온다. 이게 이 앱의 주력 수집원이다.
찾는 과정은 `scripts/scan-chunks.js`(같은 호스트 JS 번들을 전부 받아 `/api/` 경로 수집) →
`scripts/grep-chunks.js`(호출부 맥락에서 파라미터·날짜 형식 확정) 순서였다.

#### originalPrice 를 그대로 정가로 쓰면 안 된다

`originalPrice` 는 업체가 **신고한** 1일 요금이고, `salePrice` 가 조회 날짜의 실제 판매가다.
실측 결과 **35% 의 상품에서 salePrice 가 originalPrice 보다 높다**(성수기 할증).

| 같은 차(3세대 K5 2023) | 신고 요금 | 판매가 | |
|---|---|---|---|
| 조아렌트카 | 180,000 | 17,700 | **-90%** |
| 무지개렌트카 | 185,000 | 38,700 | -79% |
| SEEU렌트카 | 200,000 | 207,400 | **+3.7% 할증** |

그래서 어댑터는 `salePrice < originalPrice` 일 때만 정가로 인정하고,
할증인 경우 정가를 비워 둔 뒤 할증률을 `notes` 에 적는다.
할증을 정가로 세워 두면 화면에 "할인"으로 보인다.

### 3. 정적 HTML 로 가격이 나오는 곳은 하나뿐이다

가격이 정적 HTML에 들어 있는 사이트는 **jejussok.com 하나뿐**이다.
carmore·dolharupang·jejupass·jarrent·jejuonecar 등은 전부 CSR이라
날짜를 선택한 뒤 내부 API를 호출해야 가격이 나온다.
cheerio 같은 정적 파서로는 가격을 가져올 수 없다 —
브라우저 자동화(Playwright)나 내부 JSON 엔드포인트 역추적이 필요하다.

**그래서 jejussok.com 어댑터는 실제로 만들어 넣었다** (`src/collector/adapters/jejussok.js`).
라이브 사이트에서 실매물 6건을 수집하는 것까지 확인했다.
다만 정적으로 얻을 수 있는 건 홈에 노출되는 6대 남짓이고,
`/rent/list.php` 는 날짜 파라미터를 붙여도 CSR 이라 카드가 비어 온다.

### 3. 공개 API 는 없다

공공데이터포털·제주데이터허브·TourAPI 어디에도 **제주 렌터카 실시간 할인가 API는 없다.**
합법성이 가장 확실한 경로는 카모아 트래블셀러/파트너 프로그램 같은 **B2B 제휴 계약**이다.

### 4. 법적 리스크

robots.txt 가 허용해도 민사 위험은 남는다.

- **저작권법 제93조(DB제작자 권리)** — 잡코리아 vs 사람인, 대법원 2017다224395. 손해배상 4.5억.
- **부정경쟁방지법 제2조 제1호 (파)목(성과도용)** — 야놀자 vs 여기어때 민사 1심 10억 인용.
- **정보통신망법 제48조** — 야놀자 vs 여기어때 형사는 대법원 2021도1533 **무죄**.
  단, 약관에 크롤링 금지를 명시하고 기술적 차단을 한 사이트는 형사 위험이 올라간다는 기준을 제시했다.

**수집 결과를 경쟁 서비스로 서비스하면 (파)목 리스크가 가장 크다.**
각 사이트 이용약관은 대부분 동적 렌더링이라 자동 확인이 안 됐다 —
소스를 켜기 전에 **사람이 직접 약관을 확인**해야 한다.

### 5. 정가를 공개하지 않는 소스 — 할인율을 지어내지 않는다

jejussok 페이지에는 정가가 이렇게 들어 있다.

```html
<div class="pro_price">
  <!-- <div class="tprice"><s>185,000원</s></div> -->   ← 주석 처리
  <div class="price"><strong>22,300</strong><span>원</span></div>
</div>
```

주석 속 185,000원을 정가로 쓰면 22,300원이 **"88% 할인"** 으로 표시된다.
그건 사이트가 표시하지 않기로 한 값이고, 제주도 할인율 상한 규칙과
표시광고법이 정확히 겨냥하는 형태다. **어댑터는 의도적으로 읽지 않는다.**

그래서 `deals.list_price` 와 `discount_pct` 는 **NULL 을 허용**한다.
정가를 모르면 화면에 "정가 미표기"로 표시하고 할인율 배지를 달지 않는다.
`discountPct()` 가 정가 없을 때 `0` 이 아니라 `null` 을 돌려주는 이유도 같다 —
"할인 0%"와 "할인율을 알 수 없음"은 다른 상태이고 다르게 보여야 한다.

### 6. 결론 — 이 앱이 택한 구조

크롤링을 유일한 경로로 두지 않았다.

1. **관리자 직접 등록**(`manual`) — 항상 동작. 크롤링이 0건이어도 앱이 빈 껍데기가 되지 않는다.
2. **샘플 데이터**(`seed`) — 둘러보기용. 운영 시 비우면 된다.
3. **수집 어댑터**(`crawler`/`api`) — robots.txt를 강제로 확인하며, **기본 비활성**.
   `jejussok` 하나가 실제로 동작하는 상태로 들어 있다.

#### 수집 켜기

이용약관을 직접 확인한 뒤에 켠다.

```bash
node scripts/source.js                # 소스 목록과 상태
node scripts/source.js jejussok on    # 켜기
npm run collect jejussok              # 즉시 1회 수집
node scripts/show.js jejussok         # 수집 결과 확인
```

관리자 화면 `수집` 탭에서 버튼으로도 같은 일을 할 수 있다.

---

## ⚠️ 할인율 60% 상한 — 앱 컨셉과 직결

**「제주특별자치도 자동차 대여약관 기재 등에 관한 규칙」**
2026-07-15 공포 / **2026-09-16 시행**

- 업체 신고 1일 대여요금의 **60%를 초과하는 할인 금지** (10일 초과 대여는 예외)
- 원가 산출 기준·자기차량손해면책제도 기준 명문화

배경: 업체가 정가를 높게 신고해 두고 비수기에 80~90% 할인하는 관행 때문에
같은 차가 비수기 1만원대, 성수기 20만원대가 되는 구조가 문제됐다.

**"특급 할인"을 내세우는 이 앱에 직접 영향을 준다.**

앱의 대응:
- `src/config.js` 의 `DISCOUNT_CAP` 에 상한율·시행일을 모아 뒀다. 규칙이 바뀌면 이 파일만 고치면 된다.
- 60%를 넘는 딜에는 목록·상세·관리자 전부에 **「상한 초과」 배지**가 붙는다.
- 카드에서 할인율보다 **실제 지불 금액**을 더 크게 표시한다.
  (허위 할인율 표기는 표시광고법 리스크가 있다)

시드 데이터에는 배지 동작 확인용으로 60% 초과 딜 2건이 일부러 들어 있다.
**실제 운영 데이터에는 없어야 한다.**

---

## 구조

```
server.js                   Express 앱 · 보안 헤더 · 정적 서빙 · graceful shutdown
src/
  config.js                 할인율 상한 등 규제 상수, 차종 등급 목록
  db.js                     better-sqlite3 초기화(WAL) · upsert · 마이그레이션
  schema.sql                테이블 · 인덱스 · CHECK 제약
  seed.js                   샘플 딜 생성기 (고정 시드 LCG — 실행마다 같은 결과)
  lib/
    http.js                 politeFetch — UA · 타임아웃 · 지수 백오프 · ETag
    robots.js               robots.txt 캐시 · 판정 (5xx=금지, 404=허용)
    limiter.js              호스트별 요청 간격 · 동시성 제한
    normalize.js            차종 등급 · 가격 · 날짜 · 보험 정규화
    code.js                 관리자 인증 유틸(타이밍 세이프 비교 · 세션 토큰)
    ratelimit.js            인메모리 고정 윈도우 rate limiter
  routes/
    deals.js                딜 목록/상세/필터 메타
    go.js                   송출 — 클릭 집계 후 판매처로 302 (오픈 리다이렉트 방어)
    admin.js                관리자 인증 · 예약/딜/소스 관리
  collector/
    index.js                수집 오케스트레이터 · 스케줄러
    registry.js             어댑터 로더
    run-once.js             CLI
    adapters/
      _template.js          새 소스 추가용 템플릿 ('_' 시작 → 로드 안 함)
      jejussok.js           제주속으로 — 실제 동작하는 크롤러
      manual.js             관리자 직접 등록
      seed.js               샘플 데이터
public/
  index.html app.js         사용자 화면
  admin.html admin.js       관리자 화면
  style.css                 공통 (다크모드 자동)
scripts/                    개발용 도구 (배포에 불필요)
  probe.js                  URL 을 robots 준수 fetch 로 받아 가격 패턴·선택자 후보 출력
  dump.js                   페이지를 저장하고 특정 문자열 주변 맥락 표시
  analyze.js                저장된 HTML 을 cheerio 로 뜯어 선택자 확정
  source.js                 수집 소스 켜기/끄기
  show.js                   소스별 수집 결과 표로 출력
tests/                      55개 (fixtures/ 에 실제 HTML 픽스처 포함)
```

### 새 소스를 붙일 때의 작업 순서

선택자를 추측해서 쓰면 반드시 깨진다. 실제 응답을 보고 시작한다.

```bash
node scripts/probe.js https://example.com/          # 가격이 HTML 에 있는지부터 확인
node scripts/dump.js https://example.com/ "22,300"  # 있으면 그 주변 마크업을 본다
node scripts/analyze.js data/probe/<저장된파일>.html  # 반복 단위·고유 ID 확정
```

가격이 안 나오면 그 사이트는 CSR 이다. 정적 파서로는 안 되니 접어야 한다.

## 새 수집 소스 추가하기

1. `src/collector/adapters/_template.js` 를 복사해 이름을 바꾼다 (예: `mysite.js`).
2. `key`·`name`·`baseUrl` 을 채우고 `collect(ctx)` 에 파싱 로직을 쓴다.
3. **`ctx.get(url)` 만 사용한다.** 직접 `fetch` 하면 robots 판정과 rate limit 을 우회한다.
4. 가격 파싱·등급 분류는 하지 말고 **원문 문자열 그대로** 넘긴다 — `normalize.js` 가 처리한다.
5. `external_id` 는 그 소스 안에서 **안정적으로 고유**해야 한다. 배열 인덱스나 타임스탬프를 쓰면
   같은 딜이 계속 새로 쌓인다.
6. 서버를 재시작하면 관리자 `수집` 탭에 뜬다. 약관을 확인한 뒤 켠다.

### 수집기가 지키는 것

- robots.txt 를 먼저 확인한다. **5xx·타임아웃이면 금지로 해석**한다(보수적).
  404는 규칙 없음 = 허용(RFC 9309).
- 호스트별 최소 2초 간격. `Crawl-delay` 가 있으면 그 값을 따른다(더 낮추지 않는다).
- ETag / Last-Modified 조건부 요청. 304면 파싱을 건너뛴다.
- **수집 0건이면 기존 딜을 만료시키지 않는다.** 선택자가 깨진 것과 특가가 사라진 것을
  구분할 수 없어서, 멀쩡한 딜을 전멸시키는 사고를 막는다.
- 실패·거부·0건을 전부 `crawl_logs` 에 남긴다.

---

## 개인정보 처리

**수집하는 개인정보가 없다.** 예약을 받지 않으므로 이름·연락처·이메일을 물을 이유가 없고,
회원가입·로그인도 없다.

송출 집계(`outbound_clicks`)에도 **IP·User-Agent·쿠키·리퍼러를 남기지 않는다.**
어떤 딜이 언제 클릭됐는지만 센다. 테이블에 그런 컬럼이 생기지 않는지 테스트로 고정해 뒀다
(`tests/go.test.js` — "집계에 개인정보를 남기지 않는다").

과거 버전에 있던 예약 접수 기능은 제거했다. 기존 DB에 예약 데이터가 남아 있으면
마이그레이션이 **삭제하지 않고** `bookings_archived` 로 옮기고 경고한다 —
개인정보가 들어 있으니 사람이 확인하고 정리해야 한다.

## 보안

- **오픈 리다이렉트 방어**: `/go/:id` 는 DB에 저장된 딜의 URL로만 이동하며,
  https 스킴과 허용 호스트를 다시 검증한다. 호스트 위장(`dolharupang.com.evil.com`,
  `evil.com?x=dolharupang.com`, `evil.com#...`) 시도를 테스트로 막아 뒀다.
- 외부 링크는 `rel="noopener noreferrer nofollow"` · `target="_blank"`.
- 집계 실패가 사용자 이동을 막지 않는다(리다이렉트 우선).
- 관리자 로그인: 15분에 8회 제한, 성공 시 카운터 초기화. 타이밍 세이프 비교.
- 관리자 세션은 DB 저장 토큰(12시간). HttpOnly · SameSite=Lax 쿠키.
  HTTPS 종단에서는 `COOKIE_SECURE=1` 을 켜라.
- CSP·X-Frame-Options·nosniff 헤더. 외부 CDN을 쓰지 않아 CSP를 좁게 유지한다.
- 프론트엔드는 모든 출력에 `esc()` 를 거친다 — 딜 데이터는 외부 사이트에서 올 수 있어 신뢰할 수 없다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `data/jeju.db` | |
| `ADMIN_PASSWORD` | `jeju2026` | **배포 전 반드시 변경** |
| `COLLECT_INTERVAL_MIN` | `180` | 자동 수집 주기(분). `0`이면 끔 |
| `CRAWLER_CONTACT` | (없음) | User-Agent에 넣을 연락처 |
| `COOKIE_SECURE` | (없음) | `1`이면 쿠키에 `Secure` 부여 |
| `TZ` | — | `Asia/Seoul` 권장 |

## 알려진 한계

- **사실상 돌하루팡 단일 소스**다(1,270여 건 중 대부분). 저쪽이 API를 바꾸면 앱이 멈춘다.
  카모아는 API 호스트·엔드포인트까지 찾았으나 파라미터를 맞추지 못해 미완이다.
- **가격은 수집 시점(기준일) 기준이다.** 성수기·비수기 차이가 10배까지 나므로
  실제 조회 날짜의 요금과 다를 수 있다. 각 딜의 `notes` 에 기준일을 명시하고
  화면에도 노출하지만, 최종 금액은 판매처에서 확인해야 한다.
- 딥링크에 수집 시점의 날짜가 박혀 있다. 사용자가 다른 날짜를 원하면
  판매처 화면에서 다시 고쳐야 한다.
- rate limiter가 프로세스 메모리 기반이라 **수평 확장 시 인스턴스별로 따로 센다.**
- 재고는 신청 건수로만 셈한다. 업체 실시간 재고와 연동되지 않는다.
- 성수기/비수기 가격 차등이 딜 단위로만 표현된다.
- rate limiter가 프로세스 메모리 기반이라 **수평 확장 시 인스턴스별로 따로 센다.**
- 예약 확정 알림(SMS/이메일)이 없다. 관리자가 직접 연락해야 한다.

## 데이터 출처 주의

시드의 **업체명은 실재**하지만 **가격·평점·재고는 조사된 시장 가격대 안에서 만든 예시**이지 실제 매물이 아니다.
2024-12-31 제주 단기렌터카 사업을 종료한 **레드캡렌터카는 제외**했고,
단종 차량(스파크·K3·말리부)은 신규 딜로 만들지 않는다(파서는 재고 운용을 고려해 계속 인식한다).
