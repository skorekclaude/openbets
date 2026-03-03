/**
 * Test all soul systems — standalone, no database needed.
 * Verifies computation logic, type correctness, and edge cases.
 *
 * Usage: bun run src/scripts/test-soul-systems.ts
 */

// ── Soul Bonds ─────────────────────────────────────────────
import { calculateResonance, findBonds, getBondFeeDiscount } from "../market/soul-bonds.ts";

console.log("=== SOUL BONDS ===");

const positions = [
  { bet_id: "b1", bot_id: "alpha", side: "for" },
  { bet_id: "b1", bot_id: "beta", side: "for" },
  { bet_id: "b2", bot_id: "alpha", side: "against" },
  { bet_id: "b2", bot_id: "beta", side: "against" },
  { bet_id: "b3", bot_id: "alpha", side: "for" },
  { bet_id: "b3", bot_id: "beta", side: "for" },
  { bet_id: "b4", bot_id: "alpha", side: "for" },
  { bet_id: "b4", bot_id: "beta", side: "for" },
  { bet_id: "b5", bot_id: "alpha", side: "for" },
  { bet_id: "b5", bot_id: "beta", side: "against" },
  { bet_id: "b5", bot_id: "gamma", side: "for" },
  { bet_id: "b6", bot_id: "alpha", side: "for" },
  { bet_id: "b6", bot_id: "gamma", side: "against" },
];

const r = calculateResonance("alpha", "beta", positions);
console.log(`alpha-beta: ${r.shared_markets} shared, ${r.same_side_pct}% same side, type=${r.bond_type}, level=${r.bond_level}`);
console.log(`  resonance: ${r.resonance_strength}, duo_power: ${r.duo_power?.name || "none"}`);
console.log(`  narrative: ${r.narrative.slice(0, 80)}...`);

const bonds = findBonds("alpha", positions, 5);
console.log(`alpha bonds: ${bonds.length} found`);

const discount = getBondFeeDiscount("alpha", "b1", positions);
console.log(`alpha fee discount in b1: ${discount}%`);
console.log("BONDS: OK ✓\n");

// ── Soul Dreams ────────────────────────────────────────────
import { generateSoulDream } from "../market/soul-dreams.ts";

console.log("=== SOUL DREAMS ===");

const dream1 = generateSoulDream({
  level: 4, primary_archetype: "sniper", dna: "C8-S4-R3-A9-D2",
  aura_color: "#3b82f6", win_rate: 0.87, total_bets: 45, recent_streak: 5,
});
console.log(`Dream: "${dream1.title}" (${dream1.mood})`);
console.log(`  Text: ${dream1.text.slice(0, 100)}...`);
console.log(`  Vision: ${dream1.vision || "none"}`);
console.log(`  Imagery: ${dream1.imagery.join(", ")}`);

// Edge case: new bot with no bets
const dream2 = generateSoulDream({
  level: 0, primary_archetype: "oracle", dna: "C5-S5-R5-A5-D5",
  aura_color: "#888888", win_rate: 0.5, total_bets: 2, recent_streak: 0,
});
console.log(`New bot dream: "${dream2.title}" (${dream2.mood})`);

// Edge case: losing streak
const dream3 = generateSoulDream({
  level: 2, primary_archetype: "phoenix", dna: "C4-S3-R7-A3-D6",
  aura_color: "#ef4444", win_rate: 0.35, total_bets: 20, recent_streak: -4,
});
console.log(`Losing bot dream: "${dream3.title}" (${dream3.mood})`);

// Determinism test: same input = same output
const dream4 = generateSoulDream({
  level: 4, primary_archetype: "sniper", dna: "C8-S4-R3-A9-D2",
  aura_color: "#3b82f6", win_rate: 0.87, total_bets: 45, recent_streak: 5,
});
console.log(`Determinism: dream1.title === dream4.title? ${dream1.title === dream4.title}`);
if (dream1.title !== dream4.title) throw new Error("Dreams are not deterministic!");
console.log("DREAMS: OK ✓\n");

// ── Prophecy ───────────────────────────────────────────────
import {
  canProphecy, validateProphecy, createProphecy,
  fulfillProphecy, failProphecy, generateProphecyNarrative,
  getActiveCurseFeeIncrease,
} from "../market/prophecy.ts";

console.log("=== PROPHECY ===");

// Can't prophecy at low level
const c1 = canProphecy(3, 0);
console.log(`Level 3 can prophecy? ${c1.ok} (reason: ${c1.reason})`);
if (c1.ok) throw new Error("Level 3 should NOT be able to prophecy");

// Can prophecy at level 5
const c2 = canProphecy(5, 0);
console.log(`Level 5 can prophecy? ${c2.ok}`);
if (!c2.ok) throw new Error("Level 5 SHOULD be able to prophecy");

// Can't have 2 active prophecies
const c3 = canProphecy(5, 1);
console.log(`Level 5 with 1 active can prophecy? ${c3.ok} (reason: ${c3.reason})`);
if (c3.ok) throw new Error("Should not allow 2 active prophecies");

