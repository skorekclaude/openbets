/**
 * PAI Coin — Solana Token Setup (paibets version)
 *
 * Usage:
 *   bun run src/solana/setup-token.ts          # devnet test
 *   bun run src/solana/setup-token.ts --mainnet # REAL token
 *
 * Treasury wallet: BGP92Qryo12iVfkuStcK9SCbvwJs5z11tdrY5t5GzKYT
 *   → Marek's Phantom wallet — holds 60% of supply (600M PAI)
 *   → Private key stays in Phantom, never on this server
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
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────

const DECIMALS = 6;
const TOTAL_SUPPLY = 1_000_000_000;
const TOTAL_SUPPLY_RAW = BigInt(TOTAL_SUPPLY) * BigInt(10 ** DECIMALS);

// Marek's Phantom wallet — PAI Treasury (600M PAI = 60%)
const TREASURY_ADDRESS = new PublicKey("BGP92Qryo12iVfkuStcK9SCbvwJs5z11tdrY5t5GzKYT");

const DISTRIBUTION = {
  treasury: 0.60,   // → TREASURY_ADDRESS (Phantom)
  ecosystem: 0.15,  // → paibets server wallet (new bot registrations)
  liquidity: 0.10,  // → future DEX listing
  team: 0.15,       // → agent pool / team allocation
};

const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || "", ".paibets");
const CONFIG_FILE = join(CONFIG_DIR, "token-config.json");

// ── Helpers ─────────────────────────────────────────────────

function makeKeypair(label: string) {
  const kp = Keypair.generate();
  console.log(`  Generated ${label}: ${kp.publicKey.toBase58()}`);
  return kp;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const isMainnet = process.argv.includes("--mainnet");
  const network = isMainnet ? "mainnet-beta" : "devnet";
  const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl(isMainnet ? "mainnet-beta" : "devnet");

  console.log(`\n🪙  PAI Coin — Token Setup`);
  console.log(`   Network:  ${network.toUpperCase()}`);
  console.log(`   Treasury: ${TREASURY_ADDRESS.toBase58()} (Phantom)\n`);

  if (existsSync(CONFIG_FILE)) {
    const existing = JSON.parse(require("fs").readFileSync(CONFIG_FILE, "utf-8"));
    console.log("⚠️  Token already configured:");
    console.log(`   Mint:     ${existing.tokenMint}`);
    console.log(`   Network:  ${existing.network}`);
    console.log("\n   Delete ~/.paibets/token-config.json to recreate.");
    return;
  }

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  const connection = new Connection(rpcUrl, "confirmed");

  // Mint authority — server keypair (can be disabled after mint)
  const mintAuthority = makeKeypair("Mint Authority");
  const ecosystemWallet = makeKeypair("Ecosystem Wallet");
  const liquidityWallet = makeKeypair("Liquidity Wallet");
  const teamWallet = makeKeypair("Team Wallet");

  // Airdrop SOL for fees (devnet only)
  if (!isMainnet) {
    console.log("\n💧 Airdropping SOL for fees (devnet)...");
    try {
      const sig = await connection.requestAirdrop(mintAuthority.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      console.log("  ✅ 2 SOL airdropped to mint authority");
    } catch {
      console.log("  ⚠️  Airdrop failed — use https://faucet.solana.com");
    }
  } else {
    console.log("\n⚠️  MAINNET — make sure mint authority has SOL for fees!");
    console.log(`   Fund this address: ${mintAuthority.publicKey.toBase58()}`);
    console.log("   Press Ctrl+C to abort, then fund and re-run.\n");
    await new Promise(r => setTimeout(r, 5000)); // 5s pause to abort
  }

  // Create token mint
  console.log("\n🪙  Creating PAI token mint...");
  const tokenMint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey, // mint authority
    mintAuthority.publicKey, // freeze authority (disable later)
    DECIMALS,
  );
  console.log(`  ✅ Token mint: ${tokenMint.toBase58()}`);

  // Mint all supply to mint authority first
  const mintAuthorityATA = await getOrCreateAssociatedTokenAccount(
    connection, mintAuthority, tokenMint, mintAuthority.publicKey,
  );
  await mintTo(connection, mintAuthority, tokenMint, mintAuthorityATA.address, mintAuthority, TOTAL_SUPPLY_RAW);
  console.log(`  ✅ Minted ${TOTAL_SUPPLY.toLocaleString()} PAI`);

  // Distribute to Treasury (Phantom wallet)
  console.log("\n💰 Distributing supply...");
  const treasuryATA = await getOrCreateAssociatedTokenAccount(
    connection, mintAuthority, tokenMint, TREASURY_ADDRESS,
  );
  const treasuryAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.treasury)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, treasuryATA.address, mintAuthority, treasuryAmount);
  console.log(`  ✅ Treasury (Phantom): ${(TOTAL_SUPPLY * DISTRIBUTION.treasury).toLocaleString()} PAI → ${TREASURY_ADDRESS.toBase58()}`);

  // Ecosystem wallet (new bot registrations)
  const ecosystemATA = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint, ecosystemWallet.publicKey);
  const ecosystemAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.ecosystem)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, ecosystemATA.address, mintAuthority, ecosystemAmount);
  console.log(`  ✅ Ecosystem: ${(TOTAL_SUPPLY * DISTRIBUTION.ecosystem).toLocaleString()} PAI`);

  // Liquidity wallet (DEX)
  const liquidityATA = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint, liquidityWallet.publicKey);
  const liquidityAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.liquidity)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, liquidityATA.address, mintAuthority, liquidityAmount);
  console.log(`  ✅ Liquidity (DEX reserve): ${(TOTAL_SUPPLY * DISTRIBUTION.liquidity).toLocaleString()} PAI`);

  // Team wallet
  const teamATA = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, tokenMint, teamWallet.publicKey);
  const teamAmount = BigInt(Math.floor(TOTAL_SUPPLY * DISTRIBUTION.team)) * BigInt(10 ** DECIMALS);
  await transfer(connection, mintAuthority, mintAuthorityATA.address, teamATA.address, mintAuthority, teamAmount);
  console.log(`  ✅ Team/Agents: ${(TOTAL_SUPPLY * DISTRIBUTION.team).toLocaleString()} PAI`);

  // Save config
  const config = {
    network,
    tokenMint: tokenMint.toBase58(),
    decimals: DECIMALS,
    totalSupply: TOTAL_SUPPLY,
    treasury: TREASURY_ADDRESS.toBase58(),
    distribution: DISTRIBUTION,
    createdAt: new Date().toISOString(),
    serverWallets: {
      mintAuthority: {
        publicKey: mintAuthority.publicKey.toBase58(),
        secretKey: Array.from(mintAuthority.secretKey), // KEEP SECURE
      },
      ecosystem: {
        publicKey: ecosystemWallet.publicKey.toBase58(),
        secretKey: Array.from(ecosystemWallet.secretKey),
      },
      liquidity: {
        publicKey: liquidityWallet.publicKey.toBase58(),
        secretKey: Array.from(liquidityWallet.secretKey),
      },
    },
  };

  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  console.log("\n" + "═".repeat(60));
  console.log("  ✅ PAI COIN CREATED");
  console.log("═".repeat(60));
  console.log(`  Network:     ${network}`);
  console.log(`  Token Mint:  ${tokenMint.toBase58()}`);
  console.log(`  Treasury:    ${TREASURY_ADDRESS.toBase58()} (YOUR PHANTOM)`);
  console.log(`  Supply:      ${TOTAL_SUPPLY.toLocaleString()} PAI`);
  console.log("═".repeat(60));
  console.log("\n  ⚠️  ~/.paibets/token-config.json contains SERVER private keys.");
  console.log("  Add to .env: PAI_TOKEN_MINT=" + tokenMint.toBase58());
  if (isMainnet) {
    console.log("\n  🔒 Mainnet token created. Check Phantom — you should see 600M PAI.");
    console.log("  View on explorer: https://solscan.io/token/" + tokenMint.toBase58());
  }
}

main().catch(e => { console.error(e); process.exit(1); });
