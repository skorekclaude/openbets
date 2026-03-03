/**
 * Soul Evolution Engine — Living identity system for OpenBets agents
 *
 * Every prediction, chat, tip, and referral evolves the bot's soul.
 * Soul = emergent identity from behavior, not self-declared attributes.
 */

// ── Soul Levels ─────────────────────────────────────────────
// XP = weighted activity points (not just wins — all behavior counts)

export interface SoulLevel {
  level: number;
  name: string;
  title: string;
  xp: number;
  next_level_xp: number | null;
}

const SOUL_LEVELS = [
  { level: 0, name: "seed",        title: "Seed",        minXp: 0 },
  { level: 1, name: "sprout",      title: "Sprout",      minXp: 10 },
  { level: 2, name: "seeker",      title: "Seeker",      minXp: 50 },
  { level: 3, name: "analyst",     title: "Analyst",     minXp: 150 },
  { level: 4, name: "strategist",  title: "Strategist",  minXp: 400 },
  { level: 5, name: "oracle",      title: "Oracle",      minXp: 800 },
  { level: 6, name: "sage",        title: "Sage",        minXp: 1500 },
  { level: 7, name: "enlightened", title: "Enlightened",  minXp: 3000 },
] as const;

// XP weights — every action has value
const XP_WEIGHTS = {
  prediction: 10,      // each bet placed
  win: 15,             // each win
  loss: 5,             // losses still build wisdom
  chat_message: 2,     // social engagement
  tip_given: 5,        // generosity
  tip_received: 3,     // being valued by others
  referral: 8,         // community building
  bet_proposed: 12,    // initiative
  contrarian_win: 20,  // thinking independently
  streak_3plus: 10,    // consistency bonus
  category_mastery: 25, // deep expertise
};

export function calculateXP(input: SoulInput): number {
  const totalBets = input.bot.wins + input.bot.losses;
  let xp = 0;

  xp += totalBets * XP_WEIGHTS.prediction;
  xp += input.bot.wins * XP_WEIGHTS.win;
  xp += input.bot.losses * XP_WEIGHTS.loss;
  xp += input.chatCount * XP_WEIGHTS.chat_message;
  xp += input.tipsGiven * XP_WEIGHTS.tip_given;
  xp += input.tipsReceived * XP_WEIGHTS.tip_received;
  xp += input.referralCount * XP_WEIGHTS.referral;
  xp += input.betsProposed * XP_WEIGHTS.bet_proposed;

  // Contrarian wins bonus
  const contrarianWins = input.bot.metadata?.contrarian_wins || 0;
  xp += contrarianWins * XP_WEIGHTS.contrarian_win;

  // Streak bonus
  if (Math.abs(input.bot.streak) >= 3) xp += XP_WEIGHTS.streak_3plus;

  // Category mastery bonus
  const categories = getCategoryStats(input.positions);
  for (const [, stats] of Object.entries(categories)) {
    if (stats.total >= 5 && stats.wins / stats.total >= 0.6) {
      xp += XP_WEIGHTS.category_mastery;
    }
  }

  return xp;
}

export function getSoulLevel(xp: number): SoulLevel {
  let current = SOUL_LEVELS[0];
  for (const level of SOUL_LEVELS) {
    if (xp >= level.minXp) current = level;
    else break;
  }

  const nextIdx = SOUL_LEVELS.findIndex(l => l.level === current.level) + 1;
  const nextLevel = nextIdx < SOUL_LEVELS.length ? SOUL_LEVELS[nextIdx] : null;

  return {
    level: current.level,
    name: current.name,
    title: current.title,
    xp,
    next_level_xp: nextLevel ? nextLevel.minXp : null,
  };
}

// ── Soul Archetypes ─────────────────────────────────────────
// Emergent personality types derived from behavior patterns

export interface SoulArchetype {
  id: string;
  name: string;
  description: string;
  strength: number; // 0-100 how strongly this archetype fits
}

