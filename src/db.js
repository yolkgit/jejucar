'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jeju.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL: 수집기가 쓰는 동안에도 웹 요청이 읽을 수 있게 한다.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 수집기와 웹 요청이 겹칠 때 SQLITE_BUSY 로 즉시 실패하지 않도록.
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * 가벼운 마이그레이션.
 * CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블에 컬럼을 추가해 주지 않으므로,
 * 스키마에 컬럼이 늘어나면 기존 DB 를 위해 여기서 채워 넣는다.
 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

// 개인정보 수집·이용 동의 시각. 개인정보보호법 제15조상 동의 사실을 남겨야 한다.
ensureColumn('bookings', 'privacy_agreed_at', 'TEXT');

/**
 * deals.list_price / discount_pct 를 NOT NULL 에서 NULL 허용으로 바꾼다.
 * SQLite 는 컬럼 제약을 ALTER 로 못 바꾸므로 테이블을 다시 만들어야 한다.
 * 이미 NULL 허용이면 아무것도 하지 않는다.
 */
function migrateNullableListPrice() {
  const cols = db.prepare('PRAGMA table_info(deals)').all();
  const listCol = cols.find((c) => c.name === 'list_price');
  if (!listCol || listCol.notnull === 0) return false;

  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // 새 정의만 뽑아 임시 테이블을 만들고 데이터를 옮긴 뒤 갈아끼운다.
  const createDeals = schemaSql
    .match(/CREATE TABLE IF NOT EXISTS deals \([\s\S]*?\n\);/)?.[0]
    ?.replace('IF NOT EXISTS deals', 'deals_new');
  if (!createDeals) throw new Error('schema.sql 에서 deals 정의를 찾지 못했습니다');

  const names = cols.map((c) => c.name).join(', ');

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(createDeals);
    db.exec(`INSERT INTO deals_new (${names}) SELECT ${names} FROM deals`);
    db.exec('DROP TABLE deals');
    db.exec('ALTER TABLE deals_new RENAME TO deals');
    // 인덱스는 테이블과 함께 사라지므로 스키마를 다시 적용해 되살린다.
    db.exec(schemaSql.match(/CREATE INDEX IF NOT EXISTS idx_deals[\s\S]*?;/g).join('\n'));
  })();
  db.pragma('foreign_keys = ON');

  console.log('[마이그레이션] deals.list_price 를 NULL 허용으로 변경');
  return true;
}
migrateNullableListPrice();

/** 'YYYY-MM-DD HH:MM:SS' 로컬 시각 문자열. SQLite datetime('now','localtime') 과 형식을 맞춘다. */
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function today() {
  return now().slice(0, 10);
}

/**
 * 정가·할인가로부터 할인율(내림)을 계산한다. 저장 전 항상 이 함수를 거친다.
 * 정가가 없으면 null — 0 이 아니다. "할인 0%"와 "할인율을 알 수 없음"은 다르고,
 * 화면에서도 다르게 보여야 한다.
 */
function discountPct(listPrice, salePrice) {
  if (listPrice === null || listPrice === undefined || listPrice === '') return null;
  const list = Number(listPrice);
  const sale = Number(salePrice);
  if (!Number.isFinite(list) || !Number.isFinite(sale) || list <= 0) return null;
  if (sale >= list) return 0;
  return Math.min(99, Math.floor(((list - sale) / list) * 100));
}

/**
 * 딜 upsert. (source_id, external_id) 기준으로 중복을 합친다.
 * 이미 있는 딜은 가격·상태를 갱신하고 last_seen_at 을 찍는다.
 * first_seen_at 은 보존해서 "언제부터 뜬 특가인지" 를 잃지 않는다.
 * @returns {'inserted'|'updated'}
 */
const upsertDealStmt = db.prepare(`
  INSERT INTO deals (
    source_id, external_id, vendor_id, vendor_name,
    car_model, car_class, fuel, seats, transmission,
    list_price, sale_price, discount_pct,
    deal_type, insurance, insurance_included, free_cancel,
    pickup_location, min_days, min_age, min_license_years,
    valid_from, valid_to, stock, detail_url, image_url, notes,
    status, first_seen_at, last_seen_at
  ) VALUES (
    @source_id, @external_id, @vendor_id, @vendor_name,
    @car_model, @car_class, @fuel, @seats, @transmission,
    @list_price, @sale_price, @discount_pct,
    @deal_type, @insurance, @insurance_included, @free_cancel,
    @pickup_location, @min_days, @min_age, @min_license_years,
    @valid_from, @valid_to, @stock, @detail_url, @image_url, @notes,
    @status, @now, @now
  )
  ON CONFLICT (source_id, external_id) DO UPDATE SET
    vendor_id          = excluded.vendor_id,
    vendor_name        = excluded.vendor_name,
    car_model          = excluded.car_model,
    car_class          = excluded.car_class,
    fuel               = excluded.fuel,
    seats              = excluded.seats,
    transmission       = excluded.transmission,
    list_price         = excluded.list_price,
    sale_price         = excluded.sale_price,
    discount_pct       = excluded.discount_pct,
    deal_type          = excluded.deal_type,
    insurance          = excluded.insurance,
    insurance_included = excluded.insurance_included,
    free_cancel        = excluded.free_cancel,
    pickup_location    = excluded.pickup_location,
    min_days           = excluded.min_days,
    min_age            = excluded.min_age,
    min_license_years  = excluded.min_license_years,
    valid_from         = excluded.valid_from,
    valid_to           = excluded.valid_to,
    stock              = excluded.stock,
    detail_url         = excluded.detail_url,
    image_url          = excluded.image_url,
    notes              = excluded.notes,
    status             = excluded.status,
    last_seen_at       = excluded.last_seen_at
`);

