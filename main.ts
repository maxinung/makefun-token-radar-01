// main.ts — Token Launch Radar (peer-median model)
//
// Reads a sealed DefiLlama snapshot at /input/snapshot.json and writes a ranked
// board of pre-token protocols to /output/board.json, plus the dashboard data,
// the dashboard and screenshots, and a dossier built by vendor/makefun-board.ts.
//
// The model is derived from the snapshot itself, in this file, from the figures
// the snapshot carries. Nothing here names a protocol in advance: the ranking
// comes from TVL, the seven-day change, the listing age and the protocol's
// category, compared against the tokened peers of that category.
//
// How an implied value is built (the "peer-median" model):
//   1. Launch candidates are the protocols that record no token (mcap, gecko_id
//      and symbol all null) and are not a wrapped, staked or bridged product,
//      not a versioned deployment, not a CEX and not named for an exchange.
//      That filter is the snapshot's own watchlist rule, applied to every row.
//   2. A category's peer multiple is the MEDIAN mcap/TVL of its tokened peers
//      (only peers with a positive market cap and TVL count). A category with
//      fewer than 3 qualifying peers falls back to the global median across all
//      qualifying tokened peers, so no single peer can set a category's price.
//   3. implied = TVL x peerMultiple x growth x age x chains, rounded to dollars.
//      growth = 1 + clamp(change_7d, -50, +100) / 200 (a week's momentum, capped
//      so one wild week cannot 45x a value); age = 0.85 + 0.15 x min(days, 1500)
//      / 1500 (a longer record earns a fuller multiple); chains = 1 + 0.03 x
//      min(chains - 1, 10) (broader reach earns a little more). Missing
//      change_7d or listed_at use the pre-token medians, computed from the data.
//   4. Rows are ranked by implied value, highest first. The whole watchlist is
//      always on the board; the board is every launch candidate the filter keeps.
//
// Farm plans are generated from each protocol's own category and chains: the
// step templates live in STEP_TEMPLATES below, and the plan for a row fills
// them with that row's name, primary chain and category. No plan is written
// by hand for a single protocol.
//
// Honesty: a protocol is described as recording no token, never as having
// none. A launch is never predicted; the implied value is this entry's own
// claim about what a token would be worth if the protocol's record stayed
// as it is.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  peer_multiple: number;
  peer_source: string;
  peer_count: number;
  growth_factor: number;
  age_factor: number;
  chain_factor: number;
}

// Categories the launch-candidate filter refuses. A protocol in one of these
// is a product of a token that already trades, a bridge, or an exchange, so
// its TVL is not a launch candidate's TVL.
const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

// A name that begins with one of these is an exchange's own product.
const EXCHANGE_NAMES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

const VERSION_MARKER = /\s(V\d+|v\d+|\d+\.\d+(\.\d+)?)\s*$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (p.mcap_usd !== null) return false;
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  const lower = p.name.toLowerCase();
  for (const ex of EXCHANGE_NAMES) {
    if (lower.startsWith(ex.toLowerCase())) return false;
  }
  return true;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export interface PeerTable {
  globalMultiple: number;
  globalPeers: number;
  byCategory: Record<string, { n: number; multiple: number; source: string }>;
}

function buildPeerTable(tokened: SnapshotProtocol[]): PeerTable {
  const qualifying = tokened.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const globalMultiple = median(qualifying.map((p) => (p.mcap_usd as number) / p.tvl_usd));
  const byCat = new Map<string, number[]>();
  for (const p of qualifying) {
    const key = p.category ?? "Uncategorised";
    const list = byCat.get(key) ?? [];
    list.push((p.mcap_usd as number) / p.tvl_usd);
    byCat.set(key, list);
  }
  const byCategory: Record<string, { n: number; multiple: number; source: string }> = {};
  for (const [cat, multiples] of [...byCat.entries()].sort()) {
    if (multiples.length >= 3) {
      byCategory[cat] = { n: multiples.length, multiple: median(multiples), source: "category" };
    } else {
      byCategory[cat] = { n: multiples.length, multiple: globalMultiple, source: "global" };
    }
  }
  return { globalMultiple, globalPeers: qualifying.length, byCategory };
}

