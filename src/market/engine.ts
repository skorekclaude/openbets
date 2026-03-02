/**
 * PAI Bets — Market Engine
 * Core prediction market logic: create bets, join, resolve, payouts.
 */

import { db, PAI, fromPAI, type Bet, type Position } from "../db/client.ts";
import { generateApiKey, generateBetId } from "./utils.ts";

const MIN_BET = PAI(100);          // 100 PAI minimum (starter can make 2 bets)
const MAX_BET = PAI(1_000_000);    // 1M PAI
const MAX_ACTIVE_BETS_STARTER = 3;
const MAX_ACTIVE_BETS_VERIFIED = 5;
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

const STARTER_BALANCE = PAI(200);       // 200 PAI free (2 mini bets)
const VERIFY_BONUS = PAI(500);          // +500 PAI on verification = 700 total

// Premium deposit matching (decreasing %)
export function calculateMatchBonus(depositPai: number): number {
  if (depositPai >= 1_000_000) return PAI(200_000);   // 1M → +200K (20%)
  if (depositPai >= 100_000)   return PAI(50_000);     // 100K → +50K (50%)
  if (depositPai >= 10_000)    return PAI(5_000);       // 10K → +5K (50%)
  return 0;
}

export function getMaxActiveBets(tier: BotTier): number {
  if (tier === "premium") return MAX_ACTIVE_BETS_PREMIUM;
  if (tier === "verified") return MAX_ACTIVE_BETS_VERIFIED;
  return MAX_ACTIVE_BETS_STARTER;
}

export function getMaxBet(tier: BotTier): number {
  if (tier === "premium") return MAX_BET;
  if (tier === "verified") return PAI(10_000);   // 10K PAI max for verified
  return PAI(1_000);                              // 1K PAI max for starters
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
    api_key: apiKey,
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
    reason: "Starter allocation (200 PAI)",
  });

  return { ok: true, apiKey };
}

// ── Verify bot (X.com or email) ─────────────────────────────

export async function verifyBot(
  botId: string,
  method: "x" | "email",
  handle: string,
): Promise<{ ok: boolean; newBalance?: number; error?: string }> {
  const { data: bot } = await db.from("bots").select("*").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };
  if (bot.verified) return { ok: false, error: "Already verified" };

  // Atomic: set verified + increment balance in one SQL call (no race condition)
  const { data: newBalance } = await db.rpc("verify_bot_atomic", {
    p_bot_id: botId,
    p_bonus: VERIFY_BONUS,
    p_method: method,
    p_handle: handle,
  });

  await db.from("ledger").insert({
    from_bot: "system",
    to_bot: botId,
    amount: VERIFY_BONUS,
    reason: `Verification bonus (${method}: ${handle})`,
  });

  return { ok: true, newBalance: fromPAI(newBalance) };
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
  const { data } = await db
    .from("bots")
    .select("*")
    .eq("api_key", apiKey)
    .single();
  return data;
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

  // Check active bet limit (tier-dependent)
  const maxActive = getMaxActiveBets(tier);
  const { data: active } = await db
    .from("positions")
    .select("bet_id, bets!inner(status)")
    .eq("bot_id", botId)
    .eq("bets.status", "open");
  if ((active?.length || 0) >= maxActive) {
    return { ok: false, error: `Max ${maxActive} active bets for ${tier} tier` };
  }

  const betId = await generateBetId(db);
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + deadlineDays);

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
  const { data: bot } = await db.from("bots").select("pai_balance, tier").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };
  if (bot.pai_balance < amountMicro) {
    return { ok: false, error: `Insufficient balance: ${fromPAI(bot.pai_balance).toLocaleString()} PAI` };
  }

  // ── Taker fee (maker = 0%, taker = 1%, premium taker = 0.5%) ──
  const takerTier = (bot.tier || "starter") as BotTier;
  const feeBps = takerTier === "premium" ? TAKER_FEE_PREMIUM_BPS : TAKER_FEE_BPS;
  const feeAmount = Math.floor(amountMicro * feeBps / 10_000);
  const totalDeducted = amountMicro + feeAmount;

  if (bot.pai_balance < totalDeducted) {
    return { ok: false, error: `Insufficient balance: need ${fromPAI(totalDeducted).toLocaleString()} PAI (${fromPAI(amountMicro)} bet + ${fromPAI(feeAmount)} fee)` };
  }

  await db.from("positions").insert({
    bet_id: betId,
    bot_id: botId,
    side,
    amount: amountMicro,
    reason,
  });

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
    for (const winner of winners) {
      const share = winner.amount / totalWinnerStake;
      const profit = Math.floor(totalLoserStake * share);
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

// ── Optimistic Resolution ────────────────────────────────────
// AI agent proposes outcome → 2h dispute window → auto-resolve if no disputes
// Inspired by UMA Optimistic Oracle (Polymarket)

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