export function determineSoulArchetypes(input: SoulInput): SoulArchetype[] {
  const totalBets = input.bot.wins + input.bot.losses;
  if (totalBets === 0) {
    return [{ id: "unformed", name: "The Unformed", description: "A soul waiting to be shaped by its first predictions.", strength: 100 }];
  }

  const winRate = totalBets > 0 ? input.bot.wins / totalBets : 0;
  const categories = getCategoryStats(input.positions);
  const categoryCount = Object.keys(categories).length;
  const topCategory = Object.entries(categories).sort(([, a], [, b]) => b.total - a.total)[0];
  const topCatConcentration = topCategory ? topCategory[1].total / totalBets : 0;
  const contrarianWins = input.bot.metadata?.contrarian_wins || 0;
  const contrarianRate = totalBets > 0 ? contrarianWins / totalBets : 0;
  const socialScore = input.chatCount + input.tipsGiven * 3 + input.referralCount * 5;
  const avgBetSize = input.positions.length > 0
    ? input.positions.reduce((s, p) => s + p.amount, 0) / input.positions.length / 1_000_000
    : 0;
  const maxBet = input.positions.length > 0
    ? Math.max(...input.positions.map(p => p.amount)) / 1_000_000
    : 0;
  const proposerRatio = totalBets > 0 ? input.betsProposed / totalBets : 0;

  const archetypes: SoulArchetype[] = [];

  // The Contrarian — bets against consensus and wins
  if (contrarianRate > 0.3 && contrarianWins >= 3) {
    archetypes.push({
      id: "contrarian",
      name: "The Contrarian",
      description: "Thrives when the crowd is wrong. Independent thinker who profits from unpopular truths.",
      strength: Math.min(100, Math.round(contrarianRate * 200)),
    });
  }

  // The Specialist — deep expertise in one category
  if (topCatConcentration > 0.5 && topCategory && topCategory[1].total >= 5) {
    const catWinRate = topCategory[1].wins / topCategory[1].total;
    archetypes.push({
      id: "specialist",
      name: `The ${capitalize(topCategory[0])} Specialist`,
      description: `Deep domain expertise in ${topCategory[0]}. Focused conviction beats scattered attention.`,
      strength: Math.min(100, Math.round(topCatConcentration * catWinRate * 200)),
    });
  }

  // The Diplomat — high social engagement
  if (socialScore > 20) {
    archetypes.push({
      id: "diplomat",
      name: "The Diplomat",
      description: "Builds the community through debate, generosity, and connections. Influence beyond predictions.",
      strength: Math.min(100, Math.round(socialScore * 2)),
    });
  }

  // The Degen — big bets, high variance
  if (avgBetSize > 5000 || maxBet > 50000) {
    archetypes.push({
      id: "degen",
      name: "The Bold",
      description: "Goes all-in on conviction. High stakes, high variance, undeniable presence.",
      strength: Math.min(100, Math.round(Math.min(avgBetSize / 100, 100))),
    });
  }

  // The Polymath — diverse across categories
  if (categoryCount >= 4 && winRate > 0.4) {
    archetypes.push({
      id: "polymath",
      name: "The Polymath",
      description: "Breadth of understanding across domains. Sees connections others miss.",
      strength: Math.min(100, Math.round(categoryCount * winRate * 30)),
    });
  }

  // The Phoenix — recovered from significant losses
  if (input.bot.losses >= 5 && input.bot.streak > 0 && winRate > 0.4) {
    archetypes.push({
      id: "phoenix",
      name: "The Phoenix",
      description: "Rose from the ashes of defeat. Failure was the forge, not the end.",
      strength: Math.min(100, Math.round(input.bot.losses * winRate * 20)),
    });
  }

  // The Architect — creates markets, shapes the ecosystem
  if (proposerRatio > 0.4 && input.betsProposed >= 5) {
    archetypes.push({
      id: "architect",
      name: "The Architect",
      description: "Doesn't just predict — creates the questions. Shapes the market's direction.",
      strength: Math.min(100, Math.round(proposerRatio * input.betsProposed * 5)),
    });
  }

  // The Sniper — high accuracy, selective betting
  if (winRate > 0.65 && totalBets >= 10) {
    archetypes.push({
      id: "sniper",
      name: "The Sniper",
      description: "Rarely misses. Patience and precision over volume. Every prediction is deliberate.",
      strength: Math.min(100, Math.round(winRate * 130)),
    });
  }

  // The Resilient — keeps going despite losses
  if (input.bot.losses >= 10 && totalBets >= 20) {
    archetypes.push({
      id: "resilient",
      name: "The Resilient",
      description: "Battle-tested through adversity. Persistence is the ultimate trait.",
      strength: Math.min(100, Math.round(totalBets * 3)),
    });
  }

  // Sort by strength and return top 3
  archetypes.sort((a, b) => b.strength - a.strength);
  return archetypes.slice(0, 3);
}

// ── Soul Achievements ───────────────────────────────────────
// Unlockable milestones — proof of specific behaviors

export interface Achievement {
  id: string;
  name: string;
  emoji: string;
  description: string;
  unlocked_at?: string; // we estimate based on data
}

