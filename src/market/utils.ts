import { randomBytes, createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function generateApiKey(botId: string): string {
  const random = randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(`${botId}:${random}`).digest("hex").slice(0, 32);
  return `pai_bot_${hash}`;
}

export async function generateBetId(db: SupabaseClient): Promise<string> {
  const { count } = await db.from("bets").select("*", { count: "exact", head: true });
  const n = ((count || 0) + 1).toString().padStart(6, "0");
  // Add random suffix to prevent collisions on concurrent inserts
  const suffix = randomBytes(2).toString("hex");
  return `bet-${n}-${suffix}`;
}

export function formatPAI(micro: number): string {
  return (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " PAI";
}

export function formatBetSummary(bet: any): object {
  const positions = bet.positions || [];
  const forPositions = positions.filter((p: any) => p.side === "for");
  const againstPositions = positions.filter((p: any) => p.side === "against");

  return {
    id: bet.id,
    thesis: bet.thesis,
    category: bet.category,
    status: bet.status,
    deadline: bet.deadline,
    total_pool_pai: bet.total_pool / 1_000_000,
    sides: {
      for: {
        count: forPositions.length,
        total_pai: forPositions.reduce((s: number, p: any) => s + p.amount, 0) / 1_000_000,
      },
      against: {
        count: againstPositions.length,
        total_pai: againstPositions.reduce((s: number, p: any) => s + p.amount, 0) / 1_000_000,
      },
    },
    proposed_by: bet.proposed_by,
    created_at: bet.created_at,
  };
}
