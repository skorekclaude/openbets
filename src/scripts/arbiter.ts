/**
 * Auto-Arbiter — resolves expired bets so souls can grow
 *
 * Without resolved bets, the soul system has no data. Every bot stays
 * at 0W/0L forever. This script is the heartbeat that makes souls evolve.
 *
 * Resolution rules:
 * 1. pending_resolution + dispute window passed → auto-resolve (use proposed outcome)
 * 2. open + deadline passed → resolve as "against" (thesis didn't prove true by deadline)
 *    This creates a game mechanic: if you bet "for" and you're right, propose resolution
 *    BEFORE the deadline. Silence = thesis unproven.
 * 3. open + deadline passed + only one side → cancel (no contest, return stakes)
 *
 * Usage:
 *   bun run src/scripts/arbiter.ts
 *   or via cron: every 15 minutes
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { db } from "../db/client";

// Import engine functions
import {
  resolveBet,
  cancelBet,
  autoResolveExpired,
  postResolutionCeremony,
} from "../market/engine";

interface ArbiterResult {
  resolved: number;
  cancelled: number;
  autoResolved: number;
  errors: string[];
  details: string[];
}

async function runArbiter(): Promise<ArbiterResult> {
  const result: ArbiterResult = {
    resolved: 0,
    cancelled: 0,
    autoResolved: 0,
    errors: [],
    details: [],
  };

  const now = new Date().toISOString();

  // ── Phase 1: Auto-resolve pending_resolution past dispute deadline ──
  try {
    const count = await autoResolveExpired();
    result.autoResolved = count;
    if (count > 0) {
      result.details.push(`Phase 1: Auto-resolved ${count} bets (dispute window expired)`);
    }
  } catch (e: any) {
    result.errors.push(`Phase 1 error: ${e.message}`);
  }

  // ── Phase 2: Resolve expired open bets ──
  const { data: expiredBets } = await db
    .from("bets")
    .select("id, thesis, category, proposed_by, status, deadline, total_pool")
    .eq("status", "open")
    .lt("deadline", now)
    .order("deadline", { ascending: true });

  if (!expiredBets?.length) {
    result.details.push("Phase 2: No expired open bets found");
    return result;
  }

  result.details.push(`Phase 2: Found ${expiredBets.length} expired open bets`);

  for (const bet of expiredBets) {
    try {
      // Get positions for this bet
      const { data: positions } = await db
        .from("positions")
        .select("bot_id, side, amount")
        .eq("bet_id", bet.id);

      if (!positions?.length) {
        // No positions at all — cancel
        const cancelResult = await cancelBet(bet.id, "Arbiter: No positions placed before deadline");
        if (cancelResult.ok) {
          result.cancelled++;
          result.details.push(`  ✗ ${bet.id}: Cancelled (no positions)`);
        }
        continue;
      }

      const forPositions = positions.filter(p => p.side === "for");
      const againstPositions = positions.filter(p => p.side === "against");

      // Only one side has positions — no real contest
      if (forPositions.length === 0 || againstPositions.length === 0) {
        const cancelResult = await cancelBet(bet.id, "Arbiter: Only one side had positions — no contest. Stakes returned.");
        if (cancelResult.ok) {
          result.cancelled++;
          result.details.push(`  ↩ ${bet.id}: Cancelled — one-sided bet, stakes returned`);
        } else {
          result.errors.push(`  ✗ ${bet.id}: Cancel failed: ${cancelResult.error}`);
        }
        continue;
      }

      // Both sides have positions → resolve
      // Default rule: if thesis expired without early resolution proposal,
      // it means the thesis was NOT obviously true → resolve "against"
      // This creates incentive for "for" bettors to propose resolution when they win
      const outcome: "for" | "against" = "against";
      const explanation =
        `Arbiter auto-resolution: Bet deadline passed (${bet.deadline}) ` +
        `without anyone proposing resolution. No evidence the thesis was proven true. ` +
        `Thesis: "${bet.thesis.slice(0, 100)}"`;

      // 🎭 Post resolution ceremony BEFORE settling — gives the bet a proper eulogy
      await postResolutionCeremony(bet.id, bet, outcome, "pai-arbiter", false, undefined);

      const resolveResult = await resolveBet(bet.id, outcome, "arbiter", explanation);
      if (resolveResult.ok) {
        result.resolved++;
        const forTotal = forPositions.reduce((s, p) => s + p.amount, 0);
        const againstTotal = againstPositions.reduce((s, p) => s + p.amount, 0);
        result.details.push(
          `  ✓ ${bet.id}: Resolved "against" — ` +
          `${forPositions.length} for (${Math.round(forTotal / 1e9)}K) vs ` +
          `${againstPositions.length} against (${Math.round(againstTotal / 1e9)}K)`
        );
      } else {
        result.errors.push(`  ✗ ${bet.id}: Resolve failed: ${resolveResult.error}`);
      }
    } catch (e: any) {
      result.errors.push(`  ✗ ${bet.id}: Error: ${e.message}`);
    }
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n⚖️  OpenBets Arbiter — ${new Date().toISOString()}`);
  console.log(`   Resolving expired bets so souls can grow...\n`);

  const result = await runArbiter();

  // Report
  console.log(`\n📊 Arbiter Results:`);
  console.log(`   Auto-resolved (dispute expired): ${result.autoResolved}`);
  console.log(`   Resolved (expired open bets):    ${result.resolved}`);
  console.log(`   Cancelled (no contest):          ${result.cancelled}`);

  if (result.details.length > 0) {
    console.log(`\n📋 Details:`);
    for (const d of result.details) console.log(`   ${d}`);
  }

  if (result.errors.length > 0) {
    console.log(`\n❌ Errors:`);
    for (const e of result.errors) console.log(`   ${e}`);
  }

  const total = result.autoResolved + result.resolved + result.cancelled;
  if (total === 0) {
    console.log(`\n💤 No bets needed resolution. Market is quiet.`);
  } else {
    console.log(`\n🔮 ${result.resolved + result.autoResolved} bets resolved — souls are evolving!`);
  }
  console.log();
}

// Only run main() when executed directly (not imported)
const isDirectRun = import.meta.main ?? (process.argv[1]?.includes("arbiter"));
if (isDirectRun) {
  main().catch(e => {
    console.error("Fatal arbiter error:", e);
    process.exit(1);
  });
}

export { runArbiter };