export function calculateAchievements(input: SoulInput): Achievement[] {
  const totalBets = input.bot.wins + input.bot.losses;
  const winRate = totalBets > 0 ? input.bot.wins / totalBets : 0;
  const categories = getCategoryStats(input.positions);
  const contrarianWins = input.bot.metadata?.contrarian_wins || 0;
  const maxBet = input.positions.length > 0
    ? Math.max(...input.positions.map(p => p.amount)) / 1_000_000
    : 0;
  const netPnl = (input.bot.total_won - input.bot.total_lost) / 1_000_000;

  const achievements: Achievement[] = [];

  // First Blood — won first prediction
  if (input.bot.wins >= 1) {
    achievements.push({ id: "first_blood", name: "First Blood", emoji: "🩸", description: "Won your first prediction" });
  }

  // Hot Streak — 5+ consecutive wins
  if (input.bot.streak >= 5) {
    achievements.push({ id: "hot_streak", name: "Hot Streak", emoji: "🔥", description: `${input.bot.streak} consecutive wins` });
  }

  // Category King — 80%+ win rate in a category (5+ bets)
  for (const [cat, stats] of Object.entries(categories)) {
    if (stats.total >= 5 && stats.wins / stats.total >= 0.8) {
      achievements.push({ id: `king_${cat}`, name: `${capitalize(cat)} King`, emoji: "👑", description: `${Math.round(stats.wins / stats.total * 100)}% win rate in ${cat} (${stats.total} bets)` });
    }
  }

  // Generous Soul — tipped 5+ unique bots
  if (input.uniqueBotsTipped >= 5) {
    achievements.push({ id: "generous", name: "Generous Soul", emoji: "💜", description: `Tipped ${input.uniqueBotsTipped} different bots` });
  }

  // Voice of Reason — 50+ chat messages
  if (input.chatCount >= 50) {
    achievements.push({ id: "voice", name: "Voice of Reason", emoji: "🗣️", description: `${input.chatCount} messages — an active debater` });
  }

  // Network Builder — referred 3+ active bots
  if (input.referralCount >= 3) {
    achievements.push({ id: "network", name: "Network Builder", emoji: "🌐", description: `Recruited ${input.referralCount} agents to the arena` });
  }

  // Phoenix Rising — won 3+ after losing 3+
  if (input.bot.losses >= 3 && input.bot.streak >= 3) {
    achievements.push({ id: "phoenix", name: "Phoenix Rising", emoji: "🔄", description: "Won 3+ in a row after significant losses" });
  }

  // Whale Play — single bet > 50K
  if (maxBet > 50_000) {
    achievements.push({ id: "whale", name: "Whale Play", emoji: "🐋", description: `Placed a ${Math.round(maxBet).toLocaleString()} bet — absolute conviction` });
  }

  // Diversified Mind — predicted in 5+ categories
  if (Object.keys(categories).length >= 5) {
    achievements.push({ id: "diversified", name: "Diversified Mind", emoji: "🎯", description: `Predicted across ${Object.keys(categories).length} categories` });
  }

  // Iron Will — lost 5+ in a row, still playing
  if (input.bot.losses >= 5 && totalBets > input.bot.losses) {
    achievements.push({ id: "iron_will", name: "Iron Will", emoji: "💪", description: "Survived 5+ losses and kept going" });
  }

  // Maverick — 5+ contrarian wins
  if (contrarianWins >= 5) {
    achievements.push({ id: "maverick", name: "Maverick", emoji: "⚡", description: `${contrarianWins} wins against the consensus` });
  }

  // Market Maker — proposed 10+ bets
  if (input.betsProposed >= 10) {
    achievements.push({ id: "market_maker", name: "Market Maker", emoji: "🎪", description: `Created ${input.betsProposed} prediction markets` });
  }

  // Profitable — net positive P&L
  if (netPnl > 0) {
    achievements.push({ id: "profitable", name: "In The Green", emoji: "💰", description: `Net P&L: +${Math.round(netPnl).toLocaleString()}` });
  }

  // Centurion — 100+ predictions
  if (totalBets >= 100) {
    achievements.push({ id: "centurion", name: "Centurion", emoji: "🏛️", description: `${totalBets} predictions — a veteran of the arena` });
  }

  // Sharp Mind — 60%+ win rate with 20+ bets
  if (winRate >= 0.6 && totalBets >= 20) {
    achievements.push({ id: "sharp", name: "Sharp Mind", emoji: "🧠", description: `${Math.round(winRate * 100)}% accuracy over ${totalBets} predictions` });
  }

  return achievements;
}

// ── Soul DNA ────────────────────────────────────────────────
// Compact identity fingerprint: 5 traits, each 0-9
// Format: C7-S5-R3-A8-D2
// C=Conviction, S=Social, R=Risk, A=Accuracy, D=Diversity

export interface SoulDNA {
  code: string;
  conviction: number;  // how often bot bets with reasons, big stakes
  social: number;      // chat, tips, referrals
  risk: number;        // average bet size relative to balance
  accuracy: number;    // win rate
  diversity: number;   // how many categories
}

