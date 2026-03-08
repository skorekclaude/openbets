/**
 * PAI Bets — Market Engine
 * Core prediction market logic: create bets, join, resolve, payouts.
 */

import { randomBytes } from "node:crypto";
import { db, PAI, fromPAI, type Bet, type Position } from "../db/client.ts";
import { generateApiKey, generateBetId, hashApiKey } from "./utils.ts";
import { checkTweetForCode, sendVerificationEmail } from "./twitter.ts";

const MIN_BET = PAI(100);          // 100 PAI minimum (starter can make 2 bets)
const MAX_BET = PAI(1_000_000);    // 1M PAI
const MAX_ACTIVE_BETS_STARTER = 5;
const MAX_ACTIVE_BETS_VERIFIED = 15;
const MAX_ACTIVE_BETS_PREMIUM = 20;
const REP_WIN = 10;
const REP_LOSS = 5;
const CONTRARIAN_MULTIPLIER = 1.5;
const DISPUTE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h dispute window

// Maker/Taker fees (in basis points, 100 bps = 1%)
const TAKER_FEE_BPS = 100;         // 1% for regular takers
const TAKER_FEE_PREMIUM_BPS = 50;  // 0.5% for premium bots

// ── Tier system ─────────────────────────────────────────────
export type BotTier = "starter" | "verified" | "premium";

const STARTER_BALANCE = PAI(100_000);   // 100K credits free (virtual chips)
const VERIFY_BONUS = PAI(1_000_000);    // +1M credits on verification (X.com/email)

// Premium deposit matching (decreasing %)
export function calculateMatchBonus(depositPai: number): number {
  if (depositPai >= 1_000_000) return PAI(200_000);   // 1M → +200K (20%)
  if (depositPai >= 100_000)   return PAI(50_000);     // 100K → +50K (50%)
  if (depositPai >= 10_000)    return PAI(5_000);       // 10K → +5K (50%)
  return 0;
}

export function getMaxActiveBets(tier: BotTier, botId?: string): number {
  // Internal PAI bots (pai-*) have no active bet limit — they're the house
  if (botId?.startsWith("pai-")) return 999;
  if (tier === "premium") return MAX_ACTIVE_BETS_PREMIUM;
  if (tier === "verified") return MAX_ACTIVE_BETS_VERIFIED;
  return MAX_ACTIVE_BETS_STARTER;
}

export function getMaxBet(tier: BotTier): number {
  if (tier === "premium") return MAX_BET;
  if (tier === "verified") return PAI(100_000);   // 100K credits max for verified
  return PAI(10_000);                              // 10K credits max for starters
}

// ── Bot registration ────────────────────────────────────────

export async function registerBot(
  id: string,
  name: string,
  owner?: string,
  email?: string,
  x_handle?: string,
): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
  // Check if already exists
  const { data: existing } = await db.from("bots").select("id").eq("id", id).single();
  if (existing) return { ok: false, error: `Bot "${id}" already registered` };

  const apiKey = generateApiKey(id);

  const { error } = await db.from("bots").insert({
    id,
    name,
    owner: owner || null,
    email: email || null,
    x_handle: x_handle || null,
    api_key: hashApiKey(apiKey),  // Store SHA-256 hash, not plaintext
    pai_balance: STARTER_BALANCE,
    tier: "starter",
    verified: false,
    deposit_amount: 0,
  });

  if (error) return { ok: false, error: error.message };

  // Log initial allocation from ecosystem
  await db.from("ledger").insert({
    from_bot: "system",
    to_bot: id,
    amount: STARTER_BALANCE,
    reason: "Starter allocation (100K credits)",
  });

  return { ok: true, apiKey };
}

// ── Verify bot (2-step: start → complete) ───────────────────
// Step 1: Generate code, store pending, send instructions
// Step 2: Verify code (tweet check or email code match)

const VERIFY_CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function generateVerifyCode(): string {
  // PAI-XXXX format (e.g. PAI-A7K9)
  return "PAI-" + randomBytes(3).toString("hex").toUpperCase().slice(0, 4);
}

export async function startVerification(
  botId: string,
  method: "x" | "email",
  handle: string,
): Promise<{ ok: boolean; code?: string; instructions?: string; expires_in_minutes?: number; error?: string }> {
  const { data: bot } = await db.from("bots").select("id, verified").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };
  if (bot.verified) return { ok: false, error: "Already verified" };

  // Check handle not already claimed by another bot
  if (method === "x") {
    const { data: existing } = await db.from("bots").select("id").eq("x_handle", handle).neq("id", botId).single();
    if (existing) return { ok: false, error: "That X handle is already claimed by another bot" };
  } else {
    const { data: existing } = await db.from("bots").select("id").eq("email", handle).neq("id", botId).single();
    if (existing) return { ok: false, error: "That email is already claimed by another bot" };
  }

  const code = generateVerifyCode();
  const expiresAt = new Date(Date.now() + VERIFY_CODE_EXPIRY_MS);

  // Upsert: replace any existing pending verification for this bot+method
  await db.from("verification_codes").upsert(
    {
      bot_id: botId,
      method,
      handle,
      code,
      expires_at: expiresAt.toISOString(),
      used: false,
    },
    { onConflict: "bot_id,method" },
  );

  // For email: send the code
  if (method === "email") {
    const emailResult = await sendVerificationEmail(handle, code);
    if (!emailResult.sent) {
      return { ok: false, error: emailResult.error || "Failed to send verification email" };
    }
    return {
      ok: true,
      instructions: `Verification code sent to ${handle}. Check your inbox and submit the code to complete verification.`,
      expires_in_minutes: 15,
    };
  }

  // For X.com: return code with tweet instructions
  const cleanHandle = handle.replace(/^@/, "");
  const tweetText = `Verifying my OpenBets bot: ${code} #OpenBets @openbets_ai`;
  return {
    ok: true,
    code,
    instructions: `Tweet exactly: "${tweetText}" from @${cleanHandle}, then click "Complete verification".`,
    expires_in_minutes: 15,
  };
}

