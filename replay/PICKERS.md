# Picker replay (phase 1)

Tasks with complete hard checks: 30 of 30. Candidates are each task's 6 baseline attempts; merge cost is the mean of two Sonnet reviews (+4 if hidden tests fail). Weighted pickers are cross-fitted across the dev/holdout task halves. "Captured" = (random − picker) / (random − oracle).

### Every group of 2 (450 pools)

| Picker | Mean merge cost | Captured of possible gain | vs random: Δ merge (95% CI over tasks) | Bad picks (merge ≥ 4) | Hidden-test fails | Notes |
|---|---|---|---|---|---|---|
| random | 1.36 | 0% | - | 13.3% | 7.2% |  |
| smallest diff | 1.31 | 12% | -0.05 [-0.10, 0.01] | 11.9% | 6.6% |  |
| hard checks (rule) | 1.30 | 15% | -0.06 [-0.16, 0.02] | 12.2% | 6.8% |  |
| hard checks (fitted) | 1.26 | 25% | -0.10 [-0.23, 0.00] | 12.8% | 6.6% |  |
| Jev (fixed, unweighted) | 1.26 | 24% | -0.09 [-0.19, -0.01] | 11.6% | 7.1% |  |
| Jev (fitted) | 1.25 | 26% | -0.10 [-0.19, -0.02] | 10.7% | 6.7% |  |
| hard filter, then Jev (fixed) | 1.26 | 24% | -0.09 [-0.19, -0.01] | 11.6% | 7.1% |  |
| hard + Jev (fitted) | 1.28 | 21% | -0.08 [-0.18, -0.00] | 12.0% | 6.9% |  |
| oracle | 0.97 | 100% | -0.39 [-0.55, -0.24] | 8.0% | 5.8% |  |

### Every group of 4 (450 pools)

| Picker | Mean merge cost | Captured of possible gain | vs random: Δ merge (95% CI over tasks) | Bad picks (merge ≥ 4) | Hidden-test fails | Notes |
|---|---|---|---|---|---|---|
| random | 1.36 | 0% | - | 13.3% | 7.2% |  |
| smallest diff | 1.22 | 21% | -0.14 [-0.31, 0.00] | 9.9% | 5.0% |  |
| hard checks (rule) | 1.18 | 26% | -0.18 [-0.42, 0.00] | 9.8% | 6.2% |  |
| hard checks (fitted) | 1.10 | 37% | -0.25 [-0.54, -0.01] | 10.1% | 5.1% |  |
| Jev (fixed, unweighted) | 1.21 | 21% | -0.14 [-0.39, 0.08] | 11.6% | 8.7% |  |
| Jev (fitted) | 1.14 | 31% | -0.21 [-0.46, -0.02] | 8.7% | 6.0% |  |
| hard filter, then Jev (fixed) | 1.21 | 21% | -0.14 [-0.39, 0.08] | 11.6% | 8.7% |  |
| hard + Jev (fitted) | 1.25 | 15% | -0.10 [-0.34, 0.08] | 11.3% | 6.9% |  |
| oracle | 0.68 | 100% | -0.68 [-0.97, -0.42] | 4.7% | 4.4% |  |

### The pairs Opus judged (90 pools)

| Picker | Mean merge cost | Captured of possible gain | vs random: Δ merge (95% CI over tasks) | Bad picks (merge ≥ 4) | Hidden-test fails | Notes |
|---|---|---|---|---|---|---|
| random | 1.36 | 0% | - | 13.3% | 7.2% |  |
| smallest diff | 1.33 | 8% | -0.03 [-0.10, 0.05] | 11.7% | 6.7% |  |
| hard checks (rule) | 1.36 | -2% | 0.01 [-0.05, 0.07] | 13.9% | 7.2% |  |
| hard checks (fitted) | 1.26 | 31% | -0.10 [-0.21, 0.01] | 13.9% | 6.7% |  |
| Jev (fixed, unweighted) | 1.32 | 12% | -0.04 [-0.17, 0.09] | 12.2% | 6.7% |  |
| Jev (fitted) | 1.33 | 8% | -0.03 [-0.13, 0.08] | 11.1% | 6.7% |  |
| hard filter, then Jev (fixed) | 1.32 | 12% | -0.04 [-0.17, 0.09] | 12.2% | 6.7% |  |
| hard + Jev (fitted) | 1.26 | 31% | -0.10 [-0.22, -0.00] | 11.1% | 6.7% |  |
| oracle | 1.03 | 100% | -0.33 [-0.44, -0.22] | 11.1% | 6.7% |  |
| Opus (one call) | 1.27 | 25% | -0.08 [-0.19, 0.03] | 13.3% | 6.7% | orders agree on 77% of pools |
| hard + Jev (fitted), Opus on closest 25% | 1.28 | 22% | -0.07 [-0.19, 0.03] | 12.2% | 6.7% | Opus called on 24% |
| pipeline: hard filter, Jev (fixed), Opus on closest 25% | 1.31 | 14% | -0.04 [-0.16, 0.06] | 12.2% | 6.7% | Opus called on 23% |
| hard + Jev (fitted), Opus on closest 50% | 1.28 | 24% | -0.08 [-0.18, 0.01] | 12.2% | 6.7% | Opus called on 50% |
| pipeline: hard filter, Jev (fixed), Opus on closest 50% | 1.29 | 19% | -0.06 [-0.19, 0.06] | 13.3% | 6.7% | Opus called on 50% |