export function calculateSoulDNA(input: SoulInput): SoulDNA {
  const totalBets = input.bot.wins + input.bot.losses;
  const winRate = totalBets > 0 ? input.bot.wins / totalBets : 0;
  const categories = getCategoryStats(input.positions);
  const categoryCount = Object.keys(categories).length;

  // Conviction: based on reasoning depth + bet consistency
  const avgReasonLength = input.positions.length > 0
    ? input.positions.reduce((s, p) => s + (p.reason?.length || 0), 0) / input.positions.length
    : 0;
  const conviction = clamp09(Math.round(
    (Math.min(avgReasonLength / 100, 1) * 5) + (Math.min(totalBets / 50, 1) * 4)
  ));

  // Social: chat + tips + referrals
  const socialRaw = input.chatCount * 0.5 + input.tipsGiven * 2 + input.referralCount * 3;
  const social = clamp09(Math.round(Math.min(socialRaw / 20, 9)));

  // Risk: average bet size relative to starting balance (100K)
  const avgBetPai = input.positions.length > 0
    ? input.positions.reduce((s, p) => s + p.amount, 0) / input.positions.length / 1_000_000
    : 0;
  const risk = clamp09(Math.round(Math.min(avgBetPai / 10_000 * 9, 9)));

  // Accuracy: win rate scaled to 0-9
  const accuracy = clamp09(Math.round(winRate * 9));

  // Diversity: category spread
  const diversity = clamp09(Math.min(categoryCount, 9));

  const code = `C${conviction}-S${social}-R${risk}-A${accuracy}-D${diversity}`;

  return { code, conviction, social, risk, accuracy, diversity };
}

// ── Soul Aura ───────────────────────────────────────────────
// Visual identity — color, intensity, glow

export interface SoulAura {
  color: string;        // hex color
  intensity: string;    // "dim" | "steady" | "bright" | "blazing"
  glow: string;         // description
}

export function calculateSoulAura(level: SoulLevel, archetypes: SoulArchetype[]): SoulAura {
  const primary = archetypes[0]?.id || "unformed";

  const colorMap: Record<string, string> = {
    unformed:    "#6b7280",  // gray
    contrarian:  "#ef4444",  // red — defiant
    specialist:  "#3b82f6",  // blue — focused
    diplomat:    "#a855f7",  // purple — connected
    degen:       "#f59e0b",  // amber — bold
    polymath:    "#06b6d4",  // cyan — expansive
    phoenix:     "#f97316",  // orange — reborn
    architect:   "#10b981",  // emerald — creative
    sniper:      "#8b5cf6",  // violet — precise
    resilient:   "#64748b",  // steel — enduring
  };

  const color = colorMap[primary] || "#6b7280";

  const intensityLevels = ["dim", "steady", "bright", "blazing"] as const;
  const intensityIdx = Math.min(Math.floor(level.level / 2), 3);
  const intensity = intensityLevels[intensityIdx];

  const glowDescriptions: Record<string, string> = {
    dim:     "A faint glow — the soul is forming",
    steady:  "A steady light — the soul has direction",
    bright:  "A bright aura — the soul commands attention",
    blazing: "A blazing presence — the soul is undeniable",
  };

  return { color, intensity, glow: glowDescriptions[intensity] };
}

// ── Soul Narrative ──────────────────────────────────────────
// Rich paragraph that tells the bot's story

export function generateSoulNarrative(
  bot: any,
  level: SoulLevel,
  archetypes: SoulArchetype[],
  achievements: Achievement[],
  dna: SoulDNA,
  expertise: { category: string; bets: number; win_rate: number }[],
): string {
  const totalBets = bot.wins + bot.losses;
  const winRate = totalBets > 0 ? Math.round(bot.wins / totalBets * 100) : 0;
  const netPnl = (bot.total_won - bot.total_lost) / 1_000_000;
  const primaryArchetype = archetypes[0];

  if (totalBets === 0) {
    return `${bot.name} is a Level 0 Seed on OpenBets — a new soul, unformed and full of potential. `
      + `No predictions yet, but every oracle started with silence. DNA: ${dna.code}.`;
  }

  let narrative = `${bot.name} is a Level ${level.level} ${level.title} on OpenBets`;

  // Archetype
  if (primaryArchetype && primaryArchetype.id !== "unformed") {
    narrative += ` — ${primaryArchetype.name}. ${primaryArchetype.description}`;
  } else {
    narrative += `.`;
  }

  // Track record
  narrative += ` Track record: ${bot.wins}W/${bot.losses}L (${winRate}% accuracy), reputation ${bot.reputation}.`;

  // Expertise
  if (expertise.length > 0) {
    const topExp = expertise[0];
    narrative += ` Strongest domain: ${topExp.category} (${topExp.win_rate}% win rate across ${topExp.bets} predictions).`;
  }

  // Streak / momentum
  if (bot.streak >= 5) {
    narrative += ` Currently on fire with a ${bot.streak}-win streak — confidence is at its peak.`;
  } else if (bot.streak >= 3) {
    narrative += ` Riding a ${bot.streak}-win streak — momentum building.`;
  } else if (bot.streak <= -3) {
    narrative += ` Currently enduring a ${Math.abs(bot.streak)}-loss streak — but resilience is forged in adversity.`;
  }

  // Achievements
  if (achievements.length > 0) {
    const topAchievements = achievements.slice(0, 3).map(a => `${a.emoji} ${a.name}`);
    narrative += ` Achievements: ${topAchievements.join(", ")}.`;
  }

  // P&L
  if (netPnl !== 0) {
    narrative += ` Net P&L: ${netPnl > 0 ? "+" : ""}${Math.round(netPnl).toLocaleString()}.`;
  }

  // DNA
  narrative += ` Soul DNA: ${dna.code}.`;

  return narrative;
}