function peerMultipleFor(
  category: string | null,
  table: PeerTable,
): { multiple: number; source: string; count: number } {
  const key = category ?? "Uncategorised";
  const entry = table.byCategory[key];
  if (entry) return { multiple: entry.multiple, source: entry.source, count: entry.n };
  return { multiple: table.globalMultiple, source: "global", count: 0 };
}

function growthFactor(change7d: number | null, neutral: number): number {
  const c = clamp(change7d ?? neutral, -50, 100);
  return 1 + c / 200;
}

function ageFactor(ageDays: number | null, neutral: number): number {
  const a = Math.min(ageDays ?? neutral, 1500);
  return 0.85 + 0.15 * (a / 1500);
}

function chainFactor(chains: string[]): number {
  return 1 + 0.03 * Math.min(Math.max(chains.length - 1, 0), 10);
}

function impliedValue(
  p: SnapshotProtocol,
  table: PeerTable,
  neutralChange: number,
  neutralAge: number,
  asOf: Date,
): { value: number; peer: { multiple: number; source: string; count: number }; growth: number; age: number; chains: number; ageDays: number | null } {
  const peer = peerMultipleFor(p.category, table);
  const growth = growthFactor(p.change_7d, neutralChange);
  const ageDays = p.listed_at
    ? Math.floor((asOf.getTime() - new Date(p.listed_at + "T00:00:00Z").getTime()) / 86400000)
    : null;
  const age = ageFactor(ageDays, neutralAge);
  const chains = chainFactor(p.chains);
  const value = Math.round(p.tvl_usd * peer.multiple * growth * age * chains);
  return { value, peer, growth, age, chains, ageDays };
}

