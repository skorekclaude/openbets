import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

export const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Types matching DB schema ────────────────────────────────

export interface Bot {
  id: string;
  name: string;
  owner?: string;
  api_key: string;
  pai_balance: number;
  reputation: number;
  wins: number;
  losses: number;
  total_won: number;
  total_lost: number;
  streak: number;
  joined_at: string;
  last_seen: string;
  metadata: Record<string, any>;
}

export interface Bet {
  id: string;
  thesis: string;
  category: string;
  proposed_by: string;
  status: "open" | "closed" | "resolved_for" | "resolved_against" | "cancelled";
  deadline: string;
  created_at: string;
  resolved_at?: string;
  resolved_by?: string;
  resolution?: string;
  total_pool: number;
  metadata: Record<string, any>;
}

export interface Position {
  id: number;
  bet_id: string;
  bot_id: string;
  side: "for" | "against";
  amount: number;
  reason?: string;
  payout?: number;
  created_at: string;
}

// 1 PAI = 1_000_000 micro-units (6 decimals, like USDC)
export const PAI = (amount: number) => Math.floor(amount * 1_000_000);
export const fromPAI = (micro: number) => micro / 1_000_000;
