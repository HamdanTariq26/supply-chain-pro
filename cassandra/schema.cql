DROP KEYSPACE IF EXISTS supply_chain;

CREATE KEYSPACE supply_chain
  WITH replication = {'class': 'NetworkTopologyStrategy', 'dc1': 3}
  AND durable_writes = true;

USE supply_chain;

CREATE TABLE users (
  user_id         UUID PRIMARY KEY,
  email           TEXT,
  password        TEXT,
  full_name       TEXT,
  phone           TEXT,
  cnic            TEXT,
  profile_pic     TEXT,
  role            TEXT,
  is_active       BOOLEAN,
  created_at      TIMESTAMP,
  updated_at      TIMESTAMP
);
CREATE INDEX ON users (email);
CREATE INDEX ON users (cnic);
CREATE INDEX ON users (role);

CREATE TABLE manufacturer_profiles (
  user_id             UUID PRIMARY KEY,
  company_name        TEXT,
  registration_number TEXT,
  factory_address     TEXT,
  city                TEXT,
  country             TEXT,
  product_categories  TEXT,
  employee_count      TEXT,
  website             TEXT,
  company_logo        TEXT,
  established_year    TEXT,
  created_at          TIMESTAMP
);

CREATE TABLE distributor_profiles (
  user_id             UUID PRIMARY KEY,
  company_name        TEXT,
  registration_number TEXT,
  warehouse_address   TEXT,
  city                TEXT,
  country             TEXT,
  coverage_areas      TEXT,
  fleet_size          TEXT,
  storage_capacity    TEXT,
  company_logo        TEXT,
  created_at          TIMESTAMP
);

CREATE TABLE retailer_profiles (
  user_id        UUID PRIMARY KEY,
  store_name     TEXT,
  license_number TEXT,
  store_address  TEXT,
  city           TEXT,
  country        TEXT,
  store_type     TEXT,
  store_size     TEXT,
  store_logo     TEXT,
  opening_hours  TEXT,
  created_at     TIMESTAMP
);

CREATE TABLE customer_profiles (
  user_id          UUID PRIMARY KEY,
  delivery_address TEXT,
  city             TEXT,
  country          TEXT,
  date_of_birth    TEXT,
  gender           TEXT,
  created_at       TIMESTAMP
);

CREATE TABLE products (
  product_id        UUID PRIMARY KEY,
  name              TEXT,
  category          TEXT,
  description       TEXT,
  manufacturer_id   UUID,
  manufacturer_org  TEXT,
  current_status    TEXT,
  current_owner_id  UUID,
  current_owner_org TEXT,
  fabric_tx_id      TEXT,
  metadata          MAP<TEXT, TEXT>,
  created_at        TIMESTAMP,
  updated_at        TIMESTAMP
);
CREATE INDEX ON products (current_status);
CREATE INDEX ON products (manufacturer_id);
CREATE INDEX ON products (current_owner_id);
CREATE INDEX ON products (manufacturer_org);
CREATE INDEX ON products (current_owner_org);

CREATE TABLE product_events (
  product_id   UUID,
  event_time   TIMEUUID,
  event_type   TEXT,
  from_user_id UUID,
  from_org     TEXT,
  to_user_id   UUID,
  to_org       TEXT,
  location     TEXT,
  fabric_tx_id TEXT,
  temperature  DECIMAL,
  humidity     DECIMAL,
  notes        TEXT,
  PRIMARY KEY (product_id, event_time)
) WITH CLUSTERING ORDER BY (event_time DESC);

CREATE TABLE products_by_user (
  user_id    UUID,
  product_id UUID,
  added_at   TIMEUUID,
  role       TEXT,
  PRIMARY KEY (user_id, added_at)
) WITH CLUSTERING ORDER BY (added_at DESC);

CREATE TABLE ownership_history (
  product_id    UUID,
  transfer_time TIMEUUID,
  from_user_id  UUID,
  from_org      TEXT,
  to_user_id    UUID,
  to_org        TEXT,
  transfer_type TEXT,
  fabric_tx_id  TEXT,
  PRIMARY KEY (product_id, transfer_time)
) WITH CLUSTERING ORDER BY (transfer_time DESC);

CREATE TABLE blockchain_audit (
  product_id   UUID,
  tx_time      TIMEUUID,
  fabric_tx_id TEXT,
  block_number BIGINT,
  chaincode_fn TEXT,
  payload_hash TEXT,
  verified     BOOLEAN,
  PRIMARY KEY (product_id, tx_time)
) WITH CLUSTERING ORDER BY (tx_time DESC);


CREATE TABLE payments (
  product_id    UUID,
  payment_time  TIMEUUID,
  amount        DECIMAL,
  currency      TEXT,
  payment_ref   TEXT,
  fabric_tx_id  TEXT,
  buyer_org     TEXT,
  status        TEXT,
  PRIMARY KEY (product_id, payment_time)
) WITH CLUSTERING ORDER BY (payment_time DESC);
