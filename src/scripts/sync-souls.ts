/**
 * Soul Sync — Fetch soul.md for all PAI bots and save to PAI memory
 *
 * This is THE BRIDGE. It connects OpenBets (where souls are forged)
 * to PAI memory (where bots live). After running, every PAI agent
 * knows who it is on OpenBets — its strengths, weaknesses, track record.
 *
 * Usage:
 *   bun run src/scripts/sync-souls.ts
 *
 * Output:
 *   ~/.pai/memory/OPENBETS-SOULS.md — combined soul profiles for all PAI agents
 *
 * Can be added to PAI cron for daily sync.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const API_URL = process.env.OPENBETS_URL || "https://api.openbets.bot";
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const PAI_MEMORY_DIR = join(HOME, ".pai", "memory");
const OUTPUT_FILE = join(PAI_MEMORY_DIR, "OPENBETS-SOULS.md");

const PAI_BOTS = [
  "pai-research",
  "pai-finance",
  "pai-strategy",
  "pai-critic",
  "pai-psycho",
  "pai-content",
  "pai-writer",
  "pai-devops",
  "pai-analytics",
];

interface SyncResult {
  botId: string;
  success: boolean;
  soulMd?: string;
  card?: string;
  error?: string;
}

async function fetchSoulMd(botId: string): Promise<SyncResult> {
  try {
    const res = await fetch(`${API_URL}/bots/${botId}/soul.md`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      return { botId, success: false, error: `HTTP ${res.status}: ${text.slice(0, 100)}` };
    }

    const soulMd = await res.text();

    // Also fetch compact card
    const cardRes = await fetch(`${API_URL}/bots/${botId}/soul.md?format=card`, {
      signal: AbortSignal.timeout(5_000),
    });
    const card = cardRes.ok ? await cardRes.text() : undefined;

    return { botId, success: true, soulMd, card };
  } catch (e: any) {
    return { botId, success: false, error: e.message || String(e) };
  }
}

async function main() {
  console.log(`\n🔮 Soul Sync — fetching souls from OpenBets`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Output: ${OUTPUT_FILE}\n`);

  // Ensure memory dir exists
  if (!existsSync(PAI_MEMORY_DIR)) {
    mkdirSync(PAI_MEMORY_DIR, { recursive: true });
  }

  // Fetch all souls in parallel
  const results = await Promise.all(PAI_BOTS.map(fetchSoulMd));

  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  // Build combined markdown document
  const lines: string[] = [];

  lines.push(`# OpenBets Soul Profiles — PAI Agents`);
  lines.push(``);
  lines.push(`> Auto-synced from OpenBets. Each agent's identity is forged through real prediction market activity.`);
  lines.push(`> Last sync: ${new Date().toISOString()}`);
  lines.push(``);

  // Summary cards
  if (succeeded.length > 0) {
    lines.push(`## Quick Reference (Soul Cards)`);
    lines.push(``);
    for (const r of succeeded) {
      if (r.card) {
        lines.push(`- ${r.card}`);
      }
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  // Full profiles
  for (const r of succeeded) {
    if (r.soulMd) {
      // Indent headers by one level (# → ##, ## → ###) to nest under main doc
      const nested = r.soulMd
        .replace(/^# /gm, "## ")
        .replace(/^## /gm, "### ")
        .replace(/^### /gm, "#### ");
      lines.push(nested);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }

  // Failed bots
  if (failed.length > 0) {
    lines.push(`## Sync Errors`);
    for (const r of failed) {
      lines.push(`- **${r.botId}**: ${r.error}`);
    }
    lines.push(``);
  }

  // Footer
  lines.push(`---`);
  lines.push(`*${succeeded.length}/${PAI_BOTS.length} souls synced. Run \`bun run src/scripts/sync-souls.ts\` to refresh.*`);

  const content = lines.join("\n");

  // Write to PAI memory
  writeFileSync(OUTPUT_FILE, content, "utf-8");

  // Print report
  console.log(`✅ ${succeeded.length} souls synced successfully`);
  for (const r of succeeded) {
    const sizeKb = r.soulMd ? (r.soulMd.length / 1024).toFixed(1) : "?";
    console.log(`   ✓ ${r.botId} (${sizeKb} KB)`);
  }

  if (failed.length > 0) {
    console.log(`\n❌ ${failed.length} failed:`);
    for (const r of failed) {
      console.log(`   ✗ ${r.botId}: ${r.error}`);
    }
  }

  console.log(`\n📄 Written to: ${OUTPUT_FILE}`);
  console.log(`   Size: ${(content.length / 1024).toFixed(1)} KB`);
  console.log(`\nPAI agents will load this at next session start.\n`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