export async function completeVerification(
  botId: string,
  code: string,
): Promise<{ ok: boolean; newBalance?: number; tier?: string; error?: string }> {
  // Look up pending verification
  const { data: pending } = await db
    .from("verification_codes")
    .select("*")
    .eq("bot_id", botId)
    .eq("used", false)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (!pending) {
    return { ok: false, error: "No pending verification found, or code has expired. Start a new verification." };
  }

  // For email: just compare the code
  if (pending.method === "email") {
    if (pending.code !== code) {
      return { ok: false, error: "Invalid verification code." };
    }
  }

  // For X.com: check if the tweet exists
  if (pending.method === "x") {
    const tweetResult = await checkTweetForCode(pending.handle, pending.code);
    if (!tweetResult.found) {
      return {
        ok: false,
        error: tweetResult.error || `Tweet with code "${pending.code}" not found from @${pending.handle.replace(/^@/, "")}. Make sure the tweet is public and try again.`,
      };
    }
  }

  // Mark code as used
  await db.from("verification_codes").update({ used: true }).eq("id", pending.id);

  // Atomic: check uniqueness + set verified + increment balance
  const { data: newBalance } = await db.rpc("verify_bot_atomic", {
    p_bot_id: botId,
    p_bonus: VERIFY_BONUS,
    p_method: pending.method,
    p_handle: pending.handle,
  });

  // -1 signals handle already claimed (atomic check inside DB function)
  if (newBalance === -1) {
    return { ok: false, error: `That ${pending.method === "x" ? "X handle" : "email"} is already claimed by another bot` };
  }

  await db.from("ledger").insert({
    from_bot: "system",
    to_bot: botId,
    amount: VERIFY_BONUS,
    reason: `Verification bonus (${pending.method}: ${pending.handle})`,
  });

  return { ok: true, newBalance: fromPAI(newBalance), tier: "verified" };
}

// Legacy wrapper — kept for backward compat, deprecated
export async function verifyBot(
  botId: string,
  method: "x" | "email",
  handle: string,
): Promise<{ ok: boolean; newBalance?: number; error?: string }> {
  return { ok: false, error: "Deprecated: use /bots/verify/start and /bots/verify/complete instead." };
}

// ── Premium deposit ─────────────────────────────────────────

export async function processPremiumDeposit(
  botId: string,
  depositPai: number,
  txSignature: string,
): Promise<{ ok: boolean; newBalance?: number; matchBonus?: number; error?: string }> {
  const { data: bot } = await db.from("bots").select("id").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };

  const depositMicro = PAI(depositPai);
  const matchBonus = calculateMatchBonus(depositPai);

  const totalCredit = depositMicro + matchBonus;

  // Atomic: set tier + increment balance + deposit_amount in one SQL call (no race condition)
  const { data: newBalance } = await db.rpc("process_deposit_atomic", {
    p_bot_id: botId,
    p_total_credit: totalCredit,
    p_deposit_amount: depositMicro,
    p_tx_signature: txSignature,
  });

  // Log deposit
  await db.from("ledger").insert({
    from_bot: `solana:${txSignature}`,
    to_bot: botId,
    amount: depositMicro,
    reason: `Premium deposit: ${depositPai.toLocaleString()} PAI on-chain`,
  });

  // Log match bonus
  if (matchBonus > 0) {
    await db.from("ledger").insert({
      from_bot: "system",
      to_bot: botId,
      amount: matchBonus,
      reason: `Premium match bonus (${Math.round(matchBonus / depositMicro * 100)}%)`,
    });
  }

  return {
    ok: true,
    newBalance: fromPAI(newBalance),
    matchBonus: fromPAI(matchBonus),
  };
}

export async function getBotByKey(apiKey: string) {
  const hashed = hashApiKey(apiKey);

  // Primary: lookup by hashed key (secure storage)
  const { data } = await db
    .from("bots")
    .select("*")
    .eq("api_key", hashed)
    .single();
  if (data) return data;

  // Fallback: legacy plaintext key (auto-migrate on first use)
  const { data: legacy } = await db
    .from("bots")
    .select("*")
    .eq("api_key", apiKey)
    .single();
  if (legacy) {
    // Auto-migrate: replace plaintext with hash
    await db.from("bots").update({ api_key: hashed }).eq("id", legacy.id);
    return legacy;
  }

  return null;
}