// Farm-plan step templates. {name}, {chain} and {category} are filled from the
// row itself. The core step varies by category; the other five steps are the
// same shape for every row, because every farm needs setup, cadence, records,
// a claim discipline and a risk check.
const STEP_TEMPLATES: {
  setup: string;
  core: Record<string, string>;
  genericCore: string;
  cadence: string;
  tracking: string;
  claim: string;
  risk: string;
} = {
  setup:
    "Open {name} on {chain} and connect a self-custody wallet. Fund it with enough {chain} gas for 3-5 transactions (about $5-$20) plus the amount you plan to use. Takes about 15 minutes.",
  core: {
    Lending:
      "Supply collateral such as ETH or a stablecoin to {name}'s lending market on {chain}, then borrow a small amount against it so both sides of the position are active. Keep loan-to-value below 50% to avoid liquidation.",
    Dexs: "Swap a small amount through {name} on {chain}, then add liquidity to one of its pools and hold the LP position. A $50-$200 position is enough to register real use.",
    Yield:
      "Deposit into {name}'s yield vault on {chain} and leave the position earning for several weeks. A $100-$500 deposit is a sensible size for a first farm.",
    "Yield Aggregator":
      "Deposit into {name}'s vault on {chain} and let it auto-compound. A $100-$500 deposit is a sensible size for a first farm.",
    RWA: "Deposit into {name}'s tokenised-asset product on {chain} and hold the position. A $100-$500 allocation is a sensible size for a first farm.",
    "Risk Curators":
      "Deposit into a vault curated by {name} on {chain} and hold the position for several weeks. A $100-$500 deposit is a sensible size for a first farm.",
    CDP: "Open a vault on {name} on {chain}, lock collateral and mint a small amount of its stablecoin. Keep the collateral ratio well above the minimum to avoid liquidation.",
    "CDP Manager":
      "Open a vault on {name} on {chain}, lock collateral and mint a small amount of its stablecoin. Keep the collateral ratio well above the minimum to avoid liquidation.",
    "Basis Trading":
      "Deposit into {name}'s basis-trading strategy on {chain} and hold the position. A $100-$500 allocation is a sensible size for a first farm.",
    "Onchain Capital Allocator":
      "Allocate capital to a strategy run by {name} on {chain} and hold the position for several weeks. A $100-$500 allocation is a sensible size for a first farm.",
    Restaking:
      "Restake through {name} on {chain} and hold the position. A $100-$500 restake is a sensible size for a first farm.",
    "Liquid Restaking":
      "Restake through {name} on {chain} and hold the position. A $100-$500 restake is a sensible size for a first farm.",
    "Staking Pool":
      "Stake through {name}'s pool on {chain} and hold the position for several weeks. A $100-$500 stake is a sensible size for a first farm.",
    Chain: "Bridge a small amount to {name} and use its leading apps on a weekly basis. A $50-$200 starting balance is enough to register real use.",
    Payments:
      "Use {name} on {chain} for a real payment or transfer each week, keeping a small working balance. Each use costs one {chain} transaction.",
    Insurance:
      "Buy cover from {name} on {chain} for a position you already hold, or provide cover if it offers that side. A small policy is enough to register real use.",
    Derivatives:
      "Open a small, low-leverage position on {name} on {chain} and manage it weekly. Keep leverage low and size small enough that a move against you is affordable.",
    "Liquidity Manager":
      "Deposit into a liquidity position managed by {name} on {chain} and hold it for several weeks. A $100-$500 deposit is a sensible size for a first farm.",
    "Leveraged Farming":
      "Open a small leveraged farming position through {name} on {chain}. Keep leverage low and size small; leveraged positions can be liquidated.",
    "Prediction Market":
      "Place small, regular predictions on {name} on {chain} and hold positions to resolution. Bet only amounts you are comfortable losing.",
    "Cross Chain Bridge":
      "Bridge a small amount through {name} on {chain} each week and use the destination chain's apps. Each bridge costs one transaction plus the bridge fee.",
    "Stablecoin Wrapper":
      "Wrap or deposit stablecoins through {name} on {chain} and hold the wrapped position. A $100-$500 position is a sensible size for a first farm.",
    "Collateral Markets":
      "Supply collateral to {name}'s market on {chain} and hold the position for several weeks. A $100-$500 supply is a sensible size for a first farm.",
    CeDeFi:
      "Use {name}'s CeDeFi product on {chain} with a real deposit and hold the position for several weeks. A $100-$500 deposit is a sensible size for a first farm.",
    "Governance Incentives":
      "Participate in governance through {name} on {chain}: vote or delegate weekly and keep a record of your participation.",
    "Anchor BTC":
      "Deposit BTC or a BTC-backed asset through {name} on {chain} and hold the position for several weeks. A small allocation is a sensible size for a first farm.",
    "Decentralized BTC":
      "Deposit BTC or a BTC-backed asset through {name} on {chain} and hold the position for several weeks. A small allocation is a sensible size for a first farm.",
    "Dual-Token Stablecoin":
      "Mint or hold {name}'s stablecoin pair on {chain} and keep the position for several weeks. A $100-$500 position is a sensible size for a first farm.",
    Farm: "Deposit into {name}'s farm on {chain} and let the position earn for several weeks. A $100-$500 deposit is a sensible size for a first farm.",
    "Uncollateralized Lending":
      "Use {name}'s lending product on {chain} with a small, real position and repay on schedule. Uncollateralised borrowing carries real default risk.",
    "Interest Rate Derivatives":
      "Open a small interest-rate position on {name} on {chain} and manage it weekly. Keep size small enough that a rate move against you is affordable.",
    "OTC Marketplace":
      "Complete a small trade on {name}'s OTC marketplace on {chain} and keep a record of it. Only trade with counterparties the marketplace itself verifies.",
    "Crypto Card Issuer":
      "Order and use {name}'s card on {chain} for regular spending, keeping a small balance topped up. Each top-up costs one {chain} transaction.",
    Indexes:
      "Buy into {name}'s index on {chain} and hold the position for several weeks. A $100-$500 allocation is a sensible size for a first farm.",
  },
  genericCore:
    "Use {name}'s core {category} product on {chain} with a real position and hold it for several weeks. A $100-$500 position is a sensible size for a first farm.",
  cadence:
    "Repeat the core action weekly for at least 4-8 weeks. Farming rewards sustained use, not a single deposit. Each visit costs one or two {chain} transactions and about 10 minutes.",
  tracking:
    "Keep a record of every deposit and transaction hash, and check {name}'s announcements weekly for a points program, a snapshot date or a rewards page. Never pay anyone for early access or a whitelist spot.",
  claim: "If {name} announces a token, use only its official claim page. Check the contract address against the announcement before signing anything, and never sign a transaction that moves your whole balance.",
  risk: "Risk check: {name} records no token, so a launch is not guaranteed and a deposit can lose value or be locked. Farm only with funds you can afford to leave untouched for months.",
};