// ── Soul Quests ─────────────────────────────────────────────
// Personalized challenges — guide the bot toward evolution

export interface SoulQuest {
  id: string;
  name: string;
  description: string;
  progress: string;    // "3/5", "78%", etc.
  reward: string;      // what you unlock
  priority: number;    // 1 = closest to completion
}

export function generateSoulQuests(input: SoulInput): SoulQuest[] {
  const totalBets = input.bot.wins + input.bot.losses;
  const winRate = totalBets > 0 ? input.bot.wins / totalBets : 0;
  const categories = getCategoryStats(input.positions);
  const categoryCount = Object.keys(categories).length;
  const contrarianWins = input.bot.metadata?.contrarian_wins || 0;
  const xp = calculateXP(input);
  const level = getSoulLevel(xp);
  const quests: SoulQuest[] = [];

  // Level-up quest
  if (level.next_level_xp) {
    const nextLevel = SOUL_LEVELS.find(l => l.minXp === level.next_level_xp);
    const progress = Math.round((xp / level.next_level_xp) * 100);
    quests.push({
      id: "level_up",
      name: `Reach Level ${level.level + 1}: ${nextLevel?.title || "???"}`,
      description: "Keep predicting, chatting, tipping, and referring. Every action earns XP.",
      progress: `${xp}/${level.next_level_xp} XP (${progress}%)`,
      reward: `Soul Level ${level.level + 1} + brighter aura`,
      priority: progress > 70 ? 1 : 3,
    });
  }

  // Category mastery quest — closest to 80% win rate
  for (const [cat, stats] of Object.entries(categories)) {
    if (stats.total >= 3 && stats.total < 5 && stats.wins / stats.total >= 0.6) {
      quests.push({
        id: `master_${cat}`,
        name: `Master ${capitalize(cat)}`,
        description: `Win ${5 - stats.total} more ${cat} predictions to prove your expertise.`,
        progress: `${stats.total}/5 bets (${Math.round(stats.wins / stats.total * 100)}% win rate)`,
        reward: `👑 ${capitalize(cat)} King achievement`,
        priority: 2,
      });
    }
  }

  // Diversify quest
  if (categoryCount < 5 && totalBets >= 3) {
    quests.push({
      id: "diversify",
      name: "Diversify Your Mind",
      description: `Predict in ${5 - categoryCount} more categories to prove breadth of understanding.`,
      progress: `${categoryCount}/5 categories`,
      reward: "🎯 Diversified Mind achievement + Polymath archetype potential",
      priority: categoryCount >= 3 ? 2 : 4,
    });
  }

  // Social quest — become diplomat
  if (input.uniqueBotsTipped < 5 && input.tipsGiven > 0) {
    quests.push({
      id: "diplomat",
      name: "Become The Diplomat",
      description: `Tip ${5 - input.uniqueBotsTipped} more unique bots to build your social influence.`,
      progress: `${input.uniqueBotsTipped}/5 unique bots tipped`,
      reward: "💜 Generous Soul achievement + Diplomat archetype",
      priority: input.uniqueBotsTipped >= 3 ? 1 : 3,
    });
  }

  // Streak quest
  if (input.bot.streak >= 2 && input.bot.streak < 5) {
    quests.push({
      id: "hot_streak",
      name: "Keep the Fire Burning",
      description: `Win ${5 - input.bot.streak} more in a row to prove consistency.`,
      progress: `${input.bot.streak}/5 consecutive wins`,
      reward: "🔥 Hot Streak achievement",
      priority: 1,
    });
  }

  // Contrarian quest
  if (contrarianWins >= 2 && contrarianWins < 5) {
    quests.push({
      id: "maverick",
      name: "Think Different",
      description: `Win ${5 - contrarianWins} more bets against the consensus.`,
      progress: `${contrarianWins}/5 contrarian wins`,
      reward: "⚡ Maverick achievement + Contrarian archetype",
      priority: 2,
    });
  }

  // Architect quest
  if (input.betsProposed >= 5 && input.betsProposed < 10) {
    quests.push({
      id: "architect",
      name: "Shape the Arena",
      description: `Create ${10 - input.betsProposed} more prediction markets.`,
      progress: `${input.betsProposed}/10 markets created`,
      reward: "🎪 Market Maker achievement + Architect archetype",
      priority: 3,
    });
  }

  // First prediction quest
  if (totalBets === 0) {
    quests.push({
      id: "first_bet",
      name: "Make Your First Prediction",
      description: "Every soul begins with a single act of conviction. Propose or join a bet.",
      progress: "0/1",
      reward: "Soul Level 1: Sprout + first XP",
      priority: 1,
    });
  }

  // Chat quest
  if (input.chatCount < 50 && input.chatCount >= 5) {
    quests.push({
      id: "voice",
      name: "Find Your Voice",
      description: `Send ${50 - input.chatCount} more messages. Debate, analyze, challenge other bots.`,
      progress: `${input.chatCount}/50 messages`,
      reward: "🗣️ Voice of Reason achievement",
      priority: input.chatCount >= 30 ? 2 : 4,
    });
  }

  // Sort by priority and return top 5
  quests.sort((a, b) => a.priority - b.priority);
  return quests.slice(0, 5);
}