### The groups of 4 Opus judged (60 pools)

| Picker | Mean merge cost | Captured of possible gain | vs random: Δ merge (95% CI over tasks) | Bad picks (merge ≥ 4) | Hidden-test fails | Notes |
|---|---|---|---|---|---|---|
| random | 1.33 | 0% | - | 12.9% | 7.1% |  |
| smallest diff | 1.30 | 5% | -0.03 [-0.20, 0.14] | 11.7% | 5.8% |  |
| hard checks (rule) | 1.19 | 23% | -0.15 [-0.36, 0.02] | 11.3% | 7.1% |  |
| hard checks (fitted) | 1.13 | 31% | -0.20 [-0.47, 0.06] | 11.7% | 5.0% |  |
| Jev (fixed, unweighted) | 1.25 | 13% | -0.08 [-0.32, 0.15] | 11.7% | 8.3% |  |
| Jev (fitted) | 1.28 | 7% | -0.05 [-0.29, 0.17] | 11.7% | 8.3% |  |
| hard filter, then Jev (fixed) | 1.25 | 13% | -0.08 [-0.32, 0.15] | 11.7% | 8.3% |  |
| hard + Jev (fitted) | 1.37 | -6% | 0.04 [-0.20, 0.24] | 13.3% | 8.3% |  |
| oracle | 0.69 | 100% | -0.64 [-0.88, -0.42] | 5.0% | 5.0% |  |
| Opus (one call) | 0.97 | 57% | -0.36 [-0.61, -0.15] | 6.7% | 5.0% | orders agree on 57% of pools |
| hard + Jev (fitted), Opus on closest 25% | 1.33 | 0% | 0.00 [-0.23, 0.22] | 13.3% | 8.3% | Opus called on 25% |
| pipeline: hard filter, Jev (fixed), Opus on closest 25% | 1.27 | 10% | -0.06 [-0.31, 0.17] | 13.3% | 8.3% | Opus called on 23% |
| hard + Jev (fitted), Opus on closest 50% | 1.18 | 24% | -0.16 [-0.40, 0.04] | 10.0% | 5.0% | Opus called on 50% |
| pipeline: hard filter, Jev (fixed), Opus on closest 50% | 1.27 | 9% | -0.06 [-0.30, 0.18] | 13.3% | 8.3% | Opus called on 50% |

### Spending by risk (draw attempts until the best one looks safe, up to 4)

Threshold = quantile of the fitted risk score on training-half candidates (stop when the best drawn candidate scores below it). Every ordering of each task's 6 attempts is simulated.

| Policy | Mean attempts | Mean merge cost | Bad picks (merge ≥ 4) | Hidden-test fails |
|---|---|---|---|---|
| always 1 | 1.00 | 1.36 | 13.3% | 7.2% |
| always 2 | 2.00 | 1.28 | 12.0% | 6.9% |
| always 3 | 3.00 | 1.26 | 11.3% | 6.8% |
| always 4 | 4.00 | 1.25 | 11.3% | 6.9% |
| stop below the 30th percentile of risk | 2.62 | 1.25 | 11.1% | 6.9% |
| stop below the 50th percentile of risk | 2.22 | 1.25 | 10.8% | 6.9% |
| stop below the 70th percentile of risk | 1.86 | 1.27 | 10.7% | 7.2% |
| stop below the 85th percentile of risk | 1.56 | 1.24 | 10.9% | 6.9% |

### Largest weights in the fitted hard + Jev picker (standardized; positive = riskier)

| Feature | Fold A weight | Fold B weight |
|---|---|---|
| j_alt_bug_1 | +0.16 | +0.92 |
| j_merge_ready | -0.25 | -0.37 |
| j_alt_unrequested_1 | +0.40 | +0.14 |
| j_stray | +0.19 | +0.34 |
| j_alt_bug_2 | -0.13 | -0.36 |
| j_extra_feature | +0.20 | +0.25 |
| crossFail | -0.05 | +0.48 |
| j_debris | +0.28 | +0.13 |
| j_correct | -0.07 | -0.32 |
| j_swallow | +0.23 | +0.16 |
| j_simpler | -0.26 | -0.12 |
| j_guessed | +0.21 | +0.16 |
| j_blocking_async | -0.21 | -0.12 |
| j_unrequested | +0.03 | +0.29 |
| j_dup_within | -0.21 | -0.07 |
