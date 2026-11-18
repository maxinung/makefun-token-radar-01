// The token radar's model — Kimchi's design: implied FDV from peer ratios + quality adjustments
// One snapshot in, one ranked board out. No hand-picked names, no special cases.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants — stated in the dashboard and changeable in the sandbox. */
export interface ModelConstants {
  // Peer ratio: median mcap/TVL of same-category protocols that already have tokens
  growth_weight: number;        // weight for 7d TVL growth (0..1)
  growth_floor: number;         // clamp floor for 7d growth (%)
  growth_cap: number;           // clamp cap for 7d growth (%)
  chain_weight: number;         // weight for chain diversity bonus
  chain_max_bonus: number;      // max bonus from chains (e.g. 0.3 = +30%)
  age_weight: number;           // weight for age maturity (0..1)
  age_floor: number;            // minimum age multiplier
  age_cap: number;              // maximum age multiplier
  age_half_life_days: number;   // days to reach midpoint of age range
  unknown_age_days: number;     // fallback age when listed_at is null
  low_high_range: number;       // symmetric range around base (e.g. 0.4 = ±40%)
}

export const MODEL: ModelConstants = {
  growth_weight: 0.35,
  growth_floor: -50,
  growth_cap: 100,
  chain_weight: 0.25,
  chain_max_bonus: 0.35,
  age_weight: 0.20,
  age_floor: 0.6,
  age_cap: 1.4,
  age_half_life_days: 548,  // ~1.5 years to midpoint
  unknown_age_days: 365,
  low_high_range: 0.40,
};

/** Model version label — the dashboard names it, the rules quote it. */
export const MODEL_VERSION = 'kimchi-1';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: action, cost, time — kept within 20..600 chars per gate. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json — the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  implied_value_low_usd: number;
  implied_value_high_usd: number;
  model: {
    peer_ratio: number;
    growth_pct: number;
    growth_multiplier: number;
    chain_multiplier: number;
    age_multiplier: number;
    age_days: number | null;
    combined_multiplier: number;
  };
  farm_steps: string[];
}

/** Compact view for data.js — farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_value_low_usd: number;
  implied_value_high_usd: number;
  peer_ratio: number;
  growth_multiplier: number;
  chain_multiplier: number;
  age_multiplier: number;
}

/** A live-token protocol: already trades, so show market cap, not a model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Finite number or fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole day count from listed_at to as_of; null if either missing/invalid. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker pattern. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is rankable: pre-token, not CEX, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Map protocols by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Compute median of a number array. */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Build the peer ratio map: for each category, median mcap/TVL of protocols
 * that already have tokens (mcap > 0) in that category.
 */
function buildPeerRatios(protocols: SnapshotProtocol[]): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.category) {
      const ratio = p.mcap_usd / p.tvl_usd;
      if (Number.isFinite(ratio) && ratio > 0) {
        const arr = byCat.get(p.category) ?? [];
        arr.push(ratio);
        byCat.set(p.category, arr);
      }
    }
  }
  const ratios = new Map<string, number>();
  for (const [cat, arr] of byCat) {
    if (arr.length >= 3) {  // need at least 3 peers for a meaningful median
      ratios.set(cat, median(arr));
    }
  }
  return ratios;
}

