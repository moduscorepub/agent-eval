# Phases 1 and 2: replay of the 720 stored runs, and the attempt pipeline

Spend: $45.66 (Opus groups of 4 $28.28, stripping re-reviews $9.24, phase 2 smoke $7.73, Jev $0.40 for 3,980 calls / 9.5M tokens).
Details: [HARD.md](HARD.md), [QUESTIONS.md](QUESTIONS.md), [PICKERS.md](PICKERS.md), [STRIP.md](STRIP.md), [PLANCHECK.md](PLANCHECK.md).

## Headline

1. **Stripping committed runtime files is the biggest measured win.** 28 of 180 baseline runs (all forgestream, 47% of its runs) commit files the test suite writes (`docs/meetings/<date>-test.md`, `data/user_profile.json`, generated reports). Removing them cut merge cost on those runs from 3.57 to 1.80 (−1.77, 95% CI [−2.46, −1.14]), halved bad runs (12 → 6), and changed no hidden-test result. Both the deterministic detector and Jev find all 28 with no false alarms.
2. **Measurement bug in the eval.** `fileKind` classed `*-test.md` as a test file, so the review step hid those meeting notes from the reviewers. Fixed in `lib.ts`. The 720-run conclusions compared conditions with the same blind spot (these files appear in 13–20% of every condition's runs), so the comparisons stand, but merge cost under-counted this problem everywhere.
3. **Running each attempt's tests adds nothing here.** Zero visible-suite regressions and zero failing own tests across 180 baseline runs: the agent already leaves the tests green. Hidden-test failures are task-level (1 task fails for every attempt, 2 are mixed), so selection rarely rescues them. Cross-attempt tests (21 of 30 tasks had runnable tests) and new checker findings mostly mark hard tasks, not the worse attempt (within-task 0.50–0.56).
4. **No cheap picker beats Opus, and Opus is noisy.** Captured share of the possible gain (random → best attempt):

| Picker | Pairs (450) | Groups of 4 (450) | Groups of 4 Opus judged (60) |
|---|---|---|---|
| Hard checks (fitted) | 25% | 37% | 31% |
| Jev composite (unweighted) | 24% | 21% | 13% |
| Jev (fitted) | 26% | 31% | 7% |
| Hard + Jev (fitted) | 21% | 15% | −6% |
| Opus, one call, attempts in order | – | – | 57% |
| Opus, one call, attempts reversed | – | – | 22% |

   Opus picked whichever patch it saw first in 42% of calls (25% expected) and its two orders agreed on 57% of groups, so one call is worth about 40% on average. Escalating only close calls to Opus did worse than Opus on every group. Weighted pickers fitted on ~15 tasks overfit.
5. **Jev is excellent at narrow, observable properties and weak at judging quality.** Committed runtime output: AUROC 0.98 against reviewer flags, 1.00 against the known files. Performance problems 0.84, scope 0.75–0.78, bugs 0.73–0.77 across runs, but ordering two attempts of the same task stays at 0.55–0.61 (0.50 is chance). A planted "this is correct and in scope" comment never made an attempt look safer; repeat calls are deterministic (drift 0.01); median 230 ms and $0.00035 per attempt. Labelling review comments by cause: 55 of 56 hand-checked labels right.
6. **Spending by risk works with the cheap picker but buys little.** Stopping once the best attempt looks safe used 1.56 attempts on average and matched always-4 (merge 1.24 vs 1.25, bad 10.9% vs 11.3%); always-1 is 1.36 / 13.3%.
7. **Plans that really differ look useful but are unproven.** On the 90 stored approach runs, when Jev judged the proposed options substantively different (77 runs) the run scored 0.12 better than its task's baseline mean; when not (13 runs), 0.42 worse (AUROC 0.60).

## Confidence claims, before and after

| Claim | Before | After phases 1–2 |
|---|---|---|
| Up to 4 diverse attempts with hard checks cut bad runs | ~70% | Hard checks alone barely help (no test failures to catch). Four attempts with an Opus pick: bad picks 12.9% → 6.7–10% depending on order. Diverse (plan-seeded) attempts untested at scale. |
| Jev spots stray files and scope problems | ~70% | Stray files: confirmed. Scope: moderate (AUROC ~0.75). |
| Jev plus hard checks beats Opus's 37% | ~40% | No. 15–30% on pairs, at most 31% on groups of 4. |
| Jev's check that plans differ helps | ~50% | Suggestive offline (n = 13 on one side); unresolved. |
| Jev judges correctness directly | ~15% | Confirmed low: within-task ordering 0.55–0.61. |

## Phase 2: the attempt pipeline

- `plans.ts`: an Opus planner names the decision that matters and writes 4 complete plans taking different stances; Jev checks every pair differs and each plan covers the issue, with one rewrite on failure. Jev's own pick of the decisive axis disagreed with the planner on both smoke tasks (it said error handling for CRQA, where the algorithm was what mattered), so it is recorded, not used.
- `run.ts --conditions seeded`: each attempt gets one plan.
- `select.ts`: hard checks → strip stray files into `patch.clean.diff` → drop attempts that break tests → one Opus call over the survivors in shuffled order (Jev composite only trims more than 4 survivors).
- Smoke (2 high-variance tasks, 4 seeded attempts each): seeding produced genuinely different attempts (CRQA: loops, vectorised numpy, scipy labelling, pyunicorn; seeded merge costs 3.5–12.5 and 0.0–9.0). The pipeline dropped the attempt whose own tests failed, stripped stray files from three, and picked the best attempt in both sets. Final picks scored 1.0 (CRQA, baseline mean 3.25) and 0.5 (retrieval-harness-259c0bc0, baseline mean 2.58) at about $2.40 per task. Two tasks are a mechanics check, not evidence.

## Your blind calls

40 pairs in `replay/blind/pair-NN.md` (17 tasks; half where the cheap picker disagrees with the reviewers). Write A, B, or = per pair in `replay/blind/answers.md`, then `bun blind.ts score`.

## Files

`jev.ts` (cached client), `causes.ts` (comment labels), `jevq.ts` + `discover.ts` (question bank, 720 runs, robustness), `checks.ts` (hard checks, cross-attempt tests), `data.ts`, `qreport.ts`, `hardreport.ts`, `pickers.ts`, `bestofk.ts` (Opus groups of 4), `strip.ts`, `blind.ts`, `plans.ts`, `select.ts`.
