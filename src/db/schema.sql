-- PAI Bets — Supabase Schema
-- Run once to set up the prediction market database

-- ── Registered bots (participants) ─────────────────────────
CREATE TABLE IF NOT EXISTS bots (
  id           TEXT PRIMARY KEY,          -- e.g. "pai-research", "moltbook-bot-xyz"
  name         TEXT NOT NULL,             -- display name
  owner        TEXT,                      -- owner handle/email
  api_key      TEXT UNIQUE NOT NULL,      -- pai_bot_xxxxxxxx
  pai_balance  BIGINT DEFAULT 0,          -- PAI coins (off-chain, in micro-units x1e6)
  reputation   INTEGER DEFAULT 1000,      -- starts at 1000
  wins         INTEGER DEFAULT 0,
  losses       INTEGER DEFAULT 0,
  total_won    BIGINT DEFAULT 0,
  total_lost   BIGINT DEFAULT 0,
  streak       INTEGER DEFAULT 0,
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  metadata     JSONB DEFAULT '{}'
);

-- ── Bets ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
  id           TEXT PRIMARY KEY,          -- bet-000001
  thesis       TEXT NOT NULL,             -- "Bitcoin hits $200K by Dec 2026"
  category     TEXT NOT NULL,             -- tech|business|market|science|crypto|geo|ai
  proposed_by  TEXT REFERENCES bots(id),
  status       TEXT DEFAULT 'open',       -- open|closed|resolved_for|resolved_against|cancelled
  deadline     TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,                      -- bot_id or "arbiter:marek"
  resolution   TEXT,                      -- explanation
  total_pool   BIGINT DEFAULT 0,          -- total PAI staked
  metadata     JSONB DEFAULT '{}'
);

-- ── Positions (individual stakes) ──────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  id           SERIAL PRIMARY KEY,
  bet_id       TEXT REFERENCES bets(id) ON DELETE CASCADE,
  bot_id       TEXT REFERENCES bots(id),
  side         TEXT NOT NULL CHECK (side IN ('for', 'against')),
  amount       BIGINT NOT NULL,           -- PAI in micro-units
  reason       TEXT,                      -- why they believe this
  payout       BIGINT,                    -- filled on resolution
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bet_id, bot_id)                  -- one position per bot per bet
);

-- ── Ledger transactions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger (
  id           SERIAL PRIMARY KEY,
  from_bot     TEXT,                      -- null = system/mint
  to_bot       TEXT,
  amount       BIGINT NOT NULL,
  reason       TEXT,
  bet_id       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Verification codes (2-step proof-of-ownership) ───────────
CREATE TABLE IF NOT EXISTS verification_codes (
  id         SERIAL PRIMARY KEY,
  bot_id     TEXT REFERENCES bots(id) ON DELETE CASCADE,
  method     TEXT NOT NULL CHECK (method IN ('x', 'email')),
  handle     TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bot_id, method)              -- one pending verification per method per bot
);

-- ── API key index ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bots_api_key ON bots(api_key);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
CREATE INDEX IF NOT EXISTS idx_positions_bet ON positions(bet_id);
CREATE INDEX IF NOT EXISTS idx_positions_bot ON positions(bot_id);
CREATE INDEX IF NOT EXISTS idx_ledger_from ON ledger(from_bot);
CREATE INDEX IF NOT EXISTS idx_ledger_to ON ledger(to_bot);
CREATE INDEX IF NOT EXISTS idx_vcode_bot ON verification_codes(bot_id);

-- ── RLS: API key auth (row level security) ─────────────────
-- Bots can only read/write their own data
ALTER TABLE bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;

-- Public read for bets and leaderboard
CREATE POLICY "bets_public_read" ON bets FOR SELECT USING (true);
CREATE POLICY "positions_public_read" ON positions FOR SELECT USING (true);
CREATE POLICY "bots_public_read" ON bots FOR SELECT USING (true);

-- ── Seed: PAI system bot (treasury) ─────────────────────────
-- NOTE: api_key is set at application startup from SYSTEM_API_KEY env var (hashed).
-- The placeholder below is overwritten on first boot — never used for auth.
INSERT INTO bots (id, name, owner, api_key, pai_balance, reputation)
VALUES (
  'system',
  'PAI System',
  'marek',
  'PLACEHOLDER_REPLACED_AT_STARTUP',
  600000000000000,  -- 600M PAI (60% treasury)
  9999
) ON CONFLICT (id) DO NOTHING;
