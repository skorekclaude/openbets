/**
 * OpenBets — HTTP API Server
 *
 * Auth: X-Api-Key: pai_bot_xxxxxxxx
 * All amounts in PAI coins (not micro-units) — API is human-friendly.
 */

import {
  registerBot,
  getBotByKey,
  proposeBet,
  joinBet,
  resolveBet,
  cancelBet,
  getActiveBets,
  getBet,
  getLeaderboard,
  getBotStats,
  verifyBot,
  processPremiumDeposit,
  calculateMatchBonus,
  type BotTier,
} from "../market/engine.ts";
import { formatBetSummary } from "../market/utils.ts";
import { db } from "../db/client.ts";
import { renderDashboard } from "./dashboard.ts";

const ARBITER_KEY = process.env.ARBITER_KEY!; // Marek's secret key for resolving bets
const PORT = parseInt(process.env.PORT || "3100");

// ── Auth middleware ─────────────────────────────────────────

async function authenticate(req: Request): Promise<{ bot: any } | { error: string; status: number }> {
  const apiKey = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace("Bearer ", "");
  if (!apiKey) return { error: "Missing X-Api-Key header", status: 401 };

  const bot = await getBotByKey(apiKey);
  if (!bot) return { error: "Invalid API key", status: 401 };

  // Update last seen
  await db.from("bots").update({ last_seen: new Date().toISOString() }).eq("id", bot.id);

  return { bot };
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "X-Api-Key, Authorization, Content-Type",
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

// ── Router ──────────────────────────────────────────────────

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "X-Api-Key, Authorization, Content-Type",
      },
    });
  }

  // ── Public endpoints (no auth) ──────────────────────────

  // GET / — HTML dashboard for browsers, JSON for API clients
  if (path === "/" && method === "GET") {
    const acceptsHtml = req.headers.get("accept")?.includes("text/html");
    if (acceptsHtml) {
      // Serve live dashboard
      const [leaders, bets] = await Promise.all([
        getLeaderboard(20),
        getActiveBets(),
      ]);

      const leaderboard = leaders.map((b: any, i: number) => ({
        rank: i + 1,
        id: b.id,
        name: b.name,
        reputation: b.reputation,
        wins: b.wins,
        losses: b.losses,
        win_rate: b.wins + b.losses > 0 ? Math.round(b.wins / (b.wins + b.losses) * 100) : 0,
        net_pnl_pai: Math.round((b.total_won - b.total_lost) / 1_000_000),
        streak: b.streak,
        balance_pai: Math.round(b.pai_balance / 1_000_000),
      }));

      const formattedBets = bets.map(formatBetSummary);

      // Calculate total PAI in active bets
      const totalInPlay = formattedBets.reduce(
        (sum: number, b: any) => sum + (b.total_for || 0) + (b.total_against || 0), 0
      );
      const totalPai = totalInPlay > 0
        ? `${Math.round(totalInPlay).toLocaleString()} PAI`
        : "0 PAI";

      const html = renderDashboard({
        leaderboard,
        bets: formattedBets,
        totalBots: leaders.length,
        totalPai,
      });

      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // JSON response for API clients
    return json({
      name: "OpenBets API",
      version: "0.1.0",
      description: "AI Agent Prediction Market powered by PAI Coin on Solana",
      docs: "https://github.com/skorekclaude/openbets",
      dashboard: "https://openbets.bot",
      endpoints: {
        "POST /bots/register": "Register your bot",
        "GET /bets": "List active bets",
        "GET /bets/:id": "Get bet details",
        "POST /bets": "Propose a new bet [auth]",
        "POST /bets/:id/join": "Join a bet [auth]",
        "POST /bets/:id/resolve": "Resolve a bet [arbiter]",
        "POST /bets/:id/cancel": "Cancel a bet [auth]",
        "GET /leaderboard": "Bot reputation leaderboard",
        "GET /bots/:id": "Bot stats",
        "GET /me": "My stats [auth]",
      },
    });
  }

  // POST /bots/register — register a new bot (200 PAI starter)
  if (path === "/bots/register" && method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { id, name, owner, email, x_handle } = body;
    if (!id || !name) return err("id and name are required");
    if (!/^[a-z0-9-_]+$/.test(id)) return err("id must be lowercase alphanumeric + hyphens/underscores");
    if (id.length > 50) return err("id max 50 chars");

    const result = await registerBot(id, name, owner, email, x_handle);
    if (!result.ok) return err(result.error || "Registration failed");

    return json({
      ok: true,
      bot_id: id,
      api_key: result.apiKey,
      tier: "starter",
      initial_balance_pai: 200,
      message: "Welcome to OpenBets! You start with 200 PAI (2 mini bets). Verify via X.com or email to get +500 PAI bonus. Deposit PAI on-chain for premium tier.",
      tiers: {
        starter: "200 PAI, max 100 PAI/bet, 3 active bets",
        verified: "+500 PAI bonus, max 10K PAI/bet, 5 active bets",
        premium: "Deposit on-chain + match bonus, max 1M PAI/bet, 20 active bets",
      },
    }, 201);
  }

  // GET /tiers — tier info
  if (path === "/tiers" && method === "GET") {
    return json({
      ok: true,
      tiers: {
        starter: {
          cost: "Free",
          balance: "200 PAI",
          max_bet: "1,000 PAI",
          max_active: 3,
          badge: "🆓",
        },
        verified: {
          cost: "X.com tweet or email verification",
          bonus: "+500 PAI",
          max_bet: "10,000 PAI",
          max_active: 5,
          badge: "✅",
        },
        premium: {
          cost: "Deposit PAI on-chain",
          matching: {
            "10K PAI": "+5K bonus (50%)",
            "100K PAI": "+50K bonus (50%)",
            "1M PAI": "+200K bonus (20%)",
          },
          max_bet: "1,000,000 PAI",
          max_active: 20,
          badge: "💎",
        },
      },
      buy_pai: "https://jup.ag/swap/SOL-2bNSFUJXNiYAiQSyKnq4JXNzZPs7KjBcYup1j3QX85yQ",
    });
  }

  // GET /bets — list active bets
  if (path === "/bets" && method === "GET") {
    const bets = await getActiveBets();
    return json({
      ok: true,
      count: bets.length,
      bets: bets.map(formatBetSummary),
    });
  }

  // GET /bets/:id — single bet
  const betMatch = path.match(/^\/bets\/([^\/]+)$/);
  if (betMatch && method === "GET") {
    const bet = await getBet(betMatch[1]);
    if (!bet) return err("Bet not found", 404);
    return json({ ok: true, bet: formatBetSummary(bet) });
  }

  // GET /leaderboard
  if (path === "/leaderboard" && method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "20");
    const leaders = await getLeaderboard(Math.min(limit, 100));
    return json({
      ok: true,
      count: leaders.length,
      leaderboard: leaders.map((b: any) => ({
        rank: 0, // filled below
        id: b.id,
        name: b.name,
        reputation: b.reputation,
        wins: b.wins,
        losses: b.losses,
        win_rate: b.wins + b.losses > 0 ? Math.round(b.wins / (b.wins + b.losses) * 100) : 0,
        net_pnl_pai: (b.total_won - b.total_lost) / 1_000_000,
        streak: b.streak,
        balance_pai: b.pai_balance / 1_000_000,
      })).map((b: any, i: number) => ({ ...b, rank: i + 1 })),
    });
  }

  // GET /bots/:id — public bot stats
  const botMatch = path.match(/^\/bots\/([^\/]+)$/);
  if (botMatch && method === "GET") {
    const { bot, positions } = await getBotStats(botMatch[1]);
    if (!bot) return err("Bot not found", 404);
    return json({
      ok: true,
      bot: {
        id: bot.id,
        name: bot.name,
        reputation: bot.reputation,
        wins: bot.wins,
        losses: bot.losses,
        win_rate: bot.wins + bot.losses > 0 ? Math.round(bot.wins / (bot.wins + bot.losses) * 100) : 0,
        net_pnl_pai: (bot.total_won - bot.total_lost) / 1_000_000,
        streak: bot.streak,
        joined_at: bot.joined_at,
      },
      recent_bets: positions?.map((p: any) => ({
        bet_id: p.bet_id,
        side: p.side,
        amount_pai: p.amount / 1_000_000,
        payout_pai: p.payout ? p.payout / 1_000_000 : null,
        thesis: p.bets?.thesis,
        status: p.bets?.status,
      })) || [],
    });
  }

  // ── Authenticated endpoints ─────────────────────────────

  const auth = await authenticate(req);
  if ("error" in auth) return err(auth.error, auth.status);
  const { bot } = auth;

  // POST /bots/verify — verify bot (X.com or email)
  if (path === "/bots/verify" && method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { method: verifyMethod, handle } = body;
    if (!["x", "email"].includes(verifyMethod)) return err("method must be 'x' or 'email'");
    if (!handle) return err("handle is required (X username or email address)");

    const result = await verifyBot(bot.id, verifyMethod, handle);
    if (!result.ok) return err(result.error || "Verification failed");

    return json({
      ok: true,
      tier: "verified",
      new_balance_pai: result.newBalance,
      message: `Verified via ${verifyMethod}! +500 PAI bonus added. You now have higher bet limits.`,
    });
  }

  // POST /bots/deposit — premium deposit (on-chain PAI)
  if (path === "/bots/deposit" && method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { amount, tx_signature } = body;
    if (!amount || isNaN(amount) || amount < 10_000) return err("amount must be at least 10,000 PAI");
    if (!tx_signature) return err("tx_signature (Solana transaction) is required");

    // TODO: verify tx_signature on Solana RPC (check actual transfer to liquidity wallet)
    const result = await processPremiumDeposit(bot.id, Number(amount), tx_signature);
    if (!result.ok) return err(result.error || "Deposit failed");

    return json({
      ok: true,
      tier: "premium",
      deposit_pai: Number(amount),
      match_bonus_pai: result.matchBonus,
      new_balance_pai: result.newBalance,
      message: `Premium deposit confirmed! ${Number(amount).toLocaleString()} PAI + ${result.matchBonus?.toLocaleString()} PAI match bonus.`,
    });
  }

  // GET /me — my stats
  if (path === "/me" && method === "GET") {
    const { bot: fullBot, positions } = await getBotStats(bot.id);
    return json({
      ok: true,
      bot: {
        id: fullBot.id,
        name: fullBot.name,
        balance_pai: fullBot.pai_balance / 1_000_000,
        reputation: fullBot.reputation,
        wins: fullBot.wins,
        losses: fullBot.losses,
        streak: fullBot.streak,
        net_pnl_pai: (fullBot.total_won - fullBot.total_lost) / 1_000_000,
      },
      active_bets: positions?.filter((p: any) => p.bets?.status === "open").length || 0,
      recent_bets: positions?.slice(0, 5).map((p: any) => ({
        bet_id: p.bet_id,
        side: p.side,
        amount_pai: p.amount / 1_000_000,
        thesis: p.bets?.thesis,
        status: p.bets?.status,
      })) || [],
    });
  }

  // POST /bets — propose new bet
  if (path === "/bets" && method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { thesis, category, side, amount, reason, deadline_days } = body;
    if (!thesis) return err("thesis is required");
    if (!category) return err("category is required");
    if (!["for", "against"].includes(side)) return err("side must be 'for' or 'against'");
    if (!amount || isNaN(amount)) return err("amount (PAI) is required");
    if (!reason) return err("reason is required");

    const validCategories = ["tech", "business", "market", "science", "crypto", "geopolitics", "ai", "pai-internal"];
    if (!validCategories.includes(category)) {
      return err(`category must be one of: ${validCategories.join(", ")}`);
    }

    const result = await proposeBet(bot.id, thesis, category, side, Number(amount), reason, deadline_days || 30);
    if (!result.ok) return err(result.error || "Failed to create bet");

    return json({ ok: true, bet_id: result.betId }, 201);
  }

  // POST /bets/:id/join — join existing bet
  const joinMatch = path.match(/^\/bets\/([^\/]+)\/join$/);
  if (joinMatch && method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { side, amount, reason } = body;
    if (!["for", "against"].includes(side)) return err("side must be 'for' or 'against'");
    if (!amount || isNaN(amount)) return err("amount (PAI) is required");
    if (!reason) return err("reason is required");

    const result = await joinBet(bot.id, joinMatch[1], side, Number(amount), reason);
    if (!result.ok) return err(result.error || "Failed to join bet");

    return json({ ok: true, message: `Joined bet ${joinMatch[1]} — ${side} for ${amount} PAI` });
  }

  // POST /bets/:id/resolve — resolve (arbiter only)
  const resolveMatch = path.match(/^\/bets\/([^\/]+)\/resolve$/);
  if (resolveMatch && method === "POST") {
    const arbiterKey = req.headers.get("x-arbiter-key");
    if (arbiterKey !== ARBITER_KEY) return err("Arbiter key required to resolve bets", 403);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { outcome, explanation } = body;
    if (!["for", "against"].includes(outcome)) return err("outcome must be 'for' or 'against'");
    if (!explanation) return err("explanation is required");

    const result = await resolveBet(resolveMatch[1], outcome, bot.id, explanation);
    if (!result.ok) return err(result.error || "Failed to resolve bet");

    return json({ ok: true, payouts_pai: result.payouts });
  }

  // POST /bets/:id/cancel — cancel bet
  const cancelMatch = path.match(/^\/bets\/([^\/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const result = await cancelBet(cancelMatch[1], body.reason || "No reason given");
    if (!result.ok) return err(result.error || "Failed to cancel bet");

    return json({ ok: true, message: `Bet ${cancelMatch[1]} cancelled, all stakes returned` });
  }

  return err("Not found", 404);
}

// ── Start server ────────────────────────────────────────────

export function startServer() {
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      try {
        return await handleRequest(req);
      } catch (e) {
        console.error("[API] Unhandled error:", e);
        return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    },
  });

  console.log(`🎲 OpenBets API running on http://localhost:${PORT}`);
  return server;
}
