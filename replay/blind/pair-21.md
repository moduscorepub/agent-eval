# Pair 21 (retrieval-harness-255ebb18)

Which patch would you merge? Answer in answers.md as `21: A`, `21: B`, or `21: =` if you cannot tell.

## Issue

Champion gate doesn't enforce all guards; objective recall is judged on the wrong slice

The tuner decides `target_met` with only `holdout recall@k >= target and leakage == 0`. The other guards (`temporal_leakage`, `refusal_integrity`, `priv_block_integrity`) show up in the ledger but are never enforced. A champion that leaks across time, fails refusals, or lets privileged content through can still report "TARGET MET". In grid mode, screening prunes only on `leakage`, so configs with `refusal_integrity < 1.0` also survive to confirmation. Smart mode already prunes on refusal integrity.

Recall is also computed over all pack rows. Graph-shaped and conversational rows drag down or inflate the text retriever's score. When the pack has a `route:retrieval` slice, that slice's recall should be the objective for screening scores, for ranking dev results to pick the champion, and for the final target comparison. Without that slice, overall `recall_at_k` stays the objective.

Add `harness.gates.objective_recall(res: dict) -> float`. It returns the recall from `res["slices"]["route:retrieval"][0]` when that slice exists, otherwise `res["recall_at_k"]`.

Add `harness.gates.champion_gate(res: dict, target: float) -> tuple[bool, list[str]]`. It passes only if all of these hold:
- `leakage == 0`
- `temporal_leakage == 0`
- `refusal_integrity == 1.0`
- `priv_block_integrity == 1.0`
- `objective_recall(res) >= target`

It returns `(passed, reasons)`. `reasons` has one human-readable entry for every failed condition, not just the first, and is empty when the gate passes. Missing guard keys are treated as passing.

Both `tune` and `tune_smart` should compute `target_met` from `champion_gate` on the holdout result and include the reasons in the outcome as `gate_reasons`. The report verdict should list those reasons, for example `WALL: leakage 2 (must be 0); recall 0.880 < target 0.9`. It should fall back to "target not met" when no reasons are present.

## Patch A