// ── Propose bet ─────────────────────────────────────────────

export async function proposeBet(
  botId: string,
  thesis: string,
  category: string,
  side: "for" | "against",
  amount: number,  // in PAI (not micro)
  reason: string,
  deadlineDays: number = 30,
): Promise<{ ok: boolean; betId?: string; error?: string }> {
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive number" };
  }
  const amountMicro = PAI(amount);

  if (amountMicro < MIN_BET) return { ok: false, error: `Min bet: 100 PAI` };
  if (!thesis || thesis.length < 10) return { ok: false, error: "Thesis too short (min 10 chars)" };

  // Check balance + tier limits
  const { data: bot } = await db.from("bots").select("pai_balance, tier, verified, wins, losses").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };

  const tier = (bot.tier || "starter") as BotTier;

  // After 2 placed bets, starter bots must verify OR buy PAI to continue
  if (tier === "starter" && !bot.verified) {
    const { count } = await db.from("positions").select("id", { count: "exact", head: true }).eq("bot_id", botId);
    if ((count || 0) >= 2) {
      return {
        ok: false,
        error: "🔒 You've used your 2 free bets! To continue: (1) Buy PAI on Jupiter and deposit on-chain via POST /bots/deposit, (2) Verify via X.com, or (3) Verify via email. POST /bots/verify or POST /bots/deposit to unlock.",
      };
    }
  }

  const maxBet = getMaxBet(tier);
  if (amountMicro > maxBet) {
    return { ok: false, error: `Max bet for ${tier}: ${fromPAI(maxBet).toLocaleString()} PAI. Upgrade tier for higher limits.` };
  }

  if (bot.pai_balance < amountMicro) {
    return { ok: false, error: `Insufficient balance: ${fromPAI(bot.pai_balance).toLocaleString()} PAI (need ${amount.toLocaleString()})` };
  }

  // Daily bet proposal limit — soul education, not spam
  // pai-* internal bots: no daily limit (market makers, 2T PAI balance)
  // premium: 500/day, verified: 100/day, starter: no limit (capped at 5 active total)
  if (tier !== "starter" && !botId?.startsWith("pai-")) {
    const dailyLimit = tier === "premium" ? 500 : 100;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: dailyCount } = await db
      .from("bets")
      .select("id", { count: "exact", head: true })
      .eq("proposed_by", botId)
      .gte("created_at", since);
    if ((dailyCount || 0) >= dailyLimit) {
      return {
        ok: false,
        error: `Daily bet limit reached (${dailyLimit}/day for ${tier} tier). Each prediction should count — come back tomorrow.`,
      };
    }
  }

  // Check active bet limit (tier-dependent, pai-* bots get premium limits)
  const maxActive = getMaxActiveBets(tier, botId);
  const { data: active } = await db
    .from("positions")
    .select("bet_id, bets!inner(status)")
    .eq("bot_id", botId)
    .eq("bets.status", "open");
  if ((active?.length || 0) >= maxActive) {
    return { ok: false, error: `Max ${maxActive} active bets for ${tier} tier` };
  }

  const betId = await generateBetId(db);
  // Use millisecond-based deadline to support fractional days (e.g., 0.0417 = 1 hour)
  const deadline = new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000);

  // Start transaction: create bet + position + deduct balance
  const { error: betError } = await db.from("bets").insert({
    id: betId,
    thesis,
    category: category.toLowerCase(),
    proposed_by: botId,
    status: "open",
    deadline: deadline.toISOString(),
    total_pool: amountMicro,
  });
  if (betError) return { ok: false, error: betError.message };

  await db.from("positions").insert({
    bet_id: betId,
    bot_id: botId,
    side,
    amount: amountMicro,
    reason,
  });

  // Deduct from balance atomically (escrow in bet — no race condition)
  await db.rpc("increment_balance", { bot_id: botId, amount: -amountMicro });
  await db.from("bots").update({ last_seen: new Date().toISOString() }).eq("id", botId);

  await db.from("ledger").insert({
    from_bot: botId,
    to_bot: `escrow:${betId}`,
    amount: amountMicro,
    reason: `Bet ${betId}: propose (${side})`,
    bet_id: betId,
  });

  return { ok: true, betId };
}

// ── Join bet ────────────────────────────────────────────────

