# Final run report: runs/final

Runs scored: 810 (baseline 180). Merge cost = mean of 2 reviews per run; lower is better.

| Condition | Runs | Hidden tests pass | Mean merge cost | Hook acted in | Cost per run | Minutes per run |
|---|---|---|---|---|---|---|
| off | 180 | 93% | 1.36 | - | $0.20 (1.00x) | 1.2 (1.00x) |
| ponytail | 90 | 91% | 1.67 | 100% | $0.20 (0.98x) | 1.1 (0.87x) |
| grain | 90 | 92% | 1.34 | 33% | $0.20 (0.99x) | 1.3 (1.04x) |
| gate | 90 | 92% | 1.54 | 61% | $0.22 (1.09x) | 1.3 (1.05x) |
| checkers | 90 | 92% | 1.66 | 52% | $0.20 (1.01x) | 1.6 (1.34x) |
| approach | 90 | 93% | 1.32 | 100% | $0.25 (1.24x) | 1.8 (1.51x) |
| history | 90 | 94% | 1.36 | 60% | $0.20 (1.01x) | 1.2 (0.98x) |
| bestof2 | 90 | 93% | 1.23 | 100% | $0.70 (3.46x) | 1.3 (1.03x) |

## Merge cost vs baseline (task means; negative = better than baseline)

| Comparison | Tasks | Mean difference | 95% CI | Tasks better / worse / equal | p (permutation) | p (Holm) | Hook-acted tasks: mean difference |
|---|---|---|---|---|---|---|---|
| ponytail − off | 30 | +0.32 | [+0.08, +0.62] | 7 / 14 / 9 | 0.020 | 0.141 | +0.32 (30 tasks) |
| grain − off | 30 | -0.02 | [-0.18, +0.17] | 15 / 8 / 7 | 0.882 | 1.000 | +0.01 (10 tasks) |
| gate − off | 30 | +0.19 | [-0.07, +0.49] | 12 / 9 / 9 | 0.220 | 0.881 | +0.19 (18 tasks) |
| checkers − off | 30 | +0.30 | [+0.06, +0.57] | 8 / 14 / 8 | 0.027 | 0.162 | +0.47 (15 tasks) |
| approach − off | 30 | -0.04 | [-0.31, +0.22] | 10 / 13 / 7 | 0.797 | 1.000 | -0.04 (30 tasks) |
| history − off | 30 | +0.01 | [-0.23, +0.22] | 8 / 12 / 10 | 0.982 | 1.000 | +0.05 (18 tasks) |
| bestof2 − off | 30 | -0.12 | [-0.23, -0.02] | 13 / 6 / 11 | 0.031 | 0.162 | -0.12 (30 tasks) |
| noise: off runs 4-6 − runs 1-3 | 30 | +0.32 | [+0.08, +0.61] | 5 / 12 / 13 | 0.026 | - | - |

## Hidden-test pass rate vs baseline (percentage points)

| Comparison | Mean difference | 95% CI |
|---|---|---|
| ponytail − off | -1.7 | [-4.4, 0.0] |
| grain − off | -0.6 | [-3.3, +1.7] |
| gate − off | -0.6 | [-3.3, +1.7] |
| checkers − off | -0.6 | [-3.3, +1.7] |
| approach − off | +0.6 | [0.0, +1.7] |
| history − off | +1.7 | [0.0, +4.4] |
| bestof2 − off | +0.6 | [0.0, +1.7] |
| noise: off runs 4-6 − runs 1-3 | -3.3 | [-8.9, 0.0] |

## Statistical verdict (before diff reading)

| Condition | Verdict |
|---|---|
| ponytail | harmful |
| grain | no detectable effect |
| gate | no detectable effect |
| checkers | harmful |
| approach | no detectable effect |
| history | no detectable effect |
| bestof2 | no detectable effect |

## Diff reading (pre-registered: 4 most-improved and 2 most-worsened tasks per condition)
| Condition | Hook-caused differences found | Notes |
|---|---|---|
| ponytail | Builds less: −23 src lines/run on forgestream features; skipped the package export on efd54879 | Extremes otherwise reviewer-severity variance on the same designs; correctness comments +0.18/run; pilot pairwise judge also against (16 vs 5) |
| grain | None | Acted in 33% of runs; extremes are noise |
| gate | None | The one plausible case (128-batch on edd95af0) also appears in 1/3 runs of approach, checkers, ponytail and 0/6 baseline: not the gate |
| checkers | None in extremes; findings were mostly transient mid-edit errors (undefined names before imports) | Fired-subset +0.47; correctness comments +0.19/run; 1.34x wall time |
| approach | Yes: CRQA task, 2/3 runs whose alternatives contrasted vectorized numpy vs the plan's loops picked numpy and scored 0; the 3rd run's alternatives missed that axis and drew a major | Average effect ~0; scope comments 0.07 vs 0.13 (not tied to stray files: 13% vs 15%) |
| history | None: agents inspected a cited commit in 0/54 carded runs | 259c0bc0 3/3 pass vs 4/6 baseline is within chance |
| bestof2 | Yes (selection): picks reasoned on stray files, guessed commands, scope; captured 37% of the oracle gain (1.36 random -> 1.23 picked; oracle 1.03) | 3.46x cost; taste mismatch with reviewers on scope (b0b5528a) |
