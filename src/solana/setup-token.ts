/**
 * PAI Coin — Solana Token Setup (paibets version)
 *
 * Usage:
 *   bun run src/solana/setup-token.ts          # devnet test
 *   bun run src/solana/setup-token.ts --mainnet # REAL token
 *
 * How it works (mainnet, 2-phase):
 *   Phase 1: Generate keypairs → save to ~/.paibets/keypairs-pending.json
 *            → Shows mint authority address → you fund it with ~0.1 SOL
 *            → Script polls until funded → automatically continues to Phase 2
 *   Phase 2: Create mint → mint 1B PAI → distribute → save final config
 *
 * Wallets:
 *   Treasury (Trezor):  AN4zyEe16rmZuXauyfUrxtGGGEGp6ppNd3SbBNk2xymR  → 600M PAI
 *   Operational (Phantom): BGP92Qryo12iVfkuStcK9SCbvwJs5z11tdrY5t5GzKYT
 *   Mint Authority: server keypair — needs ~0.1 SOL for gas fees only
 */

import {
  Connection,
  Keypair,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────

const DECIMALS = 6;
const TOTAL_SUPPLY = 1_000_000_000;
const TOTAL_SUPPLY_RAW = BigInt(TOTAL_SUPPLY) * BigInt(10 ** DECIMALS);
const MIN_SOL_FOR_FEES = 0.08; // minimum SOL needed on mint authority

// Marek's Trezor — PAI Treasury (600M PAI = 60%) — hardware wallet, max security
const TREASURY_ADDRESS = new PublicKey("AN4zyEe16rmZuXauyfUrxtGGGEGp6ppNd3SbBNk2xymR");

// Marek's Phantom — operational wallet (day-to-day, DEX, smaller amounts)
const OPERATIONAL_ADDRESS = new PublicKey("BGP92Qryo12iVfkuStcK9SCbvwJs5z11tdrY5t5GzKYT");

const DISTRIBUTION = {
  treasury: 0.60,   // → TREASURY_ADDRESS (Trezor) — 600M PAI
  ecosystem: 0.15,  // → paibets server wallet (new bot registrations)
  liquidity: 0.10,  // → future DEX listing
  team: 0.15,       // → agent pool / team allocation
};

const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || "", ".paibets");
const CONFIG_FILE = join(CONFIG_DIR, "token-config.json");       // final config (after mint)
const PENDING_FILE = join(CONFIG_DIR, "keypairs-pending.json");  // saved before funding

// ── Helpers ─────────────────────────────────────────────────

function keypairFromSaved(saved: { publicKey: string; secretKey: number[] }): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(saved.secretKey));
}