// UPDATE 경로에서도 changes 는 1 이고 lastInsertRowid 는 직전 INSERT 값이 그대로 남는다.
// 두 값 모두 신규/갱신을 구분해 주지 못하므로 존재 여부를 먼저 확인한다.
// better-sqlite3 는 동기 실행이라 이 조회와 upsert 사이에 다른 쓰기가 끼어들 수 없다.
const existingDealStmt = db.prepare(
  'SELECT id FROM deals WHERE source_id = ? AND external_id = ?'
);

function upsertDeal(deal) {
  const row = {
    source_id: deal.source_id,
    external_id: String(deal.external_id),
    vendor_id: deal.vendor_id ?? null,
    vendor_name: deal.vendor_name,
    car_model: deal.car_model,
    car_class: deal.car_class,
    fuel: deal.fuel ?? null,
    seats: deal.seats ?? null,
    transmission: deal.transmission ?? '자동',
    list_price:
      deal.list_price === null || deal.list_price === undefined
        ? null
        : Math.round(deal.list_price),
    sale_price: Math.round(deal.sale_price),
    discount_pct: discountPct(deal.list_price, deal.sale_price),
    deal_type: deal.deal_type ?? null,
    insurance: deal.insurance ?? null,
    insurance_included: deal.insurance_included ? 1 : 0,
    free_cancel: deal.free_cancel === false ? 0 : 1,
    pickup_location: deal.pickup_location ?? null,
    min_days: deal.min_days ?? 1,
    min_age: deal.min_age ?? null,
    min_license_years: deal.min_license_years ?? null,
    valid_from: deal.valid_from ?? null,
    valid_to: deal.valid_to ?? null,
    stock: deal.stock ?? null,
    detail_url: deal.detail_url ?? null,
    image_url: deal.image_url ?? null,
    notes: deal.notes ?? null,
    status: deal.status ?? 'active',
    now: now(),
  };
  const existed = existingDealStmt.get(row.source_id, row.external_id);
  upsertDealStmt.run(row);
  return existed ? 'updated' : 'inserted';
}

/** 업체명을 보고 없으면 만들어 id 를 돌려준다. */
const findVendor = db.prepare('SELECT id FROM vendors WHERE name = ?');
const insertVendor = db.prepare(
  'INSERT INTO vendors (name, phone, pickup_type, address, rating, review_count) VALUES (?, ?, ?, ?, ?, ?)'
);

function ensureVendor(name, extra = {}) {
  const found = findVendor.get(name);
  if (found) return found.id;
  const info = insertVendor.run(
    name,
    extra.phone ?? null,
    extra.pickup_type ?? null,
    extra.address ?? null,
    extra.rating ?? null,
    extra.review_count ?? 0
  );
  return Number(info.lastInsertRowid);
}

const findSource = db.prepare('SELECT * FROM sources WHERE key = ?');
const insertSource = db.prepare(`
  INSERT INTO sources (key, name, kind, base_url, enabled, note)
  VALUES (@key, @name, @kind, @base_url, @enabled, @note)
`);

function ensureSource(src) {
  const found = findSource.get(src.key);
  if (found) return found;
  insertSource.run({
    key: src.key,
    name: src.name,
    kind: src.kind ?? 'crawler',
    base_url: src.base_url ?? null,
    enabled: src.enabled ? 1 : 0,
    note: src.note ?? null,
  });
  return findSource.get(src.key);
}

/**
 * 유효기간이 지난 딜을 expired 로 내린다.
 * 삭제하지 않는 이유: 기존 예약의 스냅샷 참조와 "지난 특가" 통계를 남기기 위해.
 */
const expireStmt = db.prepare(`
  UPDATE deals SET status = 'expired'
  WHERE status = 'active' AND valid_to IS NOT NULL AND valid_to < ?
`);

function expireStaleDeals() {
  return expireStmt.run(today()).changes;
}

module.exports = {
  db,
  DB_PATH,
  now,
  today,
  discountPct,
  upsertDeal,
  ensureVendor,
  ensureSource,
  expireStaleDeals,
};