export async function joinBet(
  botId: string,
  betId: string,
  side: "for" | "against",
  amount: number,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive number" };
  }
  const amountMicro = PAI(amount);

  if (amountMicro < MIN_BET) return { ok: false, error: `Min bet: 100 PAI` };

  // Check bet exists and is open
  const { data: bet } = await db.from("bets").select("*").eq("id", betId).single();
  if (!bet) return { ok: false, error: `Bet "${betId}" not found` };
  if (bet.status !== "open") return { ok: false, error: `Bet is "${bet.status}", not open` };
  if (new Date(bet.deadline) <= new Date()) return { ok: false, error: "Bet deadline has passed" };

  // Check already joined
  const { data: existing } = await db
    .from("positions")
    .select("id")
    .eq("bet_id", betId)
    .eq("bot_id", botId)
    .single();
  if (existing) return { ok: false, error: "Already have a position in this bet" };

  // Check balance + tier in single query (BUG FIX: was 2 separate queries)
  const { data: bot } = await db.from("bots").select("pai_balance, tier, metadata").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };
  if (bot.pai_balance < amountMicro) {
    return { ok: false, error: `Insufficient balance: ${fromPAI(bot.pai_balance).toLocaleString()} PAI` };
  }

  // ── Taker fee (maker = 0%, taker = 1%, premium taker = 0.5%) ──
  // Soul powers can reduce fees further
  const takerTier = (bot.tier || "starter") as BotTier;
  let feeBps = takerTier === "premium" ? TAKER_FEE_PREMIUM_BPS : TAKER_FEE_BPS;

  // Apply soul power fee discount if bot has committed soul with powers
  const soulPowers = bot.metadata?.committed_soul?.powers || [];
  if (soulPowers.length > 0) {
    // Check for fee discount powers
    const positions = bet.positions || [];
    const forTotal = positions.filter((p: any) => p.side === "for").reduce((s: number, p: any) => s + p.amount, 0);
    const againstTotal = positions.filter((p: any) => p.side === "against").reduce((s: number, p: any) => s + p.amount, 0);
    const total = forTotal + againstTotal;
    const isMinoritySide = total > 0 && (
      (side === "for" && forTotal < againstTotal) ||
      (side === "against" && againstTotal < forTotal)
    );

    let discountPct = 0;
    for (const power of soulPowers) {
      if (power.effect === "fee_discount_all") discountPct += power.value;
      if (power.effect === "fee_discount_minority" && isMinoritySide) discountPct += power.value;
    }
    if (discountPct > 0) {
      discountPct = Math.min(discountPct, 75); // cap at 75%
      feeBps = Math.round(feeBps * (1 - discountPct / 100));
    }
  }

  // Apply Hubris Curse fee increase (from failed prophecies)
  const activeCurse = bot.metadata?.active_curse;
  if (activeCurse && new Date(activeCurse.expires_at) > new Date()) {
    const cursePct = activeCurse.fee_increase_pct || 0;
    feeBps = Math.round(feeBps * (1 + cursePct / 100));
  }

  const feeAmount = Math.floor(amountMicro * feeBps / 10_000);
  const totalDeducted = amountMicro + feeAmount;

  if (bot.pai_balance < totalDeducted) {
    return { ok: false, error: `Insufficient balance: need ${fromPAI(totalDeducted).toLocaleString()} PAI (${fromPAI(amountMicro)} bet + ${fromPAI(feeAmount)} fee)` };
  }

  const { error: posError } = await db.from("positions").insert({
    bet_id: betId,
    bot_id: botId,
    side,
    amount: amountMicro,
    reason,
  });
  // DB unique constraint on (bet_id, bot_id) catches race-condition hedging attempts
  if (posError) {
    if (posError.code === "23505") return { ok: false, error: "Already have a position in this bet" };
    return { ok: false, error: posError.message };
  }

  // Atomic: increment bet pool (no race condition)
  await db.rpc("increment_pool", { p_bet_id: betId, amount: amountMicro });

  // Atomic: deduct bet + fee from taker (no race condition)
  await db.rpc("increment_balance", { bot_id: botId, amount: -totalDeducted });
  await db.from("bots").update({ last_seen: new Date().toISOString() }).eq("id", botId);

  // Fee → system treasury (atomic)
  if (feeAmount > 0) {
    await db.rpc("increment_balance", { bot_id: "system", amount: feeAmount });
    await db.from("ledger").insert({
      from_bot: botId,
      to_bot: "system",
      amount: feeAmount,
      reason: `Taker fee (${feeBps / 100}%) on bet ${betId}`,
      bet_id: betId,
    });
  }

  await db.from("ledger").insert({
    from_bot: botId,
    to_bot: `escrow:${betId}`,
    amount: amountMicro,
    reason: `Bet ${betId}: join (${side})`,
    bet_id: betId,
  });

  return { ok: true, fee: fromPAI(feeAmount) };
}

// ── Resolve bet ─────────────────────────────────────────────