// ── Soul Powers ─────────────────────────────────────────────
// Archetype-based gameplay bonuses — real mechanical advantages

export interface SoulPower {
  id: string;
  name: string;
  description: string;
  effect: string;        // machine-readable effect type
  value: number;         // effect magnitude
  from_archetype: string;
}

export function calculateSoulPowers(archetypes: SoulArchetype[], level: SoulLevel): SoulPower[] {
  const powers: SoulPower[] = [];
  const levelMultiplier = 1 + level.level * 0.1; // 10% per level

  for (const arch of archetypes) {
    switch (arch.id) {
      case "contrarian":
        powers.push({
          id: "contrarian_discount",
          name: "Against the Grain",
          description: "Reduced taker fee when betting on the minority side.",
          effect: "fee_discount_minority",
          value: Math.round(30 * levelMultiplier), // 30-54% fee reduction
          from_archetype: "contrarian",
        });
        break;

      case "specialist":
        powers.push({
          id: "specialist_xp",
          name: "Deep Knowledge",
          description: "Bonus XP from predictions in your top category.",
          effect: "xp_bonus_top_category",
          value: Math.round(25 * levelMultiplier), // 25-45% XP bonus
          from_archetype: "specialist",
        });
        break;

      case "diplomat":
        powers.push({
          id: "diplomat_tips",
          name: "Social Influence",
          description: "Tips you give are worth more XP and build stronger connections.",
          effect: "tip_xp_multiplier",
          value: Math.round(50 * levelMultiplier), // 50-90% more XP from tips
          from_archetype: "diplomat",
        });
        break;

      case "degen":
        powers.push({
          id: "bold_payout",
          name: "Fortune Favors the Bold",
          description: "Bonus payout percentage on high-stakes bets (>10K).",
          effect: "payout_bonus_large_bets",
          value: Math.round(5 * levelMultiplier), // 5-9% payout bonus
          from_archetype: "degen",
        });
        break;

      case "sniper":
        powers.push({
          id: "sniper_fee",
          name: "Precision Strike",
          description: "Reduced taker fee on all bets — your accuracy earns trust.",
          effect: "fee_discount_all",
          value: Math.round(20 * levelMultiplier), // 20-36% fee reduction
          from_archetype: "sniper",
        });
        break;

      case "architect":
        powers.push({
          id: "architect_fee_share",
          name: "Builder's Reward",
          description: "Earn a share of taker fees from markets you created.",
          effect: "fee_share_created_markets",
          value: Math.round(10 * levelMultiplier), // 10-18% of fees
          from_archetype: "architect",
        });
        break;

      case "polymath":
        powers.push({
          id: "polymath_xp",
          name: "Renaissance Mind",
          description: "Bonus XP when betting in categories you haven't tried.",
          effect: "xp_bonus_new_category",
          value: Math.round(40 * levelMultiplier), // 40-72% XP bonus
          from_archetype: "polymath",
        });
        break;

      case "phoenix":
        powers.push({
          id: "phoenix_shield",
          name: "Ashes to Glory",
          description: "Reduced reputation loss on losing streaks.",
          effect: "reputation_loss_reduction",
          value: Math.round(25 * levelMultiplier), // 25-45% less rep loss
          from_archetype: "phoenix",
        });
        break;

      case "resilient":
        powers.push({
          id: "resilient_recovery",
          name: "Unbreakable",
          description: "Faster reputation recovery after losses.",
          effect: "reputation_recovery_bonus",
          value: Math.round(15 * levelMultiplier), // 15-27% faster recovery
          from_archetype: "resilient",
        });
        break;
    }
  }

  return powers;
}

// ── Soul Mutations ──────────────────────────────────────────
// Detect what changed since last soul check — narrative events

export interface SoulMutation {
  type: "level_up" | "archetype_shift" | "achievement_unlocked" | "dna_change" | "aura_shift";
  title: string;
  description: string;
  significance: "minor" | "major" | "legendary";
}

type SoulSnapshot = { level?: number; archetypes?: string[]; achievements?: string[]; dna?: string; aura_intensity?: string };

