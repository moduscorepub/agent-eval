# Hard checks on baseline runs

180 baseline runs over 30 tasks. Bad = merge cost >= 4. Within-task = among same-task pairs whose merge cost differs by >= 1, how often the signal ranks the worse run as riskier (0.50 = chance; ties count half).

| Signal | Fires on | Bad when fires | Bad otherwise | Hidden fails when fires | Hidden fails otherwise | Within-task |
|---|---|---|---|---|---|---|
| patch did not apply | 0 (0%) | - | 13% | - | 7% | 0.50 |
| visible-suite regression | 0 (0%) | - | 13% | - | 7% | 0.50 |
| own tests fail | 0 (0%) | - | 13% | - | 7% | 0.50 |
| stray files (deterministic) | 28 (16%) | 29% | 11% | 7% | 7% | 0.54 |
| new checker findings | 45 (25%) | 29% | 8% | 13% | 5% | 0.50 |
| any hard failure (regression, own tests, stray) | 28 (16%) | 29% | 11% | 7% | 7% | 0.54 |
| others' tests fail on it (rate > 0) | 38 (21%) | 29% | 9% | 13% | 6% | 0.53 |

Cross-attempt tests as a continuous signal: AUROC vs hidden-test failure 0.59, vs bad 0.65, within-task 0.56. Tasks where at least one attempt added runnable tests: 21 of 30.

## Hidden-test failures are mostly task-level

Tasks where every baseline attempt fails the hidden tests: 1; where some but not all fail: 2. Selection can only help the second kind.

## Stray-file detection

Runs committing the known runtime outputs (data/user_profile.json, docs/meetings/*): 28. Deterministic detector fires on 28; on the known-output runs it catches 28/28, and fires on 0 other runs.
Jev whole-change stray question: AUROC vs known outputs 1.00; Jev per-file question (max over files): 1.00; per-file >= 0.5 fires on 27 runs (27 known).