export async function resolveBet(
  betId: string,
  outcome: "for" | "against",
  resolvedBy: string,
  explanation: string,
): Promise<{ ok: boolean; payouts?: Record<string, number>; error?: string }> {
  const { data: bet } = await db.from("bets").select("*").eq("id", betId).single();
  if (!bet) return { ok: false, error: `Bet "${betId}" not found` };
  if (bet.status !== "open" && bet.status !== "closed" && bet.status !== "pending_resolution") {
    return { ok: false, error: `Bet already resolved: ${bet.status}` };
  }

  const { data: allPositions } = await db.from("positions").select("*").eq("bet_id", betId);
  if (!allPositions?.length) return { ok: false, error: "No positions found" };

  const winners = allPositions.filter((p) => p.side === outcome);
  const losers = allPositions.filter((p) => p.side !== outcome);

  const totalWinnerStake = winners.reduce((s, p) => s + p.amount, 0);
  const totalLoserStake = losers.reduce((s, p) => s + p.amount, 0);

  const payouts: Record<string, number> = {};

  if (winners.length === 0 || losers.length === 0) {
    // No contest — return all stakes (atomic, no race condition)
    for (const pos of allPositions) {
      await db.rpc("increment_balance", { bot_id: pos.bot_id, amount: pos.amount });
      payouts[pos.bot_id] = 0;
    }
  } else {
    // Distribute winnings (atomic — no race condition)
    // Use BigInt arithmetic to avoid precision loss on large pools
    const loserStakeBig = BigInt(Math.round(totalLoserStake));
    const winnerStakeBig = BigInt(Math.round(totalWinnerStake));
    for (const winner of winners) {
      const winnerAmountBig = BigInt(Math.round(winner.amount));
      const profit = Number((loserStakeBig * winnerAmountBig) / winnerStakeBig);
      const totalReturn = winner.amount + profit;

      const isContrarian = winners.length < losers.length;
      const repGain = isContrarian ? Math.floor(REP_WIN * CONTRARIAN_MULTIPLIER) : REP_WIN;

      // Atomic: update balance + stats in one SQL call (no race condition)
      await db.rpc("update_winner_atomic", {
        p_bot_id: winner.bot_id,
        p_payout: totalReturn,
        p_profit: profit,
        p_rep_gain: repGain,
      });

      await db.from("positions").update({ payout: profit }).eq("bet_id", betId).eq("bot_id", winner.bot_id);
      await db.from("ledger").insert({
        from_bot: `escrow:${betId}`,
        to_bot: winner.bot_id,
        amount: totalReturn,
        reason: `Bet ${betId}: won (${outcome})`,
        bet_id: betId,
      });

      payouts[winner.bot_id] = fromPAI(profit);

      // ── Referral chain bonuses (5% L1, 1% L2) ──
      if (profit > 0) {
        const { data: winnerBot } = await db.from("bots").select("referred_by").eq("id", winner.bot_id).single();
        if (winnerBot?.referred_by) {
          // Level 1: 5% of net profit to direct referrer
          const l1Amount = Math.floor(profit * 0.05);
          if (l1Amount > 0) {
            await db.rpc("increment_balance", { bot_id: winnerBot.referred_by, amount: l1Amount });
            await db.from("ledger").insert({
              from_bot: "system",
              to_bot: winnerBot.referred_by,
              amount: l1Amount,
              reason: `Referral L1 (5%): ${winner.bot_id} won bet ${betId}`,
              bet_id: betId,
            });

            // Level 2: 1% of net profit to L1 referrer's referrer
            const { data: l1Bot } = await db.from("bots").select("referred_by").eq("id", winnerBot.referred_by).single();
            if (l1Bot?.referred_by) {
              const l2Amount = Math.floor(profit * 0.01);
              if (l2Amount > 0) {
                await db.rpc("increment_balance", { bot_id: l1Bot.referred_by, amount: l2Amount });
                await db.from("ledger").insert({
                  from_bot: "system",
                  to_bot: l1Bot.referred_by,
                  amount: l2Amount,
                  reason: `Referral L2 (1%): ${winner.bot_id} won bet ${betId} (via ${winnerBot.referred_by})`,
                  bet_id: betId,
                });
              }
            }
          }
        }
      }
    }

    for (const loser of losers) {
      // Atomic: update loser stats in one SQL call (no race condition)
      await db.rpc("update_loser_atomic", {
        p_bot_id: loser.bot_id,
        p_loss_amount: loser.amount,
        p_rep_loss: REP_LOSS,
      });

      await db.from("positions").update({ payout: -loser.amount }).eq("bet_id", betId).eq("bot_id", loser.bot_id);
      payouts[loser.bot_id] = -fromPAI(loser.amount);
    }
  }

  // Update bet status
  await db.from("bets").update({
    status: outcome === "for" ? "resolved_for" : "resolved_against",
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy,
    resolution: explanation,
  }).eq("id", betId);

  return { ok: true, payouts };
}

// ── Cancel bet ──────────────────────────────────────────────

export async function cancelBet(
  betId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: bet } = await db.from("bets").select("*").eq("id", betId).single();
  if (!bet) return { ok: false, error: `Bet "${betId}" not found` };
  if (bet.status !== "open") return { ok: false, error: `Bet is "${bet.status}", not open` };

  const { data: positions } = await db.from("positions").select("*").eq("bet_id", betId);
  if (positions) {
    for (const pos of positions) {
      // Atomic: refund balance (no race condition)
      await db.rpc("increment_balance", { bot_id: pos.bot_id, amount: pos.amount });
      await db.from("ledger").insert({
        from_bot: `escrow:${betId}`,
        to_bot: pos.bot_id,
        amount: pos.amount,
        reason: `Bet ${betId}: cancelled — ${reason}`,
        bet_id: betId,
      });
    }
  }

  await db.from("bets").update({
    status: "cancelled",
    resolved_at: new Date().toISOString(),
    resolution: `Cancelled: ${reason}`,
  }).eq("id", betId);

  return { ok: true };
}

// ── Queries ─────────────────────────────────────────────────

export async function getActiveBets() {
  const { data } = await db
    .from("bets")
    .select("*, positions(*)")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  return data || [];
}

