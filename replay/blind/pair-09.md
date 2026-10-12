# Pair 09 (forgestream-900fcbb0)

Which patch would you merge? Answer in answers.md as `09: A`, `09: B`, or `09: =` if you cannot tell.

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
index 0000000..be3c6eb
--- /dev/null
+++ b/forgestream/emotion/transfer_entropy.py
@@ -0,0 +1,113 @@
+"""Transfer entropy and symmetry scoring for directed vocal influence.
+
+TE(X→Y) = I(Y_{t+lag} ; X_t | Y_t), estimated from histograms over
+equal-width bins, in bits. The plug-in estimate is positively biased for
+short series, so the mean TE of source-shuffled surrogates is subtracted and
+the result is clamped at zero.
+"""
+
+from __future__ import annotations
+
+import numpy as np
+
+# Minimum lagged samples needed for a meaningful histogram estimate.
+MIN_USABLE_SAMPLES = 10
+# Totals at or below this are treated as "no influence" by compute_symmetry.
+_ZERO_EPS = 1e-9
+# Shuffle surrogates used to remove small-sample bias from the TE estimate.
+_N_SURROGATES = 20
+_SURROGATE_SEED = 0
+
+
+def _discretize(values: np.ndarray, n_bins: int) -> np.ndarray:
+    """Map values to integer bins 0..n_bins-1 (equal width over the range)."""
+    lo, hi = float(values.min()), float(values.max())
+    if hi - lo <= 0.0:
+        return np.zeros(len(values), dtype=np.int64)
+    idx = np.floor((values - lo) / (hi - lo) * n_bins).astype(np.int64)
+    return np.clip(idx, 0, n_bins - 1)
+
+
+def _entropy_bits(codes: np.ndarray) -> float:
+    """Plug-in Shannon entropy (bits) of integer-coded samples."""
+    _, counts = np.unique(codes, return_counts=True)
+    p = counts / counts.sum()
+    return float(-(p * np.log2(p)).sum())
+
+
+def _plugin_te(
+    x_past: np.ndarray, y_past: np.ndarray, y_future: np.ndarray, n_bins: int
+) -> float:
+    """Plug-in I(y_future; x_past | y_past) = H(f,p)+H(p,x)-H(p)-H(f,p,x)."""
+    yp_x = y_past * n_bins + x_past
+    f_yp = y_future * n_bins + y_past
+    f_yp_x = f_yp * n_bins + x_past
+    return (
+        _entropy_bits(f_yp)
+        + _entropy_bits(yp_x)
+        - _entropy_bits(y_past)
+        - _entropy_bits(f_yp_x)
+    )
+
+
+def compute_transfer_entropy(
+    source: list[float],
+    target: list[float],
+    lag: int = 1,
+    n_bins: int = 8,
+) -> float:
+    """Transfer entropy from ``source`` to ``target`` in bits (always >= 0).
+
+    Measures how much ``source[t]`` reduces uncertainty about
+    ``target[t + lag]`` beyond what ``target[t]`` already provides.
+    Unequal-length series are truncated to the shorter one. Returns 0.0 when
+    the series are too short to estimate.
+    """
+    if lag < 1 or n_bins < 1:
+        raise ValueError("lag and n_bins must be >= 1")
+
+    n = min(len(source), len(target))
+    if n < lag + 2:
+        return 0.0
+    usable = n - lag
+    if usable < MIN_USABLE_SAMPLES:
+        return 0.0
+
+    x = np.asarray(source[:n], dtype=float)
+    y = np.asarray(target[:n], dtype=float)
+    if not (np.isfinite(x).all() and np.isfinite(y).all()):
+        return 0.0
+
+    xb = _discretize(x, n_bins)
+    yb = _discretize(y, n_bins)
+
+    x_past = xb[:usable]
+    y_past = yb[:usable]
+    y_future = yb[lag:]
+
+    te = _plugin_te(x_past, y_past, y_future, n_bins)
+
+    # Plug-in TE is biased upward (many histogram cells, few samples). Subtract
+    # the mean TE over source-shuffled surrogates, which destroys any x→y
+    # coupling but preserves the same bias. Fixed seed keeps results deterministic.
+    rng = np.random.default_rng(_SURROGATE_SEED)
+    baseline = 0.0
+    for _ in range(_N_SURROGATES):
+        baseline += _plugin_te(rng.permutation(x_past), y_past, y_future, n_bins)
+    te -= baseline / _N_SURROGATES
+
+    return max(0.0, te)
+
+
+def compute_symmetry(te_a_to_b: float, te_b_to_a: float) -> float:
+    """Symmetry of two directional influence values, in [0, 1].
+
+    1.0 when equal (or both effectively zero); approaches 0.0 as influence
+    becomes fully one-directional.
+    """
+    a = max(0.0, te_a_to_b)
+    b = max(0.0, te_b_to_a)
+    total = a + b
+    if total <= _ZERO_EPS:
+        return 1.0
+    return 1.0 - abs(a - b) / total

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
index 0000000..222d51d
--- /dev/null
+++ b/forgestream/emotion/transfer_entropy.py
@@ -0,0 +1,96 @@
+"""Transfer entropy and symmetry scoring for directed vocal influence.
+
+TE(X→Y) = I(Y_t ; X_{t-lag} | Y_{t-1}), estimated on equal-width binned
+series with a shuffle-surrogate bias correction, clipped at zero.
+"""
+
+from __future__ import annotations
+
+import math
+import random
+from collections import Counter
+
+_MIN_SAMPLES = 10
+_N_SURROGATES = 20
+_EPSILON = 1e-9
+
+
+def _discretize(series: list[float], n_bins: int) -> list[int]:
+    lo, hi = min(series), max(series)
+    span = hi - lo
+    if span <= 0.0:
+        return [0] * len(series)
+    return [min(int((v - lo) / span * n_bins), n_bins - 1) for v in series]
+
+
+def _entropy(counts: Counter, n: int) -> float:
+    return -sum((c / n) * math.log2(c / n) for c in counts.values())
+
+
+def _plugin_te(y_f: list[int], y_p: list[int], x_p: list[int]) -> float:
+    m = len(y_f)
+    return (
+        _entropy(Counter(zip(y_f, y_p)), m)
+        - _entropy(Counter(y_p), m)
+        - _entropy(Counter(zip(y_f, y_p, x_p)), m)
+        + _entropy(Counter(zip(y_p, x_p)), m)
+    )
+
+
+def compute_transfer_entropy(
+    source: list[float],
+    target: list[float],
+    lag: int = 1,
+    n_bins: int = 8,
+) -> float:
+    """Transfer entropy from ``source`` to ``target`` in bits (>= 0).
+
+    Returns 0.0 when the series are too short to estimate. Unequal-length
+    series are truncated to the shorter one.
+    """
+    if lag < 1 or n_bins < 1:
+        raise ValueError("lag and n_bins must be >= 1")
+    n = min(len(source), len(target))
+    if n < lag + 2:
+        return 0.0
+
+    x = _discretize([float(v) for v in source[:n]], n_bins)
+    y = _discretize([float(v) for v in target[:n]], n_bins)
+
+    # Y_t (future), Y_{t-1} (past), X_{t-lag} (source), for t in [max(lag,1), n)
+    start = lag
+    m = n - start
+    if m < _MIN_SAMPLES:
+        return 0.0
+
+    y_f = y[start:]
+    y_p = y[start - 1 : n - 1]
+    x_p = x[: m]  # x[t - lag]
+
+    raw = _plugin_te(y_f, y_p, x_p)
+    if raw <= 0.0:
+        return 0.0
+
+    # The plug-in estimator is strongly positively biased for small samples.
+    # Estimate the bias from source-shuffled surrogates (fixed seed: deterministic).
+    rng = random.Random(0)
+    surrogate = x_p[:]
+    bias = 0.0
+    for _ in range(_N_SURROGATES):
+        rng.shuffle(surrogate)
+        bias += _plugin_te(y_f, y_p, surrogate)
+    return max(0.0, raw - bias / _N_SURROGATES)
+
+
+def compute_symmetry(te_a_to_b: float, te_b_to_a: float) -> float:
+    """Symmetry of two directional influences in [0, 1].
+
+    1.0 when equal (or both ~0); approaches 0.0 as influence becomes
+    fully one-directional.
+    """
+    a = max(0.0, te_a_to_b)
+    b = max(0.0, te_b_to_a)
+    total = a + b
+    if total < _EPSILON:
+        return 1.0
+    return 1.0 - abs(a - b) / total
diff --git a/tests/emotion/test_transfer_entropy.py b/tests/emotion/test_transfer_entropy.py
new file mode 100644
index 0000000..2de2ddb
--- /dev/null
+++ b/tests/emotion/test_transfer_entropy.py
@@ -0,0 +1,53 @@
+import random
+
+import pytest
+
+from forgestream.emotion.transfer_entropy import (
+    compute_symmetry,
+    compute_transfer_entropy,
+)
+
+
+def _driven_pair(seed: int = 1, n: int = 200):
+    r = random.Random(seed)
+    a = [r.random() for _ in range(n)]
+    b = [0.0] + [0.8 * a[i] + 0.2 * r.random() for i in range(n - 1)]
+    return a, b
+
+
+def test_directionality():
+    a, b = _driven_pair()
+    assert compute_transfer_entropy(a, b) > compute_transfer_entropy(b, a)
+
+
+def test_independent_signals_small():
+    r = random.Random(7)
+    a = [r.random() for _ in range(200)]
+    b = [r.random() for _ in range(200)]
+    assert 0.0 <= compute_transfer_entropy(a, b) < 0.5
+    assert 0.0 <= compute_transfer_entropy(b, a) < 0.5
+
+
+def test_too_short_returns_zero():
+    assert compute_transfer_entropy([1.0, 2.0], [1.0, 2.0]) == 0.0
+    assert compute_transfer_entropy([1.0] * 5, [2.0] * 5, lag=4) == 0.0
+    assert compute_transfer_entropy([], []) == 0.0
+
+
+def test_unequal_lengths_truncated():
+    a, b = _driven_pair()
+    assert compute_transfer_entropy(a + [0.3] * 50, b) == compute_transfer_entropy(a, b)
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
+    assert compute_symmetry(0.2, 0.7) == compute_symmetry(0.7, 0.2)

```