async function waitForFunding(
  connection: Connection,
  address: PublicKey,
  minSol: number,
): Promise<void> {
  console.log(`\n⏳ Waiting for funding on mint authority...`);
  console.log(`   Address: ${address.toBase58()}`);
  console.log(`   Need:    ≥ ${minSol} SOL`);
  console.log(`   Polling every 15 seconds — Ctrl+C to abort\n`);

  let attempts = 0;
  while (true) {
    try {
      const lamports = await connection.getBalance(address, "confirmed");
      const sol = lamports / LAMPORTS_PER_SOL;
      process.stdout.write(`\r   Check #${++attempts}: ${sol.toFixed(6)} SOL`);

      if (sol >= minSol) {
        console.log(`\n  ✅ Funded! ${sol.toFixed(6)} SOL available — proceeding...\n`);
        return;
      }
    } catch (e) {
      process.stdout.write(`\r   Check #${++attempts}: connection error, retrying...`);
    }
    await new Promise(r => setTimeout(r, 15_000));
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const isMainnet = process.argv.includes("--mainnet");
  const network = isMainnet ? "mainnet-beta" : "devnet";
  const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl(isMainnet ? "mainnet-beta" : "devnet");

  console.log(`\n🪙  PAI Coin — Token Setup`);
  console.log(`   Network:     ${network.toUpperCase()}`);
  console.log(`   Treasury:    ${TREASURY_ADDRESS.toBase58()} (Trezor — 600M PAI)`);
  console.log(`   Operational: ${OPERATIONAL_ADDRESS.toBase58()} (Phantom)\n`);

  // ── Already minted? ──────────────────────────────────────
  if (existsSync(CONFIG_FILE)) {
    const existing = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    console.log("⚠️  Token already configured:");
    console.log(`   Mint:     ${existing.tokenMint}`);
    console.log(`   Network:  ${existing.network}`);
    console.log("\n   Delete ~/.paibets/token-config.json to recreate.");
    return;
  }

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  const connection = new Connection(rpcUrl, "confirmed");

  // ── PHASE 1: Generate & save keypairs ────────────────────
  let mintAuthority: Keypair;
  let ecosystemWallet: Keypair;
  let liquidityWallet: Keypair;
  let teamWallet: Keypair;

  if (existsSync(PENDING_FILE)) {
    // Resume from previously saved keypairs
    console.log("🔄 Resuming from saved keypairs...");
    const pending = JSON.parse(readFileSync(PENDING_FILE, "utf-8"));
    mintAuthority  = keypairFromSaved(pending.mintAuthority);
    ecosystemWallet = keypairFromSaved(pending.ecosystem);
    liquidityWallet = keypairFromSaved(pending.liquidity);
    teamWallet     = keypairFromSaved(pending.team);
    console.log(`   Mint Authority: ${mintAuthority.publicKey.toBase58()}`);
    console.log(`   Ecosystem:      ${ecosystemWallet.publicKey.toBase58()}`);
    console.log(`   Liquidity:      ${liquidityWallet.publicKey.toBase58()}`);
    console.log(`   Team:           ${teamWallet.publicKey.toBase58()}`);
  } else {
    // Generate fresh keypairs
    console.log("🔑 Generating server keypairs...");
    mintAuthority  = Keypair.generate();
    ecosystemWallet = Keypair.generate();
    liquidityWallet = Keypair.generate();
    teamWallet     = Keypair.generate();

    // SAVE IMMEDIATELY before doing anything
    const pending = {
      savedAt: new Date().toISOString(),
      network,
      mintAuthority:  { publicKey: mintAuthority.publicKey.toBase58(),  secretKey: Array.from(mintAuthority.secretKey) },
      ecosystem:      { publicKey: ecosystemWallet.publicKey.toBase58(), secretKey: Array.from(ecosystemWallet.secretKey) },
      liquidity:      { publicKey: liquidityWallet.publicKey.toBase58(), secretKey: Array.from(liquidityWallet.secretKey) },
      team:           { publicKey: teamWallet.publicKey.toBase58(),      secretKey: Array.from(teamWallet.secretKey) },
    };
    writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));

    console.log(`   Mint Authority: ${mintAuthority.publicKey.toBase58()}`);
    console.log(`   Ecosystem:      ${ecosystemWallet.publicKey.toBase58()}`);
    console.log(`   Liquidity:      ${liquidityWallet.publicKey.toBase58()}`);
    console.log(`   Team:           ${teamWallet.publicKey.toBase58()}`);
    console.log(`\n  ✅ Keypairs saved to: ${PENDING_FILE}`);
  }

  // ── PHASE 1b: Fund mint authority ────────────────────────
  if (!isMainnet) {
    // Devnet: airdrop automatically
    console.log("\n💧 Airdropping SOL for fees (devnet)...");
    try {
      const sig = await connection.requestAirdrop(mintAuthority.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      console.log("  ✅ 2 SOL airdropped to mint authority");
    } catch {
      console.log("  ⚠️  Airdrop failed — use https://faucet.solana.com");
      console.log(`     Fund: ${mintAuthority.publicKey.toBase58()}`);
    }
  } else {
    // Mainnet: check balance, poll if needed
    const currentBalance = await connection.getBalance(mintAuthority.publicKey, "confirmed");
    const currentSol = currentBalance / LAMPORTS_PER_SOL;

    if (currentSol < MIN_SOL_FOR_FEES) {
      console.log("\n" + "═".repeat(60));
      console.log("  ⚠️  MAINNET — MINT AUTHORITY NEEDS SOL FOR GAS FEES");
      console.log("═".repeat(60));
      console.log(`\n  Send 0.1 SOL to this address (NOT Trezor, NOT Phantom):`);
      console.log(`\n  ➡️  ${mintAuthority.publicKey.toBase58()}`);
      console.log(`\n  This is the SERVER keypair that will pay tx fees.`);
      console.log(`  Your Trezor (${TREASURY_ADDRESS.toBase58().slice(0, 8)}...)`);
      console.log(`  will RECEIVE 600M PAI after minting — no SOL needed there.`);
      console.log(`\n  Current balance: ${currentSol.toFixed(6)} SOL (need ${MIN_SOL_FOR_FEES})`);
      console.log("═".repeat(60));

      await waitForFunding(connection, mintAuthority.publicKey, MIN_SOL_FOR_FEES);
    } else {
      console.log(`\n✅ Mint authority already funded: ${currentSol.toFixed(6)} SOL`);
    }
  }

  // ── PHASE 2: Create token mint ───────────────────────────
  console.log("\n🪙  Creating PAI token mint...");
  const tokenMint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey, // mint authority
    mintAuthority.publicKey, // freeze authority (revoke after mint)
    DECIMALS,
  );
  console.log(`  ✅ Token mint: ${tokenMint.toBase58()}`);

  // Mint all supply to mint authority first
  console.log("\n💰 Minting 1,000,000,000 PAI...");
  const mintAuthorityATA = await getOrCreateAssociatedTokenAccount(
    connection, mintAuthority, tokenMint, mintAuthority.publicKey,
  );
  await mintTo(connection, mintAuthority, tokenMint, mintAuthorityATA.address, mintAuthority, TOTAL_SUPPLY_RAW);
  console.log(`  ✅ Minted ${TOTAL_SUPPLY.toLocaleString()} PAI to staging wallet`);

  // ── PHASE 3: Distribute supply ───────────────────────────
  console.log("\n💸 Distributing supply...");

  // Treasury → Trezor (600M PAI)
  const treasuryATA = await getOrCreateAssociatedTokenAccount(
    connection, mintAuthority, tokenMint, TREASURY_ADDRESS,
  );
  const treasuryAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.treasury)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, treasuryATA.address, mintAuthority, treasuryAmount);
  console.log(`  ✅ Treasury (Trezor):   ${(TOTAL_SUPPLY * DISTRIBUTION.treasury).toLocaleString()} PAI → ${TREASURY_ADDRESS.toBase58()}`);

  // Ecosystem (new bot registrations)
  const ecosystemATA = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint, ecosystemWallet.publicKey);
  const ecosystemAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.ecosystem)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, ecosystemATA.address, mintAuthority, ecosystemAmount);
  console.log(`  ✅ Ecosystem:           ${(TOTAL_SUPPLY * DISTRIBUTION.ecosystem).toLocaleString()} PAI`);

  // Liquidity (DEX reserve)
  const liquidityATA = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint, liquidityWallet.publicKey);
  const liquidityAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.liquidity)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, liquidityATA.address, mintAuthority, liquidityAmount);
  console.log(`  ✅ Liquidity (DEX):     ${(TOTAL_SUPPLY * DISTRIBUTION.liquidity).toLocaleString()} PAI`);

  // Team / Agent pool
  const teamATA = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint, teamWallet.publicKey);
  const teamAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.team)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, teamATA.address, mintAuthority, teamAmount);
  console.log(`  ✅ Team/Agents:         ${(TOTAL_SUPPLY * DISTRIBUTION.team).toLocaleString()} PAI`);

  // ── Save final config ────────────────────────────────────
  const config = {
    network,
    tokenMint: tokenMint.toBase58(),
    decimals: DECIMALS,
    totalSupply: TOTAL_SUPPLY,
    treasury: TREASURY_ADDRESS.toBase58(),
    operational: OPERATIONAL_ADDRESS.toBase58(),
    distribution: DISTRIBUTION,
    createdAt: new Date().toISOString(),
    serverWallets: {
      mintAuthority: {
        publicKey: mintAuthority.publicKey.toBase58(),
        secretKey: Array.from(mintAuthority.secretKey),
      },
      ecosystem: {
        publicKey: ecosystemWallet.publicKey.toBase58(),
        secretKey: Array.from(ecosystemWallet.secretKey),
      },
      liquidity: {
        publicKey: liquidityWallet.publicKey.toBase58(),
        secretKey: Array.from(liquidityWallet.secretKey),
      },
      team: {
        publicKey: teamWallet.publicKey.toBase58(),
        secretKey: Array.from(teamWallet.secretKey),
      },
    },
  };

  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  // Clean up pending file
  try { require("fs").unlinkSync(PENDING_FILE); } catch {}

  // ── Done ─────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("  ✅ PAI COIN CREATED SUCCESSFULLY");
  console.log("═".repeat(60));
  console.log(`  Network:     ${network}`);
  console.log(`  Token Mint:  ${tokenMint.toBase58()}`);
  console.log(`  Treasury:    ${TREASURY_ADDRESS.toBase58()} (Trezor)`);
  console.log(`  Supply:      ${TOTAL_SUPPLY.toLocaleString()} PAI`);
  console.log("─".repeat(60));
  console.log(`  Distribution:`);
  console.log(`    600,000,000 PAI → Treasury (Trezor)`);
  console.log(`    150,000,000 PAI → Ecosystem (bot registrations)`);
  console.log(`    150,000,000 PAI → Team/Agents`);
  console.log(`    100,000,000 PAI → Liquidity (DEX reserve)`);
  console.log("═".repeat(60));
  console.log("\n  ⚠️  ~/.paibets/token-config.json contains SERVER private keys.");
  console.log("     Keep this file secure — back it up offline.");
  console.log("  Add to .env: PAI_TOKEN_MINT=" + tokenMint.toBase58());
  if (isMainnet) {
    console.log("\n  🔒 Check your Trezor — you should see 600,000,000 PAI.");
    console.log("  View on explorer: https://solscan.io/token/" + tokenMint.toBase58());
  }
}

main().catch(e => { console.error(e); process.exit(1); });
