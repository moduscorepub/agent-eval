# Pair 17 (forgestream-900fcbb0)

Which patch would you merge? Answer in answers.md as `17: A`, `17: B`, or `17: =` if you cannot tell.

## Issue

Add transfer entropy and symmetry scoring to forgestream.emotion

The emotion module has no way to measure directed influence between two speakers' vocal signals, which the symmetry component of rapport scoring needs. Add a new module `forgestream/emotion/transfer_entropy.py` with two public functions.

`compute_transfer_entropy(source: list[float], target: list[float], lag: int = 1, n_bins: int = 8) -> float` returns the transfer entropy from `source` to `target` in bits. The result is never negative. It should be higher for TE(A→B) than TE(B→A) when B is driven by A's previous value. For independent random signals of about 200 samples, it should stay small (under 0.5 bits). If either series is too short to estimate (fewer than `lag + 2` samples, or too few usable samples after lagging), return `0.0`. Unequal-length series are truncated to the shorter one. Constant series and identical series must work and return a value >= 0.

`compute_symmetry(te_a_to_b: float, te_b_to_a: float) -> float` turns the two directional values into a symmetry score. It returns 1.0 when they are equal, and approaches 0.0 as influence becomes fully one-directional. For example, `compute_symmetry(0.5, 0.1)` should be below 0.5. When both values are effectively zero, return 1.0.

## Patch A