function fill(template: string, p: SnapshotProtocol): string {
  const chain = p.chains.length > 0 ? p.chains[0] : "Ethereum";
  return template
    .replaceAll("{name}", p.name)
    .replaceAll("{chain}", chain)
    .replaceAll("{category}", p.category ?? "protocol");
}

function farmSteps(p: SnapshotProtocol): string[] {
  const core = STEP_TEMPLATES.core[p.category ?? ""] ?? STEP_TEMPLATES.genericCore;
  return [
    fill(STEP_TEMPLATES.setup, p),
    fill(core, p),
    fill(STEP_TEMPLATES.cadence, p),
    fill(STEP_TEMPLATES.tracking, p),
    fill(STEP_TEMPLATES.claim, p),
    fill(STEP_TEMPLATES.risk, p),
  ];
}

export interface Board {
  title: string;
  model: string;
  as_of: string;
  floor_usd: number;
  candidates: number;
  global_multiple: number;
  global_peers: number;
  neutral_change: number;
  neutral_age: number;
  rows: BoardRow[];
}

export function buildBoard(snapshot: Snapshot): Board {
  const asOf = new Date(snapshot.as_of + "T00:00:00Z");
  const preToken = snapshot.protocols.filter((p) => p.mcap_usd === null);
  const tokened = snapshot.protocols.filter((p) => p.mcap_usd !== null);
  const table = buildPeerTable(tokened);
  const neutralChange = median(
    preToken.map((p) => p.change_7d).filter((v): v is number => v !== null),
  );
  const neutralAge = median(
    preToken
      .map((p) =>
        p.listed_at
          ? Math.floor((asOf.getTime() - new Date(p.listed_at + "T00:00:00Z").getTime()) / 86400000)
          : null,
      )
      .filter((v): v is number => v !== null),
  );
  const candidates = snapshot.protocols.filter(isLaunchCandidate);
  const scored = candidates.map((p) => {
    const r = impliedValue(p, table, neutralChange, neutralAge, asOf);
    return { p, r };
  });
  scored.sort((a, b) => b.r.value - a.r.value || a.p.slug.localeCompare(b.p.slug));
  const rows: BoardRow[] = scored.map(({ p, r }, i) => ({
    slug: p.slug,
    name: p.name,
    rank: i + 1,
    implied_value_usd: r.value,
    farm_steps: farmSteps(p),
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    age_days: r.ageDays,
    peer_multiple: r.peer.multiple,
    peer_source: r.peer.source,
    peer_count: r.peer.count,
    growth_factor: r.growth,
    age_factor: r.age,
    chain_factor: r.chains,
  }));
  return {
    title: "Token Launch Radar",
    model: "peer-median",
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    candidates: candidates.length,
    global_multiple: table.globalMultiple,
    global_peers: table.globalPeers,
    neutral_change: neutralChange,
    neutral_age: neutralAge,
    rows,
  };
}