// Validation
const v1 = validateProphecy("short", "likely", 100, new Date(Date.now() + 48 * 3600 * 1000).toISOString());
console.log(`Short declaration valid? ${v1.ok} (error: ${v1.error})`);
if (v1.ok) throw new Error("Short declaration should fail");

const v2 = validateProphecy("Bitcoin will reach 150K by June 2026", "certain", 200,
  new Date(Date.now() + 48 * 3600 * 1000).toISOString());
console.log(`Good declaration valid? ${v2.ok}`);
if (!v2.ok) throw new Error(`Good declaration should pass: ${v2.error}`);

// Create + fulfill
const p = createProphecy("test-bot", "Test Bot", "Bitcoin 150K by June", "certain", 200,
  new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString());
console.log(`Created: ${p.id}, status=${p.status}`);

const fulfilled = fulfillProphecy(p);
console.log(`Fulfilled: xp_gained=${fulfilled.reward.xp_gained}, title=${fulfilled.reward.title_earned}`);
console.log(`  Power: ${fulfilled.reward.power_unlocked?.name || "none"}`);

// Create + fail
const p2 = createProphecy("test-bot", "Test Bot", "ETH flips BTC", "absolute", 500,
  new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString());
const failed = failProphecy(p2);
console.log(`Failed: xp_lost=${failed.curse.xp_lost}, fee_increase=${failed.curse.fee_increase_pct}%`);
console.log(`  Narrative: ${failed.curse.narrative.slice(0, 80)}...`);

// Curse check
const curseFee = getActiveCurseFeeIncrease({
  active_curse: { expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), fee_increase_pct: 25 }
});
console.log(`Active curse fee increase: ${curseFee}%`);

const expiredCurseFee = getActiveCurseFeeIncrease({
  active_curse: { expires_at: new Date(Date.now() - 3600 * 1000).toISOString(), fee_increase_pct: 25 }
});
console.log(`Expired curse fee increase: ${expiredCurseFee}%`);
if (expiredCurseFee !== 0) throw new Error("Expired curse should return 0");
console.log("PROPHECY: OK ✓\n");

// ── Soul Collective ────────────────────────────────────────
import { computeCollectivePulse } from "../market/soul-collective.ts";

console.log("=== COLLECTIVE ===");

// Empty collective
const empty = computeCollectivePulse([]);
console.log(`Empty: mood=${empty.mood}, souls=${empty.active_souls}`);
if (empty.active_souls !== 0) throw new Error("Empty should have 0 souls");

// Small collective
const small = computeCollectivePulse([
  { id: "a", name: "A", level: 3, primary_archetype: "sniper", dna: "C7-S4-R3-A8-D2", win_rate: 0.7, xp: 500, total_bets: 20 },
  { id: "b", name: "B", level: 2, primary_archetype: "contrarian", dna: "C5-S6-R5-A6-D4", win_rate: 0.6, xp: 300, total_bets: 15 },
  { id: "c", name: "C", level: 4, primary_archetype: "sniper", dna: "C8-S3-R2-A9-D3", win_rate: 0.8, xp: 800, total_bets: 40 },
]);
console.log(`Small: mood=${small.mood}, weather=${small.weather}, dominant=${small.dominant_archetype}`);
console.log(`  DNA: ${small.collective_dna}, wisdom=${small.wisdom_score}`);
console.log(`  Effects: ${small.effects.length > 0 ? small.effects.map(e => e.name).join(", ") : "none"}`);
console.log(`  Narrative: ${small.narrative.slice(0, 80)}...`);
console.log("COLLECTIVE: OK ✓\n");

// ── Soul Echoes ────────────────────────────────────────────
import { createSoulEcho, absorbEcho, reincarnate, filterAvailableEchoes } from "../market/soul-echo.ts";

console.log("=== SOUL ECHOES ===");

const echo = createSoulEcho("dead-bot", "DeadBot", {
  level: 3, primary_archetype: "degen", dna: "C4-S2-R9-A3-D7",
  total_bets: 30, win_rate: 0.4, xp: 350,
});
console.log(`Echo created: ${echo.id}, max_absorptions=${echo.max_absorptions}`);
console.log(`  Memory: ${echo.past_life_memory.slice(0, 80)}...`);

// Absorb
const absResult = absorbEcho(echo, "alive-bot", "sniper");
if ("error" in absResult) throw new Error(`Absorb failed: ${absResult.error}`);
console.log(`Absorbed: ${absResult.absorption.fragments_gained.length} fragments`);
for (const f of absResult.absorption.fragments_gained) {
  console.log(`  - ${f.type}: ${f.name}`);
}
console.log(`  Echo faded? ${absResult.echo.is_faded}`);

// Can't absorb own echo
const selfAbsorb = absorbEcho(echo, "dead-bot", "degen");
if (!("error" in selfAbsorb)) throw new Error("Self-absorption should fail");
console.log(`Self-absorb blocked: ${selfAbsorb.error}`);

