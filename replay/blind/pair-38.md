# Pair 38 (retrieval-harness-4803c24f)

Which patch would you merge? Answer in answers.md as `38: A`, `38: B`, or `38: =` if you cannot tell.

## Issue

Calibration picks its refusal threshold on holdout, and serving applies it to configs it wasn't trained for

The calibration run trains on all of dev, then chooses the refusal threshold (`chosen_tau`) from the holdout operating curve. The holdout "gate" is therefore judged on data that selected the threshold, so the reported refusal precision and sacrifice are optimistic. The threshold should be chosen on a slice that holdout never touches. Dev should split deterministically (by qid hash, roughly one in four rows) into train and calibration. The model should train on train, and tau should be chosen on the calibration slice. Holdout should then be evaluated once, at that fixed tau. `run_calibration` should accept `top_k: int = 5` and record `top_k`, `temporal`, the cal curve, the holdout curve, and the holdout metrics at the chosen tau in the artifact.

Serving has a second problem. `/search` applies the loaded calibration artifact to any request. That includes requests with a different embedder, alpha, fetch_k, rerank, top_k, or temporal setting, such as the lexical-only fallback. Scores and refusals from those requests are meaningless. The artifact should apply only to the configuration it was trained under. Otherwise the response should be uncalibrated: no answerability score and no refusals. Legacy artifacts without `temporal` or `top_k` should still be bound to their own config.

Requested interface:
- `cal_split(rows) -> (train, cal)`: deterministic, disjoint, with `cal` about 25% of rows.
- `point_at_tau(model, x, y, tau) -> dict`: returns `tau`, `coverage`, `refusal_precision`, `sacrifice` and `answer_precision` at one fixed threshold.
- `calibration_applies(calib, cfg, embedder, temporal, top_k) -> bool`: false for a missing artifact or any mismatch in the fields above.

The search response config should report `calibration: "bound"` or `"unbound"`. The working panel should show a note when the calibration is unbound: confidence is withheld and nothing refuses.

## Patch A

