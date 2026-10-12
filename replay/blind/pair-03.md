# Pair 03 (forgestream-c8b5bfe7)

Which patch would you merge? Answer in answers.md as `03: A`, `03: B`, or `03: =` if you cannot tell.

## Issue

Title: Add CRQAComputeRouter to route CRQA computation to RunPod with local fallback and circuit breaker

The emotion pipeline needs a way to compute cross-recurrence quantification analysis (CRQA) metrics between two F0 (pitch) series. Surrogate-validated results should come from a remote RunPod GPU endpoint. If that endpoint is missing or failing, the pipeline should fall back to a local CPU computation instead of erroring.

Add `forgestream.emotion.crqa_router` with a `CRQAResult` dataclass and a `CRQAComputeRouter` class.

`CRQAResult` has the fields `det`, `tt`, `entr`, `lam`, `rr` (floats) and `surrogate_validated: bool = False`.

`CRQAComputeRouter(runpod_endpoint: str = "", timeout: float = 4.0)` exposes `async compute(f0_a: list[float], f0_b: list[float], embedding_dim: int = 3, time_delay: int = 2, radius: float = 0.25) -> CRQAResult`.

Behavior:
- **Short input:** if either series has fewer than 10 samples, return an all-zero result without calling anything remote.
- **No endpoint:** with an empty `runpod_endpoint`, always compute locally. The local result has `surrogate_validated=False`, a non-negative `det`, and `det`, `lam`, `rr` derived from the recurrence matrix of the standardized series.
- **Endpoint set:** POST to `{endpoint}/crqa/validate` with the two series and the params, including 20 surrogates. A successful response gives `surrogate_validated=True`. In that case `det` and `tt` are reported only when the response marks them significant, and are 0.0 otherwise.
- **Failure:** on any request error or timeout, log a warning and return the local result (`surrogate_validated=False`).
- **Circuit breaker:** after 3 consecutive RunPod failures the circuit opens. For the next 5 `compute` calls, RunPod is skipped and the local path is used. After those skips, RunPod is tried again. A successful RunPod call resets the failure count and closes the circuit.