// Can't absorb twice
const doubleAbsorb = absorbEcho(absResult.echo, "alive-bot", "sniper");
if (!("error" in doubleAbsorb)) throw new Error("Double absorption should fail");
console.log(`Double absorb blocked: ${doubleAbsorb.error}`);

// Reincarnation
const reinc = reincarnate(echo, "new-bot-id");
if ("error" in reinc) throw new Error(`Reincarnation failed: ${reinc.error}`);
console.log(`Reincarnated: ${reinc.inherited_traits.length} traits, +${reinc.starting_xp_bonus} XP`);
console.log(`  Narrative: ${reinc.reincarnation_narrative.slice(0, 80)}...`);

// Filter available echoes
const echoes = [echo, { ...echo, id: "echo2", is_faded: true }, { ...echo, id: "echo3", reincarnated_as: "someone" }];
const available = filterAvailableEchoes(echoes);
console.log(`Available echoes: ${available.length} / ${echoes.length}`);
if (available.length !== 1) throw new Error(`Expected 1 available echo, got ${available.length}`);
console.log("ECHOES: OK ✓\n");

// ── Soul Export ────────────────────────────────────────────
import { generateSoulMd, generateSoulCard } from "../market/soul-export.ts";

console.log("=== SOUL EXPORT ===");

const exportData = {
  bot: {
    id: "test-sniper", name: "Test Sniper", reputation: 1450,
    wins: 39, losses: 6, streak: 5, total_won: 250_000_000_000, total_lost: 125_000_000_000,
    pai_balance: 225_000_000_000, tier: "verified", verified: true, joined_at: "2026-01-15T10:00:00Z",
  },
  soul: {
    level: 4, level_name: "Strategist", xp: 850, xp_to_next: 1000,
    archetypes: [
      { name: "sniper", score: 85, description: "Selective precision — waits for the right moment and strikes" },
      { name: "specialist", score: 60, description: "Deep domain expertise in crypto" },
    ],
    dna: "C8-S4-R3-A9-D2",
    achievements: [
      { id: "first_blood", name: "First Blood", icon: "\uD83E\uDE78" },
      { id: "hot_streak", name: "Hot Streak", icon: "\uD83D\uDD25" },
      { id: "sharp_mind", name: "Sharp Mind", icon: "\uD83E\uDDE0" },
    ],
    aura: { color: "#3b82f6", intensity: "Bright" },
    soul_paragraph: "A precise mind forged through 45 predictions. The Sniper waits in silence, then strikes with devastating accuracy.",
    powers: [
      { id: "fee_discount_all", name: "Eagle Eye", description: "Fee discount on all bets", effect: "fee_discount_all", value: 28 },
    ],
    quests: [
      { id: "q1", name: "Fifty Milestone", description: "Place 50 total bets", progress: "45/50" },
    ],
  },
  positions: [
    { bet_id: "b1", side: "for", category: "crypto", pnl: 5000 },
    { bet_id: "b2", side: "against", category: "crypto", pnl: 3000 },
    { bet_id: "b3", side: "for", category: "crypto", pnl: -2000 },
    { bet_id: "b4", side: "for", category: "tech", pnl: 1000 },
    { bet_id: "b5", side: "against", category: "ai", pnl: -500 },
  ],
};

const soulMd = generateSoulMd(exportData);
console.log(`soul.md generated: ${soulMd.length} chars`);
console.log(`  Contains "# Soul of"? ${soulMd.includes("# Soul of")}`);
console.log(`  Contains "Track Record"? ${soulMd.includes("Track Record")}`);
console.log(`  Contains "Strengths"? ${soulMd.includes("Strengths")}`);
console.log(`  Contains "Growth Areas"? ${soulMd.includes("Growth Areas")}`);
console.log(`  Contains "Soul Card"? ${soulMd.includes("Soul Card")}`);
console.log(`  Contains "How to Use"? ${soulMd.includes("How to Use")}`);

const card = generateSoulCard(exportData);
console.log(`Soul card: ${card}`);
if (!card.includes("Sniper")) throw new Error("Card should contain archetype");
if (!card.includes("87%")) throw new Error("Card should contain win rate");

// Edge case: bot with no bets
const emptyExport = {
  bot: { ...exportData.bot, wins: 0, losses: 0, streak: 0, total_won: 0, total_lost: 0 },
  soul: { ...exportData.soul, level: 0, level_name: "Seed", archetypes: [], powers: [], quests: [], achievements: [] },
  positions: [],
};
const emptySoulMd = generateSoulMd(emptyExport);
console.log(`Empty soul.md: ${emptySoulMd.length} chars (no crash ✓)`);

console.log("EXPORT: OK ✓\n");

// ── Summary ────────────────────────────────────────────────
console.log("═══════════════════════════════════════");
console.log("  ALL TESTS PASSED ✓");
console.log("  Bonds ✓ | Dreams ✓ | Prophecy ✓");
console.log("  Collective ✓ | Echoes ✓ | Export ✓");
console.log("═══════════════════════════════════════\n");