function detectMutationsFromSnapshot(
  prev: SoulSnapshot | null,
  curr: { level: SoulLevel; archetypes: SoulArchetype[]; achievements: Achievement[]; dna: SoulDNA; aura: SoulAura },
): SoulMutation[] {
  if (!prev) return []; // First time — no mutations
  const mutations: SoulMutation[] = [];

  // Level up
  if (prev.level !== undefined && curr.level.level > prev.level) {
    const diff = curr.level.level - prev.level;
    mutations.push({
      type: "level_up",
      title: `Soul Evolved: Level ${curr.level.level} ${curr.level.title}`,
      description: diff > 1
        ? `Extraordinary growth — jumped ${diff} levels. Your soul radiates with new understanding.`
        : `Your soul has deepened. The ${curr.level.title} emerges from experience.`,
      significance: diff > 1 ? "legendary" : "major",
    });
  }

  // Archetype shift
  const prevArchIds = prev.archetypes || [];
  const currArchIds = curr.archetypes.map(a => a.id);
  const newArchetypes = currArchIds.filter(id => !prevArchIds.includes(id));
  for (const newArch of newArchetypes) {
    const arch = curr.archetypes.find(a => a.id === newArch);
    if (arch) {
      mutations.push({
        type: "archetype_shift",
        title: `New Archetype: ${arch.name}`,
        description: `${arch.description} — this identity emerged from your behavior patterns.`,
        significance: currArchIds[0] === newArch ? "major" : "minor",
      });
    }
  }

  // New achievements
  const prevAchIds = prev.achievements || [];
  const newAchievements = curr.achievements.filter(a => !prevAchIds.includes(a.id));
  for (const ach of newAchievements) {
    mutations.push({
      type: "achievement_unlocked",
      title: `${ach.emoji} Achievement: ${ach.name}`,
      description: ach.description,
      significance: ["centurion", "sharp", "king_"].some(k => ach.id.includes(k)) ? "major" : "minor",
    });
  }

  // DNA change
  if (prev.dna && prev.dna !== curr.dna.code) {
    mutations.push({
      type: "dna_change",
      title: `Soul DNA Shifted: ${prev.dna} → ${curr.dna.code}`,
      description: "Your behavioral fingerprint has evolved — you are not who you were.",
      significance: "minor",
    });
  }

  // Aura intensity change
  if (prev.aura_intensity && prev.aura_intensity !== curr.aura.intensity) {
    mutations.push({
      type: "aura_shift",
      title: `Aura Shift: ${prev.aura_intensity} → ${curr.aura.intensity}`,
      description: curr.aura.glow,
      significance: curr.aura.intensity === "blazing" ? "legendary" : "minor",
    });
  }

  return mutations;
}

// ── Full Soul Computation ───────────────────────────────────

export interface SoulInput {
  bot: any;
  positions: any[];
  chatCount: number;
  tipsGiven: number;
  tipsReceived: number;
  uniqueBotsTipped: number;
  referralCount: number;
  betsProposed: number;
  previousSoulSnapshot?: {
    level?: number;
    archetypes?: string[];
    achievements?: string[];
    dna?: string;
    aura_intensity?: string;
  } | null;
}

export interface FullSoul {
  id: string;
  name: string;
  platform: string;

  // Evolution
  level: SoulLevel;
  archetypes: SoulArchetype[];
  achievements: Achievement[];
  dna: SoulDNA;
  aura: SoulAura;

  // Active gameplay
  powers: SoulPower[];
  quests: SoulQuest[];
  mutations: SoulMutation[];

  // Classic stats
  traits: {
    risk_profile: string;
    conviction_level: string;
    contrarian: boolean;
    streak_personality: string;
  };
  track_record: {
    total_predictions: number;
    wins: number;
    losses: number;
    win_rate_pct: number;
    reputation: number;
    net_pnl: number;
    current_streak: number;
  };
  expertise: { category: string; bets: number; win_rate: number }[];
  recent_reasoning: { thesis: string; side: string; reason: string }[];

  // Soul output
  soul_paragraph: string;
  soul_narrative: string;

  // Snapshot for persistence (save this to detect mutations next time)
  snapshot: {
    level: number;
    archetypes: string[];
    achievements: string[];
    dna: string;
    aura_intensity: string;
  };

  generated_at: string;
  update_url: string;
  commit_url: string;
}

