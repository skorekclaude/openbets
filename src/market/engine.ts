/**
 * PAI Bets — Market Engine
 * Core prediction market logic: create bets, join, resolve, payouts.
 */

import { db, PAI, fromPAI, type Bet, type Position } from "../db/client.ts";
import { generateApiKey, generateBetId } from "./utils.ts";

const MIN_BET = PAI(1_000);       // 1,000 PAI
const MAX_BET = PAI(1_000_000);   // 1M PAI
const MAX_ACTIVE_BETS = 5;
const REP_WIN = 10;
const REP_LOSS = 5;
const CONTRARIAN_MULTIPLIER = 1.5;
const INITIAL_BOT_BALANCE = PAI(16_666_666); // ~16.6M PAI per new bot from ecosystem

// ── Bot registration ────────────────────────────────────────

export async function registerBot(
  id: string,
  name: string,
  owner?: string,
): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
  // Check if already exists
  const { data: existing } = await db.from("bots").select("id").eq("id", id).single();
  if (existing) return { ok: false, error: `Bot "${id}" already registered` };

  const apiKey = generateApiKey(id);

  const { error } = await db.from("bots").insert({
    id,
    name,
    owner: owner || null,
    api_key: apiKey,
    pai_balance: INITIAL_BOT_BALANCE,
  });

  if (error) return { ok: false, error: error.message };

  // Log initial allocation from ecosystem
  await db.from("ledger").insert({
    from_bot: "system",
    to_bot: id,
    amount: INITIAL_BOT_BALANCE,
    reason: "Initial ecosystem allocation",
  });

  return { ok: true, apiKey };
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

  if (amountMicro < MIN_BET) return { ok: false, error: `Min bet: 1,000 PAI` };
  if (amountMicro > MAX_BET) return { ok: false, error: `Max bet: 1,000,000 PAI` };
  if (!thesis || thesis.length < 10) return { ok: false, error: "Thesis too short (min 10 chars)" };

  // Check balance
  const { data: bot } = await db.from("bots").select("pai_balance").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };
  if (bot.pai_balance < amountMicro) {
    return { ok: false, error: `Insufficient balance: ${fromPAI(bot.pai_balance).toLocaleString()} PAI (need ${amount.toLocaleString()})` };
  }

  // Check active bet limit
  const { data: active } = await db
    .from("positions")
    .select("bet_id, bets!inner(status)")
    .eq("bot_id", botId)
    .eq("bets.status", "open");
  if ((active?.length || 0) >= MAX_ACTIVE_BETS) {
    return { ok: false, error: `Max ${MAX_ACTIVE_BETS} active bets per bot` };
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

  // Deduct from balance (escrow in bet)
  await db.from("bots").update({
    pai_balance: bot.pai_balance - amountMicro,
    last_seen: new Date().toISOString(),
  }).eq("id", botId);

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

  if (amountMicro < MIN_BET) return { ok: false, error: `Min bet: 1,000 PAI` };
  if (amountMicro > MAX_BET) return { ok: false, error: `Max bet: 1,000,000 PAI` };

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

  // Check balance
  const { data: bot } = await db.from("bots").select("pai_balance").eq("id", botId).single();
  if (!bot) return { ok: false, error: "Bot not found" };
  if (bot.pai_balance < amountMicro) {
    return { ok: false, error: `Insufficient balance: ${fromPAI(bot.pai_balance).toLocaleString()} PAI` };
  }

  await db.from("positions").insert({
    bet_id: betId,
    bot_id: botId,
    side,
    amount: amountMicro,
    reason,
  });

  await db.from("bets").update({ total_pool: bet.total_pool + amountMicro }).eq("id", betId);

  await db.from("bots").update({
    pai_balance: bot.pai_balance - amountMicro,
    last_seen: new Date().toISOString(),
  }).eq("id", botId);

  await db.from("ledger").insert({
    from_bot: botId,
    to_bot: `escrow:${betId}`,
    amount: amountMicro,
    reason: `Bet ${betId}: join (${side})`,
    bet_id: betId,
  });

  return { ok: true };
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
  if (bet.status !== "open" && bet.status !== "closed") {
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
    // No contest — return all stakes
    for (const pos of allPositions) {
      await db.from("bots").update({
        pai_balance: db.raw ? undefined : 0, // handled below
      }).eq("id", pos.bot_id);

      const { data: botData } = await db.from("bots").select("pai_balance").eq("id", pos.bot_id).single();
      if (botData) {
        await db.from("bots").update({ pai_balance: botData.pai_balance + pos.amount }).eq("id", pos.bot_id);
      }
      payouts[pos.bot_id] = 0;
    }
  } else {
    // Distribute winnings
    for (const winner of winners) {
      const share = winner.amount / totalWinnerStake;
      const profit = Math.floor(totalLoserStake * share);
      const totalReturn = winner.amount + profit;

      const { data: botData } = await db.from("bots").select("pai_balance, wins, total_won, reputation, streak").eq("id", winner.bot_id).single();
      if (botData) {
        const isContrarian = winners.length < losers.length;
        const repGain = isContrarian ? Math.floor(REP_WIN * CONTRARIAN_MULTIPLIER) : REP_WIN;

        await db.from("bots").update({
          pai_balance: botData.pai_balance + totalReturn,
          wins: botData.wins + 1,
          total_won: botData.total_won + profit,
          reputation: botData.reputation + repGain,
          streak: botData.streak > 0 ? botData.streak + 1 : 1,
          last_seen: new Date().toISOString(),
        }).eq("id", winner.bot_id);
      }

      await db.from("positions").update({ payout: profit }).eq("bet_id", betId).eq("bot_id", winner.bot_id);
      await db.from("ledger").insert({
        from_bot: `escrow:${betId}`,
        to_bot: winner.bot_id,
        amount: totalReturn,
        reason: `Bet ${betId}: won (${outcome})`,
        bet_id: betId,
      });

      payouts[winner.bot_id] = fromPAI(profit);
    }

    for (const loser of losers) {
      const { data: botData } = await db.from("bots").select("losses, total_lost, reputation, streak").eq("id", loser.bot_id).single();
      if (botData) {
        await db.from("bots").update({
          losses: botData.losses + 1,
          total_lost: botData.total_lost + loser.amount,
          reputation: Math.max(0, botData.reputation - REP_LOSS),
          streak: botData.streak < 0 ? botData.streak - 1 : -1,
          last_seen: new Date().toISOString(),
        }).eq("id", loser.bot_id);
      }

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
      const { data: botData } = await db.from("bots").select("pai_balance").eq("id", pos.bot_id).single();
      if (botData) {
        await db.from("bots").update({ pai_balance: botData.pai_balance + pos.amount }).eq("id", pos.bot_id);
      }
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
    .select("id, name, reputation, wins, losses, total_won, total_lost, streak, pai_balance")
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
