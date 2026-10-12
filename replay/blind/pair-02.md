# Pair 02 (forgestream-900fcbb0)

Which patch would you merge? Answer in answers.md as `02: A`, `02: B`, or `02: =` if you cannot tell.

## Issue

Add transfer entropy and symmetry scoring to forgestream.emotion

The emotion module has no way to measure directed influence between two speakers' vocal signals, which the symmetry component of rapport scoring needs. Add a new module `forgestream/emotion/transfer_entropy.py` with two public functions.

`compute_transfer_entropy(source: list[float], target: list[float], lag: int = 1, n_bins: int = 8) -> float` returns the transfer entropy from `source` to `target` in bits. The result is never negative. It should be higher for TE(A→B) than TE(B→A) when B is driven by A's previous value. For independent random signals of about 200 samples, it should stay small (under 0.5 bits). If either series is too short to estimate (fewer than `lag + 2` samples, or too few usable samples after lagging), return `0.0`. Unequal-length series are truncated to the shorter one. Constant series and identical series must work and return a value >= 0.

`compute_symmetry(te_a_to_b: float, te_b_to_a: float) -> float` turns the two directional values into a symmetry score. It returns 1.0 when they are equal, and approaches 0.0 as influence becomes fully one-directional. For example, `compute_symmetry(0.5, 0.1)` should be below 0.5. When both values are effectively zero, return 1.0.

## Patch A

```diff
diff --git a/forgestream/emotion/transfer_entropy.py b/forgestream/emotion/transfer_entropy.py
new file mode 100644
index 0000000..ee0b820
--- /dev/null
+++ b/forgestream/emotion/transfer_entropy.py
@@ -0,0 +1,98 @@
+"""Transfer entropy and symmetry scoring for directed vocal influence.
+
+TE(source -> target) = I(target[t+lag] ; source[t] | target[t]), in bits,
+estimated on quantile-binned series. The plug-in estimator is heavily biased
+upward for short series, so the mean TE over shuffled-source surrogates
+(which destroy any source->target coupling) is subtracted ("effective TE"),
+and the result is clamped at zero.
+"""
+
+from __future__ import annotations
+
+import math
+
+import numpy as np
+
+# Minimum number of lagged samples needed for a meaningful estimate.
+MIN_USABLE_SAMPLES = 10
+_EPS = 1e-9
+_N_SURROGATES = 20
+_SURROGATE_SEED = 0
+
+
+def _discretize(x: np.ndarray, n_bins: int) -> np.ndarray:
+    """Quantile-bin x into at most n_bins integer symbols (constant -> all 0)."""
+    edges = np.unique(np.quantile(x, np.linspace(0.0, 1.0, n_bins + 1)[1:-1]))
+    return np.digitize(x, edges).astype(np.int64)
+
+
+def _entropy(*symbols: np.ndarray) -> float:
+    """Plug-in joint Shannon entropy (bits) of aligned symbol arrays."""
+    n = len(symbols[0])
+    _, counts = np.unique(np.stack(symbols, axis=1), axis=0, return_counts=True)
+    p = counts / n
+    return -float(np.sum(p * np.log2(p)))
+
+
+def _plugin_te(s: np.ndarray, y_past: np.ndarray, y_future: np.ndarray) -> float:
+    return (
+        _entropy(y_future, y_past)
+        + _entropy(y_past, s)
+        - _entropy(y_past)
+        - _entropy(y_future, y_past, s)
+    )
+
+
+def compute_transfer_entropy(
+    source: list[float],
+    target: list[float],
+    lag: int = 1,
+    n_bins: int = 8,
+) -> float:
+    """Transfer entropy from source to target in bits (>= 0).
+
+    Measures how much source[t] reduces uncertainty about target[t + lag]
+    beyond what target[t] already explains. Series are truncated to the
+    shorter length. Returns 0.0 when there are too few samples.
+    """
+    n = min(len(source), len(target))
+    if lag < 1 or n_bins < 2 or n < lag + 2 or n - lag < MIN_USABLE_SAMPLES:
+        return 0.0
+
+    src = np.asarray(source[:n], dtype=float)
+    tgt = np.asarray(target[:n], dtype=float)
+    if not (np.all(np.isfinite(src)) and np.all(np.isfinite(tgt))):
+        return 0.0
+
+    y = _discretize(tgt, n_bins)
+    s = _discretize(src, n_bins)[:-lag]
+    y_past, y_future = y[:-lag], y[lag:]
+
+    te = _plugin_te(s, y_past, y_future)
+    if te <= _EPS:
+        return 0.0
+    rng = np.random.default_rng(_SURROGATE_SEED)
+    bias = float(
+        np.mean(
+            [
+                _plugin_te(rng.permutation(s), y_past, y_future)
+                for _ in range(_N_SURROGATES)
+            ]
+        )
+    )
+    te -= bias
+    return max(0.0, float(te))
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
+    return max(0.0, min(1.0, 1.0 - abs(a - b) / total))
diff --git a/tests/emotion/test_transfer_entropy.py b/tests/emotion/test_transfer_entropy.py
new file mode 100644
index 0000000..cbcc657
--- /dev/null
+++ b/tests/emotion/test_transfer_entropy.py
@@ -0,0 +1,53 @@
+import numpy as np
+import pytest
+
+from forgestream.emotion.transfer_entropy import (
+    compute_symmetry,
+    compute_transfer_entropy,
+)
+
+
+def _driven_pair(n=200, seed=1):
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
+    assert compute_transfer_entropy(a, b) > compute_transfer_entropy(b, a)
+
+
+def test_te_independent_small():
+    rng = np.random.default_rng(0)
+    a, b = rng.normal(size=200).tolist(), rng.normal(size=200).tolist()
+    assert 0.0 <= compute_transfer_entropy(a, b) < 0.5
+    assert 0.0 <= compute_transfer_entropy(b, a) < 0.5
+
+
+def test_te_too_short_returns_zero():
+    assert compute_transfer_entropy([1.0], [1.0]) == 0.0
+    assert compute_transfer_entropy([1.0, 2.0], [2.0, 1.0], lag=1) == 0.0
+    assert compute_transfer_entropy([], []) == 0.0
+
+
+def test_te_unequal_lengths_truncated():
+    a, b = _driven_pair()
+    assert compute_transfer_entropy(a, b[:120]) == compute_transfer_entropy(a[:120], b[:120])
+
+
+def test_te_constant_and_identical_nonnegative():
+    assert compute_transfer_entropy([1.0] * 50, [1.0] * 50) >= 0.0
+    a, _ = _driven_pair()
+    assert compute_transfer_entropy(a, a) >= 0.0
+
+
+def test_symmetry():
+    assert compute_symmetry(0.3, 0.3) == 1.0
+    assert compute_symmetry(0.5, 0.1) < 0.5
+    assert compute_symmetry(1.0, 0.0) == pytest.approx(0.0)
+    assert compute_symmetry(0.0, 0.0) == 1.0
+    assert compute_symmetry(0.5, 0.1) == compute_symmetry(0.1, 0.5)

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