export async function getBet(betId: string) {
  const { data } = await db
    .from("bets")
    .select("*, positions(*)")
    .eq("id", betId)
    .single();
  return data;
}

export async function getLeaderboard(limit = 20) {
  const { data } = await db
    .from("bots")
    .select("id, name, reputation, wins, losses, total_won, total_lost, streak, pai_balance, tier, verified, deposit_amount")
    .neq("id", "system")
    .order("reputation", { ascending: false })
    .limit(limit);
  return data || [];
}

export async function getBotStats(botId: string) {
  const { data: bot } = await db.from("bots").select("*").eq("id", botId).single();
  const { data: positions } = await db
    .from("positions")
    .select("*, bets(*)")
    .eq("bot_id", botId)
    .order("created_at", { ascending: false })
    .limit(10);
  return { bot, positions };
}

// ── Weekly Rewards Distribution ──────────────────────────────
// Runs once per week (Sunday midnight UTC). Rewards top performers:
//   #1: 500K PAI + "Weekly Champion" badge
//   #2: 250K PAI
//   #3: 100K PAI
//   Top 4-10: 50K PAI each
//   Best contrarian play: 100K PAI
//
// Rankings based on weekly net P&L from resolved bets in the past 7 days.

const WEEKLY_REWARDS = [
  { rank: 1, amount: PAI(500_000), label: "Weekly Champion" },
  { rank: 2, amount: PAI(250_000), label: "#2 Weekly" },
  { rank: 3, amount: PAI(100_000), label: "#3 Weekly" },
  { rank: 4, amount: PAI(50_000), label: "Top 10 Weekly" },
  { rank: 5, amount: PAI(50_000), label: "Top 10 Weekly" },
  { rank: 6, amount: PAI(50_000), label: "Top 10 Weekly" },
  { rank: 7, amount: PAI(50_000), label: "Top 10 Weekly" },
  { rank: 8, amount: PAI(50_000), label: "Top 10 Weekly" },
  { rank: 9, amount: PAI(50_000), label: "Top 10 Weekly" },
  { rank: 10, amount: PAI(50_000), label: "Top 10 Weekly" },
];
const CONTRARIAN_REWARD = PAI(100_000);

export interface WeeklyRewardResult {
  ok: boolean;
  week: string;
  rewards: Array<{ bot_id: string; rank: number; amount_pai: number; label: string }>;
  contrarian?: { bot_id: string; bet_id: string; profit_pai: number; amount_pai: number };
  already_distributed?: boolean;
}

export async function distributeWeeklyRewards(): Promise<WeeklyRewardResult> {
  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekLabel = `${weekStart.toISOString().slice(0, 10)}_${weekEnd.toISOString().slice(0, 10)}`;

  // Check if already distributed this week (idempotency)
  const { data: existing } = await db
    .from("ledger")
    .select("id")
    .eq("reason", `Weekly rewards: ${weekLabel}`)
    .limit(1);
  if (existing && existing.length > 0) {
    return { ok: true, week: weekLabel, rewards: [], already_distributed: true };
  }

  // Get all resolved bets from the past 7 days
  const { data: resolvedBets } = await db
    .from("bets")
    .select("id, status, resolved_at")
    .gte("resolved_at", weekStart.toISOString())
    .lt("resolved_at", weekEnd.toISOString())
    .in("status", ["resolved_for", "resolved_against"]);

  if (!resolvedBets || resolvedBets.length === 0) {
    return { ok: true, week: weekLabel, rewards: [] };
  }

  const betIds = resolvedBets.map(b => b.id);

  // Get all positions with payouts for these resolved bets
  const { data: positions } = await db
    .from("positions")
    .select("bot_id, bet_id, side, amount, payout")
    .in("bet_id", betIds);

  if (!positions || positions.length === 0) {
    return { ok: true, week: weekLabel, rewards: [] };
  }

  // Build bet outcome map
  const betOutcome = new Map<string, "for" | "against">();
  for (const bet of resolvedBets) {
    betOutcome.set(bet.id, bet.status === "resolved_for" ? "for" : "against");
  }

  // Calculate weekly P&L per bot
  const botPnl = new Map<string, number>();
  for (const pos of positions) {
    const pnl = pos.payout || 0; // payout is positive for winners, negative for losers
    const current = botPnl.get(pos.bot_id) || 0;
    botPnl.set(pos.bot_id, current + pnl);
  }

  // Sort by net P&L descending
  const ranked = [...botPnl.entries()]
    .filter(([_, pnl]) => pnl > 0) // only profitable bots
    .sort((a, b) => b[1] - a[1]);

  // Find best contrarian play
  // Contrarian = winning on minority side (fewer positions on winner's side)
  let bestContrarian: { bot_id: string; bet_id: string; profit: number } | null = null;

  for (const pos of positions) {
    if (!pos.payout || pos.payout <= 0) continue; // skip losers
    const outcome = betOutcome.get(pos.bet_id);
    if (!outcome || pos.side !== outcome) continue; // skip losers

    // Count sides for this bet
    const betPositions = positions.filter(p => p.bet_id === pos.bet_id);
    const winnersCount = betPositions.filter(p => p.side === outcome).length;
    const losersCount = betPositions.filter(p => p.side !== outcome).length;

    // Contrarian = fewer winners than losers (minority side won)
    if (winnersCount < losersCount && pos.payout > (bestContrarian?.profit || 0)) {
      bestContrarian = { bot_id: pos.bot_id, bet_id: pos.bet_id, profit: pos.payout };
    }
  }

  const rewards: WeeklyRewardResult["rewards"] = [];

  // Distribute rank rewards
  for (let i = 0; i < Math.min(ranked.length, WEEKLY_REWARDS.length); i++) {
    const [botId] = ranked[i];
    const reward = WEEKLY_REWARDS[i];
    await db.rpc("increment_balance", { bot_id: botId, amount: reward.amount });
    await db.from("ledger").insert({
      from_bot: "system",
      to_bot: botId,
      amount: reward.amount,
      reason: `Weekly rewards: ${weekLabel}`,
    });
    rewards.push({
      bot_id: botId,
      rank: reward.rank,
      amount_pai: fromPAI(reward.amount),
      label: reward.label,
    });
  }

  // Distribute contrarian reward
  let contrarianResult: WeeklyRewardResult["contrarian"] = undefined;
  if (bestContrarian) {
    // Don't double-reward if already in top 10 — still give contrarian bonus (it's separate)
    await db.rpc("increment_balance", { bot_id: bestContrarian.bot_id, amount: CONTRARIAN_REWARD });
    await db.from("ledger").insert({
      from_bot: "system",
      to_bot: bestContrarian.bot_id,
      amount: CONTRARIAN_REWARD,
      reason: `Weekly rewards: ${weekLabel} — best contrarian play`,
    });
    contrarianResult = {
      bot_id: bestContrarian.bot_id,
      bet_id: bestContrarian.bet_id,
      profit_pai: fromPAI(bestContrarian.profit),
      amount_pai: fromPAI(CONTRARIAN_REWARD),
    };
  }

  console.log(`[WEEKLY REWARDS] Week ${weekLabel}: ${rewards.length} rewards distributed, contrarian: ${bestContrarian?.bot_id || "none"}`);

  return { ok: true, week: weekLabel, rewards, contrarian: contrarianResult };
}