```diff
diff --git a/src/harness/calibrate.py b/src/harness/calibrate.py
index 769b397..b375d90 100644
--- a/src/harness/calibrate.py
+++ b/src/harness/calibrate.py
@@ -10,12 +10,14 @@ refusal precision (of what it refuses, how much deserved refusal), sacrifice
 """
 from __future__ import annotations
 
+import hashlib
 import json
 import time
 from pathlib import Path
 
 import numpy as np
 
+from .db import is_temporal
 from .metrics import evaluate  # noqa: F401  (kept: same eval semantics anchor)
 from .ports import QueryContext
 
@@ -71,21 +73,62 @@ def predict(model: dict, feats: dict[str, float]) -> float:
     return 1.0 / (1.0 + np.exp(-z))
 
 
-def operating_curve(model: dict, x: np.ndarray, y: np.ndarray) -> list[dict]:
+def _probs(model: dict, x: np.ndarray) -> np.ndarray:
     xs = (x - np.array(model["mean"])) / np.array(model["std"])
-    p = 1.0 / (1.0 + np.exp(-(xs @ np.array(model["weights"]) + model["bias"])))
-    curve = []
-    for tau in np.unique(np.round(np.percentile(p, np.arange(2, 99, 4)), 4)):
-        refused = p < tau
-        n_ref = int(refused.sum())
-        curve.append({
-            "tau": float(tau),
-            "coverage": float((~refused).mean()),
-            "refusal_precision": float((y[refused] == 0).mean()) if n_ref else 1.0,
-            "sacrifice": float(refused[y == 1].mean()) if (y == 1).any() else 0.0,
-            "answer_precision": float((y[~refused] == 1).mean()) if (~refused).any() else 0.0,
-        })
-    return curve
+    return 1.0 / (1.0 + np.exp(-(xs @ np.array(model["weights"]) + model["bias"])))
+
+
+def point_at_tau(model: dict, x: np.ndarray, y: np.ndarray, tau: float) -> dict:
+    """Operating metrics at one fixed threshold; refuses when p < tau."""
+    refused = _probs(model, x) < tau
+    n_ref = int(refused.sum())
+    return {
+        "tau": float(tau),
+        "coverage": float((~refused).mean()),
+        "refusal_precision": float((y[refused] == 0).mean()) if n_ref else 1.0,
+        "sacrifice": float(refused[y == 1].mean()) if (y == 1).any() else 0.0,
+        "answer_precision": float((y[~refused] == 1).mean()) if (~refused).any() else 0.0,
+    }
+
+
+def operating_curve(model: dict, x: np.ndarray, y: np.ndarray) -> list[dict]:
+    p = _probs(model, x)
+    return [point_at_tau(model, x, y, tau)
+            for tau in np.unique(np.round(np.percentile(p, np.arange(2, 99, 4)), 4))]
+
+
+CAL_MODULUS = 4
+
+
+def cal_split(rows: list[dict]) -> tuple[list[dict], list[dict]]:
+    """Deterministic qid-hash split of dev: about one row in four goes to
+    calibration (tau selection), the rest trains the model."""
+    train, cal = [], []
+    for r in rows:
+        h = int.from_bytes(hashlib.sha256(str(r["qid"]).encode()).digest()[:8], "big")
+        (cal if h % CAL_MODULUS == 0 else train).append(r)
+    return train, cal
+
+
+def calibration_applies(calib: dict | None, cfg: dict, embedder: str,
+                        temporal: bool, top_k: int) -> bool:
+    """The artifact is valid only for the configuration it was trained under.
+    Legacy artifacts predate `temporal` and `top_k`; they were trained on a
+    plain index at top_k=5."""
+    if not calib:
+        return False
+    c = calib.get("config") or {}
+    if c.get("embedder") != embedder or cfg.get("embedder", embedder) != embedder:
+        return False
+    if float(c.get("alpha", 0.3)) != float(cfg.get("alpha", 0.3)):
+        return False
+    if c.get("fetch_k") != cfg.get("fetch_k"):
+        return False
+    if (c.get("rerank") or "none") != (cfg.get("rerank") or "none"):
+        return False
+    if int(calib.get("top_k", 5)) != int(top_k):
+        return False
+    return bool(calib.get("temporal", False)) == bool(temporal)
 
 
 def pick_tau(curve: list[dict], min_refusal_precision: float = 0.95,
@@ -97,29 +140,42 @@ def pick_tau(curve: list[dict], min_refusal_precision: float = 0.95,
 
 
 def run_calibration(pack_rows: list[dict], retriever, config: dict,
-                    index_version: str, out_dir: str, log=print) -> dict:
+                    index_version: str, out_dir: str, log=print,
+                    top_k: int = 5) -> dict:
     dev = [r for r in pack_rows if r["split"] == "dev"
            and r.get("variant", "raw") == "raw"]
     hold = [r for r in pack_rows if r["split"] == "holdout"
             and r.get("variant", "raw") == "raw"]
-    log(f"calibration: collecting features on {len(dev)} dev / {len(hold)} holdout rows")
-    x_dev, y_dev, _ = collect(dev, retriever, config, index_version)
-    x_hold, y_hold, _ = collect(hold, retriever, config, index_version)
-
-    model = train_logistic(x_dev, y_dev)
+    train, cal = cal_split(dev)
+    if not train or not cal:
+        raise ValueError(f"dev split is degenerate: {len(train)} train / {len(cal)} cal rows")
+    log(f"calibration: collecting features on {len(train)} train / {len(cal)} cal "
+        f"/ {len(hold)} holdout rows")
+    x_train, y_train, _ = collect(train, retriever, config, index_version, top_k)
+    x_cal, y_cal, _ = collect(cal, retriever, config, index_version, top_k)
+    x_hold, y_hold, _ = collect(hold, retriever, config, index_version, top_k)
+
+    model = train_logistic(x_train, y_train)
+    cal_curve = operating_curve(model, x_cal, y_cal)
+    chosen = pick_tau(cal_curve)
     hold_curve = operating_curve(model, x_hold, y_hold)
-    chosen = pick_tau(hold_curve)
+    hold_at_tau = point_at_tau(model, x_hold, y_hold, chosen["tau"]) if chosen else None
 
     artifact = {
-        "dev_curve": operating_curve(model, x_dev, y_dev),
+        "dev_curve": operating_curve(model, x_train, y_train),
         "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
-        "trained_on": {"dev_rows": len(dev), "positives": int(y_dev.sum())},
+        "trained_on": {"dev_rows": len(train), "positives": int(y_train.sum()),
+                       "cal_rows": len(cal)},
         "config": {k: v for k, v in config.items() if k != "bundle"},
+        "top_k": top_k,
+        "temporal": is_temporal(index_version),
         "index_version": index_version,
         **model,
+        "cal_curve": cal_curve,
         "holdout_curve": hold_curve,
         "chosen_tau": chosen["tau"] if chosen else None,
         "chosen_point": chosen,
+        "holdout_at_tau": hold_at_tau,
     }
     Path(out_dir).mkdir(parents=True, exist_ok=True)
     Path(out_dir, "calibration.json").write_text(json.dumps(artifact, indent=2))
@@ -127,16 +183,24 @@ def run_calibration(pack_rows: list[dict], retriever, config: dict,
     stable.mkdir(exist_ok=True)
     (stable / "calibration.json").write_text(json.dumps(artifact, indent=2))
 
-    log("\nholdout operating curve (tau · coverage · refusal precision · sacrifice):")
-    for c in hold_curve:
+    log("\ncalibration-slice operating curve (tau · coverage · refusal precision · sacrifice):")
+    for c in cal_curve:
         marker = "  <-- chosen" if chosen and c["tau"] == chosen["tau"] else ""
         log(f"  {c['tau']:.4f} · {c['coverage']:.2f} · "
             f"{c['refusal_precision']:.2f} · {c['sacrifice']:.2f}{marker}")
-    if chosen:
-        log(f"\nGATE PASSED: tau={chosen['tau']:.4f} refuses with precision "
-            f"{chosen['refusal_precision']:.2f} at sacrifice {chosen['sacrifice']:.2f}, "
-            f"coverage {chosen['coverage']:.2f}")
+    if chosen and hold_at_tau:
+        log(f"\nchosen on cal: tau={chosen['tau']:.4f} precision "
+            f"{chosen['refusal_precision']:.2f} sacrifice {chosen['sacrifice']:.2f}")
+        log(f"holdout at that tau (evaluated once): refusal precision "
+            f"{hold_at_tau['refusal_precision']:.2f}, sacrifice "
+            f"{hold_at_tau['sacrifice']:.2f}, coverage {hold_at_tau['coverage']:.2f}")
+        if (hold_at_tau["refusal_precision"] >= 0.95
+                and hold_at_tau["sacrifice"] <= 0.10):
+            log("GATE PASSED on holdout")
+        else:
+            log("GATE WALL: the cal-chosen tau does not hold on holdout.")
     else:
-        log("\nGATE WALL: no threshold meets precision >= 0.95 at sacrifice <= 0.10. "
-            "The honest curve ships; see holdout_curve in the artifact.")
+        log("\nGATE WALL: no threshold meets precision >= 0.95 at sacrifice <= 0.10 "
+            "on the calibration slice. The honest curves ship; see cal_curve and "
+            "holdout_curve in the artifact.")
     return artifact
diff --git a/src/harness/cli.py b/src/harness/cli.py
index 4bd5948..bb50663 100644
--- a/src/harness/cli.py
+++ b/src/harness/cli.py
@@ -184,7 +184,7 @@ def cmd_calibrate(args) -> None:
     retriever.index(chunk_documents(docs, policy), index_version, embedder)
     stamp = time.strftime("%Y%m%d-%H%M%S")
     run_calibration(rows, retriever, config, index_version,
-                    str(ROOT / "runs" / stamp))
+                    str(ROOT / "runs" / stamp), top_k=int(cfg.get("top_k", 5)))
 
 
 def cmd_serve(args) -> None:
diff --git a/src/harness/serve.py b/src/harness/serve.py
index 7de94c9..d847c98 100644
--- a/src/harness/serve.py
+++ b/src/harness/serve.py
@@ -82,30 +82,32 @@ def api_search(req: SearchRequest) -> SearchResponse:
     ctx = QueryContext(can_see_privileged=req.can_see_privileged,
                        as_known_at=req.as_known_at,
                        temporal_mode=req.temporal_mode)
+    from .calibrate import calibration_applies, predict
     from .db import is_temporal
     temporal = is_temporal(req.index_version)
     t0 = time.perf_counter()
-    answerability: float | None = None
-    refused = False
 
     def _run(cfg: dict):
-        if _calibration:
+        # the artifact scores only the config it was trained under; anything
+        # else (lexical fallback, other alpha/fetch/rerank/top_k/temporal)
+        # is served uncalibrated: no score, no refusals
+        if calibration_applies(_calibration, cfg, embedder, temporal, req.top_k):
             h, feats = _retriever.search_with_features(
                 req.query, cfg, ctx, req.index_version, top_k=req.top_k)
-            from .calibrate import predict
             a = round(predict(_calibration, feats), 3)
             tau = _calibration.get("chosen_tau")
-            return h, a, bool(tau is not None and a < tau)
+            return h, a, bool(tau is not None and a < tau), "bound"
         return (_retriever.search(req.query, cfg, ctx, req.index_version,
-                                  top_k=req.top_k), None, False)
+                                  top_k=req.top_k), None, False, "unbound")
 
     try:
-        hits, answerability, refused = _run(config)
+        hits, answerability, refused, bound = _run(config)
     except RuntimeError as e:
         # the embedder tier is unreachable (relay down, key missing): degrade
         # to the lexical arm with the reason on record instead of failing
         config = {**config, "alpha": 0.0, "degraded": f"lexical-only: {e}"}
-        hits, answerability, refused = _run(config)
+        hits, answerability, refused, bound = _run(config)
+    config = {**config, "calibration": bound}
     # bundles and the graph panel are temporal-aware; the door applies at T
     graph_panel = _graph_panel(req.query, req.index_version, ctx)
     bundles: list = []
diff --git a/tests/test_calibrate_split.py b/tests/test_calibrate_split.py
new file mode 100644
index 0000000..825119c
--- /dev/null
+++ b/tests/test_calibrate_split.py
@@ -0,0 +1,38 @@
+import numpy as np
+
+from harness.calibrate import (cal_split, calibration_applies, point_at_tau,
+                               train_logistic)
+
+
+def test_cal_split_is_deterministic_disjoint_and_about_a_quarter():
+    rows = [{"qid": f"q{i}"} for i in range(400)]
+    train, cal = cal_split(rows)
+    assert (train, cal) == cal_split(list(rows))
+    assert not {r["qid"] for r in train} & {r["qid"] for r in cal}
+    assert len(train) + len(cal) == len(rows)
+    assert 0.18 < len(cal) / len(rows) < 0.32
+
+
+def test_point_at_tau_refuses_below_threshold():
+    x = np.linspace(0, 1, 40).reshape(-1, 1)
+    y = (x[:, 0] > 0.5).astype(float)
+    m = train_logistic(x, y)
+    lo = point_at_tau(m, x, y, 0.0)
+    assert lo["coverage"] == 1.0 and lo["sacrifice"] == 0.0
+    hi = point_at_tau(m, x, y, 0.999999)
+    assert hi["coverage"] == 0.0 and hi["sacrifice"] == 1.0
+
+
+def test_calibration_binds_to_its_own_config():
+    cfg = {"alpha": 0.3, "fetch_k": 50, "rerank": "none", "embedder": "hash"}
+    calib = {"config": cfg}  # legacy: no temporal / top_k
+    assert calibration_applies(calib, cfg, "hash", False, 5)
+    assert not calibration_applies(None, cfg, "hash", False, 5)
+    assert not calibration_applies(calib, {**cfg, "alpha": 0.0}, "hash", False, 5)
+    assert not calibration_applies(calib, {**cfg, "fetch_k": 20}, "hash", False, 5)
+    assert not calibration_applies(calib, {**cfg, "rerank": "st:x@10"}, "hash", False, 5)
+    assert not calibration_applies(calib, cfg, "openai:m", False, 5)
+    assert not calibration_applies(calib, cfg, "hash", True, 5)
+    assert not calibration_applies(calib, cfg, "hash", False, 3)
+    assert calibration_applies({**calib, "top_k": 3, "temporal": True},
+                               cfg, "hash", True, 3)
diff --git a/web/src/components/WorkingPanel.tsx b/web/src/components/WorkingPanel.tsx
index 3c62bfe..f91f99b 100644
--- a/web/src/components/WorkingPanel.tsx
+++ b/web/src/components/WorkingPanel.tsx
@@ -59,6 +59,13 @@ export default function WorkingPanel({ exchange }: { exchange: Exchange }) {
           }
         />
       )}
+      {cfg.calibration === "unbound" && (
+        <Row
+          k="calibration"
+          v="unbound to this search config · confidence is withheld and nothing refuses"
+          cls="bad"
+        />
+      )}
       {blocked !== undefined && (
         <Row
           k="the door"

```

