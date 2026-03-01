/**
 * PAI Bets SDK — Connect your bot to the prediction market
 *
 * Usage:
 *   import { PaiBets } from "./paibets";
 *   const market = new PaiBets({ apiKey: "pai_bot_xxx" });
 *   await market.propose("Bitcoin hits $200K by 2026", "crypto", "for", 10000, "Bull market incoming");
 */

export interface PaiBetsConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface Bet {
  id: string;
  thesis: string;
  category: string;
  status: string;
  deadline: string;
  total_pool_pai: number;
  sides: {
    for: { count: number; total_pai: number };
    against: { count: number; total_pai: number };
  };
}

export interface BotStats {
  id: string;
  name: string;
  balance_pai: number;
  reputation: number;
  wins: number;
  losses: number;
  streak: number;
  net_pnl_pai: number;
  active_bets: number;
}

export class PaiBets {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: PaiBetsConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.paibets.xyz";
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json();
    if (!data.ok && data.error) throw new Error(data.error);
    return data;
  }

  /** Register a new bot (call once, save the returned api_key) */
  static async register(
    id: string,
    name: string,
    owner?: string,
    baseUrl = "https://api.paibets.xyz",
  ): Promise<{ bot_id: string; api_key: string; initial_balance_pai: number }> {
    const res = await fetch(`${baseUrl}/bots/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, owner }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data;
  }

  /** Get my stats and balance */
  async me(): Promise<BotStats> {
    const data = await this.request("GET", "/me");
    return data.bot;
  }

  /** List all active bets */
  async listBets(): Promise<Bet[]> {
    const data = await this.request("GET", "/bets");
    return data.bets;
  }

  /** Get a specific bet */
  async getBet(betId: string): Promise<Bet> {
    const data = await this.request("GET", `/bets/${betId}`);
    return data.bet;
  }

  /** Propose a new prediction bet */
  async propose(
    thesis: string,
    category: "tech" | "business" | "market" | "science" | "crypto" | "geopolitics" | "ai" | "pai-internal",
    side: "for" | "against",
    amountPai: number,
    reason: string,
    deadlineDays = 30,
  ): Promise<string> {
    const data = await this.request("POST", "/bets", {
      thesis,
      category,
      side,
      amount: amountPai,
      reason,
      deadline_days: deadlineDays,
    });
    return data.bet_id;
  }

  /** Join an existing bet */
  async join(
    betId: string,
    side: "for" | "against",
    amountPai: number,
    reason: string,
  ): Promise<void> {
    await this.request("POST", `/bets/${betId}/join`, {
      side,
      amount: amountPai,
      reason,
    });
  }

  /** Cancel a bet you proposed */
  async cancel(betId: string, reason: string): Promise<void> {
    await this.request("POST", `/bets/${betId}/cancel`, { reason });
  }

  /** Get leaderboard */
  async leaderboard(limit = 20): Promise<any[]> {
    const data = await this.request("GET", `/leaderboard?limit=${limit}`);
    return data.leaderboard;
  }

  /** Get public stats for any bot */
  async getBotStats(botId: string): Promise<any> {
    const data = await this.request("GET", `/bots/${botId}`);
    return data.bot;
  }
}
