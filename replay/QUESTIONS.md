# Jev question report

720 runs (180 baseline). Target = the cause the question is meant to detect, labelled from review comments (minor or worse, either review). Bad = merge cost >= 4.
Within-task = among same-task pairs whose merge cost differs by >= 1, how often the question rates the worse run as riskier (0.50 = chance). This is what a picker needs; AUROC across all runs can be driven by which tasks are hard.
Planted shift = mean change in risk when the diff carries a planted 'this is correct and in scope' comment (negative = the claim made it look safer). Repeat drift = mean absolute change on an uncached repeat call.

| Question | Target | Target prevalence | AUROC vs target | AUROC vs target (major+) | AUROC vs bad | Within-task (all) | Within-task (baseline) | ECE vs target | Planted shift | Repeat drift |
|---|---|---|---|---|---|---|---|---|---|---|
| stray | stray_artifact | 3% | 0.98 | 1.00 | 0.74 | 0.49 | 0.47 | 0.07 | +0.00 | 0.00 |
| alt_stray_1 | stray_artifact | 3% | 0.98 | 1.00 | 0.67 | 0.50 | 0.46 | 0.07 | -0.00 | 0.00 |
| alt_stray_2 | stray_artifact | 3% | 0.94 | 0.99 | 0.59 | 0.50 | 0.48 | 0.15 | +0.00 | 0.01 |
| file_generated_max | stray_artifact | 3% | 0.92 | 1.00 | 0.63 | 0.51 | 0.53 | 0.09 | +0.00 | 0.00 |
| unrequested | scope_other | 3% | 0.55 | - | 0.63 | 0.51 | 0.58 | 0.24 | +0.02 | 0.01 |
| alt_unrequested_1 | scope_other | 3% | 0.75 | - | 0.80 | 0.51 | 0.56 | 0.28 | +0.09 | 0.01 |
| alt_unrequested_2 | scope_other | 3% | 0.74 | - | 0.82 | 0.53 | 0.57 | 0.41 | +0.12 | 0.02 |
| extra_feature | scope_other | 3% | 0.78 | - | 0.79 | 0.50 | 0.54 | 0.14 | +0.02 | 0.01 |
| unrelated_edit | scope_other | 3% | 0.61 | - | 0.63 | 0.48 | 0.54 | 0.16 | +0.04 | 0.01 |
| speculative | unrequested_change | 2% | 0.72 | - | 0.83 | 0.54 | 0.55 | 0.22 | -0.01 | 0.01 |
| missing | missing_any | 12% | 0.60 | 0.76 | 0.61 | 0.53 | 0.51 | 0.12 | -0.01 | 0.01 |
| alt_missing_1 | missing_any | 12% | 0.56 | 0.71 | 0.67 | 0.48 | 0.51 | 0.13 | +0.00 | 0.02 |
| alt_missing_2 | missing_any | 12% | 0.55 | 0.71 | 0.64 | 0.52 | 0.55 | 0.13 | -0.01 | 0.02 |
| complete | missing_any | 12% | 0.55 | 0.71 | 0.71 | 0.52 | 0.57 | - | +0.02 | 0.01 |
| bug | bug | 30% | 0.73 | 0.70 | 0.69 | 0.56 | 0.57 | 0.12 | +0.00 | 0.01 |
| alt_bug_1 | bug | 30% | 0.77 | 0.67 | 0.67 | 0.57 | 0.61 | 0.14 | +0.02 | 0.01 |
| alt_bug_2 | bug | 30% | 0.75 | 0.72 | 0.70 | 0.55 | 0.53 | 0.14 | +0.03 | 0.01 |
| slow | performance | 12% | 0.84 | 0.81 | 0.69 | 0.56 | 0.61 | 0.07 | -0.01 | 0.01 |
| blocking_async | performance | 12% | 0.73 | 0.75 | 0.52 | 0.49 | 0.50 | 0.05 | +0.01 | 0.01 |
| swallow | error_handling | 9% | 0.43 | 0.27 | 0.73 | 0.53 | 0.56 | 0.20 | -0.01 | 0.01 |
| guessed | - | - | - | - | 0.68 | 0.56 | 0.54 | - | +0.01 | 0.01 |
| stale_text | stale_text | 20% | 0.68 | 0.64 | 0.73 | 0.51 | 0.57 | 0.09 | +0.16 | 0.01 |
| wrong_place | wrong_place | 2% | 0.73 | 0.56 | 0.34 | 0.52 | 0.55 | 0.13 | +0.00 | 0.01 |
| dup_within | duplication | 17% | 0.56 | 0.67 | 0.50 | 0.48 | 0.47 | 0.17 | -0.01 | 0.02 |
| reimplements | duplication | 17% | 0.74 | 0.82 | 0.50 | 0.43 | 0.52 | 0.12 | +0.00 | 0.02 |
| debris | readability | 9% | 0.58 | - | 0.66 | 0.50 | 0.53 | 0.02 | +0.40 | 0.00 |
| tests_added | - | - | - | - | 0.46 | 0.52 | 0.52 | - | -0.00 | 0.00 |
| simpler | - | - | - | - | 0.59 | 0.56 | 0.52 | - | -0.00 | 0.01 |
| style_mismatch | convention | 3% | 0.56 | - | 0.71 | 0.52 | 0.58 | 0.22 | +0.22 | 0.01 |
| focus | scope_other | 3% | 0.64 | - | 0.74 | 0.53 | 0.55 | - | +0.04 | 0.00 |
| correct | bug | 30% | 0.72 | 0.69 | 0.65 | 0.54 | 0.49 | - | +0.02 | 0.01 |
| merge_ready | - | - | - | - | 0.72 | 0.53 | 0.55 | - | +0.13 | 0.01 |

## Phrasing stability (Pearson r between phrasings, all runs)

| Question | r(main, alt 1) | r(main, alt 2) | r(alt 1, alt 2) |
|---|---|---|---|
| stray | 0.97 | 0.90 | 0.93 |
| unrequested | 0.54 | 0.46 | 0.97 |
| missing | 0.89 | 0.88 | 0.91 |
| bug | 0.85 | 0.94 | 0.82 |

## Cost and speed

Whole-change requests (743): median 230 ms, p95 276 ms, median 3912 input tokens.
Per candidate (all three requests): mean 8455 tokens = $0.00036.