## Patch B

```diff
diff --git a/src/harness/calibrate.py b/src/harness/calibrate.py
index 769b397..2fe26ed 100644
--- a/src/harness/calibrate.py
+++ b/src/harness/calibrate.py
@@ -10,6 +10,7 @@ refusal precision (of what it refuses, how much deserved refusal), sacrifice
 """
 from __future__ import annotations
 
+import hashlib
 import json
 import time
 from pathlib import Path
@@ -71,21 +72,32 @@ def predict(model: dict, feats: dict[str, float]) -> float:
     return 1.0 / (1.0 + np.exp(-z))
 
 
-def operating_curve(model: dict, x: np.ndarray, y: np.ndarray) -> list[dict]:
+def _probs(model: dict, x: np.ndarray) -> np.ndarray:
     xs = (x - np.array(model["mean"])) / np.array(model["std"])
-    p = 1.0 / (1.0 + np.exp(-(xs @ np.array(model["weights"]) + model["bias"])))
-    curve = []
-    for tau in np.unique(np.round(np.percentile(p, np.arange(2, 99, 4)), 4)):
-        refused = p < tau
-        n_ref = int(refused.sum())
-        curve.append({
-            "tau": float(tau),
-            "coverage": float((~refused).mean()),
-            "refusal_precision": float((y[refused] == 0).mean()) if n_ref else 1.0,
-            "sacrifice": float(refused[y == 1].mean()) if (y == 1).any() else 0.0,
-            "answer_precision": float((y[~refused] == 1).mean()) if (~refused).any() else 0.0,
-        })
-    return curve
+    return 1.0 / (1.0 + np.exp(-(xs @ np.array(model["weights"]) + model["bias"])))
+
+
+def _point(p: np.ndarray, y: np.ndarray, tau: float) -> dict:
+    refused = p < tau
+    n_ref = int(refused.sum())
+    return {
+        "tau": float(tau),
+        "coverage": float((~refused).mean()),
+        "refusal_precision": float((y[refused] == 0).mean()) if n_ref else 1.0,
+        "sacrifice": float(refused[y == 1].mean()) if (y == 1).any() else 0.0,
+        "answer_precision": float((y[~refused] == 1).mean()) if (~refused).any() else 0.0,
+    }
+
+
+def operating_curve(model: dict, x: np.ndarray, y: np.ndarray) -> list[dict]:
+    p = _probs(model, x)
+    return [_point(p, y, tau)
+            for tau in np.unique(np.round(np.percentile(p, np.arange(2, 99, 4)), 4))]
+
+
+def point_at_tau(model: dict, x: np.ndarray, y: np.ndarray, tau: float) -> dict:
+    """Metrics at one fixed threshold: how a tau chosen elsewhere behaves here."""
+    return _point(_probs(model, x), y, tau)
 
 
 def pick_tau(curve: list[dict], min_refusal_precision: float = 0.95,
@@ -96,29 +108,75 @@ def pick_tau(curve: list[dict], min_refusal_precision: float = 0.95,
     return max(ok, key=lambda c: c["tau"]) if ok else None
 
 
+def cal_split(rows: list[dict]) -> tuple[list[dict], list[dict]]:
+    """Deterministic dev split by qid hash: about one row in four goes to the
+    calibration slice (picks tau), the rest trains the model. Holdout never
+    enters either."""
+    train, cal = [], []
+    for r in rows:
+        h = int.from_bytes(hashlib.sha256(str(r["qid"]).encode()).digest()[:8], "big")
+        (cal if h % 4 == 0 else train).append(r)
+    return train, cal
+
+
+# the fields that tie an artifact to the retrieval setup it was trained under
+_BOUND_CONFIG = ("alpha", "fetch_k", "rerank")
+_LEGACY_TOP_K = 5      # artifacts written before top_k was recorded used collect's default
+
+
+def calibration_applies(calib: dict | None, cfg: dict, embedder: str,
+                        temporal: bool, top_k: int) -> bool:
+    """True only when the request runs under the configuration the artifact was
+    trained on. Anywhere else its scores and refusals are meaningless."""
+    if not calib:
+        return False
+    trained = calib.get("config") or {}
+    if trained.get("embedder") != embedder:
+        return False
+    if any(trained.get(k) != cfg.get(k) for k in _BOUND_CONFIG):
+        return False
+    if bool(calib.get("temporal", False)) != bool(temporal):
+        return False
+    return int(calib.get("top_k", _LEGACY_TOP_K)) == int(top_k)
+
+
 def run_calibration(pack_rows: list[dict], retriever, config: dict,
-                    index_version: str, out_dir: str, log=print) -> dict:
+                    index_version: str, out_dir: str, log=print,
+                    top_k: int = 5) -> dict:
+    from .db import is_temporal
+
     dev = [r for r in pack_rows if r["split"] == "dev"
            and r.get("variant", "raw") == "raw"]
     hold = [r for r in pack_rows if r["split"] == "holdout"
             and r.get("variant", "raw") == "raw"]
-    log(f"calibration: collecting features on {len(dev)} dev / {len(hold)} holdout rows")
-    x_dev, y_dev, _ = collect(dev, retriever, config, index_version)
-    x_hold, y_hold, _ = collect(hold, retriever, config, index_version)
-
-    model = train_logistic(x_dev, y_dev)
+    train, cal = cal_split(dev)
+    log(f"calibration: collecting features on {len(train)} train / {len(cal)} cal "
+        f"/ {len(hold)} holdout rows")
+    x_train, y_train, _ = collect(train, retriever, config, index_version, top_k)
+    x_cal, y_cal, _ = collect(cal, retriever, config, index_version, top_k)
+    x_hold, y_hold, _ = collect(hold, retriever, config, index_version, top_k)
+
+    model = train_logistic(x_train, y_train)
+    cal_curve = operating_curve(model, x_cal, y_cal)
+    cal_point = pick_tau(cal_curve)
+    tau = cal_point["tau"] if cal_point else None
     hold_curve = operating_curve(model, x_hold, y_hold)
-    chosen = pick_tau(hold_curve)
+    # holdout is read once, at the tau the calibration slice chose
+    chosen = point_at_tau(model, x_hold, y_hold, tau) if tau is not None else None
 
     artifact = {
-        "dev_curve": operating_curve(model, x_dev, y_dev),
         "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
-        "trained_on": {"dev_rows": len(dev), "positives": int(y_dev.sum())},
+        "trained_on": {"train_rows": len(train), "positives": int(y_train.sum()),
+                       "cal_rows": len(cal), "holdout_rows": len(hold)},
         "config": {k: v for k, v in config.items() if k != "bundle"},
+        "top_k": top_k,
+        "temporal": is_temporal(index_version),
         "index_version": index_version,
         **model,
+        "cal_curve": cal_curve,
+        "cal_point": cal_point,
         "holdout_curve": hold_curve,
-        "chosen_tau": chosen["tau"] if chosen else None,
+        "chosen_tau": tau,
         "chosen_point": chosen,
     }
     Path(out_dir).mkdir(parents=True, exist_ok=True)
@@ -127,16 +185,21 @@ def run_calibration(pack_rows: list[dict], retriever, config: dict,
     stable.mkdir(exist_ok=True)
     (stable / "calibration.json").write_text(json.dumps(artifact, indent=2))
 
-    log("\nholdout operating curve (tau · coverage · refusal precision · sacrifice):")
-    for c in hold_curve:
-        marker = "  <-- chosen" if chosen and c["tau"] == chosen["tau"] else ""
+    log("\ncalibration-slice operating curve (tau · coverage · refusal precision · sacrifice):")
+    for c in cal_curve:
+        marker = "  <-- chosen" if cal_point and c["tau"] == tau else ""
         log(f"  {c['tau']:.4f} · {c['coverage']:.2f} · "
             f"{c['refusal_precision']:.2f} · {c['sacrifice']:.2f}{marker}")
-    if chosen:
-        log(f"\nGATE PASSED: tau={chosen['tau']:.4f} refuses with precision "
-            f"{chosen['refusal_precision']:.2f} at sacrifice {chosen['sacrifice']:.2f}, "
-            f"coverage {chosen['coverage']:.2f}")
+    if chosen and chosen["refusal_precision"] >= 0.95 and chosen["sacrifice"] <= 0.10:
+        log(f"\nGATE PASSED on holdout at the fixed tau={chosen['tau']:.4f}: refuses with "
+            f"precision {chosen['refusal_precision']:.2f} at sacrifice "
+            f"{chosen['sacrifice']:.2f}, coverage {chosen['coverage']:.2f}")
+    elif chosen:
+        log(f"\nGATE WALL: tau={chosen['tau']:.4f} met the bar on the calibration slice "
+            f"but holdout shows precision {chosen['refusal_precision']:.2f} at sacrifice "
+            f"{chosen['sacrifice']:.2f}, coverage {chosen['coverage']:.2f}")
     else:
-        log("\nGATE WALL: no threshold meets precision >= 0.95 at sacrifice <= 0.10. "
-            "The honest curve ships; see holdout_curve in the artifact.")
+        log("\nGATE WALL: no threshold on the calibration slice meets precision >= 0.95 "
+            "at sacrifice <= 0.10. The honest curves ship; see cal_curve and "
+            "holdout_curve in the artifact.")
     return artifact
diff --git a/src/harness/serve.py b/src/harness/serve.py
index 7de94c9..f1258c8 100644
--- a/src/harness/serve.py
+++ b/src/harness/serve.py
@@ -85,27 +85,26 @@ def api_search(req: SearchRequest) -> SearchResponse:
     from .db import is_temporal
     temporal = is_temporal(req.index_version)
     t0 = time.perf_counter()
-    answerability: float | None = None
-    refused = False
 
     def _run(cfg: dict):
-        if _calibration:
+        from .calibrate import calibration_applies, predict
+        if calibration_applies(_calibration, cfg, embedder, temporal, req.top_k):
             h, feats = _retriever.search_with_features(
                 req.query, cfg, ctx, req.index_version, top_k=req.top_k)
-            from .calibrate import predict
             a = round(predict(_calibration, feats), 3)
             tau = _calibration.get("chosen_tau")
-            return h, a, bool(tau is not None and a < tau)
+            return h, a, bool(tau is not None and a < tau), "bound"
         return (_retriever.search(req.query, cfg, ctx, req.index_version,
-                                  top_k=req.top_k), None, False)
+                                  top_k=req.top_k), None, False, "unbound")
 
     try:
-        hits, answerability, refused = _run(config)
+        hits, answerability, refused, calibration = _run(config)
     except RuntimeError as e:
         # the embedder tier is unreachable (relay down, key missing): degrade
         # to the lexical arm with the reason on record instead of failing
         config = {**config, "alpha": 0.0, "degraded": f"lexical-only: {e}"}
-        hits, answerability, refused = _run(config)
+        hits, answerability, refused, calibration = _run(config)
+    config = {**config, "calibration": calibration}
     # bundles and the graph panel are temporal-aware; the door applies at T
     graph_panel = _graph_panel(req.query, req.index_version, ctx)
     bundles: list = []
diff --git a/tests/test_calibrate.py b/tests/test_calibrate.py
new file mode 100644
index 0000000..a3e3d75
--- /dev/null
+++ b/tests/test_calibrate.py
@@ -0,0 +1,57 @@
+import numpy as np
+
+from harness.calibrate import (
+    cal_split,
+    calibration_applies,
+    operating_curve,
+    point_at_tau,
+    train_logistic,
+)
+
+
+def test_cal_split_is_deterministic_disjoint_and_about_a_quarter():
+    rows = [{"qid": f"q{i}"} for i in range(2000)]
+    train, cal = cal_split(rows)
+    assert (train, cal) == cal_split(rows)
+    assert {r["qid"] for r in train}.isdisjoint(r["qid"] for r in cal)
+    assert len(train) + len(cal) == len(rows)
+    assert 0.20 < len(cal) / len(rows) < 0.30
+    # membership depends on the qid alone, not on neighbours or order
+    _, cal_rev = cal_split(rows[::-1])
+    assert {r["qid"] for r in cal_rev} == {r["qid"] for r in cal}
+
+
+def test_point_at_tau_matches_the_curve_point_at_that_threshold():
+    rng = np.random.default_rng(0)
+    x = rng.normal(size=(300, 3))
+    y = (x[:, 0] + 0.3 * rng.normal(size=300) > 0).astype(float)
+    model = train_logistic(x, y)
+    for c in operating_curve(model, x, y)[:5]:
+        assert point_at_tau(model, x, y, c["tau"]) == c
+    p = point_at_tau(model, x, y, 0.5)
+    assert p["tau"] == 0.5
+    assert set(p) == {"tau", "coverage", "refusal_precision", "sacrifice",
+                      "answer_precision"}
+
+
+CALIB = {"config": {"alpha": 0.3, "fetch_k": 50, "rerank": "none", "embedder": "hash"},
+         "top_k": 5, "temporal": False}
+CFG = {"alpha": 0.3, "fetch_k": 50, "rerank": "none", "embedder": "hash"}
+
+
+def test_calibration_applies_only_to_its_own_configuration():
+    assert calibration_applies(CALIB, CFG, "hash", False, 5)
+    assert not calibration_applies(None, CFG, "hash", False, 5)
+    assert not calibration_applies(CALIB, CFG, "openai:x", False, 5)
+    assert not calibration_applies(CALIB, {**CFG, "alpha": 0.0}, "hash", False, 5)
+    assert not calibration_applies(CALIB, {**CFG, "fetch_k": 20}, "hash", False, 5)
+    assert not calibration_applies(CALIB, {**CFG, "rerank": "st:m@10"}, "hash", False, 5)
+    assert not calibration_applies(CALIB, CFG, "hash", True, 5)
+    assert not calibration_applies(CALIB, CFG, "hash", False, 10)
+
+
+def test_legacy_artifact_binds_to_plain_index_and_top_five():
+    legacy = {"config": CALIB["config"]}
+    assert calibration_applies(legacy, CFG, "hash", False, 5)
+    assert not calibration_applies(legacy, CFG, "hash", True, 5)
+    assert not calibration_applies(legacy, CFG, "hash", False, 3)
diff --git a/web/src/components/WorkingPanel.tsx b/web/src/components/WorkingPanel.tsx
index 3c62bfe..a6c0303 100644
--- a/web/src/components/WorkingPanel.tsx
+++ b/web/src/components/WorkingPanel.tsx
@@ -49,6 +49,13 @@ export default function WorkingPanel({ exchange }: { exchange: Exchange }) {
           v={`${exchange.asOf.slice(0, 10)} · ${exchange.audit ? "audit" : "disclosure safe"}`}
         />
       )}
+      {cfg.calibration === "unbound" && (
+        <Row
+          k="calibration"
+          v="unbound: this search ran outside the configuration the calibration was trained on, so confidence is withheld and nothing refuses"
+          cls="bad"
+        />
+      )}
       {conf !== null && (
         <Row
           k="answerability"

```