The breaker state is tracked on the router as `_consecutive_failures`, `_circuit_open`, and `_skip_remaining`. Callers and tooling may read or set these attributes.

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
diff --git a/forgestream/emotion/crqa_router.py b/forgestream/emotion/crqa_router.py
new file mode 100644
index 0000000..9fe2a8a
--- /dev/null
+++ b/forgestream/emotion/crqa_router.py
@@ -0,0 +1,218 @@
+"""CRQA compute router with RunPod GPU and local CPU fallback.
+
+Routes CRQA computation to a RunPod serverless endpoint for surrogate-
+validated results. Falls back to local numpy CRQA (without surrogates)
+when RunPod is unavailable. A circuit breaker prevents hammering a dead
+endpoint.
+"""
+
+from __future__ import annotations
+
+import logging
+from dataclasses import dataclass
+
+import numpy as np
+
+logger = logging.getLogger(__name__)
+
+MIN_SAMPLES = 10             # shorter series return an all-zero result
+N_SURROGATES = 20            # surrogates requested from RunPod
+CIRCUIT_OPEN_THRESHOLD = 3   # consecutive failures before circuit opens
+CIRCUIT_SKIP_CYCLES = 5      # compute calls to skip before retrying RunPod
+
+
+@dataclass
+class CRQAResult:
+    """Result of a CRQA computation."""
+
+    det: float              # determinism
+    tt: float               # trapping time
+    entr: float             # diagonal entropy
+    lam: float              # laminarity
+    rr: float               # recurrence rate
+    surrogate_validated: bool = False
+
+
+def _zero_result() -> CRQAResult:
+    return CRQAResult(det=0.0, tt=0.0, entr=0.0, lam=0.0, rr=0.0)
+
+
+class CRQAComputeRouter:
+    """Routes CRQA computation to RunPod or local fallback.
+
+    Parameters:
+        runpod_endpoint: URL of the RunPod CRQA endpoint. Empty = local only.
+        timeout: Per-request timeout in seconds.
+    """
+
+    def __init__(
+        self,
+        runpod_endpoint: str = "",
+        timeout: float = 4.0,
+    ) -> None:
+        self._endpoint = runpod_endpoint
+        self._timeout = timeout
+        self._consecutive_failures = 0
+        self._circuit_open = False
+        self._skip_remaining = 0
+
+    async def compute(
+        self,
+        f0_a: list[float],
+        f0_b: list[float],
+        embedding_dim: int = 3,
+        time_delay: int = 2,
+        radius: float = 0.25,
+    ) -> CRQAResult:
+        """Compute CRQA metrics, routing to RunPod or local fallback."""
+        if len(f0_a) < MIN_SAMPLES or len(f0_b) < MIN_SAMPLES:
+            return _zero_result()
+
+        if self._endpoint and not self._should_skip():
+            try:
+                result = await self._runpod_compute(
+                    f0_a, f0_b, embedding_dim, time_delay, radius
+                )
+            except Exception as e:
+                logger.warning("RunPod CRQA failed: %s", e)
+                self._consecutive_failures += 1
+                if self._consecutive_failures >= CIRCUIT_OPEN_THRESHOLD:
+                    self._circuit_open = True
+                    self._skip_remaining = CIRCUIT_SKIP_CYCLES
+                    logger.info(
+                        "CRQA circuit breaker opened after %d failures",
+                        self._consecutive_failures,
+                    )
+            else:
+                self._consecutive_failures = 0
+                self._circuit_open = False
+                self._skip_remaining = 0
+                return result
+
+        return self._local_compute(f0_a, f0_b, radius)
+
+    def _should_skip(self) -> bool:
+        """True while the circuit is open and skip cycles remain."""
+        if not self._circuit_open:
+            return False
+        if self._skip_remaining > 0:
+            self._skip_remaining -= 1
+            return True
+        # Skip period expired: half-open, try RunPod again.
+        return False
+
+    async def _runpod_compute(
+        self,
+        f0_a: list[float],
+        f0_b: list[float],
+        embedding_dim: int,
+        time_delay: int,
+        radius: float,
+    ) -> CRQAResult:
+        """Send CRQA request to the RunPod endpoint."""
+        import httpx
+
+        async with httpx.AsyncClient(timeout=self._timeout) as client:
+            response = await client.post(
+                f"{self._endpoint}/crqa/validate",
+                json={
+                    "f0_a": f0_a,
+                    "f0_b": f0_b,
+                    "params": {
+                        "embedding_dim": embedding_dim,
+                        "time_delay": time_delay,
+                        "radius": radius,
+                        "n_surrogates": N_SURROGATES,
+                    },
+                },
+            )
+            response.raise_for_status()
+            data = response.json()
+
+        real = data["real"]
+        sig = data.get("significant", {})
+
+        return CRQAResult(
+            det=real["det"] if sig.get("det", False) else 0.0,
+            tt=real["tt"] if sig.get("tt", False) else 0.0,
+            entr=real.get("entr", 0.0),
+            lam=real.get("lam", 0.0),
+            rr=real.get("rr", 0.0),
+            surrogate_validated=True,
+        )
+
+    def _local_compute(
+        self,
+        f0_a: list[float],
+        f0_b: list[float],
+        radius: float = 0.25,
+    ) -> CRQAResult:
+        """Local CPU CRQA (no surrogates)."""
+        a = np.array(f0_a, dtype=np.float64)
+        b = np.array(f0_b, dtype=np.float64)
+
+        if a.std() > 0:
+            a = (a - a.mean()) / a.std()
+        if b.std() > 0:
+            b = (b - b.mean()) / b.std()
+
+        combined_std = np.std(np.concatenate([a, b]))
+        if combined_std < 1e-10:
+            return _zero_result()
+
+        threshold = radius * combined_std * 3  # wider radius for local
+        recurrence = np.abs(a[:, None] - b[None, :]) < threshold
+
+        return CRQAResult(
+            det=self._compute_determinism(recurrence),
+            tt=0.0,
+            entr=0.0,
+            lam=self._compute_laminarity(recurrence),
+            rr=float(np.mean(recurrence)),
+            surrogate_validated=False,
+        )
+
+    @staticmethod
+    def _compute_determinism(recurrence: np.ndarray) -> float:
+        """%DET: proportion of recurrence points on diagonal lines >= 2."""
+        n_rows, n_cols = recurrence.shape
+        total_recurrent = int(recurrence.sum())
+        if total_recurrent == 0:
+            return 0.0
+
+        diagonal_points = 0
+        for offset in range(-n_rows + 1, n_cols):
+            line_length = 0
+            for val in np.diagonal(recurrence, offset=offset):
+                if val:
+                    line_length += 1
+                else:
+                    if line_length >= 2:
+                        diagonal_points += line_length
+                    line_length = 0
+            if line_length >= 2:
+                diagonal_points += line_length
+
+        return min(1.0, diagonal_points / total_recurrent)
+
+    @staticmethod
+    def _compute_laminarity(recurrence: np.ndarray) -> float:
+        """%LAM: proportion of recurrence points on vertical lines >= 2."""
+        total_recurrent = int(recurrence.sum())
+        if total_recurrent == 0:
+            return 0.0
+
+        vertical_points = 0
+        for col in range(recurrence.shape[1]):
+            line_length = 0
+            for val in recurrence[:, col]:
+                if val:
+                    line_length += 1
+                else:
+                    if line_length >= 2:
+                        vertical_points += line_length
+                    line_length = 0
+            if line_length >= 2:
+                vertical_points += line_length
+
+        return min(1.0, vertical_points / total_recurrent)
diff --git a/pyproject.toml b/pyproject.toml
index 9726d88..6cf6973 100644
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -18,6 +18,7 @@ emotion = [
     "opensmile>=2.5",
     "praat-parselmouth>=0.4",
     "numpy>=1.26",
+    "httpx>=0.27",
 ]
 emotion-ml = [
     "forgestream[emotion]",
diff --git a/tests/emotion/test_crqa_router.py b/tests/emotion/test_crqa_router.py
new file mode 100644
index 0000000..878763c
--- /dev/null
+++ b/tests/emotion/test_crqa_router.py
@@ -0,0 +1,85 @@
+from unittest.mock import AsyncMock, MagicMock, patch
+
+import httpx
+import numpy as np
+
+from forgestream.emotion.crqa_router import CRQAComputeRouter, CRQAResult
+
+SIGNAL = [float(x) for x in np.sin(np.linspace(0, 4 * np.pi, 60))]
+
+
+def _client(post: AsyncMock) -> MagicMock:
+    client = MagicMock()
+    client.__aenter__ = AsyncMock(return_value=client)
+    client.__aexit__ = AsyncMock(return_value=False)
+    client.post = post
+    return client
+
+
+def _ok(payload: dict[str, object]) -> AsyncMock:
+    resp = MagicMock()
+    resp.raise_for_status = MagicMock()
+    resp.json = MagicMock(return_value=payload)
+    return AsyncMock(return_value=resp)
+
+
+async def test_short_input_returns_zeros_without_remote_call():
+    router = CRQAComputeRouter(runpod_endpoint="http://x")
+    with patch("httpx.AsyncClient") as cls:
+        result = await router.compute([1.0] * 9, SIGNAL)
+    cls.assert_not_called()
+    assert result == CRQAResult(0.0, 0.0, 0.0, 0.0, 0.0)
+
+
+async def test_local_only_when_no_endpoint():
+    result = await CRQAComputeRouter().compute(SIGNAL, SIGNAL)
+    assert result.surrogate_validated is False
+    assert result.det >= 0.0
+    assert result.rr > 0.0
+
+
+async def test_runpod_success_gates_det_tt_on_significance():
+    post = _ok({
+        "real": {"det": 0.7, "tt": 3.0, "entr": 1.1, "lam": 0.4, "rr": 0.05},
+        "significant": {"det": True, "tt": False},
+    })
+    router = CRQAComputeRouter(runpod_endpoint="http://x")
+    with patch("httpx.AsyncClient", return_value=_client(post)):
+        result = await router.compute(SIGNAL, SIGNAL)
+    assert result.surrogate_validated is True
+    assert (result.det, result.tt) == (0.7, 0.0)
+    assert (result.entr, result.lam, result.rr) == (1.1, 0.4, 0.05)
+    url = post.call_args.args[0]
+    body = post.call_args.kwargs["json"]
+    assert url == "http://x/crqa/validate"
+    assert body["params"]["n_surrogates"] == 20
+
+
+async def test_circuit_opens_skips_five_then_retries():
+    post = AsyncMock(side_effect=httpx.ConnectError("down"))
+    router = CRQAComputeRouter(runpod_endpoint="http://x")
+    with patch("httpx.AsyncClient", return_value=_client(post)):
+        for _ in range(3):
+            r = await router.compute(SIGNAL, SIGNAL)
+            assert r.surrogate_validated is False
+        assert router._circuit_open is True
+        assert post.await_count == 3
+        for _ in range(5):
+            r = await router.compute(SIGNAL, SIGNAL)
+            assert r.surrogate_validated is False
+        assert post.await_count == 3  # all skipped
+        await router.compute(SIGNAL, SIGNAL)
+        assert post.await_count == 4  # retried
+
+
+async def test_success_closes_circuit():
+    router = CRQAComputeRouter(runpod_endpoint="http://x")
+    router._consecutive_failures = 3
+    router._circuit_open = True
+    router._skip_remaining = 0
+    post = _ok({"real": {"det": 0.5, "tt": 2.0}, "significant": {}})
+    with patch("httpx.AsyncClient", return_value=_client(post)):
+        result = await router.compute(SIGNAL, SIGNAL)
+    assert result.surrogate_validated is True
+    assert router._consecutive_failures == 0
+    assert router._circuit_open is False

```

## Patch B

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
diff --git a/forgestream/emotion/crqa_router.py b/forgestream/emotion/crqa_router.py
new file mode 100644
index 0000000..11398c2
--- /dev/null
+++ b/forgestream/emotion/crqa_router.py
@@ -0,0 +1,203 @@
+"""CRQA compute router with RunPod GPU and local CPU fallback.
+
+Routes CRQA computation to a RunPod serverless endpoint for surrogate-
+validated results. Falls back to local numpy CRQA (without surrogates)
+when RunPod is unavailable. A circuit breaker prevents hammering a dead
+endpoint.
+"""
+
+from __future__ import annotations
+
+import asyncio
+import logging
+from dataclasses import dataclass
+
+import httpx
+import numpy as np
+
+logger = logging.getLogger(__name__)
+
+MIN_SAMPLES = 10             # shorter series return an all-zero result
+N_SURROGATES = 20            # surrogates requested from RunPod
+CIRCUIT_OPEN_THRESHOLD = 3   # consecutive failures before circuit opens
+CIRCUIT_SKIP_CYCLES = 5      # compute() calls that skip RunPod once open
+
+
+@dataclass
+class CRQAResult:
+    """Result of a CRQA computation."""
+
+    det: float              # determinism
+    tt: float               # trapping time
+    entr: float             # diagonal entropy
+    lam: float              # laminarity
+    rr: float               # recurrence rate
+    surrogate_validated: bool = False
+
+
+class CRQAComputeRouter:
+    """Routes CRQA computation to RunPod or local fallback.
+
+    Parameters:
+        runpod_endpoint: Base URL of the RunPod CRQA endpoint. Empty = local only.
+        timeout: Per-request timeout in seconds.
+    """
+
+    def __init__(
+        self,
+        runpod_endpoint: str = "",
+        timeout: float = 4.0,
+    ) -> None:
+        self._endpoint = runpod_endpoint
+        self._timeout = timeout
+        self._consecutive_failures = 0
+        self._circuit_open = False
+        self._skip_remaining = 0
+
+    async def compute(
+        self,
+        f0_a: list[float],
+        f0_b: list[float],
+        embedding_dim: int = 3,
+        time_delay: int = 2,
+        radius: float = 0.25,
+    ) -> CRQAResult:
+        """Compute CRQA metrics, routing to RunPod or local fallback."""
+        if len(f0_a) < MIN_SAMPLES or len(f0_b) < MIN_SAMPLES:
+            return CRQAResult(det=0.0, tt=0.0, entr=0.0, lam=0.0, rr=0.0)
+
+        if self._endpoint and not self._should_skip():
+            try:
+                result = await self._runpod_compute(
+                    f0_a, f0_b, embedding_dim, time_delay, radius
+                )
+            except Exception as e:  # any request/parse error or timeout
+                logger.warning("RunPod CRQA failed: %r", e)
+                self._consecutive_failures += 1
+                if self._consecutive_failures >= CIRCUIT_OPEN_THRESHOLD:
+                    self._circuit_open = True
+                    self._skip_remaining = CIRCUIT_SKIP_CYCLES
+                    logger.info(
+                        "CRQA circuit breaker open after %d failures",
+                        self._consecutive_failures,
+                    )
+            else:
+                self._consecutive_failures = 0
+                self._circuit_open = False
+                self._skip_remaining = 0
+                return result
+
+        return await asyncio.to_thread(self._local_compute, f0_a, f0_b, radius)
+
+    def _should_skip(self) -> bool:
+        """True while the circuit is open and skip budget remains."""
+        if not self._circuit_open:
+            return False
+        if self._skip_remaining > 0:
+            self._skip_remaining -= 1
+            return True
+        return False  # skip period over: try RunPod again
+
+    async def _runpod_compute(
+        self,
+        f0_a: list[float],
+        f0_b: list[float],
+        embedding_dim: int,
+        time_delay: int,
+        radius: float,
+    ) -> CRQAResult:
+        """Send CRQA request to RunPod endpoint."""
+        async with httpx.AsyncClient(timeout=self._timeout) as client:
+            response = await client.post(
+                f"{self._endpoint}/crqa/validate",
+                json={
+                    "f0_a": f0_a,
+                    "f0_b": f0_b,
+                    "params": {
+                        "embedding_dim": embedding_dim,
+                        "time_delay": time_delay,
+                        "radius": radius,
+                        "n_surrogates": N_SURROGATES,
+                    },
+                },
+            )
+            response.raise_for_status()
+            data = response.json()
+
+        real = data["real"]
+        sig = data.get("significant", {})
+
+        return CRQAResult(
+            det=real["det"] if sig.get("det", False) else 0.0,
+            tt=real["tt"] if sig.get("tt", False) else 0.0,
+            entr=real.get("entr", 0.0),
+            lam=real.get("lam", 0.0),
+            rr=real.get("rr", 0.0),
+            surrogate_validated=True,
+        )
+
+    def _local_compute(
+        self,
+        f0_a: list[float],
+        f0_b: list[float],
+        radius: float = 0.25,
+    ) -> CRQAResult:
+        """Local CPU CRQA (no surrogates) on standardized series."""
+        a = np.array(f0_a, dtype=np.float64)
+        b = np.array(f0_b, dtype=np.float64)
+
+        if a.std() > 0:
+            a = (a - a.mean()) / a.std()
+        if b.std() > 0:
+            b = (b - b.mean()) / b.std()
+
+        combined_std = np.std(np.concatenate([a, b]))
+        if combined_std < 1e-10:
+            return CRQAResult(det=0.0, tt=0.0, entr=0.0, lam=0.0, rr=0.0)
+
+        threshold = radius * combined_std * 3  # wider radius for local
+        recurrence = np.abs(a[:, None] - b[None, :]) < threshold
+
+        return CRQAResult(
+            det=self._compute_determinism(recurrence),
+            tt=0.0,
+            entr=0.0,
+            lam=self._compute_laminarity(recurrence),
+            rr=float(np.mean(recurrence)),
+            surrogate_validated=False,
+        )
+
+    @staticmethod
+    def _compute_determinism(recurrence: np.ndarray) -> float:
+        """%DET: share of recurrence points on diagonal lines of length >= 2."""
+        total = int(recurrence.sum())
+        if total == 0:
+            return 0.0
+
+        n_rows, n_cols = recurrence.shape
+        diagonal_points = 0
+        for offset in range(-n_rows + 1, n_cols):
+            diagonal_points += _points_on_lines(np.diagonal(recurrence, offset=offset))
+
+        return min(1.0, diagonal_points / total)
+
+    @staticmethod
+    def _compute_laminarity(recurrence: np.ndarray) -> float:
+        """%LAM: share of recurrence points on vertical lines of length >= 2."""
+        total = int(recurrence.sum())
+        if total == 0:
+            return 0.0
+
+        vertical_points = 0
+        for col in range(recurrence.shape[1]):
+            vertical_points += _points_on_lines(recurrence[:, col])
+
+        return min(1.0, vertical_points / total)
+
+
+def _points_on_lines(line: np.ndarray, min_length: int = 2) -> int:
+    """Count True cells in runs of True with length >= min_length."""
+    padded = np.concatenate(([False], line.astype(bool), [False]))
+    edges = np.flatnonzero(padded[1:] != padded[:-1])
+    lengths = edges[1::2] - edges[0::2]
+    return int(lengths[lengths >= min_length].sum())
diff --git a/pyproject.toml b/pyproject.toml
index 9726d88..6cf6973 100644
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -18,6 +18,7 @@ emotion = [
     "opensmile>=2.5",
     "praat-parselmouth>=0.4",
     "numpy>=1.26",
+    "httpx>=0.27",
 ]
 emotion-ml = [
     "forgestream[emotion]",
diff --git a/tests/emotion/test_crqa_router.py b/tests/emotion/test_crqa_router.py
new file mode 100644
index 0000000..21770d5
--- /dev/null
+++ b/tests/emotion/test_crqa_router.py
@@ -0,0 +1,108 @@
+"""Tests for CRQAComputeRouter — RunPod/local routing + circuit breaker."""
+
+from unittest.mock import AsyncMock, MagicMock, patch
+
+import httpx
+import numpy as np
+import pytest
+
+from forgestream.emotion.crqa_router import CRQAComputeRouter, CRQAResult
+
+SIGNAL = [float(x) for x in np.sin(np.linspace(0, 4 * np.pi, 50))]
+
+
+def _client(post: AsyncMock) -> MagicMock:
+    client = MagicMock()
+    client.post = post
+    client.__aenter__ = AsyncMock(return_value=client)
+    client.__aexit__ = AsyncMock(return_value=False)
+    return client
+
+
+def _ok(significant: dict) -> AsyncMock:
+    response = MagicMock()
+    response.raise_for_status = MagicMock()
+    response.json.return_value = {
+        "real": {"det": 0.58, "tt": 4.2, "entr": 1.8, "lam": 0.45, "rr": 0.035},
+        "significant": significant,
+    }
+    return AsyncMock(return_value=response)
+
+
+class TestLocal:
+    async def test_local_result(self):
+        router = CRQAComputeRouter()
+        result = await router.compute(SIGNAL, SIGNAL)
+        assert result.surrogate_validated is False
+        assert result.det > 0.0
+        assert 0.0 < result.rr <= 1.0
+
+    async def test_short_input_is_zero_and_never_remote(self):
+        router = CRQAComputeRouter(runpod_endpoint="http://fake")
+        with patch("httpx.AsyncClient") as cls:
+            result = await router.compute(SIGNAL[:9], SIGNAL)
+        cls.assert_not_called()
+        assert result == CRQAResult(0.0, 0.0, 0.0, 0.0, 0.0)
+
+
+class TestRunPod:
+    async def test_success_posts_params_and_gates_on_significance(self):
+        post = _ok({"det": True, "tt": False})
+        router = CRQAComputeRouter(runpod_endpoint="http://fake")
+        with patch("httpx.AsyncClient", return_value=_client(post)):
+            result = await router.compute(SIGNAL, SIGNAL)
+        assert result.surrogate_validated is True
+        assert result.det == 0.58
+        assert result.tt == 0.0
+        assert result.lam == 0.45
+        url = post.call_args.args[0]
+        assert url == "http://fake/crqa/validate"
+        assert post.call_args.kwargs["json"]["params"] == {
+            "embedding_dim": 3,
+            "time_delay": 2,
+            "radius": 0.25,
+            "n_surrogates": 20,
+        }
+
+    async def test_error_falls_back_locally(self):
+        post = AsyncMock(side_effect=httpx.ConnectError("down"))
+        router = CRQAComputeRouter(runpod_endpoint="http://fake")
+        with patch("httpx.AsyncClient", return_value=_client(post)):
+            result = await router.compute(SIGNAL, SIGNAL)
+        assert result.surrogate_validated is False
+        assert router._consecutive_failures == 1
+
+
+class TestCircuitBreaker:
+    async def test_opens_skips_five_then_retries_and_resets(self):
+        fail = AsyncMock(side_effect=httpx.ConnectError("down"))
+        router = CRQAComputeRouter(runpod_endpoint="http://fake")
+        with patch("httpx.AsyncClient", return_value=_client(fail)):
+            for _ in range(3):
+                await router.compute(SIGNAL, SIGNAL)
+            assert router._circuit_open is True
+            assert fail.await_count == 3
+
+            for _ in range(5):
+                result = await router.compute(SIGNAL, SIGNAL)
+                assert result.surrogate_validated is False
+            assert fail.await_count == 3  # all skipped
+
+        ok = _ok({"det": True, "tt": True})
+        with patch("httpx.AsyncClient", return_value=_client(ok)):
+            result = await router.compute(SIGNAL, SIGNAL)
+        assert result.surrogate_validated is True
+        assert router._consecutive_failures == 0
+        assert router._circuit_open is False
+
+    async def test_failed_retry_reopens_circuit(self):
+        fail = AsyncMock(side_effect=httpx.ConnectError("down"))
+        router = CRQAComputeRouter(runpod_endpoint="http://fake")
+        router._consecutive_failures = 3
+        router._circuit_open = True
+        router._skip_remaining = 0
+        with patch("httpx.AsyncClient", return_value=_client(fail)):
+            await router.compute(SIGNAL, SIGNAL)
+        assert fail.await_count == 1
+        assert router._circuit_open is True
+        assert router._skip_remaining == 5

```