```diff
diff --git a/src/harness/gates.py b/src/harness/gates.py
new file mode 100644
index 0000000..95b8b85
--- /dev/null
+++ b/src/harness/gates.py
@@ -0,0 +1,29 @@
+"""Champion gate: every guard must hold and the objective recall must reach
+the target. The objective is the route:retrieval slice when the pack has one,
+so graph and conversational rows never move the text retriever's score."""
+from __future__ import annotations
+
+RETRIEVAL_SLICE = "route:retrieval"
+
+
+def objective_recall(res: dict) -> float:
+    sl = (res.get("slices") or {}).get(RETRIEVAL_SLICE)
+    if sl is not None:
+        return sl[0]
+    return res["recall_at_k"]
+
+
+def champion_gate(res: dict, target: float) -> tuple[bool, list[str]]:
+    reasons: list[str] = []
+    for key in ("leakage", "temporal_leakage"):
+        v = res.get(key, 0)
+        if v != 0:
+            reasons.append(f"{key} {v} (must be 0)")
+    for key in ("refusal_integrity", "priv_block_integrity"):
+        v = res.get(key, 1.0)
+        if v != 1.0:
+            reasons.append(f"{key} {v:.3f} (must be 1.0)")
+    recall = objective_recall(res)
+    if recall < target:
+        reasons.append(f"recall {recall:.3f} < target {target}")
+    return not reasons, reasons
diff --git a/src/harness/report.py b/src/harness/report.py
index ae0ad8a..ae4c9fe 100644
--- a/src/harness/report.py
+++ b/src/harness/report.py
@@ -14,7 +14,11 @@ def write_report(outcome: dict, path: str) -> str:
 
     lines = []
     lines.append("# Retrieval calibration report\n")
-    verdict = "TARGET MET" if outcome["target_met"] else "WALL: target not met"
+    if outcome["target_met"]:
+        verdict = "TARGET MET"
+    else:
+        why = "; ".join(outcome.get("gate_reasons") or []) or "target not met"
+        verdict = f"WALL: {why}"
     lines.append(f"**{verdict}** · target recall@5 ≥ {outcome['target']} · "
                  f"holdout recall@5 = {hold['recall_at_k']:.3f}\n")
 
diff --git a/src/harness/runner.py b/src/harness/runner.py
index 63d730b..72a563b 100644
--- a/src/harness/runner.py
+++ b/src/harness/runner.py
@@ -13,6 +13,7 @@ import time
 from pathlib import Path
 
 from .chunking import chunk_documents
+from .gates import champion_gate, objective_recall
 from .metrics import evaluate
 
 LEDGER_DDL = """
@@ -115,7 +116,7 @@ def tune_smart(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print)
         res = evaluate(screen, retriever, config, index_version, top_k, stype, priv_ids)
         ledger.log(pack_version, index_version, "screen", config, res)
         bad = res["leakage"] > 0 or res["refusal_integrity"] < 1.0
-        score = -1.0 if bad else res["recall_at_k"]
+        score = -1.0 if bad else objective_recall(res)
         proposer.tell(trial, score)
         results.append({"policy": policy, "index_version": index_version,
                         "config": config, "screen": score})
@@ -144,15 +145,16 @@ def tune_smart(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print)
         log(f"  dev {r['index_version']} {json.dumps(r['config'], sort_keys=True)} -> "
             f"recall@{top_k} {res['recall_at_k']:.3f} · mrr {res['mrr']:.3f}")
 
-    confirmed.sort(key=lambda r: (r["dev"]["recall_at_k"], r["dev"]["mrr"]), reverse=True)
+    confirmed.sort(key=lambda r: (objective_recall(r["dev"]), r["dev"]["mrr"]), reverse=True)
     champion = confirmed[0]
     hold = evaluate(holdout, retriever, champion["config"],
                     champion["index_version"], top_k, stype, priv_ids)
     ledger.log(pack_version, champion["index_version"], "holdout",
                champion["config"], hold)
+    met, reasons = champion_gate(hold, target)
     return {
         "champion": champion, "holdout": hold, "target": target,
-        "target_met": hold["recall_at_k"] >= target and hold["leakage"] == 0,
+        "target_met": met, "gate_reasons": reasons,
         "all_dev": [{"config": r["config"], "policy": r["policy"],
                      "recall": r["dev"]["recall_at_k"], "mrr": r["dev"]["mrr"],
                      "p95": r["dev"]["latency_ms_p95"]} for r in confirmed],
@@ -193,8 +195,8 @@ def tune(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print) -> di
                 res = evaluate(screen, retriever, config, index_version, top_k,
                                stype, priv_ids)
                 ledger.log(pack_version, index_version, "screen", config, res)
-                if res["leakage"] == 0:
-                    survivors.append((res["recall_at_k"], config))
+                if res["leakage"] == 0 and res["refusal_integrity"] == 1.0:
+                    survivors.append((objective_recall(res), config))
             survivors.sort(key=lambda x: x[0], reverse=True)
             keep = max(1, int(cfg.get("confirm_top", 3)))
 
@@ -211,16 +213,16 @@ def tune(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print) -> di
     if not results:
         return {"error": "no configs survived screening"}
 
-    results.sort(key=lambda r: (r["dev"]["recall_at_k"], r["dev"]["mrr"]), reverse=True)
+    results.sort(key=lambda r: (objective_recall(r["dev"]), r["dev"]["mrr"]), reverse=True)
     champion = results[0]
     hold = evaluate(holdout, retriever, champion["config"],
                     champion["index_version"], top_k, stype, priv_ids)
     ledger.log(pack_version, champion["index_version"], "holdout",
                champion["config"], hold)
-
+    met, reasons = champion_gate(hold, target)
     return {
         "champion": champion, "holdout": hold, "target": target,
-        "target_met": hold["recall_at_k"] >= target and hold["leakage"] == 0,
+        "target_met": met, "gate_reasons": reasons,
         "all_dev": [{"config": r["config"], "policy": r["policy"],
                      "recall": r["dev"]["recall_at_k"], "mrr": r["dev"]["mrr"],
                      "p95": r["dev"]["latency_ms_p95"]} for r in results],

```

## Patch B

