# Token Launch Radar — PREVIEW

## What it is

A program that reads a sealed DefiLlama snapshot (2026-11-14, 758 protocols) and
ranks the protocols that record no token by what a launch would be worth, each
with a concrete plan to farm it. The dashboard shows the board, a detail view
per protocol, a filter, the model's peer multiples and self-checks — all static,
no network.

## The model: peer median

The model was derived from the snapshot itself, not from a design doc. The
question it answers: *if this protocol launched a token today, what would it be
worth, judged by what the market already pays for similar tokened protocols?*

**Eligibility.** A protocol ranks only if it records no token (mcap, gecko_id and
symbol all null) and is not a wrapped, staked or bridged product, a versioned
deployment, a CEX, or an exchange's own product. That is the snapshot's own
watchlist rule, applied to every protocol — not just the 40 on the watchlist.
**198 protocols qualify** (60 at or above the $50M floor, 138 below it); all 40
watchlist protocols are inside.

**Implied value.** For each qualifying protocol:

```
implied value = TVL × peer multiple × growth × age × chains
```

- **Peer multiple** = the median mcap/TVL of the tokened protocols in the same
  category (only peers with a positive market cap and TVL count). A category
  with fewer than 3 qualifying peers uses the **global median 0.214** (128
  qualifying peers) instead, so no single peer can set a category's price. This
  matters: Risk Curators' only peer is 2.975× and Chain's only peer is 3.026× —
  both fall back to the global median. Category multiples actually used:
  Basis Trading 0.654, Dexs 0.342, RWA 0.275, Yield 0.191, CDP 0.169,
  Lending 0.132, Yield Aggregator 0.151.
- **Growth** = 1 + clamp(7-day TVL change, −50%, +100%) / 200. A week's
  momentum, capped so one wild week cannot 45× a value (the snapshot's biggest
  7-day move is +4448%).
- **Age** = 0.85 + 0.15 × min(days since listing, 1500) / 1500. A longer record
  earns a fuller multiple. Missing listing dates use the pre-token median age
  (634 days).
- **Chains** = 1 + 0.03 × min(chains − 1, 10). Broader reach earns a little more.

**Farm plans.** 6 steps per row, generated from category templates filled with
the row's name, primary chain and category: open the protocol on its chain and
fund a wallet (cost + time stated), the category's core action (deposit, trade,
provide liquidity, stake, etc.) at a sensible size, a weekly cadence of 4–8
weeks, record-keeping plus watching official announcements, an official-claims-
only rule, and a risk check stating the protocol records no token and a launch
is not guaranteed.

**Honesty.** Every row is a protocol that *records no token* in the snapshot.
That is DefiLlama's record, not proof — a protocol may still have a token its
record does not carry. No launch is predicted and no date is given.

## Top 5 implied values

| Rank | Protocol | Category | TVL | Implied value |
| --- | --- | --- | --- | --- |
| 1 | Steakhouse Financial | Risk Curators | $2,753,981,495 | $684,607,708 |
| 2 | Sentora Curator | Risk Curators | $2,757,585,593 | $579,177,123 |
| 3 | Gauntlet | Risk Curators | $1,577,685,462 | $407,735,745 |
| 4 | Veda | Onchain Capital Allocator | $1,563,415,482 | $380,376,089 |
| 5 | USDD | CDP | $1,055,793,606 | $169,602,659 |

## Verification (all checked independently of the program)

- `main.ts` runs clean (exit 0): **board.json 198 rows**, watchlist **40/40**,
  global peer multiple 0.214 (n=128). Board 343,118 bytes (≤8 MiB).
- Ranks exactly 1..198; implied values non-increasing, all distinct, all
  positive whole dollars; slugs unique with no whitespace; names non-empty.
- Farm steps: every row 6 steps, each 20–600 characters.
- Dashboard: the page recomputes every row's implied value from its own figures
  with the same formula — the screenshot run checked 198 + 34 rendered rows
  against board.json, **0 mismatches**. The page's self-checks (watchlist,
  ranks, recompute, farm steps, no hardcoded names, honesty) all pass live.
- Screenshots (all viewed, all 1440×900, all different):
  - `1-board.png` — 145,351 B, sha256 `8b63b815791bb1be242b3d86e042820132e451ec18729bc48491a7f11992638e`
  - `2-detail.png` — 162,454 B, sha256 `ce22e4b48a994bd7dbf2b06dc7313a4bedfaa2567afc4b705b4f3403c2b689ca`
  - `3-filtered.png` — 134,399 B, sha256 `d36762b21043fb5bc865403a7d3b9ae801e88e31908791b53d5af16221196789`
- `dossier.json` 661,952 bytes (≤1.5 MiB); its text is 64,118 bytes, under the
  65,536-byte cap, so the full dashboard source is inside it. Dashboard source
  total 63,788 bytes.
- Determinism: run twice, board.json is byte-identical.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `input/snapshot.json` (or `--input <path>` / `/input/snapshot.json`),
writes `out/board.json`, copies `dashboard/` and `screenshots/` into `out/`,
writes the dashboard's `data.js`, and builds `out/dossier.json` with
`vendor/makefun-board.ts`. The dashboard renders with no network.
