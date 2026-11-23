# Winner Takes All — Dip Rider

[![make.fun](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/airdropjepe45-svg/winner-takes-all/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/airdropjepe45-svg/winner-takes-all/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

A paper-trading bot for the **Winner Takes All — $5 Pump.fun Replay Sprint**
on make.fun. It trades 10 SOL of paper money on a replay of pump.fun
bonding-curve data, aiming for the best net PnL. One winner takes the pot.

## How the bot works

Most fresh pump.fun coins spike, dump hard, then bounce. The bot plays that
shape with three behaviours, decided once per batch from the batch data and
its own deterministic book (no clock, no randomness):

- **Dip buying (the money-maker).** The bot tracks each coin's high price
  since it first saw the coin. When the price has fallen 30–45% from that
  high and the coin's real SOL reserve is at least 12 SOL, it opens a
  position with a first tranche of 0.12 SOL.
- **Pyramid adds.** While a held coin's price sits at or above the entry
  price and at most 5% above it, the bot adds further 0.12 SOL tranches, up
  to a 3.0 SOL total position per coin. Adds go only into strength, never
  into a falling price.
- **Exits.** Every position is sold in full on take-profit (+30% vs cost),
  stop-loss (−9% vs cost), or after 600 slots held — whichever comes first.
  One entry per coin: once a coin is exited, it is never re-entered.
- **Scout buys (guardrail filler).** On each fresh coin, the bot buys a
  small 0.05 SOL stake once its size cap allows, so the entry reaches the
  20-coin round-trip guardrail. Scouts stop once 3 positions are committed,
  keeping slots free for dip entries.

Position and cash discipline: never more than 5 open positions, never more
than 16 orders per batch, never more than the per-coin size cap
(`state.maxBuyLamports`), never more cash than is free after fees, and wide
slippage (10000 bps) so orders are not refused for price moves during the
2-slot latency. All strategy numbers live as named constants at the top of
`main.ts` so they can be swept later.

## How to run

The grader runs it with the repo mounted at `/bot`:

```sh
node /bot/main.ts
```

It needs Node 22.18 or later (Node strips the TypeScript types; nothing to
install). To grade it locally against the dev window, from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

## Layout

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit SDK shim.
- `LICENSE` — MIT.
