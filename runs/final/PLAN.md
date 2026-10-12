# Final run: pre-registered plan (written before any final-run result exists)

## Conditions
| Condition | What it is |
|---|---|
| off | Baseline: harness, no hooks. 6 runs per task. |
| ponytail | Ponytail skill + controller (copied from ~/.omp). |
| grain | Convention notes after edits (sibling snippet, exports, docstrings, library); bare-number rule removed. |
| gate | Idea 1, v2: before the first edit to a definition, block once and show real call sites (Python ast), same-named implementations and tests the agent has not observed. |
| checkers | Idea 5: project checkers (ruff/mypy or basedpyright; tsc + oxlint), new findings only, after every edit; one continuation at stop if new findings remain. |
| approach | Idea 3: first source edit blocked until the agent proposes 2-3 approaches; a separate Haiku call reads the repo and picks one. |
| history | Idea 4: on first read of a source file, git co-change partners and the most task-similar past commits with their shape. |
| bestof2 | Idea 2: Opus picks between two independent baseline attempts (pairs s1/s2, s3/s4, s5/s6), both orders, no hidden-test info; disagreement falls back to the first attempt. |

All conditions: Sonnet 5.5 agent, 30 tasks, 3 runs per task (baseline 6), jobs interleaved in one deterministic shuffled queue, isolated HOME per run, prompt on stdin, provider failures and external kills retried.

## Measures (per run)
- Hidden tests pass (objective).
- Merge cost: mean of 2 independent Sonnet reviews of the production diff (blocker 4, major 2, minor 1, nit 0; +4 when hidden tests fail).
- Cost (agent + any hook model calls), wall time.
- Hook activity from the run's hook ledger.

## Analysis (task is the unit)
- Per task, average each measure over that condition's runs.
- Primary: difference in mean merge cost, condition minus baseline, across 30 tasks; 95% CI from 10,000 task-bootstrap resamples; exact sign test over tasks; Holm correction across the 7 comparisons.
- Secondary: difference in hidden-test pass rate (same method); cost and time multipliers.
- Noise reference: baseline runs 1-3 vs 4-6 (same method).
- Hook-fired subset: the same comparison restricted to tasks where the hook acted in at least 2 of 3 runs.

## Decision rule
- Works: merge-cost CI entirely below 0 (Holm-adjusted p < 0.05), hidden-pass rate not worse (CI lower bound above -5 points), and my diff reading finds the improvement attributable to the hook in most examined cases.
- Harmful: merge-cost CI entirely above 0, or hidden-pass CI entirely below 0.
- Otherwise: no detectable effect at this sample size.

## Diff reading (after the numbers, for every condition)
For each condition, the 4 tasks where it improved most and the 2 where it got worse most (task means). For each, compare one condition run with the baseline run nearest the baseline median, read both diffs and the reviews, and check the hook ledger and the agent's next actions to decide whether the difference was caused by the hook. Report each verdict with evidence.
