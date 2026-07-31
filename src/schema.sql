-- 제주 렌터카 특가 앱 스키마
-- 날짜/시각은 SQLite 관례대로 TEXT(ISO8601, Asia/Seoul 로컬)로 저장한다.

PRAGMA foreign_keys = ON;

-- ── 수집 소스 ────────────────────────────────────────────────
-- kind: 'manual'  관리자 수동 등록 (항상 존재, 크롤링 없음)
--       'api'     공개 API (이용약관상 허용)
--       'crawler' HTML 크롤링 (robots.txt 판정 후에만 동작)
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY,
  key           TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'crawler'
                        CHECK (kind IN ('manual', 'api', 'crawler')),
  base_url      TEXT,
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- robots.txt 최근 판정 결과. 'allowed' | 'blocked' | 'unknown' | 'n/a'
  robots_status TEXT    NOT NULL DEFAULT 'unknown',
  robots_reason TEXT,
  robots_checked_at TEXT,
  -- 조건부 요청용 캐시 검증자
  etag          TEXT,
  last_modified TEXT,
  last_run_at   TEXT,
  last_ok_at    TEXT,
  last_error    TEXT,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ── 렌터카 업체 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  phone        TEXT,
  -- 'airport_shuttle' 공항 셔틀 | 'airport_walk' 공항 도보 | 'office' 지점 방문 | 'delivery' 탁송
  pickup_type  TEXT,
  address      TEXT,
  rating       REAL    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  review_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ── 딜(특가 상품) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id            INTEGER PRIMARY KEY,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- 소스 안에서의 고유 식별자. (source_id, external_id) 가 중복 제거 키다.
  external_id   TEXT    NOT NULL,

  vendor_id     INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name   TEXT    NOT NULL,          -- 비정규화: 목록 조회 시 조인 회피

  car_model     TEXT    NOT NULL,          -- '아반떼 CN7'
  car_class     TEXT    NOT NULL,          -- '경차' | '소형' | '준중형' | '중형' | 'SUV' | '승합' | '수입' | '전기'
  fuel          TEXT,                      -- '가솔린' | '디젤' | 'LPG' | '하이브리드' | '전기'
  seats         INTEGER,
  transmission  TEXT    NOT NULL DEFAULT '자동',

  -- 금액은 원 단위 정수. 부동소수점 쓰지 않는다.
  list_price    INTEGER NOT NULL CHECK (list_price  > 0),   -- 24시간 정가
  sale_price    INTEGER NOT NULL CHECK (sale_price  > 0),   -- 24시간 할인가
  -- 할인율은 파생값이지만 정렬·인덱싱을 위해 저장한다. 쓰기 시점에 계산.
  discount_pct  INTEGER NOT NULL CHECK (discount_pct BETWEEN 0 AND 99),

  deal_type     TEXT,                      -- '얼리버드' | '타임세일' | '초특가' | '마감임박' | '장기할인'
  insurance     TEXT,                      -- '완전자차' | '일반자차' | '책임보험'
  insurance_included INTEGER NOT NULL DEFAULT 0 CHECK (insurance_included IN (0, 1)),
  free_cancel   INTEGER NOT NULL DEFAULT 1 CHECK (free_cancel IN (0, 1)),

  pickup_location TEXT,                    -- '제주공항' | '서귀포' | '중문' | ...
  min_days      INTEGER NOT NULL DEFAULT 1 CHECK (min_days >= 1),
  min_age       INTEGER,                   -- 최소 운전자 연령(만)
  min_license_years INTEGER,               -- 면허 취득 후 최소 경과 연수

  -- 이 특가로 대여 가능한 기간
  valid_from    TEXT,
  valid_to      TEXT,
  stock         INTEGER,                   -- NULL = 수량 미표시

  detail_url    TEXT,
  image_url     TEXT,
  notes         TEXT,

  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'expired', 'hidden')),
  first_seen_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),

  CHECK (sale_price <= list_price),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  UNIQUE (source_id, external_id)
);

-- 목록 화면의 기본 정렬은 "할인율 높은 순" 이므로 status 와 함께 복합 인덱스를 건다.
CREATE INDEX IF NOT EXISTS idx_deals_rank     ON deals (status, discount_pct DESC, sale_price ASC);
CREATE INDEX IF NOT EXISTS idx_deals_price    ON deals (status, sale_price ASC);
CREATE INDEX IF NOT EXISTS idx_deals_class    ON deals (status, car_class, discount_pct DESC);
CREATE INDEX IF NOT EXISTS idx_deals_valid    ON deals (status, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_deals_source   ON deals (source_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_deals_vendor   ON deals (vendor_name);

-- ── 예약 신청 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY,
  code           TEXT    NOT NULL UNIQUE,   -- 'JJ-XXXX-XXXX'
  -- 딜이 만료·삭제돼도 예약 기록은 남아야 하므로 참조는 SET NULL,
  -- 실제 예약 내용은 snapshot_json 에 동결해 보관한다.
  deal_id        INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  snapshot_json  TEXT    NOT NULL,

  days           INTEGER NOT NULL CHECK (days >= 1),
  quoted_price   INTEGER NOT NULL CHECK (quoted_price >= 0),  -- 총 견적(원)

  pickup_at      TEXT    NOT NULL,          -- 'YYYY-MM-DD HH:MM'
  return_at      TEXT    NOT NULL,
  pickup_place   TEXT,

  name           TEXT    NOT NULL,
  phone          TEXT    NOT NULL,          -- 숫자만 정규화해 저장
  email          TEXT,
  driver_age     INTEGER CHECK (driver_age IS NULL OR driver_age BETWEEN 18 AND 100),
  license_years  INTEGER CHECK (license_years IS NULL OR license_years >= 0),
  memo           TEXT,

  -- 개인정보 수집·이용에 동의한 시각. 동의 없이 접수하지 않는다.
  privacy_agreed_at TEXT,

  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'confirmed', 'cancelled', 'rejected')),
  admin_memo     TEXT,
  cancelled_by   TEXT    CHECK (cancelled_by IS NULL OR cancelled_by IN ('user', 'admin')),

  created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),

  CHECK (return_at > pickup_at)
);

CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_phone   ON bookings (phone);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup  ON bookings (pickup_at);
CREATE INDEX IF NOT EXISTS idx_bookings_deal    ON bookings (deal_id);

-- ── 수집 로그 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crawl_logs (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  source_key  TEXT,                         -- 소스가 지워져도 남는 표시용
  started_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  finished_at TEXT,
  status      TEXT    NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'ok', 'blocked', 'error', 'skipped', 'unchanged')),
  fetched     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  expired     INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_logs_time ON crawl_logs (started_at DESC);

-- ── 관리자 세션 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions (expires_at);
