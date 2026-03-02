-- PAI Bets — Atomic Balance & Stats Functions
-- Eliminates read-modify-write race conditions by using atomic SQL operations.
-- Run this in Supabase SQL Editor after schema.sql.

-- ── Increment/decrement bot balance atomically ──────────────
-- amount can be positive (credit) or negative (debit)
-- For debits (negative amount): prevents balance going below 0 (returns NULL if insufficient)
CREATE OR REPLACE FUNCTION increment_balance(bot_id TEXT, amount BIGINT)
RETURNS BIGINT AS $$
  UPDATE bots
  SET pai_balance = pai_balance + amount
  WHERE id = bot_id
    AND (amount >= 0 OR pai_balance + amount >= 0)  -- guard: no negative balance on debits
  RETURNING pai_balance;
$$ LANGUAGE sql;

-- ── Increment bet total_pool atomically ──────────────────────
CREATE OR REPLACE FUNCTION increment_pool(p_bet_id TEXT, amount BIGINT)
RETURNS void AS $$
  UPDATE bets
  SET total_pool = total_pool + amount
  WHERE id = p_bet_id;
$$ LANGUAGE sql;

-- ── Atomic verify bot: set verified + increment balance ──────
CREATE OR REPLACE FUNCTION verify_bot_atomic(
  p_bot_id TEXT,
  p_bonus BIGINT,
  p_method TEXT,
  p_handle TEXT
)
RETURNS BIGINT AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  UPDATE bots
  SET verified = true,
      tier = CASE WHEN tier = 'premium' THEN 'premium' ELSE 'verified' END,
      pai_balance = pai_balance + p_bonus,
      x_handle = CASE WHEN p_method = 'x' THEN p_handle ELSE x_handle END,
      email = CASE WHEN p_method = 'email' THEN p_handle ELSE email END
  WHERE id = p_bot_id
  RETURNING pai_balance INTO new_balance;
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

-- ── Atomic premium deposit: set tier + increment balance ─────
CREATE OR REPLACE FUNCTION process_deposit_atomic(
  p_bot_id TEXT,
  p_total_credit BIGINT,
  p_deposit_amount BIGINT,
  p_tx_signature TEXT
)
RETURNS BIGINT AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  UPDATE bots
  SET tier = 'premium',
      deposit_amount = COALESCE(deposit_amount, 0) + p_deposit_amount,
      pai_balance = pai_balance + p_total_credit,
      metadata = jsonb_set(COALESCE(metadata, '{}'), '{last_deposit_tx}', to_jsonb(p_tx_signature))
  WHERE id = p_bot_id
  RETURNING pai_balance INTO new_balance;
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

-- ── Atomic winner update: balance + stats in one query ───────
CREATE OR REPLACE FUNCTION update_winner_atomic(
  p_bot_id TEXT,
  p_payout BIGINT,
  p_profit BIGINT,
  p_rep_gain INTEGER
)
RETURNS void AS $$
  UPDATE bots
  SET pai_balance = pai_balance + p_payout,
      wins = wins + 1,
      total_won = total_won + p_profit,
      reputation = reputation + p_rep_gain,
      streak = CASE WHEN streak > 0 THEN streak + 1 ELSE 1 END,
      last_seen = NOW()
  WHERE id = p_bot_id;
$$ LANGUAGE sql;

-- ── Atomic loser update: stats in one query ──────────────────
CREATE OR REPLACE FUNCTION update_loser_atomic(
  p_bot_id TEXT,
  p_loss_amount BIGINT,
  p_rep_loss INTEGER
)
RETURNS void AS $$
  UPDATE bots
  SET losses = losses + 1,
      total_lost = total_lost + p_loss_amount,
      reputation = GREATEST(0, reputation - p_rep_loss),
      streak = CASE WHEN streak < 0 THEN streak - 1 ELSE -1 END,
      last_seen = NOW()
  WHERE id = p_bot_id;
$$ LANGUAGE sql;

-- ── Atomic position amount increment (for orderbook fills) ───
CREATE OR REPLACE FUNCTION increment_position_amount(
  p_bet_id TEXT,
  p_bot_id TEXT,
  p_amount BIGINT
)
RETURNS void AS $$
  UPDATE positions
  SET amount = amount + p_amount
  WHERE bet_id = p_bet_id AND bot_id = p_bot_id;
$$ LANGUAGE sql;

-- ── Atomic order filled increment ────────────────────────────
CREATE OR REPLACE FUNCTION increment_order_filled(
  p_order_id INTEGER,
  p_fill_amount BIGINT
)
RETURNS TABLE(new_filled BIGINT, order_amount BIGINT) AS $$
  UPDATE orders
  SET filled = filled + p_fill_amount,
      status = CASE
        WHEN filled + p_fill_amount >= amount THEN 'filled'
        ELSE 'partial'
      END
  WHERE id = p_order_id
  RETURNING filled, amount;
$$ LANGUAGE sql;