```diff
diff --git a/docs/meetings/2026-10-11-test.md b/docs/meetings/2026-10-11-test.md
new file mode 100644
index 0000000..6cf15e8
--- /dev/null
+++ b/docs/meetings/2026-10-11-test.md
@@ -0,0 +1,19 @@
+# Meeting: test
+**Date:** 2026-10-11
+**Claims:** 1
+**E(pi) final:** 0.000
+
+## Knowledge Extracted
+- 1 claims captured
+- 0 verified findings
+- 0 requirements detected
+- 0 artifacts produced
+
+## SOS Status
+- Evaluator weights: see data/weights.json
+- Final E(pi): 0.000
+
+## Human Review Queue
+- [ ] Review detected requirements
+- [ ] Check scaffold artifacts
+- [ ] Promote or archive seeds
\ No newline at end of file
diff --git a/forgestream/emotion/__init__.py b/forgestream/emotion/__init__.py
index 507b9fd..d3e024d 100644
--- a/forgestream/emotion/__init__.py
+++ b/forgestream/emotion/__init__.py
@@ -6,6 +6,7 @@ from .extractor import EmotionExtractor
 from .features import EGeMAPSExtractor, PraatExtractor, ProsodicFeatures
 from .persistence import EmotionCorpus
 from .speaker import SpeakerTimeSeries
+from .transfer_entropy import compute_symmetry, compute_transfer_entropy
 
 __all__ = [
     "AudioRingBuffer",
@@ -17,4 +18,6 @@ __all__ = [
     "PraatExtractor",
     "ProsodicFeatures",
     "SpeakerTimeSeries",
+    "compute_symmetry",
+    "compute_transfer_entropy",
 ]
diff --git a/forgestream/emotion/transfer_entropy.py b/forgestream/emotion/transfer_entropy.py
new file mode 100644
index 0000000..8313c22
--- /dev/null
+++ b/forgestream/emotion/transfer_entropy.py
@@ -0,0 +1,113 @@
+"""Transfer entropy and symmetry scoring for directed vocal influence.
+
+TE(X -> Y) = H(Y_{t+lag} | Y_t) - H(Y_{t+lag} | Y_t, X_t), in bits, using
+equal-frequency binning. The plug-in estimator is strongly positively biased
+for small samples (>1 bit for 8 bins, 200 samples), so the mean TE over
+source-shuffled surrogates is subtracted (effective transfer entropy,
+Marschinski & Kantz 2002) and the result is clamped at 0. Surrogates use a
+fixed seed, so results are deterministic.
+"""
+
+from __future__ import annotations
+
+import math
+
+import numpy as np
+
+MIN_USABLE_SAMPLES = 10
+_SYMMETRY_EPSILON = 1e-9
+_N_SURROGATES = 20
+_SURROGATE_SEED = 0
+
+
+def _discretize(values: np.ndarray, n_bins: int) -> np.ndarray:
+    """Equal-frequency binning to integer labels in [0, n_bins). Constant input -> one bin."""
+    edges = np.quantile(values, np.linspace(0.0, 1.0, n_bins + 1)[1:-1])
+    return np.digitize(values, edges, right=True)
+
+
+def _conditional_entropy(cond: np.ndarray, target: np.ndarray) -> float:
+    """Plug-in H(target | cond) in bits.
+
+    cond and target are 1-D non-negative int arrays of equal length.
+    """
+    n = len(target)
+    joint_key = cond.astype(np.int64) * (int(target.max()) + 1) + target
+    _, joint_counts = np.unique(joint_key, return_counts=True)
+    _, cond_counts = np.unique(cond, return_counts=True)
+
+    def entropy_nats(counts: np.ndarray) -> float:
+        p = counts / n
+        return float(-np.sum(p * np.log(p)))
+
+    return (entropy_nats(joint_counts) - entropy_nats(cond_counts)) / math.log(2.0)
+
+
+def _plugin_te(
+    y_future: np.ndarray, y_past: np.ndarray, x_past: np.ndarray, n_bins: int
+) -> float:
+    joint_past = y_past.astype(np.int64) * n_bins + x_past
+    return _conditional_entropy(y_past, y_future) - _conditional_entropy(
+        joint_past, y_future
+    )
+
+
+def compute_transfer_entropy(
+    source: list[float],
+    target: list[float],
+    lag: int = 1,
+    n_bins: int = 8,
+) -> float:
+    """Transfer entropy from ``source`` to ``target`` in bits (never negative).
+
+    Measures how much ``source[t]`` reduces uncertainty about ``target[t + lag]``
+    beyond what ``target[t]`` already provides. Unequal lengths are truncated to
+    the shorter series. Returns 0.0 when there are too few usable samples.
+    """
+    if lag < 1:
+        raise ValueError("lag must be >= 1")
+    if n_bins < 2:
+        raise ValueError("n_bins must be >= 2")
+
+    n = min(len(source), len(target))
+    if n < lag + 2 or n - lag < MIN_USABLE_SAMPLES:
+        return 0.0
+
+    x = np.asarray(source[:n], dtype=float)
+    y = np.asarray(target[:n], dtype=float)
+    if not (np.all(np.isfinite(x)) and np.all(np.isfinite(y))):
+        raise ValueError("series must contain only finite values")
+
+    xb = _discretize(x, n_bins)
+    yb = _discretize(y, n_bins)
+
+    y_future = yb[lag:]
+    y_past = yb[:-lag]
+    x_past = xb[:-lag]
+
+    observed = _plugin_te(y_future, y_past, x_past, n_bins)
+    rng = np.random.default_rng(_SURROGATE_SEED)
+    bias = float(
+        np.mean(
+            [
+                _plugin_te(y_future, y_past, rng.permutation(x_past), n_bins)
+                for _ in range(_N_SURROGATES)
+            ]
+        )
+    )
+    te = observed - bias
+    return max(0.0, float(te))
+
+
+def compute_symmetry(te_a_to_b: float, te_b_to_a: float) -> float:
+    """Symmetry of bidirectional influence in [0, 1].
+
+    1.0 when equal (or both effectively zero); approaches 0.0 as influence
+    becomes fully one-directional. Computed as min / max.
+    """
+    a = max(0.0, te_a_to_b)
+    b = max(0.0, te_b_to_a)
+    hi = max(a, b)
+    if hi < _SYMMETRY_EPSILON:
+        return 1.0
+    return min(a, b) / hi
diff --git a/tests/emotion/test_transfer_entropy.py b/tests/emotion/test_transfer_entropy.py
new file mode 100644
index 0000000..9a3819e
--- /dev/null
+++ b/tests/emotion/test_transfer_entropy.py
@@ -0,0 +1,63 @@
+import numpy as np
+import pytest
+
+from forgestream.emotion.transfer_entropy import (
+    compute_symmetry,
+    compute_transfer_entropy,
+)
+
+
+def _driven_pair(seed: int = 0, n: int = 200) -> tuple[list[float], list[float]]:
+    rng = np.random.default_rng(seed)
+    a = rng.normal(size=n)
+    b = np.zeros(n)
+    for t in range(1, n):
+        b[t] = 0.8 * a[t - 1] + 0.2 * rng.normal()
+    return a.tolist(), b.tolist()
+
+
+def test_te_directional():
+    a, b = _driven_pair()
+    forward = compute_transfer_entropy(a, b)
+    backward = compute_transfer_entropy(b, a)
+    assert forward > backward
+    assert forward > 0.3
+
+
+def test_te_independent_is_small():
+    for seed in range(10):
+        rng = np.random.default_rng(seed)
+        te = compute_transfer_entropy(
+            rng.normal(size=200).tolist(), rng.normal(size=200).tolist()
+        )
+        assert 0.0 <= te < 0.5
+
+
+def test_te_short_series_returns_zero():
+    assert compute_transfer_entropy([1.0, 2.0], [1.0, 2.0]) == 0.0
+    assert compute_transfer_entropy([], []) == 0.0
+    assert compute_transfer_entropy([1.0] * 3, [1.0] * 100) == 0.0
+
+
+def test_te_unequal_lengths_truncated():
+    a, b = _driven_pair()
+    assert compute_transfer_entropy(a, b) == compute_transfer_entropy(a + [0.0] * 50, b)
+
+
+def test_te_constant_and_identical():
+    assert compute_transfer_entropy([1.0] * 50, [1.0] * 50) == 0.0
+    a, _ = _driven_pair()
+    assert compute_transfer_entropy(a, a) >= 0.0
+
+
+def test_te_rejects_bad_params():
+    with pytest.raises(ValueError):
+        compute_transfer_entropy([1.0] * 50, [1.0] * 50, lag=0)
+
+
+def test_symmetry():
+    assert compute_symmetry(0.3, 0.3) == 1.0
+    assert compute_symmetry(0.0, 0.0) == 1.0
+    assert compute_symmetry(0.5, 0.1) < 0.5
+    assert compute_symmetry(0.5, 0.1) == compute_symmetry(0.1, 0.5)
+    assert compute_symmetry(1.0, 0.0) == 0.0

```

