// 数据库结构：与根目录 schema.sql 保持一致（测试会检查）。Worker 首次访问时自动建表。
export default `-- 骏和屋拼单 D1 数据库结构
-- 每张表都带 group_id，以后开放给多个团时不用改结构。

CREATE TABLE IF NOT EXISTS groups (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  prefecture    TEXT NOT NULL DEFAULT '大阪府',
  buyer_email   TEXT NOT NULL,
  cc_email      TEXT,
  admin_hash    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- 团员：CN 在团内唯一；PIN（QQ 号后 4 位）只存加盐哈希
CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  cn         TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, cn)
);

-- 店铺运费：按收货地各存一份。tiers 是 JSON：[{"min":0,"fee":550},{"min":2000,"fee":0}]
-- source = 'auto'（抓取）或 'manual'（团长手动，优先）
CREATE TABLE IF NOT EXISTS shops (
  shop_id     TEXT NOT NULL,
  prefecture  TEXT NOT NULL,
  name        TEXT,
  tiers       TEXT,
  source      TEXT NOT NULL DEFAULT 'auto',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (shop_id, prefecture)
);

-- 拼单：一家店同一时间只有一个 status='open' 的团
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  shop_id     TEXT NOT NULL,
  shop_name   TEXT,
  status      TEXT NOT NULL DEFAULT 'open',   -- open 拼单中 / done 已成团 / ordered 已下单 / closed 已关闭
  fee_override TEXT,                          -- 本团单独调整的运费分档（JSON），可空
  done_at     INTEGER,
  mail_status TEXT,                           -- sent / failed:原因
  created_at  INTEGER NOT NULL,
  ready_at    INTEGER,                        -- 满足成团条件的时间（等团长确认）
  order_no    TEXT,                           -- 团长下单后填的单号
  ordered_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(group_id, shop_id, status);

-- 成员在某个团里愿意分摊的运费上限（整单合计）
CREATE TABLE IF NOT EXISTS caps (
  order_id  TEXT NOT NULL REFERENCES orders(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  cap       INTEGER NOT NULL,
  PRIMARY KEY (order_id, member_id)
);

-- 商品：撤销只记时间，不删除
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  member_id   TEXT NOT NULL REFERENCES members(id),
  product_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT,
  image       TEXT,
  price       INTEGER NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,
  removed_by  TEXT                            -- self / admin
);
CREATE INDEX IF NOT EXISTS idx_items_order ON items(order_id, removed_at);
`;
