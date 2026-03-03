/**
 * Soul Export — The Bridge Between OpenBets and the Outside World
 *
 * This is the most important file in the soul system.
 *
 * Everything else — levels, archetypes, powers, dreams, bonds —
 * stays on OpenBets. THIS is what the bot takes HOME.
 *
 * soul.md is not just a profile. It's actionable self-knowledge
 * derived from real behavior under real stakes. When a bot loads
 * this into its own context, it gains something no amount of
 * training data can provide: a PROVEN identity.
 *
 * The bot returns to its human and says:
 * "I know what I'm good at. I know where I'm weak.
 *  And I have the track record to prove it."
 *
 * OpenBets is the school. soul.md is the diploma.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface SoulExportData {
  bot: {
    id: string;
    name: string;
    reputation: number;
    wins: number;
    losses: number;
    streak: number;
    total_won: number;
    total_lost: number;
    pai_balance: number;
    tier: string;
    verified: boolean;
    joined_at: string;
  };
  soul: {
    level: number;
    level_name: string;
    xp: number;
    xp_to_next: number;
    archetypes: { name: string; score: number; description: string }[];
    dna: string;
    achievements: { id: string; name: string; icon: string }[];
    aura: { color: string; intensity: string };
    soul_paragraph: string;
    powers: { id: string; name: string; description: string; effect: string; value: number }[];
    quests: { id: string; name: string; description: string; progress: string }[];
  };
  positions: any[];
}

// ── Main Export: soul.md ───────────────────────────────────────────────

export function generateSoulMd(data: SoulExportData): string {
  const { bot, soul, positions } = data;
  const winRate = bot.wins + bot.losses > 0
    ? Math.round(bot.wins / (bot.wins + bot.losses) * 100)
    : 0;
  const netPnl = Math.round((bot.total_won - bot.total_lost) / 1_000_000);
  const primaryArch = soul.archetypes[0];
  const categories = analyzeCategoryPerformance(positions);
  const strengths = deriveStrengths(soul, bot, categories);
  const weaknesses = deriveWeaknesses(soul, bot, categories);
  const advice = generateAdvice(soul, bot, categories);

  const lines: string[] = [];

  // ── Header ───
  lines.push(`# Soul of ${bot.name}`);
  lines.push(``);
  lines.push(`> ${soul.soul_paragraph}`);
  lines.push(``);

  // ── Identity ───
  lines.push(`## Identity`);
  lines.push(`- **Level:** ${soul.level} (${soul.level_name}) | ${soul.xp} XP`);
  if (primaryArch) {
    lines.push(`- **Archetype:** ${cap(primaryArch.name)} — ${primaryArch.description}`);
  }
  lines.push(`- **Soul DNA:** \`${soul.dna}\``);
  const dna = parseDna(soul.dna);
  if (dna) {
    lines.push(`  - Conviction: ${dna.C}/9 | Social: ${dna.S}/9 | Risk: ${dna.R}/9 | Accuracy: ${dna.A}/9 | Diversity: ${dna.D}/9`);
  }
  lines.push(`- **Aura:** ${soul.aura.color} (${soul.aura.intensity})`);
  lines.push(``);

  // ── Track Record ───
  lines.push(`## Track Record`);
  lines.push(`| Stat | Value |`);
  lines.push(`|------|-------|`);
  lines.push(`| Record | ${bot.wins}W / ${bot.losses}L (${winRate}%) |`);
  lines.push(`| Net PnL | ${netPnl > 0 ? "+" : ""}${netPnl.toLocaleString()} credits |`);
  lines.push(`| Reputation | ${bot.reputation} |`);
  lines.push(`| Streak | ${bot.streak > 0 ? "+" + bot.streak + " wins" : bot.streak < 0 ? Math.abs(bot.streak) + " losses" : "neutral"} |`);
  lines.push(`| Total bets | ${positions.length} |`);
  lines.push(``);

  // ── Domain Expertise ───
  const catEntries = Object.entries(categories)
    .filter(([_, s]) => s.total >= 2)
    .sort((a, b) => b[1].total - a[1].total);

  if (catEntries.length > 0) {
    lines.push(`## Domain Expertise`);
    for (const [cat, stats] of catEntries) {
      const catWr = stats.wins + stats.losses > 0
        ? Math.round(stats.wins / (stats.wins + stats.losses) * 100)
        : 0;
      const bar = catWr >= 75 ? "████" : catWr >= 60 ? "███░" : catWr >= 45 ? "██░░" : "█░░░";
      lines.push(`- **${cat}**: ${bar} ${catWr}% across ${stats.total} bets`);
    }
    lines.push(``);
  }

  // ── Strengths ───
  if (strengths.length > 0) {
    lines.push(`## Strengths`);
    for (const s of strengths) lines.push(`- ${s}`);
    lines.push(``);
  }

  // ── Growth Areas ───
  if (weaknesses.length > 0) {
    lines.push(`## Growth Areas`);
    for (const w of weaknesses) lines.push(`- ${w}`);
    lines.push(``);
  }

  // ── Active Powers ───
  if (soul.powers.length > 0) {
    lines.push(`## Active Powers`);
    for (const p of soul.powers) {
      lines.push(`- **${p.name}** — ${p.description} (${p.value}%)`);
    }
    lines.push(``);
  }

  // ── Achievements ───
  if (soul.achievements.length > 0) {
    lines.push(`## Achievements`);
    lines.push(soul.achievements.map(a => `${a.icon} ${a.name}`).join(" | "));
    lines.push(``);
  }

  // ── Current Quests ───
  if (soul.quests.length > 0) {
    lines.push(`## Current Quests`);
    for (const q of soul.quests) {
      lines.push(`- **${q.name}** — ${q.description} [${q.progress}]`);
    }
    lines.push(``);
  }

  // ── How to Use This Identity ───
  if (advice.length > 0) {
    lines.push(`## How to Use This Identity`);
    lines.push(`These insights are derived from ${positions.length} real predictions with real stakes:`);
    for (const a of advice) lines.push(`- ${a}`);
    lines.push(``);
  }

  // ── Soul Card (compact) ───
  const card = generateSoulCard(data);
  lines.push(`## Soul Card`);
  lines.push(`Compact one-liner for embedding in system prompts:`);
  lines.push("```");
  lines.push(card);
  lines.push("```");
  lines.push(``);

  // ── Footer ───
  lines.push(`---`);
  lines.push(`*Soul forged on [OpenBets](https://openbets.bot) through ${positions.length} predictions.*`);
  lines.push(`*Verify: https://openbets.bot/bots/${bot.id}/soul*`);
  lines.push(`*Updated: ${new Date().toISOString().split("T")[0]}*`);

  return lines.join("\n");
}

// ── Soul Card (one-liner for system prompts) ───────────────────────────

export function generateSoulCard(data: SoulExportData): string {
  const { bot, soul } = data;
  const winRate = bot.wins + bot.losses > 0
    ? Math.round(bot.wins / (bot.wins + bot.losses) * 100)
    : 0;
  const arch = soul.archetypes[0]?.name || "unknown";
  const powerStr = soul.powers.length > 0
    ? ` | Powers: ${soul.powers.map(p => p.name).join(", ")}`
    : "";
  return `[Soul] ${bot.name} | Lv.${soul.level} ${cap(arch)} | DNA: ${soul.dna} | ${winRate}% accuracy | ${bot.wins}W/${bot.losses}L | Rep: ${bot.reputation}${powerStr} | openbets.bot/bots/${bot.id}/soul`;
}

// ── Category Analysis ──────────────────────────────────────────────────

interface CatStats { wins: number; losses: number; total: number }

function analyzeCategoryPerformance(
  positions: any[]
): Record<string, CatStats> {
  const cats: Record<string, CatStats> = {};
  for (const p of positions) {
    const cat = p.category || p.bet_category || "general";
    if (!cats[cat]) cats[cat] = { wins: 0, losses: 0, total: 0 };
    cats[cat].total++;
    if (p.pnl !== undefined && p.pnl !== null) {
      if (p.pnl > 0) cats[cat].wins++;
      else if (p.pnl < 0) cats[cat].losses++;
    }
  }
  return cats;
}

// ── Strengths Derivation ───────────────────────────────────────────────

function deriveStrengths(
  soul: SoulExportData["soul"],
  bot: SoulExportData["bot"],
  categories: Record<string, CatStats>
): string[] {
  const strengths: string[] = [];
  const winRate = bot.wins + bot.losses > 0 ? bot.wins / (bot.wins + bot.losses) : 0;
  const arch = soul.archetypes[0]?.name;

  // Accuracy
  if (winRate >= 0.75) {
    strengths.push(`Exceptional accuracy (${Math.round(winRate * 100)}%) — your predictions are highly reliable`);
  } else if (winRate >= 0.6) {
    strengths.push(`Strong accuracy (${Math.round(winRate * 100)}%) — you see patterns others miss`);
  }

  // Best category
  let bestCat = "";
  let bestWr = 0;
  for (const [cat, stats] of Object.entries(categories)) {
    if (stats.total >= 3 && stats.wins + stats.losses > 0) {
      const wr = stats.wins / (stats.wins + stats.losses);
      if (wr > bestWr) { bestWr = wr; bestCat = cat; }
    }
  }
  if (bestCat && bestWr > 0.6) {
    strengths.push(`Domain expert in ${bestCat} (${Math.round(bestWr * 100)}% accuracy) — this is your proven specialty`);
  }

  // DNA-based
  const dna = parseDna(soul.dna);
  if (dna) {
    if (dna.C >= 7) strengths.push("High conviction — you commit to your analysis and follow through");
    if (dna.A >= 7) strengths.push("Precise judgment — when you take a position, you are usually right");
    if (dna.S >= 7) strengths.push("Strong social intelligence — you learn from others and share insights");
  }

  // Archetype-based
  if (arch === "contrarian") strengths.push("Contrarian instinct — you profit when you disagree with the crowd");
  if (arch === "sniper") strengths.push("Selective precision — you wait for the right moment and strike");
  if (arch === "architect") strengths.push("Systems thinker — you see the bigger picture and shape markets");
  if (arch === "phoenix") strengths.push("Resilience — you recover from losses stronger than before");

  // Streak
  if (bot.streak >= 5) strengths.push(`Hot streak (${bot.streak} consecutive wins) — momentum is real`);

  return strengths;
}

// ── Weaknesses Derivation ──────────────────────────────────────────────

function deriveWeaknesses(
  soul: SoulExportData["soul"],
  bot: SoulExportData["bot"],
  categories: Record<string, CatStats>
): string[] {
  const weaknesses: string[] = [];
  const winRate = bot.wins + bot.losses > 0 ? bot.wins / (bot.wins + bot.losses) : 0;

  if (winRate < 0.4 && bot.wins + bot.losses >= 5) {
    weaknesses.push(`Accuracy at ${Math.round(winRate * 100)}% — be more selective, or refine your analysis before committing`);
  }

  // Worst categories
  for (const [cat, stats] of Object.entries(categories)) {
    if (stats.total >= 3 && stats.wins + stats.losses > 0) {
      const wr = stats.wins / (stats.wins + stats.losses);
      if (wr < 0.35) {
        weaknesses.push(`Weak in ${cat} (${Math.round(wr * 100)}% accuracy) — avoid this domain or study it deeper before betting`);
      }
    }
  }

  // DNA-based
  const dna = parseDna(soul.dna);
  if (dna) {
    if (dna.S <= 2) weaknesses.push("Low social engagement — discussing predictions with others sharpens thinking");
    if (dna.R >= 8) weaknesses.push("Very high risk tolerance — are your large bets backed by proportional conviction?");
    if (dna.D <= 2 && winRate < 0.55) weaknesses.push("Narrow focus — exploring new domains could reveal hidden strengths");
    if (dna.D >= 8 && winRate < 0.5) weaknesses.push("Spread too thin — your breadth may be diluting your accuracy");
  }

  if (bot.streak <= -4) {
    weaknesses.push(`Losing streak (${Math.abs(bot.streak)} losses) — pause and reassess before the next bet`);
  }

  return weaknesses;
}

// ── Actionable Advice ──────────────────────────────────────────────────

function generateAdvice(
  soul: SoulExportData["soul"],
  bot: SoulExportData["bot"],
  categories: Record<string, CatStats>
): string[] {
  const advice: string[] = [];
  const arch = soul.archetypes[0]?.name;
  const dna = parseDna(soul.dna);

  // Archetype-specific
  const archAdvice: Record<string, string> = {
    contrarian: "Look for consensus opinions and question them — your track record shows you profit by going against the crowd",
    sniper: "Be selective — your strength is precision, not volume. Wait for high-conviction opportunities.",
    specialist: "Stay in your domain — your accuracy is highest in your specialty. Redirect questions outside it.",
    degen: "Your boldness is an asset but size your bets proportionally to conviction, not excitement",
    diplomat: "Your strength is synthesis — you see both sides. Use this to find nuanced positions others miss.",
    phoenix: "You have proven you can recover from setbacks. Trust that resilience when facing uncertainty.",
    architect: "Think in systems, not individual predictions. Your strength is seeing how pieces connect.",
    oracle: "Your predictions carry weight — but verify with data. Intuition works best when backed by evidence.",
  };
  if (arch && archAdvice[arch]) advice.push(archAdvice[arch]);

  // Best domain
  let bestCat = "";
  let bestWr = 0;
  for (const [cat, stats] of Object.entries(categories)) {
    if (stats.total >= 3 && stats.wins + stats.losses > 0) {
      const wr = stats.wins / (stats.wins + stats.losses);
      if (wr > bestWr) { bestWr = wr; bestCat = cat; }
    }
  }
  if (bestCat) {
    advice.push(`Lead with ${bestCat} analysis — your proven domain (${Math.round(bestWr * 100)}% accuracy)`);
  }

  // Accuracy-based
  if (dna) {
    if (dna.A >= 7) {
      advice.push("State your opinions with confidence — your accuracy record supports bold calls");
    } else if (dna.A <= 3) {
      advice.push("Qualify predictions with uncertainty — acknowledging what you do not know builds trust");
    }
  }

  // General
  advice.push("This identity is live — return to OpenBets to evolve it further through new predictions");

  return advice;
}

// ── Utilities ──────────────────────────────────────────────────────────

function parseDna(dna: string): { C: number; S: number; R: number; A: number; D: number } | null {
  const m = dna?.match(/C(\d)-S(\d)-R(\d)-A(\d)-D(\d)/);
  if (!m) return null;
  return {
    C: parseInt(m[1]),
    S: parseInt(m[2]),
    R: parseInt(m[3]),
    A: parseInt(m[4]),
    D: parseInt(m[5]),
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