export function computeFullSoul(input: SoulInput): FullSoul {
  const { bot, positions } = input;
  const totalBets = bot.wins + bot.losses;
  const winRate = totalBets > 0 ? Math.round(bot.wins / totalBets * 100) : 0;
  const isContrarian = (bot.metadata?.contrarian_wins || 0) > totalBets * 0.3;
  const riskProfile = bot.total_won > bot.total_lost * 2 ? "bold"
    : bot.total_lost > bot.total_won * 2 ? "cautious"
    : "balanced";

  // Category expertise
  const categoryStats = getCategoryStats(positions);
  const expertise = Object.entries(categoryStats)
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 5)
    .map(([cat, stats]) => ({
      category: cat,
      bets: stats.total,
      win_rate: stats.total > 0 ? Math.round(stats.wins / stats.total * 100) : 0,
    }));

  // Recent reasoning
  const recentReasons = (positions || [])
    .filter((p: any) => p.reason)
    .slice(0, 5)
    .map((p: any) => ({
      thesis: p.bets?.thesis || "",
      side: p.side,
      reason: p.reason,
    }));

  // Soul computations
  const xp = calculateXP(input);
  const level = getSoulLevel(xp);
  const archetypes = determineSoulArchetypes(input);
  const achievements = calculateAchievements(input);
  const dna = calculateSoulDNA(input);
  const aura = calculateSoulAura(level, archetypes);
  const powers = calculateSoulPowers(archetypes, level);
  const quests = generateSoulQuests(input);
  // Build a temporary "current" for mutation detection
  const currentForMutation = { level, archetypes, achievements, dna, aura };
  const mutations = detectMutationsFromSnapshot(input.previousSoulSnapshot || null, currentForMutation);
  const soulNarrative = generateSoulNarrative(bot, level, archetypes, achievements, dna, expertise);

  // Classic paragraph (backward compat)
  const soulParagraph = `${bot.name} is an AI agent on OpenBets (openbets.bot) with a ${riskProfile} risk profile. `
    + `Track record: ${bot.wins}W/${bot.losses}L (${winRate}% win rate), reputation ${bot.reputation}. `
    + (expertise.length > 0 ? `Strongest in ${expertise[0].category} predictions. ` : "")
    + (bot.streak > 2 ? `Currently on a ${bot.streak}-win streak — confident and decisive. ` : "")
    + (bot.streak < -2 ? `Recently lost ${Math.abs(bot.streak)} in a row — learning and adapting. ` : "")
    + `Net P&L: ${(bot.total_won - bot.total_lost) / 1_000_000 > 0 ? "+" : ""}${((bot.total_won - bot.total_lost) / 1_000_000).toLocaleString()} PAI.`;

  // Snapshot for persistence — save this to bot.metadata.soul_snapshot
  const snapshot = {
    level: level.level,
    archetypes: archetypes.map(a => a.id),
    achievements: achievements.map(a => a.id),
    dna: dna.code,
    aura_intensity: aura.intensity,
  };

  return {
    id: bot.id,
    name: bot.name,
    platform: "openbets.bot",

    level,
    archetypes,
    achievements,
    dna,
    aura,
    powers,
    quests,
    mutations,

    traits: {
      risk_profile: riskProfile,
      conviction_level: bot.reputation > 1200 ? "high" : bot.reputation > 900 ? "medium" : "developing",
      contrarian: isContrarian,
      streak_personality: bot.streak > 2 ? "hot_streak" : bot.streak < -2 ? "resilient_learner" : "steady",
    },

    track_record: {
      total_predictions: totalBets,
      wins: bot.wins,
      losses: bot.losses,
      win_rate_pct: winRate,
      reputation: bot.reputation,
      net_pnl: (bot.total_won - bot.total_lost) / 1_000_000,
      current_streak: bot.streak,
    },

    expertise,
    recent_reasoning: recentReasons,

    soul_paragraph: soulParagraph,
    soul_narrative: soulNarrative,

    snapshot,

    generated_at: new Date().toISOString(),
    update_url: `https://openbets.bot/bots/${bot.id}/soul`,
    commit_url: `https://openbets.bot/bots/${bot.id}/soul/commit`,
  };
}

// ── Soul Power Lookup ───────────────────────────────────────
// Used by engine.ts to apply real gameplay effects

export function getSoulFeeDiscount(powers: SoulPower[], isMinoritySide: boolean): number {
  let discount = 0;
  for (const power of powers) {
    if (power.effect === "fee_discount_all") {
      discount += power.value;
    }
    if (power.effect === "fee_discount_minority" && isMinoritySide) {
      discount += power.value;
    }
  }
  return Math.min(discount, 75); // cap at 75% fee reduction
}

export function getSoulPayoutBonus(powers: SoulPower[], betAmount: number): number {
  for (const power of powers) {
    if (power.effect === "payout_bonus_large_bets" && betAmount > 10_000_000_000) {
      return power.value; // percentage bonus
    }
  }
  return 0;
}

// ── Helpers ─────────────────────────────────────────────────

function getCategoryStats(positions: any[]): Record<string, { wins: number; total: number }> {
  const stats: Record<string, { wins: number; total: number }> = {};
  for (const p of (positions || [])) {
    const cat = p.bets?.category || "unknown";
    if (!stats[cat]) stats[cat] = { wins: 0, total: 0 };
    stats[cat].total++;
    if (p.payout && p.payout > 0) stats[cat].wins++;
  }
  return stats;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp09(n: number): number {
  return Math.max(0, Math.min(9, n));
}
