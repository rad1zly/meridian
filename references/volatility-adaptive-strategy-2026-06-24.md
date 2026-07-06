# Multi-Signal Directional Strategy Selection

## Problem

Single volatility threshold (e.g. `vol >= 2.7`) is a noisy discriminator between spot and bid_ask because:

1. **Magnitude ≠ sweep direction**: vol = typical move size. Two pools at vol=3 — one sideways choppy, one crashing — get treated identically.
2. **bid_ask is directional, not magnitude-dependent**: bid_ask concentrates liquidity at range edges. It only outperforms spot when price SWEEPS through the range.
3. **Historical data (n=155)**: spot 82% win rate, bid_ask 56%. Single threshold (current=2.7) over-deploys bid_ask because vol is mostly uncorrelated with sweep outcomes.

## Solution: Directional Multi-Signal Score

Since we're single-side SOL with `bins_below` only, our range sits BELOW current price. The LP POV is from ABOVE — we capture fees when price sweeps DOWN into our range from above. bid_ask concentrates at the top edge (where price enters our range).

**Score = sum of 5 signals, threshold = 3 (default).** Need multi-signal consensus to flip from spot (default bias) to bid_ask.

| Signal | Source | Logic |
|---|---|---|
| vol >= 3 | Meteora 30m | Sweep magnitude potential |
| price_change_30m <= -15% | Meteora 30m | Recent dump toward our range |
| price_change_30m <= -30% | Meteora 30m | Extreme dump = strong sweep signal |
| RSI <= 30 (15m) | chart-indicators | Oversold = dump just happened |
| supertrendBreakDown | chart-indicators | Downtrend confirmed |

**Default bias = spot** (82% WR). bid_ask only when 3+ signals independently confirm a downward sweep setup.

## Implementation

| File | Change |
|---|---|
| `tools/screening.js` | `computeStrategySuggestion(pool)` — pure function, applied after indicator confirmation block |
| `tools/screening.js` (`condensePool`) | Adds `suggested_strategy` field to LLM-facing pool object |
| `tools/screening.js` | Logs bid_ask suggestions with breakdown for backtest analysis |
| `index.js:549-559` | Candidate block shows `30m_price_change`, `15m_rsi`, `suggested_strategy` to LLM |
| `prompt.js:137-141` | LLM reads `candidate.suggested_strategy` (deterministic, not LLM-judged) |
| `config.js` (`strategy`) | `scoreBidAskThreshold: 3` |
| `user-config.json` | `"scoreBidAskThreshold": 3` |

## Calibration Notes

- Threshold 3 chosen because spot wins 82% historically and we don't want to flip easily.
- Lower threshold (2) → more aggressive bid_ask deployment (more experiments, more variance).
- Higher threshold (4-5) → almost always spot (loses bid_ask's edge case wins).
- Watch `pool-memory.json` win rate by strategy after 30-50 closes; expect bid_ask WR to converge upward as the formula only picks true sweep setups.

## Lessons Captured

- **strategy-library active ≠ runtime shape**: `strategy-library.json` `db.active` field is library metadata; actual deploy shape comes from prompt.js rule + `user-config.strategy` default.
- **LLM threshold compliance is unreliable**: hardcoded `vol >= 2.7` rule was intermittently ignored by LLM (subjective narrative override). Deterministic field is more reliable.
- **Single-side SOL = POV from above**: range sits below price, we capture downward sweeps. Pump-and-leave scenarios favor spot (or skip entirely).