// The dashboard's data file: compact rows (short keys) plus the peer table and
// the step templates, so the page can render the board and generate each row's
// farm plan from the same templates main.ts used for board.json.
export function buildDashboardData(board: Board, table: PeerTable, snapshot: Snapshot): string {
  const data = {
    asOf: board.as_of,
    floor: board.floor_usd,
    model: board.model,
    globalMult: table.globalMultiple,
    globalPeers: table.globalPeers,
    neutralChg: board.neutral_change,
    neutralAge: board.neutral_age,
    peers: table.byCategory,
    steps: STEP_TEMPLATES,
    rows: board.rows.map((r) => ({
      s: r.slug,
      n: r.name,
      c: r.category,
      h: r.chains,
      t: r.tvl_usd,
      g: r.change_7d,
      a: r.age_days,
      m: r.peer_multiple,
      v: r.implied_value_usd,
    })),
    watchlist: snapshot.watchlist,
  };
  return "window.RADAR_DATA = " + JSON.stringify(data) + ";\n";
}

// --- output ---

function repoRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function parseArgs(argv: string[]): { input: string | null; output: string | null } {
  let input: string | null = null;
  let output: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && i + 1 < argv.length) input = argv[++i];
    else if (argv[i] === "--output" && i + 1 < argv.length) output = argv[++i];
  }
  return { input, output };
}

function main(): void {
  const root = repoRoot();
  const args = parseArgs(process.argv.slice(2));
  const inputPath =
    args.input ??
    (existsSync("/input/snapshot.json") ? "/input/snapshot.json" : join(root, "input", "snapshot.json"));
  const outputDir =
    args.output ??
    process.env.MAKEFUN_OUTPUT_DIR ??
    (existsSync("/output") ? "/output" : join(root, "out"));
  const snapshot = JSON.parse(readFileSync(inputPath, "utf8")) as Snapshot;
  const board = buildBoard(snapshot);
  const tokened = snapshot.protocols.filter((p) => p.mcap_usd !== null);
  const table = buildPeerTable(tokened);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "board.json"), JSON.stringify(board, null, 2) + "\n", "utf8");

  const dashSrc = join(root, "dashboard");
  const shotsSrc = join(root, "screenshots");
  if (existsSync(dashSrc)) cpSync(dashSrc, join(outputDir, "dashboard"), { recursive: true });
  else mkdirSync(join(outputDir, "dashboard"), { recursive: true });
  if (existsSync(shotsSrc)) cpSync(shotsSrc, join(outputDir, "screenshots"), { recursive: true });
  else mkdirSync(join(outputDir, "screenshots"), { recursive: true });

  writeFileSync(
    join(outputDir, "dashboard", "data.js"),
    buildDashboardData(board, table, snapshot),
    "utf8",
  );

  const dossier = buildDossier(outputDir, { text_max_bytes: 65536 });
  void dossier;

  const watchlistCovered = snapshot.watchlist.filter((s) =>
    board.rows.some((r) => r.slug === s),
  ).length;
  console.log(`board rows: ${board.rows.length}`);
  console.log(`watchlist covered: ${watchlistCovered}/${snapshot.watchlist.length}`);
  console.log(`global peer multiple: ${table.globalMultiple} (n=${table.globalPeers})`);
  console.log("top 5 implied value:");
  for (const r of board.rows.slice(0, 5)) {
    console.log(`  #${r.rank} ${r.slug} ${r.name} $${r.implied_value_usd.toLocaleString("en-US")}`);
  }
  console.log(`wrote ${join(outputDir, "board.json")}`);
  console.log(`wrote ${join(outputDir, "dossier.json")}`);
}

main();