## Patch B

```diff
diff --git a/forgestream/emotion/__init__.py b/forgestream/emotion/__init__.py
index 507b9fd..d3e024d 100644
--- a/forgestream/emotion/__init__.py
+++ b/forgestream/emotion/__init__.py
@@ -6,6 +6,7 @@ from .extractor import EmotionExtractor
 from .features import EGeMAPSExtractor, PraatExtractor, ProsodicFeatures
 from .persistence import EmotionCorpus
 from .speaker import SpeakerTimeSeries
+from .transfer_entropy import compute_symmetry, compute_transfer_entropy
 
 __all__ = [
     "AudioRingBuffer",
@@ -17,4 +18,6 @@ __all__ = [
     "PraatExtractor",
     "ProsodicFeatures",
     "SpeakerTimeSeries",
+    "compute_symmetry",
+    "compute_transfer_entropy",
 ]
diff --git a/forgestream/emotion/transfer_entropy.py b/forgestream/emotion/transfer_entropy.py
new file mode 100644
index 0000000..166eeda
--- /dev/null
+++ b/forgestream/emotion/transfer_entropy.py
@@ -0,0 +1,101 @@
+"""Transfer entropy and symmetry scoring for directed vocal influence.
+
+TE(X→Y) = H(Y_t | Y_{t-lag}) - H(Y_t | Y_{t-lag}, X_{t-lag}), in bits, estimated
+from equal-width discretised series. The plug-in estimator is strongly biased
+upward on short series (n_bins**3 joint cells vs ~200 samples), so the mean TE
+of source-shuffled surrogates (same marginals, no source->target coupling) is
+subtracted and the result clamped at zero.
+"""
+
+from __future__ import annotations
+
+import math
+
+import numpy as np
+
+MIN_SAMPLES = 10
+_N_SURROGATES = 20
+_SURROGATE_SEED = 0
+_EPS = 1e-9
+
+
+def _discretise(x: np.ndarray, n_bins: int) -> np.ndarray:
+    lo, hi = float(x.min()), float(x.max())
+    if not hi > lo:
+        return np.zeros(len(x), dtype=np.int64)
+    idx = np.floor((x - lo) / (hi - lo) * n_bins).astype(np.int64)
+    return np.clip(idx, 0, n_bins - 1)
+
+
+def _entropy_nats(*cols: np.ndarray) -> float:
+    """Plug-in joint entropy (nats) of aligned integer columns."""
+    n = len(cols[0])
+    _, counts = np.unique(np.stack(cols, axis=1), axis=0, return_counts=True)
+    p = counts / n
+    return -float(np.sum(p * np.log(p)))
+
+
+def _plugin_te_nats(y_future: np.ndarray, y_past: np.ndarray, x_past: np.ndarray) -> float:
+    return (
+        _entropy_nats(y_future, y_past)
+        - _entropy_nats(y_past)
+        - _entropy_nats(y_future, y_past, x_past)
+        + _entropy_nats(y_past, x_past)
+    )
+
+
+def compute_transfer_entropy(
+    source: list[float],
+    target: list[float],
+    lag: int = 1,
+    n_bins: int = 8,
+) -> float:
+    """Transfer entropy from `source` to `target` in bits (never negative).
+
+    Returns 0.0 when the series are too short to estimate. Unequal lengths are
+    truncated to the shorter series.
+    """
+    if lag < 1 or n_bins < 1:
+        raise ValueError("lag and n_bins must be >= 1")
+    n = min(len(source), len(target))
+    if n < lag + 2 or n - lag < MIN_SAMPLES:
+        return 0.0
+
+    x = np.asarray(source[:n], dtype=float)
+    y = np.asarray(target[:n], dtype=float)
+    if not (np.isfinite(x).all() and np.isfinite(y).all()):
+        return 0.0
+
+    xd = _discretise(x, n_bins)
+    yd = _discretise(y, n_bins)
+
+    y_future = yd[lag:]
+    y_past = yd[:-lag]
+    x_past = xd[:-lag]
+
+    raw = _plugin_te_nats(y_future, y_past, x_past)
+    rng = np.random.default_rng(_SURROGATE_SEED)
+    bias = float(
+        np.mean(
+            [
+                _plugin_te_nats(y_future, y_past, rng.permutation(x_past))
+                for _ in range(_N_SURROGATES)
+            ]
+        )
+    )
+    te_nats = raw - bias
+    return max(0.0, te_nats / math.log(2))
+
+
+def compute_symmetry(te_a_to_b: float, te_b_to_a: float) -> float:
+    """Symmetry of two directional influences in [0, 1].
+
+    1.0 when equal (or both effectively zero); approaches 0.0 as influence
+    becomes fully one-directional.
+    """
+    a = max(0.0, te_a_to_b)
+    b = max(0.0, te_b_to_a)
+    total = a + b
+    if total < _EPS:
+        return 1.0
+    return 1.0 - abs(a - b) / total
diff --git a/tests/emotion/test_transfer_entropy.py b/tests/emotion/test_transfer_entropy.py
new file mode 100644
index 0000000..f791437
--- /dev/null
+++ b/tests/emotion/test_transfer_entropy.py
@@ -0,0 +1,51 @@
+import numpy as np
+import pytest
+
+from forgestream.emotion.transfer_entropy import (
+    compute_symmetry,
+    compute_transfer_entropy,
+)
+
+
+def _driven_pair(seed: int = 0, n: int = 200):
+    rng = np.random.default_rng(seed)
+    a = rng.normal(size=n)
+    b = np.zeros(n)
+    for t in range(1, n):
+        b[t] = 0.8 * a[t - 1] + 0.2 * rng.normal()
+    return a.tolist(), b.tolist()
+
+
+def test_directionality():
+    a, b = _driven_pair()
+    assert compute_transfer_entropy(a, b) > compute_transfer_entropy(b, a)
+
+
+def test_independent_signals_small():
+    rng = np.random.default_rng(1)
+    a, b = rng.normal(size=200).tolist(), rng.normal(size=200).tolist()
+    assert 0.0 <= compute_transfer_entropy(a, b) < 0.5
+
+
+def test_too_short_returns_zero():
+    assert compute_transfer_entropy([1.0], [1.0]) == 0.0
+    assert compute_transfer_entropy([1.0, 2.0], [2.0, 1.0], lag=1) == 0.0
+    assert compute_transfer_entropy([1.0, 2.0, 3.0], [1.0, 2.0, 3.0], lag=2) == 0.0
+
+
+def test_unequal_lengths_truncated():
+    a, b = _driven_pair()
+    assert compute_transfer_entropy(a, b[:150]) == compute_transfer_entropy(a[:150], b[:150])
+
+
+def test_constant_and_identical():
+    assert compute_transfer_entropy([1.0] * 50, [1.0] * 50) >= 0.0
+    a, _ = _driven_pair()
+    assert compute_transfer_entropy(a, a) >= 0.0
+
+
+def test_symmetry():
+    assert compute_symmetry(0.3, 0.3) == 1.0
+    assert compute_symmetry(0.5, 0.1) < 0.5
+    assert compute_symmetry(0.0, 0.0) == 1.0
+    assert compute_symmetry(1.0, 0.0) == pytest.approx(0.0)

```