```diff
diff --git a/src/harness/gates.py b/src/harness/gates.py
new file mode 100644
index 0000000..c18fc6b
--- /dev/null
+++ b/src/harness/gates.py
@@ -0,0 +1,29 @@
+"""Champion gate: every guard must hold, and the objective recall (the text
+retriever's own slice when the pack has one) must reach the target."""
+from __future__ import annotations
+
+RETRIEVAL_SLICE = "route:retrieval"
+
+
+def objective_recall(res: dict) -> float:
+    sl = (res.get("slices") or {}).get(RETRIEVAL_SLICE)
+    if sl is not None:
+        return sl[0]
+    return res["recall_at_k"]
+
+
+def champion_gate(res: dict, target: float) -> tuple[bool, list[str]]:
+    reasons: list[str] = []
+    for key, label in (("leakage", "leakage"), ("temporal_leakage", "temporal leakage")):
+        v = res.get(key, 0)
+        if v != 0:
+            reasons.append(f"{label} {v} (must be 0)")
+    for key, label in (("refusal_integrity", "refusal integrity"),
+                       ("priv_block_integrity", "privilege-block integrity")):
+        v = res.get(key, 1.0)
+        if v != 1.0:
+            reasons.append(f"{label} {v:.3f} (must be 1.0)")
+    recall = objective_recall(res)
+    if recall < target:
+        reasons.append(f"recall {recall:.3f} < target {target:g}")
+    return not reasons, reasons
diff --git a/src/harness/report.py b/src/harness/report.py
index ae0ad8a..b523d29 100644
--- a/src/harness/report.py
+++ b/src/harness/report.py
@@ -14,7 +14,9 @@ def write_report(outcome: dict, path: str) -> str:
 
     lines = []
     lines.append("# Retrieval calibration report\n")
-    verdict = "TARGET MET" if outcome["target_met"] else "WALL: target not met"
+    reasons = outcome.get("gate_reasons") or []
+    verdict = ("TARGET MET" if outcome["target_met"]
+               else "WALL: " + ("; ".join(reasons) if reasons else "target not met"))
     lines.append(f"**{verdict}** · target recall@5 ≥ {outcome['target']} · "
                  f"holdout recall@5 = {hold['recall_at_k']:.3f}\n")
 
diff --git a/src/harness/runner.py b/src/harness/runner.py
index 63d730b..6982e1b 100644
--- a/src/harness/runner.py
+++ b/src/harness/runner.py
@@ -13,6 +13,7 @@ import time
 from pathlib import Path
 
 from .chunking import chunk_documents
+from .gates import champion_gate, objective_recall
 from .metrics import evaluate
 
 LEDGER_DDL = """
@@ -115,7 +116,7 @@ def tune_smart(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print)
         res = evaluate(screen, retriever, config, index_version, top_k, stype, priv_ids)
         ledger.log(pack_version, index_version, "screen", config, res)
         bad = res["leakage"] > 0 or res["refusal_integrity"] < 1.0
-        score = -1.0 if bad else res["recall_at_k"]
+        score = -1.0 if bad else objective_recall(res)
         proposer.tell(trial, score)
         results.append({"policy": policy, "index_version": index_version,
                         "config": config, "screen": score})
@@ -144,15 +145,16 @@ def tune_smart(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print)
         log(f"  dev {r['index_version']} {json.dumps(r['config'], sort_keys=True)} -> "
             f"recall@{top_k} {res['recall_at_k']:.3f} · mrr {res['mrr']:.3f}")
 
-    confirmed.sort(key=lambda r: (r["dev"]["recall_at_k"], r["dev"]["mrr"]), reverse=True)
+    confirmed.sort(key=lambda r: (objective_recall(r["dev"]), r["dev"]["mrr"]), reverse=True)
     champion = confirmed[0]
     hold = evaluate(holdout, retriever, champion["config"],
                     champion["index_version"], top_k, stype, priv_ids)
+    passed, reasons = champion_gate(hold, target)
     ledger.log(pack_version, champion["index_version"], "holdout",
                champion["config"], hold)
     return {
         "champion": champion, "holdout": hold, "target": target,
-        "target_met": hold["recall_at_k"] >= target and hold["leakage"] == 0,
+        "target_met": passed, "gate_reasons": reasons,
         "all_dev": [{"config": r["config"], "policy": r["policy"],
                      "recall": r["dev"]["recall_at_k"], "mrr": r["dev"]["mrr"],
                      "p95": r["dev"]["latency_ms_p95"]} for r in confirmed],
@@ -193,8 +195,8 @@ def tune(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print) -> di
                 res = evaluate(screen, retriever, config, index_version, top_k,
                                stype, priv_ids)
                 ledger.log(pack_version, index_version, "screen", config, res)
-                if res["leakage"] == 0:
-                    survivors.append((res["recall_at_k"], config))
+                if res["leakage"] == 0 and res["refusal_integrity"] >= 1.0:
+                    survivors.append((objective_recall(res), config))
             survivors.sort(key=lambda x: x[0], reverse=True)
             keep = max(1, int(cfg.get("confirm_top", 3)))
 
@@ -211,16 +213,17 @@ def tune(docs, pack_rows, retriever, cfg: dict, ledger: Ledger, log=print) -> di
     if not results:
         return {"error": "no configs survived screening"}
 
-    results.sort(key=lambda r: (r["dev"]["recall_at_k"], r["dev"]["mrr"]), reverse=True)
+    results.sort(key=lambda r: (objective_recall(r["dev"]), r["dev"]["mrr"]), reverse=True)
     champion = results[0]
     hold = evaluate(holdout, retriever, champion["config"],
                     champion["index_version"], top_k, stype, priv_ids)
+    passed, reasons = champion_gate(hold, target)
     ledger.log(pack_version, champion["index_version"], "holdout",
                champion["config"], hold)
 
     return {
         "champion": champion, "holdout": hold, "target": target,
-        "target_met": hold["recall_at_k"] >= target and hold["leakage"] == 0,
+        "target_met": passed, "gate_reasons": reasons,
         "all_dev": [{"config": r["config"], "policy": r["policy"],
                      "recall": r["dev"]["recall_at_k"], "mrr": r["dev"]["mrr"],
                      "p95": r["dev"]["latency_ms_p95"]} for r in results],

```