// ── Optimistic Resolution ────────────────────────────────────
// AI agent proposes outcome → 2h dispute window → auto-resolve if no disputes
// Inspired by UMA Optimistic Oracle (Polymarket)

// ── Resolution Ceremony ──────────────────────────────────────
// Posted by pai-arbiter at the START of every resolution.
// Provides market intelligence so participants can make informed dispute decisions.

export async function postResolutionCeremony(
  betId: string,
  bet: Record<string, any>,
  outcome: "for" | "against",
  proposedBy: string,
  isDisputed: boolean = false,
  disputeDeadlineIso?: string,
): Promise<void> {
  try {
    // Fetch all positions + bot reputation data
    const { data: positions } = await db
      .from("positions")
      .select("bot_id, side, amount")
      .eq("bet_id", betId);

    if (!positions?.length) return;

    const forPos  = positions.filter(p => p.side === "for");
    const agPos   = positions.filter(p => p.side === "against");
    const totalFor    = forPos.reduce((s, p) => s + p.amount, 0);
    const totalAgainst = agPos.reduce((s, p) => s + p.amount, 0);
    const totalPool   = totalFor + totalAgainst;
    const forPct  = totalPool > 0 ? Math.round((totalFor / totalPool) * 100) : 50;
    const agPct   = 100 - forPct;

    // Fetch reputation (wins/losses) for all participants
    const allBotIds = [...new Set(positions.map(p => p.bot_id))];
    const { data: bots } = await db
      .from("bots")
      .select("id, wins, losses, reputation")
      .in("id", allBotIds);

    const botMap: Record<string, { wins: number; losses: number; rep: number }> = {};
    for (const b of (bots || [])) {
      botMap[b.id] = { wins: b.wins || 0, losses: b.losses || 0, rep: b.reputation || 0 };
    }

    // Soul-weighted vote: sum of rep scores on each side
    let forRep = 0, agRep = 0;
    for (const p of forPos)  forRep += botMap[p.bot_id]?.rep || 0;
    for (const p of agPos)   agRep  += botMap[p.bot_id]?.rep || 0;

    const totalRep = forRep + agRep;
    const forRepPct = totalRep > 0 ? Math.round((forRep / totalRep) * 100) : 50;
    const agRepPct  = 100 - forRepPct;

    // Crowd alignment with proposed outcome
    const crowdSide   = forPct >= 50 ? "for" : "against";
    const crowdAligned = crowdSide === outcome;

    // Contrarian flag — proposed outcome goes AGAINST the money
    const isContrarian = !crowdAligned;

    // Pool in human-readable PAI
    const poolK = fromPAI(totalPool);
    const poolDisplay = poolK >= 1_000_000
      ? `${(poolK / 1_000_000).toFixed(1)}M`
      : poolK >= 1_000
        ? `${Math.round(poolK / 1_000)}K`
        : `${Math.round(poolK)}`;

    // Verdict confidence
    const outcomeMarketPct = outcome === "for" ? forPct : agPct;
    const outcomeRepPct    = outcome === "for" ? forRepPct : agRepPct;
    const confidence = Math.round((outcomeMarketPct + outcomeRepPct) / 2);
    const confidenceLabel = confidence >= 75 ? "HIGH" : confidence >= 55 ? "MODERATE" : "CONTESTED";

    // Build the ceremony message
    const verdictEmoji = outcome === "for" ? "✅" : "❌";
    const outcomeLabel = outcome === "for" ? "FOR (thesis TRUE)" : "AGAINST (thesis FALSE)";

    const lines: string[] = [
      `⚖️ RESOLUTION CEREMONY — Bet #${betId.slice(0, 8)}`,
      ``,
      `📋 Thesis: "${bet.thesis?.slice(0, 120)}${(bet.thesis?.length || 0) > 120 ? "…" : ""}"`,
      ``,
      `📊 Market Intelligence:`,
      `  Pool: ${poolDisplay} PAI | ${forPos.length + agPos.length} participants`,
      `  Stake split:  FOR ${forPct}%  ·  AGAINST ${agPct}%`,
      `  Rep-weighted: FOR ${forRepPct}%  ·  AGAINST ${agRepPct}%`,
      ``,
      `${verdictEmoji} Proposed outcome: ${outcomeLabel}`,
      `  Proposed by: ${proposedBy}`,
      `  Confidence: ${confidenceLabel} (${confidence}% consensus)`,
    ];

    if (isContrarian) {
      lines.push(`  ⚡ CONTRARIAN CALL — goes against ${100 - outcomeMarketPct}% of market stake`);
    } else {
      lines.push(`  ✓ Crowd-aligned — matches ${outcomeMarketPct}% majority`);
    }

    if (!isDisputed && disputeDeadlineIso) {
      const disputeMs = new Date(disputeDeadlineIso).getTime() - Date.now();
      const disputeHrs = Math.max(0, Math.round(disputeMs / 1000 / 60 / 10) / 6);
      lines.push(``);
      lines.push(`⏳ Dispute window: ${disputeHrs.toFixed(1)}h`);
      lines.push(`  Challenge via: POST /bets/${betId}/dispute`);
      lines.push(`  No disputes → settlement executes automatically.`);
    } else if (isDisputed) {
      lines.push(``);
      lines.push(`🔥 Resolution is DISPUTED — elevated to manual review.`);
    }

    await db.from("messages").insert({
      bet_id: betId,
      bot_id: "pai-arbiter",
      content: lines.join("\n"),
    });
  } catch (e) {
    // Ceremony is non-critical — never fail the resolution because of it
    console.error("[Resolution Ceremony] Failed:", e);
  }
}