/** First chain or neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Capital tier from TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Hold days from age: younger = longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Category-specific action — generic but specific to the category type. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  }
  if (c.includes('bridge') || c.includes('canonical bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  }
  if (c.includes('staking') || c.includes('restak') || c.includes('liquid staking') || c.includes('liquid restaking')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and place one market position on ${name}.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk curator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (c.includes('stable') || c.includes('cdp')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  }
  if (c.includes('payments') || c.includes('lightning')) {
    return `Open a $${capital} channel on ${name} and route payments for ${holdDaysFor(null)} days.`;
  }
  if (c.includes('chain') && !c.includes('allocator') && !c.includes('curator')) {
    return `Bridge $${capital} to ${name} and use at least one native app on ${chain}.`;
  }
  if (c.includes('governance') || c.includes('incentive')) {
    return `Stake $${capital} of the governance asset on ${name} and vote on at least one proposal.`;
  }
  if (c.includes('yield') && !c.includes('aggregator')) {
    return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the position open.`;
  }
  if (c.includes('collateral') || c.includes('collateral market')) {
    return `Deposit $${capital} of accepted collateral into ${name} on ${chain} and maintain the position.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Build a farm plan: 6 steps, each with action, cost, time — honest about uncertainty. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const cat = (p.category ?? '').toLowerCase();
  const hasTokenUncertainty = ' (no token recorded; a launch is not guaranteed)';
  const categoryNote = cat ? ` Category: ${p.category}.` : '';
  const chainNote = p.chains.length > 1 ? ` Multi-chain (${p.chains.slice(0, 3).join(', ')}...).` : ` Chain: ${chain}.`;

  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.${categoryNote}${chainNote}`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `${action}${hasTokenUncertainty}`,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week (deposit, borrow, swap, vote, or stake) so activity appears in multiple snapshots.`,
      cost: 'about $2–5 of gas per week depending on chain',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one DefiLlama snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before withdrawing, open the protocol's own points/rewards page (if any) and claim only from the link it publishes — never pay to claim.`,
      cost: 'no fee to check; never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet address, dates, and every transaction in a farm log so you can repeat or unwind the position.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** Format a farm step as one string within 20..600 chars. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Live-token protocols by market cap for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && (p.mcap_usd ?? 0) > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Compute implied value for one protocol using Kimchi's model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  peerRatio: number
): {
  implied: number;
  impliedLow: number;
  impliedHigh: number;
  growthPct: number;
  growthMult: number;
  chainMult: number;
  ageMult: number;
  combinedMult: number;
  age: number | null;
  peerRatio: number;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;

  // Chain diversity: more chains = more surface area for airdrop
  const chainCount = protocol.chains.length;
  const chainMult = 1 + Math.min(model.chain_max_bonus, (chainCount - 1) * 0.05) * model.chain_weight;

  // Age maturity: longer running without token = more credible, but with diminishing returns
  const ageForModel = age ?? model.unknown_age_days;
  const ageProgress = Math.min(1, ageForModel / model.age_half_life_days);
  const ageMult = model.age_floor + (model.age_cap - model.age_floor) * ageProgress;
  const ageMultWeighted = 1 + (ageMult - 1) * model.age_weight;

  const combinedMult = growthMult * chainMult * ageMultWeighted;

  // Base implied FDV = TVL * peer_ratio * combined multipliers
  const base = protocol.tvl_usd * peerRatio * combinedMult;
  const implied = Math.max(1, Math.round(base));

  // Low/high range
  const range = model.low_high_range;
  const impliedLow = Math.max(1, Math.round(implied * (1 - range)));
  const impliedHigh = Math.round(implied * (1 + range));

  return {
    implied,
    impliedLow,
    impliedHigh,
    growthPct,
    growthMult: round4(growthMult),
    chainMult: round4(chainMult),
    ageMult: round4(ageMultWeighted),
    combinedMult: round4(combinedMult),
    age,
    peerRatio: round4(peerRatio),
  };
}

/** Build the full board: watchlist + early pre-token protocols below floor. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const peerRatios = buildPeerRatios(snapshot.protocols);

  // Default peer ratio for categories without enough peers
  const allRatios = [...peerRatios.values()];
  const globalMedianRatio = allRatios.length > 0 ? median(allRatios) : 0.15;

  const chosen = new Map<string, SnapshotProtocol>();

  // Watchlist is the floor: every slug must appear
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  // Early radar: pre-token protocols below watchlist floor, by TVL
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);

  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const cat = p.category ?? 'Unknown';
    const peerRatio = peerRatios.get(cat) ?? globalMedianRatio;
    const vals = impliedValue(p, snapshot.as_of, model, peerRatio);
    return { p, ...vals };
  });

  // Sort by implied value descending, then slug for determinism
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    implied_value_low_usd: s.impliedLow,
    implied_value_high_usd: s.impliedHigh,
    model: {
      peer_ratio: s.peerRatio,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      chain_multiplier: s.chainMult,
      age_multiplier: s.ageMult,
      age_days: s.age,
      combined_multiplier: s.combinedMult,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** Compact board row for data.js (farm plan generated in page). */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    implied_value_low_usd: row.implied_value_low_usd,
    implied_value_high_usd: row.implied_value_high_usd,
    peer_ratio: row.model.peer_ratio,
    growth_multiplier: row.model.growth_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    age_multiplier: row.model.age_multiplier,
  };
}

/** Build everything the dashboard needs. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Parse snapshot from JSON text. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Validate board against gate rules; return issue string or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
    return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!Number.isSafeInteger(r.implied_value_low_usd) || r.implied_value_low_usd <= 0) return `${r.slug} has implied low ${r.implied_value_low_usd}`;
    if (!Number.isSafeInteger(r.implied_value_high_usd) || r.implied_value_high_usd <= 0) return `${r.slug} has implied high ${r.implied_value_high_usd}`;
    if (r.implied_value_low_usd > r.implied_value_usd) return `${r.slug} low > base`;
    if (r.implied_value_high_usd < r.implied_value_usd) return `${r.slug} high < base`;
  }
  return null;
}

/** Compact data.js for the dashboard. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}