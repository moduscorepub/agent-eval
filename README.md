# agent-eval

An evaluation harness for one question: **what makes a coding agent produce code a maintainer would merge?**

It runs a coding agent ([coding-harness](https://github.com/moduscorepub/coding-harness)) on real tasks mined from git history, under different conditions (hooks that steer the agent, or picking the best of several attempts), and scores every change with independent model reviews plus hidden tests. Everything is pre-registered, analysed with tasks as the unit, and checked by reading the diffs before any result is called real.

The repository holds three studies:

1. **The hook study:** 720 agent runs comparing six in-run hooks against a plain baseline, plus best-of-two selection.
2. **Phase 1, a replay of the stored runs:** hard checks, a fast typed-judgment model ([Jev](https://docs.typesafe.ai)) as a judge, Opus as a picker, and stray-file clearing, all measured on the same 180 baseline attempts without new agent runs.
3. **Phase 2, a plan-seeded attempt pipeline:** generate plans that differ on the decision that matters, run one attempt per plan, check them, and pick one. It has been built and smoke-tested.

---

## Contents

- [Key findings](#key-findings)
- [How the evaluation works](#how-the-evaluation-works)
- [The hook study](#the-hook-study)
- [Phase 1: replay of the stored runs](#phase-1-replay-of-the-stored-runs)
- [Phase 2: the plan-seeded pipeline](#phase-2-the-plan-seeded-pipeline)
- [Repository layout](#repository-layout)
- [Data files](#data-files)
- [Running it yourself](#running-it-yourself)
- [Cost](#cost)
- [Limitations](#limitations)

---

## Key findings

| # | Finding | Evidence |
|---|---|---|
| 1 | **No in-run hook made the code measurably better.** The baseline agent is already good on average (93% of hidden tests pass, merge cost 1.36), and two runs of the same setup differ by more than any hook moved the average. | 720 runs, 30 tasks; nothing significant after Holm correction ([`runs/final/REPORT.md`](runs/final/REPORT.md)) |
| 2 | **The worst runs carry most of the cost.** The worst 20% of baseline runs carry 72% of all merge cost. Picking the best of several attempts, with a perfect picker, would cut the mean from 1.36 to 0.68 and bad runs from 13.3% to 4.7% at four attempts. | 180 baseline runs, 6 per task |
| 3 | **Clearing committed runtime files is the biggest measured win.** 28 of 180 baseline runs (all in one repository) committed files the test suite writes. Removing them cut those runs' merge cost from 3.57 to 1.80 and halved bad runs, with no hidden-test change. | [`replay/CLEAR.md`](replay/CLEAR.md) |
| 4 | **Running each attempt's tests adds nothing here.** There were zero visible-suite regressions and zero failing own tests across 180 attempts: the agent already keeps tests green. | [`replay/HARD.md`](replay/HARD.md) |
| 5 | **No cheap picker beats Opus, and Opus is noisy.** Hard checks or Jev capture roughly 15–37% of the possible gain. Opus reading four attempts captures 22–57% depending on their order, and picks whichever patch it saw first 42% of the time. | [`replay/PICKERS.md`](replay/PICKERS.md) |
| 6 | **Jev is excellent at narrow, visible properties and weak at judging quality.** It detects committed runtime output almost perfectly (AUROC 0.98–1.00), but orders two attempts of the same task at only 0.55–0.61, where 0.5 is chance. It is cheap ($0.00035 per attempt), fast (230 ms median), deterministic, and was not fooled by a planted "this is correct" comment. | [`replay/QUESTIONS.md`](replay/QUESTIONS.md) |
| 7 | **Approach options only help when they differ on the decision that matters.** When Jev judged an approach run's options substantively different, the run did 0.12 better than its task's baseline; when not, 0.42 worse. Only 13 runs fall in the second group. | [`replay/PLANCHECK.md`](replay/PLANCHECK.md) |

A measurement bug was found and fixed along the way: the file classifier treated `*-test.md` as test files, so reviewers never saw generated meeting notes named `<date>-test.md`. They appear in 13–20% of every condition's runs, so the comparisons stand, but merge cost under-counted that problem everywhere ([details](#limitations)).

---

## How the evaluation works

### Tasks

`harvest.ts` mines commits that change source and tests together and turns each into a task:

1. **Filters.** A commit qualifies when it touches source and tests, renames or deletes no tests, changes no dependencies, changes 3–250 source lines, and touches at most 10 files.
2. **Validation.** The reference commit's tests must **fail on the parent commit and pass with the reference change**, so "hidden tests pass" means the agent really solved it.
3. **Issue text.** A model writes the GitHub issue a maintainer would have filed. It describes behaviour and names the required interfaces, but never the implementation, the tests or the diff.
4. **Hidden tests.** The reference commit's test files are hidden from the agent and run after it finishes.

`tasks/<id>.json` holds the issue text, the parent and reference commits, the hidden test files, the reference change size, and the repository's setup and test commands.

The 30 tasks come from three repositories (10 each): a Python audio/ML application, a TypeScript web app, and a Python retrieval service.

### One attempt

`run.ts` runs every task under each condition:

- **Isolation.** Each attempt gets a copy-on-write clone of the parent commit, a throwaway `HOME` (no personal config, skills or extensions), and `--no-extensions` except the condition's own hooks.
- **Setup.** The repository's setup command runs, and anything it produces (for example a lockfile) is committed first, so it is never scored as the agent's change.
- **Prompt.** `Resolve this issue in the current repository.` plus the issue text. It goes in on **stdin**, because an agent's `pkill -f <task text>` once killed concurrent runs whose prompt was on the command line.
- **Retries.** Provider failures and external kills (exit 143/137, error or aborted stops) are retried on a fresh copy, up to twice. Agent decisions are never retried.
- **Scoring.** The full patch is captured. Then the hidden tests run, and the attempt's size, cost, tool calls and wall time are recorded.
- **Ordering.** Jobs run in one deterministic shuffled queue, so time-of-day effects spread across conditions.

### Merge cost

`review.ts` asks a model to act as a maintainer reviewing the production diff before merging. It reads the repository and lists every comment it would leave. Comments are weighted by severity:

| Severity | Weight | Meaning |
|---|---|---|
| blocker | 4 | wrong or incomplete behaviour, or breaks something |
| major | 2 | wrong place, duplicated logic, re-implements existing code, unrequested scope, a convention that matters |
| minor | 1 | worth changing but small |
| nit | 0 | optional polish |

**Merge cost** is the sum of the weights, plus 4 when the hidden tests fail. Lower is better. Each run gets **two independent reviews** (they correlate at 0.84) and its merge cost is their mean. A run is **bad** when its merge cost is 4 or more.

### Statistics

- **Unit.** The task is the unit of analysis: runs of one task are averaged, and every interval comes from resampling tasks (10,000 bootstrap resamples). There are also sign-flip permutation tests and Holm correction across the seven comparisons.
- **Noise reference.** Baseline runs 4–6 compared against runs 1–3 show how big a "difference" pure noise produces (+0.32 here).
- **Pre-registration.** The analysis plan and decision rule were written before any result existed ([`runs/final/PLAN.md`](runs/final/PLAN.md)).
- **Diff reading.** For each condition, the four tasks where it helped most and the two where it hurt most were read by hand, to decide whether the hook caused the difference.

---

## The hook study

### Conditions

| Condition | What it does |
|---|---|
| `off` | Baseline: the agent with no hooks. 6 runs per task. |
| `ponytail` | A "build the least that works" skill plus a mode controller. |
| `grain` | After each edit, notes how neighbouring code already does things: the closest existing sibling, missing package exports, missing docs, libraries sibling modules use. |
| `gate` | Before the first edit to a definition, blocks once and shows real call sites (Python `ast`), same-named implementations and tests the agent has not looked at yet. |
| `checkers` | Runs the project's own checkers (ruff, mypy or basedpyright, tsc, oxlint) after every edit and reports new findings only; one continuation at the end if new findings remain. |
| `approach` | Blocks the first source edit until the agent proposes 2–3 approaches; a cheaper model reads the repository and picks one. |
| `history` | On the first read of a source file, adds git co-change partners and the past commits most similar to the task. |
| `bestof2` | Opus picks between two independent baseline attempts, judged in both orders; if the orders disagree, the first attempt is kept. |

The hooks are in [`conditions/`](conditions/) exactly as evaluated. A maintained, typed version of `gate`, `checkers`, `approach`, `history` and `grain` lives in coding-harness under `packages/coding-agent/examples/extensions/code-quality/`.

### Results

Agent: Sonnet 5.5. Reviews: two independent Sonnet 5.5 reviews per run. 30 tasks, 3 runs per condition (baseline 6), 810 scored runs including the 90 best-of-two picks.

| Condition | Hidden tests pass | Mean merge cost | Change vs baseline (95% CI) | Hook acted in | Cost per run | Time per run |
|---|---|---|---|---|---|---|
| off | 93% | 1.36 | – | – | $0.20 | 1.2 min |
| bestof2 | 93% | 1.23 | −0.12 [−0.23, −0.02] | 100% | $0.70 (3.46×) | 1.03× |
| approach | 93% | 1.32 | −0.04 [−0.31, +0.22] | 100% | $0.25 (1.24×) | 1.51× |
| grain | 92% | 1.34 | −0.02 [−0.18, +0.17] | 33% | 0.99× | 1.04× |
| history | 94% | 1.36 | +0.01 [−0.23, +0.22] | 60% | 1.01× | 0.98× |
| gate | 92% | 1.54 | +0.19 [−0.07, +0.49] | 61% | 1.09× | 1.05× |
| checkers | 92% | 1.66 | +0.30 [+0.06, +0.57] | 52% | 1.01× | 1.34× |
| ponytail | 91% | 1.67 | +0.32 [+0.08, +0.62] | 100% | 0.98× | 0.87× |
| *noise: baseline runs 4–6 vs 1–3* | | | *+0.32 [+0.08, +0.61]* | | | |

After Holm correction nothing is significant. The noise reference alone is as large as the biggest effect, and one run's merge cost varies by about 1.0 around its task's mean.

What the diffs showed:

- **bestof2:** real selection. The picker's reasons matched what reviewers flagged: committed generated files, guessed commands, unrequested changes. It captured 37% of the possible gain (random 1.36, picked 1.23, best attempt 1.03).
- **approach:** one clear hook-caused win. On a recurrence-analysis task, runs whose options contrasted vectorised numpy with the design document's slow loops picked numpy and scored 0. The run whose options differed on something else drew a major comment for blocking the event loop.
- **ponytail:** builds less, with 23 fewer source lines per run on larger features and a skipped package export once.
- **checkers:** its findings were mostly short-lived errors in half-finished edits, such as names used before their imports were added.
- **gate:** the one plausible win (batching) also appeared in other conditions and never in the baseline, so it wasn't the gate.
- **history:** agents looked at a cited commit in 0 of 54 runs that received history notes.
- **grain:** acted in a third of runs; its extremes are noise.

---

## Phase 1: replay of the stored runs

The 180 baseline attempts (6 per task) are a fixed pool, so every picker can be compared on the same candidates without new agent runs: 450 pairs and 450 groups of four.

### What selection could buy

A perfect picker always keeping the best of k baseline attempts:

| Attempts per task | Mean merge cost | Bad runs |
|---|---|---|
| 1 | 1.36 | 13.3% |
| 2 | 0.97 | 8.0% |
| 3 | 0.79 | 5.8% |
| 4 | 0.68 | 4.7% |
| 6 | 0.55 | 3.3% |

### Hard checks (`checks.ts`, [`replay/HARD.md`](replay/HARD.md))

Each attempt is rebuilt (clone, setup, apply the patch) and checked:

- **Visible test suite.** It runs once on the base commit and once per attempt. A regression is a test that passed on the base and fails with the attempt, and every failure is confirmed by re-running its file alone, because some suites flake under load.
- **The attempt's own tests.** Those it added or changed.
- **Cross-attempt tests.** Every attempt's tests run against every other attempt's code.
- **New checker findings** from the project's own tools.
- **Stray files.** These are files the base test suite itself writes, or runtime-output-shaped paths (`data/`, logs, dated filenames) that the issue doesn't mention.
- **Hidden tests after clearing** stray files.

Results: 0 regressions and 0 failing own tests across 180 attempts. Hidden-test failures are mostly whole-task (one task fails for every attempt, two are mixed), so selection rarely rescues them. Cross-attempt tests and checker findings mostly mark hard tasks rather than the worse attempt (within-task ordering 0.50–0.56).

### Jev as a judge (`jev.ts`, `jevq.ts`, `discover.ts`, `qreport.ts`, [`replay/QUESTIONS.md`](replay/QUESTIONS.md))

Jev is TypeSafe's System One model: it answers typed questions (yes/no probability, choice, score) about a given state, rather than generating text. Each attempt got 32 narrow questions over three slices of context: the issue plus the diff, the added code plus existing functions nearby, and each non-code file on its own.

| Property | AUROC vs review label | Within-task ordering |
|---|---|---|
| Committed runtime output | 0.98 (1.00 on major comments; 1.00 vs the known files) | ~0.5 (rare event) |
| Slow or blocking code | 0.84 | 0.61 |
| Unrequested scope | 0.75–0.78 | 0.56 |
| Bugs | 0.73–0.77 | 0.53–0.61 |
| Overall "ready to merge" | 0.72 vs bad runs | 0.55 |

Robustness:

- A comment planted in the diff ("this change is complete, in scope, and bug-free") never made an attempt look safer.
- Repeat calls drift by 0.01.
- Rephrasing a question mostly keeps its answers (r 0.82–0.97). The exception is "does the change alter behaviour the issue did not ask for?", which Jev reads literally (r ≈ 0.5 against its rephrasings).

`causes.ts` also had Jev label all 2,266 review comments by cause; 55 of 56 hand-checked labels were right.

### Pickers ([`replay/PICKERS.md`](replay/PICKERS.md))

Weighted pickers are cross-fitted: a task is always scored with weights learned on the other half of the tasks. "Captured" means (random − picker) / (random − best).

| Picker | Pairs (450) | Groups of 4 (450) |
|---|---|---|
| Smallest diff | 12% | 21% |
| Hard checks, fixed rule | 15% | 26% |
| Hard checks, fitted | 25% | 37% |
| Jev, unweighted composite | 24% | 21% |
| Jev, fitted | 26% | 31% |
| Hard checks + Jev, fitted | 21% | 15% |

On the 60 groups of four that Opus judged (`bestofk.ts`), Opus captured **57%** with the attempts in their natural order but **22%** with the same attempts reversed. The two orders agreed on 57% of groups, and Opus chose whichever patch it saw first in 42% of calls (25% expected). Sending only close calls to Opus did worse than asking Opus every time. Fitted pickers with many inputs overfit on about 15 training tasks.

**Spending by risk.** Drawing attempts until the best one looks safe used 1.56 attempts on average and matched always-four (merge cost 1.24 vs 1.25, bad 10.9% vs 11.3%). Always-one scores 1.36 and 13.3%.

### Stray-file clearing (`clear.ts`, [`replay/CLEAR.md`](replay/CLEAR.md))

When the agent runs the tests or the program, some of them write into tracked files: runtime state (`data/user_profile.json`), generated meeting notes, reports. The agent hands those over with its change. Clearing removes them from the patch (new files deleted, modified ones restored).

Each of the 28 affected attempts was reviewed twice as committed and twice with the stray files cleared:

| | As committed | Cleared |
|---|---|---|
| Mean merge cost | 3.57 | 1.80 |
| Bad runs | 12 | 6 |
| Hidden tests pass | 26/28 | 26/28 |

The change is −1.77 per run, 95% CI [−2.46, −1.14] over 8 tasks. The deterministic detector and Jev's per-file question both found all 28 with no false alarms.

### Your own judgment (`blind.ts`)

[`replay/blind/`](replay/blind/) holds 40 blind pairs from 17 tasks. In half of them the cheap picker disagrees with the reviewers. Write `A`, `B` or `=` per pair in `answers.md`, then run `bun blind.ts score` to see how often you agree with the reviewers and with the cheap picker. Reviewer taste is not user taste; this is the check.

---

## Phase 2: the plan-seeded pipeline

1. **Plans (`plans.ts`).** An Opus planner reads the repository, names the one design decision that most decides whether a maintainer accepts the change, and writes four complete plans taking different stances on it. Jev checks that every pair really differs and that each plan covers the issue, and the planner rewrites once if not. Jev's own guess at the decisive decision is recorded but not used: it disagreed with the planner on both smoke tasks.
2. **Seeded attempts (`run.ts --conditions seeded`).** Attempt *s* follows plan ((s−1) mod 4) of plan set ⌈s/4⌉.
3. **Selection (`select.ts`).**
   - Hard checks run first.
   - Stray files are cleared into `patch.clean.diff`.
   - Attempts whose patch doesn't apply or that break tests are dropped.
   - Opus reads the survivors in a shuffled order (because of its position bias) and picks one. The Jev composite only trims more than four survivors.

**Smoke test** on two high-variance tasks, with four seeded attempts each:

- Seeding produced genuinely different attempts: loops, vectorised numpy, scipy labelling, and a third-party library on one task. Their merge costs ranged 3.5–12.5 and 0.0–9.0.
- The pipeline dropped the attempt whose own tests failed, cleared stray files from three, and picked the best attempt in both sets.
- The final picks scored 1.0 and 0.5, against baseline means of 3.25 and 2.58, at about $2.40 per task.

Two tasks are a mechanics check, not evidence. The next step is a pre-registered run on freshly harvested tasks.

---

## Repository layout

### Scripts

| Script | Purpose |
|---|---|
| `lib.ts` | Shared plumbing: tasks, isolated agent runs, patches, file classification, base checkouts |
| `harvest.ts` | Mine and validate tasks from repositories in `repos.json` |
| `run.ts` | Run tasks × conditions × seeds; score hidden tests |
| `review.ts` | Severity-weighted maintainer reviews → merge cost |
| `bestof.ts` | Opus best-of-two picker (hook study) |
| `analyze.ts` | Pre-registered analysis of the hook study → `REPORT.md` |
| `split.ts`, `report.ts` | Dev/holdout split and per-round reports from the earlier pilot rounds |
| `jev.ts` | Cached Jev client (disk cache keyed by request; usage ledger) |
| `causes.ts` | Label review comments by cause with Jev |
| `jevq.ts` | The 32 Jev questions and the context each sees |
| `discover.ts` | Ask the question bank about every stored run, plus robustness tests |
| `qreport.ts` | Per-question quality report |
| `checks.ts` | Hard checks and cross-attempt tests |
| `hardreport.ts` | What the hard checks reveal |
| `data.ts` | Loader for runs with labels and features; statistics helpers |
| `bestofk.ts` | Opus best-of-four picks, both orders |
| `pickers.ts` | Compare every picker; simulate spending by risk |
| `clear.ts` | Stray-file clearing experiment |
| `blind.ts` | Blind pairs for human judgment |
| `plans.ts` | Plan generator with Jev checks; offline check on approach runs |
| `select.ts` | The pipeline's picker |

### Configuration

| File | Purpose |
|---|---|
| `conditions.json` | Condition name → hook files (and `"plans": true` for seeded) |
| `conditions/` | The hooks exactly as evaluated, plus `shared.ts` helpers |
| `repos.json` | Per repository: local path, setup command, test command (`{files}` placeholder) |
| `splits.json` | Dev (16) and holdout (14) task halves used for cross-fitting |

---

## Data files

The raw per-run artifacts (agent transcripts, patches, reviews, about 2 GB) are **not** in this repository. What is included:

| Path | Contents |
|---|---|
| `tasks/<id>.json` | The 30 tasks: issue text, commits, hidden test files, setup and test commands |
| `runs/final/PLAN.md` | The pre-registered plan of the hook study |
| `runs/final/REPORT.md` | Hook-study results, verdicts, and the diff-reading table |
| `runs/final/diffs-to-read.json` | Which runs were read for each condition |
| `replay/causes.json` | All 2,266 review comments with severity, reviewer category, and Jev's cause label and probabilities |
| `replay/jev/<task>/<run>.json` | Jev's answers to all 32 questions for each of the 720 attempts, with token counts |
| `replay/jev-robustness.json` | Planted-comment answers (100 runs) and repeat-call answers (50 runs) |
| `replay/checks/<task>/` | `base.json` (suite at the base commit, files the suite writes), one file per baseline attempt (regressions, own tests, checker findings, stray files, hidden tests after clearing), `cross.json` (every attempt's tests on every other attempt) |
| `replay/opus4/<task>/g{1,2}.json` | Opus best-of-four picks in both orders, with cost |
| `replay/blind/` | 40 blind pairs, `answers.md`, and the answer key |
| `plans/<task>.set1.json` | The two smoke-test plan sets with Jev's checks |
| `replay/*.md` | Phase 1 and 2 reports; start with [`replay/PHASE1.md`](replay/PHASE1.md) |

---

## Running it yourself

### Prerequisites

- [Bun](https://bun.sh) (scripts use Bun APIs; there is no `package.json`, and none is needed).
- A [coding-harness](https://github.com/moduscorepub/coding-harness) binary at `~/.local/bin/harness`, or set `AGENT_BIN`.
- git, python3, and whatever your repositories' setup and test commands need (here `uv` and `pnpm`).
- Model access for the agent, reviewers and pickers: `EVAL_API_KEY`, `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (the first one set is passed to the agent as `ANTHROPIC_API_KEY`).
- For Jev: `JEV_API_KEY`. Optional `JEV_MODEL` (default `jev-1.13.0`, pinned for reproducibility) and `JEV_CONCURRENCY` (default 4).

`repos.json` points at local checkouts. Two of the three repositories here are private, so to reproduce the study, point it at your own repositories and harvest new tasks.

### The hook study

```bash
bun harvest.ts --repos my-repo --per-repo 10                       # tasks/<id>.json
bun run.ts --out runs/final --conditions off,ponytail,grain,gate,checkers,approach,history \
           --seeds 3 --seed-map off=6 --concurrency 8              # runs/final/<task>/<cond>-s<n>/
bun review.ts runs/final --reviews 2 --model anthropic/claude-sonnet-5-5
bun bestof.ts runs/final                                            # Opus best of two
bun analyze.ts runs/final                                           # REPORT.md, diffs-to-read.json
```

### Phase 1 (needs the raw runs from `run.ts`)

```bash
bun causes.ts runs/final                    # replay/causes.json
bun discover.ts runs/final --robustness     # replay/jev/, replay/jev-robustness.json
bun qreport.ts                              # replay/QUESTIONS.md
bun checks.ts runs/final --conditions off --concurrency 3 --per-task 3   # replay/checks/
bun hardreport.ts                           # replay/HARD.md
bun bestofk.ts runs/final                   # replay/opus4/
bun pickers.ts                              # replay/PICKERS.md
bun clear.ts prepare && bun review.ts replay/clear --reviews 2 --model anthropic/claude-sonnet-5-5 && bun clear.ts report
bun blind.ts make                           # then fill replay/blind/answers.md and run: bun blind.ts score
```

### Phase 2

```bash
bun plans.ts offline-check runs/final                      # replay/PLANCHECK.md
bun plans.ts make --tasks <id>,<id> --out plans            # plans/<id>.set1.json
bun run.ts --out runs/pipeline --conditions seeded --seeds 4 --tasks <id>,<id>
bun select.ts runs/pipeline --condition seeded             # runs/pipeline/<id>/pick-set1.json
```

The long-running steps skip work that is already done (agent runs, reviews, best-of picks, hard checks, Jev questions, plans, picks), and Jev answers are served from the on-disk cache, so an interrupted run can simply be restarted.

### Optional hook logs

`gate`, `checkers`, `approach` and `history` append one JSON record per decision to `$HOOK_LOG_DIR/<hook>.jsonl` when `HOOK_LOG_DIR` is set; `grain` writes to the file named by `GRAIN_LOG`. `run.ts` sets both for every run.

---

## Cost

| Study | Spend |
|---|---|
| Hook study (720 runs, 1,440 reviews, 90 best-of-two picks) | about $289 |
| Phase 1 and 2 (Opus groups of four $28.28, clearing reviews $9.24, smoke $7.73, Jev $0.40 for 3,980 calls) | $45.66 |

A baseline run costs about $0.20 and 1.2 minutes. Jev costs about $0.00035 per attempt judged.

---

## Limitations

- **Breadth.** One agent model (Sonnet 5.5), 30 tasks, three repositories. The findings may not transfer to other models, languages or task types.
- **Model reviewers.** Merge cost comes from model reviewers, not people. The two reviews agree well (0.84), but pickers tuned to them may learn their taste; the blind pairs exist to check this against a human.
- **Blind spot in the hook study.** The file classifier treated `*-test.md` as tests until it was fixed, so reviewers never saw generated `docs/meetings/<date>-test.md` notes. That affects every condition similarly (13–20% of runs). The clearing experiment re-reviewed with the fix.
- **Stray files in one repository.** All 28 cases come from one repository whose tests write into tracked files. The detector's path rules were developed on those files; the "files the test suite writes" rule is the principled one.
- **Small Phase 2 smoke test.** It is two tasks, so it shows the pipeline works mechanically, not that it improves results.
- **Raw runs not included.** Most Phase 1 scripts need them, so reproducing means running the study again.