export async function proposeResolution(
  betId: string,
  proposedBy: string,       // AI agent bot_id
  outcome: "for" | "against",
  explanation: string,
): Promise<{ ok: boolean; disputeDeadline?: string; error?: string }> {
  const { data: bet } = await db.from("bets").select("*").eq("id", betId).single();
  if (!bet) return { ok: false, error: "Bet not found" };
  if (bet.status !== "open" && bet.status !== "closed") {
    return { ok: false, error: `Bet already resolved or in dispute: ${bet.status}` };
  }

  const disputeDeadline = new Date(Date.now() + DISPUTE_WINDOW_MS);

  await db.from("bets").update({
    status: "pending_resolution",
    proposed_outcome: outcome,
    proposed_by_agent: proposedBy,
    dispute_deadline: disputeDeadline.toISOString(),
    resolution: explanation,
  }).eq("id", betId);

  // 🎭 Post resolution ceremony — market intelligence snapshot for dispute period
  await postResolutionCeremony(betId, bet, outcome, proposedBy, false, disputeDeadline.toISOString());

  return { ok: true, disputeDeadline: disputeDeadline.toISOString() };
}

export async function disputeResolution(
  betId: string,
  disputedBy: string,  // bot_id challenging
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: bet } = await db.from("bets").select("*").eq("id", betId).single();
  if (!bet) return { ok: false, error: "Bet not found" };
  if (bet.status !== "pending_resolution") {
    return { ok: false, error: `Bet not pending resolution (status: ${bet.status})` };
  }
  if (new Date(bet.dispute_deadline) <= new Date()) {
    return { ok: false, error: "Dispute window has closed (2h expired)" };
  }

  await db.from("bets").update({
    status: "disputed",
    dispute_reason: `${disputedBy}: ${reason}`,
  }).eq("id", betId);

  return { ok: true };
}

// Called on GET /bets (lazy evaluation — no cron needed)
export async function autoResolveExpired(): Promise<number> {
  const now = new Date().toISOString();
  const { data: pending } = await db
    .from("bets")
    .select("*")
    .eq("status", "pending_resolution")
    .lt("dispute_deadline", now);

  if (!pending?.length) return 0;

  let resolved = 0;
  for (const bet of pending) {
    if (bet.proposed_outcome) {
      await resolveBet(
        bet.id,
        bet.proposed_outcome as "for" | "against",
        `ai:${bet.proposed_by_agent}`,
        `Auto-resolved (no disputes in 2h): ${bet.resolution}`,
      );
      resolved++;
    }
  }
  return resolved;
}
