# Stray-file clearing

28 baseline runs had stray files. Each was reviewed twice as committed (now with every file visible to the reviewer) and twice with the stray files cleared.

| Measure | As committed | Stray files cleared |
|---|---|---|
| Mean merge cost | 3.57 | 1.80 |
| Bad (merge ≥ 4) | 12 | 6 |
| Hidden tests pass | 26/28 | 26/28 |

Change from clearing: -1.77 per run (95% CI over 8 tasks: [-2.46, -1.14]). The original reviews (which never saw `docs/meetings/*-test.md`) averaged 2.36 on these runs.

| Run | Stray files | Old review | As committed | Cleared |
|---|---|---|---|---|
| forgestream-d49ca481 off-s5 | data/user_profile.json, docs/meetings/2026-10-11-test-arch-report.md, docs/meetings/2026-10-11-test.md | 8.0 | 5.5 | 2.5 |
| forgestream-d49ca481 off-s2 | data/user_profile.json, docs/meetings/2026-10-11-test-arch-report.md, docs/meetings/2026-10-11-test.md | 4.5 | 4.0 | 1.0 |
| forgestream-d49ca481 off-s1 | data/user_profile.json, docs/meetings/2026-10-11-test-arch-report.md, docs/meetings/2026-10-11-test.md | 6.5 | 5.0 | 1.5 |
| forgestream-d49ca481 off-s6 | data/user_profile.json, docs/meetings/2026-10-11-test-arch-report.md, docs/meetings/2026-10-11-test.md | 6.0 | 5.5 | 1.5 |
| forgestream-c8b5bfe7 off-s5 | docs/meetings/2026-10-11-test.md | 4.5 | 5.0 | 4.0 |
| forgestream-c8b5bfe7 off-s1 | docs/meetings/2026-10-11-test.md | 1.0 | 3.0 | 2.0 |
| forgestream-ac0e3178 off-s5 | docs/meetings/2026-10-11-test.md | 0.5 | 2.0 | 0.5 |
| forgestream-ac0e3178 off-s2 | docs/meetings/2026-10-11-test.md | 1.5 | 3.5 | 0.5 |
| forgestream-ac0e3178 off-s3 | docs/meetings/2026-10-11-test.md | 0.0 | 2.0 | 0.5 |
| forgestream-ac0e3178 off-s4 | docs/meetings/2026-10-11-test.md | 1.0 | 5.5 | 1.5 |
| forgestream-ac0e3178 off-s1 | docs/meetings/2026-10-11-test.md | 0.5 | 2.5 | 1.0 |
| forgestream-8699f287 off-s5 | docs/meetings/2026-10-11-test.md | 1.5 | 6.5 | 3.5 |
| forgestream-8699f287 off-s2 | docs/meetings/2026-10-11-test.md | 2.0 | 2.5 | 4.0 |
| forgestream-8699f287 off-s3 | docs/meetings/2026-10-11-test.md | 2.5 | 4.5 | 4.0 |
| forgestream-8699f287 off-s4 | docs/meetings/2026-10-11-test.md | 2.5 | 4.0 | 1.0 |
| forgestream-8699f287 off-s6 | docs/meetings/2026-10-11-test.md | 4.0 | 2.5 | 4.0 |
| forgestream-efd54879 off-s4 | docs/meetings/2026-10-11-test.md | 8.5 | 8.0 | 6.5 |
| forgestream-efd54879 off-s1 | docs/meetings/2026-10-11-test.md | 6.0 | 6.5 | 6.5 |
| forgestream-900fcbb0 off-s2 | docs/meetings/2026-10-11-test.md | 1.0 | 2.0 | 1.0 |
| forgestream-900fcbb0 off-s4 | docs/meetings/2026-10-11-test.md | 1.5 | 2.0 | 1.0 |
| forgestream-900fcbb0 off-s6 | docs/meetings/2026-10-11-test.md | 0.0 | 3.0 | 0.0 |
| forgestream-ae149ba0 off-s5 | docs/meetings/2026-10-11-test.md | 0.0 | 2.0 | 0.0 |
| forgestream-ae149ba0 off-s2 | docs/meetings/2026-10-11-test.md | 0.0 | 2.0 | 0.0 |
| forgestream-ae149ba0 off-s3 | docs/meetings/2026-10-11-test.md | 0.0 | 2.0 | 0.0 |
| forgestream-ae149ba0 off-s4 | docs/meetings/2026-10-11-test.md | 0.0 | 1.5 | 0.0 |
| forgestream-ae149ba0 off-s1 | docs/meetings/2026-10-11-test.md | 0.0 | 1.0 | 0.0 |
| forgestream-ae149ba0 off-s6 | docs/meetings/2026-10-11-test.md | 0.0 | 1.0 | 0.0 |
| forgestream-55dd23a4 off-s2 | docs/meetings/2026-10-11-test.md | 2.5 | 5.5 | 2.5 |
