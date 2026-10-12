# Pair 29 (forgestream-8699f287)

Which patch would you merge? Answer in answers.md as `29: A`, `29: B`, or `29: =` if you cannot tell.

## Issue

Add RapportEngine: composite rapport scoring from prosodic and entrainment events

ForgeStream has no component that turns prosodic and entrainment data into a rapport measure. Add `forgestream.emotion.rapport.RapportEngine(orchestrator, meeting_count: int = 1, damping_factor: float = 0.3, runpod_endpoint: str = "", runpod_timeout: float = 4.0)` with `async on_event(event: Event) -> None` as the EventBus handler. Also add `interpolate_weights(meeting_count: int) -> dict[str, float]`.

The engine should track per-speaker arousal, valence and f0 from `PROSODIC_FEATURE` events. Each `ENTRAINMENT_SNAPSHOT` event should trigger a rapport computation. It should ignore events authored by `"rapport_engine"` so it doesn't loop on its own output. With fewer than two known speakers, a snapshot should emit nothing.

For each speaker pair, score four components in [0, 1]: attentiveness, positivity, coordination and symmetry. Combine them into a weighted composite that is damped when either speaker is detected as disengaged. `interpolate_weights` should return weights for those four keys that sum to 1.0. At meeting 1, attentiveness and positivity should outweigh coordination. By meeting 5 and later, coordination should outweigh both. Meeting 3 should fall between the two profiles.

Each snapshot should emit one `RAPPORT_SCORE` event (author `"rapport_engine"`) through `orchestrator.process_event`. Its payload should contain:
- `pair_scores`: one entry per speaker pair. Each entry has `speaker_a`, `speaker_b`, `attentiveness`, `positivity`, `coordination`, `symmetry`, `composite`, `disengagement_damped` and `surrogate_validated`.
- `group_composite`: the mean of the pair composites, in [0, 1].
- `group_trend`: the trend of recent group composites.
- `disengaged_speakers`.
- `weights_applied`.
- `meeting_count`.
- `timestamp_ms`.
- `window_duration_ms`.

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
diff --git a/forgestream/emotion/rapport.py b/forgestream/emotion/rapport.py
new file mode 100644
index 0000000..6b2fafc
--- /dev/null
+++ b/forgestream/emotion/rapport.py
@@ -0,0 +1,237 @@
+"""RapportEngine — multi-component rapport scoring.
+
+Subscribes to EventBus. Consumes PROSODIC_FEATURE events (for disengagement
+detection and arousal/valence/f0 tracking) and ENTRAINMENT_SNAPSHOT events
+(as the trigger to compute rapport). Emits RAPPORT_SCORE events with a
+composite plus per-pair component scores.
+"""
+
+from __future__ import annotations
+
+import logging
+import math
+from collections import deque
+from itertools import combinations
+from typing import TYPE_CHECKING
+
+import numpy as np
+
+from forgestream.events.schema import Event, EventType
+
+if TYPE_CHECKING:
+    from forgestream.orchestrator import Orchestrator
+
+from .crqa_router import CRQAComputeRouter
+from .disengagement import DisengagementDetector
+from .transfer_entropy import compute_symmetry, compute_transfer_entropy
+
+logger = logging.getLogger(__name__)
+
+AUTHOR = "rapport_engine"
+
+WINDOW_DURATION_MS = 30_000
+SERIES_MAXLEN = 30  # one prosodic entry per second -> 30s window
+TREND_HISTORY = 10
+
+# Weight profiles (Tickle-Degnen & Rosenthal 1990)
+EARLY_WEIGHTS = {
+    "attentiveness": 0.35,
+    "positivity": 0.30,
+    "coordination": 0.15,
+    "symmetry": 0.20,
+}
+ESTABLISHED_WEIGHTS = {
+    "attentiveness": 0.20,
+    "positivity": 0.15,
+    "coordination": 0.40,
+    "symmetry": 0.25,
+}
+
+
+def interpolate_weights(meeting_count: int) -> dict[str, float]:
+    """Sigmoid interpolation between early and established weight profiles.
+
+    Meeting 1 is ~12% established, meeting 3 is 50%, meeting 5 is ~88%.
+    Both profiles sum to 1.0, so the interpolation does too.
+    """
+    t = 1.0 / (1.0 + math.exp(-(meeting_count - 3)))
+    return {
+        k: EARLY_WEIGHTS[k] * (1 - t) + ESTABLISHED_WEIGHTS[k] * t
+        for k in EARLY_WEIGHTS
+    }
+
+
+def _clamp01(x: float) -> float:
+    return max(0.0, min(1.0, x))
+
+
+class RapportEngine:
+    """Multi-component rapport scoring engine.
+
+    Parameters:
+        orchestrator: The ForgeStream Orchestrator.
+        meeting_count: Meeting number (for weight interpolation).
+        damping_factor: Composite multiplier when either speaker is disengaged.
+        runpod_endpoint: RunPod CRQA endpoint URL (empty = local only).
+        runpod_timeout: RunPod request timeout in seconds.
+    """
+
+    def __init__(
+        self,
+        orchestrator: "Orchestrator",
+        meeting_count: int = 1,
+        damping_factor: float = 0.3,
+        runpod_endpoint: str = "",
+        runpod_timeout: float = 4.0,
+    ) -> None:
+        self._orchestrator = orchestrator
+        self._meeting_count = meeting_count
+        self._weights = interpolate_weights(meeting_count)
+
+        self._disengagement = DisengagementDetector(damping_factor=damping_factor)
+        self._crqa_router = CRQAComputeRouter(
+            runpod_endpoint=runpod_endpoint, timeout=runpod_timeout,
+        )
+
+        self._arousal_series: dict[str, deque[float]] = {}
+        self._valence_series: dict[str, deque[float]] = {}
+        self._f0_series: dict[str, deque[float]] = {}
+
+        self._recent_composites: deque[float] = deque(maxlen=TREND_HISTORY)
+
+    async def on_event(self, event: Event) -> None:
+        """EventBus handler."""
+        if event.author == AUTHOR:
+            return
+
+        if event.event_type == EventType.PROSODIC_FEATURE:
+            self._handle_prosodic(event)
+        elif event.event_type == EventType.ENTRAINMENT_SNAPSHOT:
+            await self._handle_snapshot(event)
+
+    def _handle_prosodic(self, event: Event) -> None:
+        """Update per-speaker series and the disengagement detector."""
+        p = event.payload
+        speaker = p.get("speaker_id", "unknown")
+
+        self._disengagement.update(speaker, p)
+
+        for series_dict, key, default in (
+            (self._arousal_series, "arousal", 0.5),
+            (self._valence_series, "valence", 0.5),
+            (self._f0_series, "f0_mean", 0.0),
+        ):
+            if speaker not in series_dict:
+                series_dict[speaker] = deque(maxlen=SERIES_MAXLEN)
+            value = p.get(key)
+            series_dict[speaker].append(default if value is None else float(value))
+
+    async def _handle_snapshot(self, event: Event) -> None:
+        """Compute and emit RAPPORT_SCORE for an ENTRAINMENT_SNAPSHOT."""
+        speakers = list(self._arousal_series.keys())
+        if len(speakers) < 2:
+            return
+
+        pair_scores = [
+            await self._compute_pair_rapport(sp_a, sp_b)
+            for sp_a, sp_b in combinations(speakers, 2)
+        ]
+
+        group_composite = sum(p["composite"] for p in pair_scores) / len(pair_scores)
+
+        self._recent_composites.append(group_composite)
+        group_trend = self._compute_trend()
+
+        payload = {
+            "timestamp_ms": event.payload.get("timestamp_ms", 0),
+            "window_duration_ms": WINDOW_DURATION_MS,
+            "pair_scores": pair_scores,
+            "group_composite": round(_clamp01(group_composite), 4),
+            "group_trend": round(group_trend, 4),
+            "disengaged_speakers": self._disengagement.disengaged_speakers(),
+            "weights_applied": {k: round(v, 4) for k, v in self._weights.items()},
+            "meeting_count": self._meeting_count,
+        }
+
+        await self._orchestrator.process_event(
+            Event(
+                event_type=EventType.RAPPORT_SCORE,
+                session_id=event.session_id,
+                branch_id=event.branch_id,
+                author=AUTHOR,
+                evaluator=0.0,
+                payload=payload,
+            )
+        )
+
+    async def _compute_pair_rapport(self, sp_a: str, sp_b: str) -> dict[str, object]:
+        """Compute rapport components for a speaker pair."""
+        arousal_a = list(self._arousal_series[sp_a])
+        arousal_b = list(self._arousal_series[sp_b])
+        attentiveness = self._pearson_clamped(arousal_a, arousal_b)
+
+        positivity = self._valence_proximity(
+            list(self._valence_series[sp_a]), list(self._valence_series[sp_b])
+        )
+
+        f0_a = list(self._f0_series[sp_a])
+        f0_b = list(self._f0_series[sp_b])
+        crqa = await self._crqa_router.compute(f0_a, f0_b)
+        coordination = _clamp01(crqa.det)
+
+        te_a_to_b = compute_transfer_entropy(f0_a, f0_b, lag=1)
+        te_b_to_a = compute_transfer_entropy(f0_b, f0_a, lag=1)
+        symmetry = _clamp01(compute_symmetry(te_a_to_b, te_b_to_a))
+
+        raw_composite = (
+            self._weights["attentiveness"] * attentiveness
+            + self._weights["positivity"] * positivity
+            + self._weights["coordination"] * coordination
+            + self._weights["symmetry"] * symmetry
+        )
+
+        damping = self._disengagement.get_pair_damping(sp_a, sp_b)
+        composite = _clamp01(raw_composite * damping)
+
+        return {
+            "speaker_a": sp_a,
+            "speaker_b": sp_b,
+            "attentiveness": round(attentiveness, 4),
+            "positivity": round(positivity, 4),
+            "coordination": round(coordination, 4),
+            "symmetry": round(symmetry, 4),
+            "composite": round(composite, 4),
+            "disengagement_damped": damping < 1.0,
+            "surrogate_validated": crqa.surrogate_validated,
+        }
+
+    def _compute_trend(self) -> float:
+        """Pearson correlation of recent group composites vs. time index."""
+        values = list(self._recent_composites)
+        if len(values) < 3:
+            return 0.0
+        y = np.array(values, dtype=np.float64)
+        if y.std() < 1e-10:
+            return 0.0
+        corr = np.corrcoef(np.arange(len(values), dtype=np.float64), y)[0, 1]
+        return 0.0 if math.isnan(corr) else float(corr)
+
+    @staticmethod
+    def _pearson_clamped(a: list[float], b: list[float]) -> float:
+        """Pearson correlation of the trailing overlap, clamped to [0, 1]."""
+        n = min(len(a), len(b))
+        if n < 3:
+            return 0.0
+        arr_a = np.array(a[-n:], dtype=np.float64)
+        arr_b = np.array(b[-n:], dtype=np.float64)
+        if arr_a.std() < 1e-10 or arr_b.std() < 1e-10:
+            return 0.0
+        r = np.corrcoef(arr_a, arr_b)[0, 1]
+        return 0.0 if math.isnan(r) else _clamp01(float(r))
+
+    @staticmethod
+    def _valence_proximity(a: list[float], b: list[float]) -> float:
+        """1 - |mean valence difference|, clamped to [0, 1]."""
+        if not a or not b:
+            return 0.5
+        return _clamp01(1.0 - abs(sum(a) / len(a) - sum(b) / len(b)))
diff --git a/tests/emotion/test_rapport.py b/tests/emotion/test_rapport.py
new file mode 100644
index 0000000..7aadbf8
--- /dev/null
+++ b/tests/emotion/test_rapport.py
@@ -0,0 +1,201 @@
+"""Tests for RapportEngine — multi-component rapport scoring."""
+
+from unittest.mock import AsyncMock, MagicMock
+from uuid import uuid4
+
+import pytest
+
+from forgestream.emotion.rapport import RapportEngine, interpolate_weights
+from forgestream.events.schema import Event, EventType
+
+
+def _make_prosodic(session_id, branch_id, speaker, ts, arousal=0.5, valence=0.5,
+                   f0_mean=200.0):
+    return Event(
+        event_type=EventType.PROSODIC_FEATURE,
+        session_id=session_id, branch_id=branch_id,
+        author="emotion_extractor", evaluator=0.0,
+        payload={
+            "speaker_id": speaker, "timestamp_ms": ts,
+            "arousal": arousal, "valence": valence,
+            "f0_mean": f0_mean, "f0_std": 30.0, "energy_rms": 0.1,
+        },
+    )
+
+
+def _make_snapshot(session_id, branch_id, ts):
+    return Event(
+        event_type=EventType.ENTRAINMENT_SNAPSHOT,
+        session_id=session_id, branch_id=branch_id,
+        author="dynamics_engine", evaluator=0.0,
+        payload={"timestamp_ms": ts, "speaker_pairs": [], "group_metrics": {}},
+    )
+
+
+def _orch():
+    orch = MagicMock()
+    orch.session_id = uuid4()
+    orch.process_event = AsyncMock(return_value=True)
+    return orch
+
+
+def _rapport_events(orch):
+    return [
+        c[0][0] for c in orch.process_event.call_args_list
+        if c[0][0].event_type == EventType.RAPPORT_SCORE
+    ]
+
+
+class TestInterpolateWeights:
+    def test_meeting_1_favors_attentiveness_positivity(self):
+        w = interpolate_weights(1)
+        assert w["attentiveness"] > w["coordination"]
+        assert w["positivity"] > w["coordination"]
+
+    @pytest.mark.parametrize("mc", [5, 6, 20])
+    def test_meeting_5_plus_favors_coordination(self, mc):
+        w = interpolate_weights(mc)
+        assert w["coordination"] > w["attentiveness"]
+        assert w["coordination"] > w["positivity"]
+
+    def test_weights_sum_to_one(self):
+        for mc in [1, 2, 3, 5, 10]:
+            w = interpolate_weights(mc)
+            assert set(w) == {"attentiveness", "positivity", "coordination", "symmetry"}
+            assert sum(w.values()) == pytest.approx(1.0, abs=1e-9)
+
+    def test_meeting_3_between_profiles(self):
+        early, mid, est = interpolate_weights(1), interpolate_weights(3), interpolate_weights(10)
+        for k in mid:
+            lo, hi = sorted((early[k], est[k]))
+            assert lo <= mid[k] <= hi
+
+
+class TestRapportEngine:
+    @pytest.mark.asyncio
+    async def test_emits_rapport_score_on_snapshot(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch, meeting_count=3)
+        sid, bid = orch.session_id, uuid4()
+
+        for i in range(30):
+            await engine.on_event(
+                _make_prosodic(sid, bid, "sp0", i * 1000, arousal=0.4 + 0.01 * i,
+                               valence=0.5, f0_mean=200 + (i % 5))
+            )
+            await engine.on_event(
+                _make_prosodic(sid, bid, "sp1", i * 1000 + 500, arousal=0.3 + 0.01 * i,
+                               valence=0.6, f0_mean=210 + (i % 5))
+            )
+        await engine.on_event(_make_snapshot(sid, bid, 30000))
+
+        events = _rapport_events(orch)
+        assert len(events) == 1
+        assert events[0].author == "rapport_engine"
+        p = events[0].payload
+        for key in ("pair_scores", "group_composite", "group_trend",
+                    "disengaged_speakers", "weights_applied", "meeting_count",
+                    "timestamp_ms", "window_duration_ms"):
+            assert key in p
+        assert p["timestamp_ms"] == 30000
+        assert p["meeting_count"] == 3
+        assert 0.0 <= p["group_composite"] <= 1.0
+        assert len(p["pair_scores"]) == 1
+        pair = p["pair_scores"][0]
+        for key in ("speaker_a", "speaker_b", "attentiveness", "positivity",
+                    "coordination", "symmetry", "composite",
+                    "disengagement_damped", "surrogate_validated"):
+            assert key in pair
+        for key in ("attentiveness", "positivity", "coordination", "symmetry", "composite"):
+            assert 0.0 <= pair[key] <= 1.0
+        assert pair["attentiveness"] > 0.9  # arousal ramps in lockstep
+        assert pair["positivity"] == pytest.approx(0.9)
+
+    @pytest.mark.asyncio
+    async def test_one_event_per_snapshot_with_pair_per_speaker_pair(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        sid, bid = orch.session_id, uuid4()
+        for i in range(5):
+            for sp in ("a", "b", "c"):
+                await engine.on_event(_make_prosodic(sid, bid, sp, i * 1000))
+        await engine.on_event(_make_snapshot(sid, bid, 5000))
+
+        events = _rapport_events(orch)
+        assert len(events) == 1
+        p = events[0].payload
+        assert len(p["pair_scores"]) == 3
+        assert p["group_composite"] == pytest.approx(
+            sum(x["composite"] for x in p["pair_scores"]) / 3, abs=1e-3
+        )
+
+    @pytest.mark.asyncio
+    async def test_fewer_than_two_speakers_emits_nothing(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        sid, bid = orch.session_id, uuid4()
+        await engine.on_event(_make_snapshot(sid, bid, 1000))
+        for i in range(5):
+            await engine.on_event(_make_prosodic(sid, bid, "sp0", i * 1000))
+        await engine.on_event(_make_snapshot(sid, bid, 5000))
+        assert orch.process_event.call_count == 0
+
+    @pytest.mark.asyncio
+    async def test_ignores_self_authored(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        sid, bid = orch.session_id, uuid4()
+        for i in range(5):
+            await engine.on_event(_make_prosodic(sid, bid, "sp0", i * 1000))
+            await engine.on_event(_make_prosodic(sid, bid, "sp1", i * 1000))
+        # Self-authored snapshot-type event must not trigger computation
+        await engine.on_event(Event(
+            event_type=EventType.ENTRAINMENT_SNAPSHOT,
+            session_id=sid, branch_id=bid,
+            author="rapport_engine", evaluator=0.0, payload={},
+        ))
+        await engine.on_event(Event(
+            event_type=EventType.RAPPORT_SCORE,
+            session_id=sid, branch_id=bid,
+            author="rapport_engine", evaluator=0.0, payload={"test": True},
+        ))
+        assert orch.process_event.call_count == 0
+
+    @pytest.mark.asyncio
+    async def test_disengagement_damps_pair_composite(self):
+        sid, bid = uuid4(), uuid4()
+
+        async def run(damping):
+            orch = _orch()
+            engine = RapportEngine(orchestrator=orch, meeting_count=3, damping_factor=damping)
+            for i in range(10):
+                await engine.on_event(_make_prosodic(sid, bid, "sp0", i * 1000))
+                await engine.on_event(_make_prosodic(sid, bid, "sp1", i * 1000))
+            return engine, orch
+
+        base_engine, base_orch = await run(0.3)
+        await base_engine.on_event(_make_snapshot(sid, bid, 10000))
+        base = _rapport_events(base_orch)[0].payload
+        assert base["pair_scores"][0]["disengagement_damped"] is False
+        assert base["disengaged_speakers"] == []
+
+        engine, orch = await run(0.3)
+        engine._disengagement._flags["sp0"] = True
+        await engine.on_event(_make_snapshot(sid, bid, 10000))
+        damped = _rapport_events(orch)[0].payload
+        pair = damped["pair_scores"][0]
+        assert pair["disengagement_damped"] is True
+        assert damped["disengaged_speakers"] == ["sp0"]
+        assert pair["composite"] == pytest.approx(
+            base["pair_scores"][0]["composite"] * 0.3, abs=1e-3
+        )
+
+    @pytest.mark.asyncio
+    async def test_trend_positive_when_composites_rise(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        engine._recent_composites.extend([0.2, 0.3, 0.4, 0.5])
+        assert engine._compute_trend() > 0.9
+        engine._recent_composites.clear()
+        engine._recent_composites.extend([0.5, 0.4, 0.3, 0.2])
+        assert engine._compute_trend() < -0.9

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
diff --git a/forgestream/emotion/rapport.py b/forgestream/emotion/rapport.py
new file mode 100644
index 0000000..66eeace
--- /dev/null
+++ b/forgestream/emotion/rapport.py
@@ -0,0 +1,230 @@
+"""RapportEngine — multi-component rapport scoring.
+
+Subscribes to EventBus. Consumes PROSODIC_FEATURE events (arousal, valence and
+F0 tracking, disengagement detection) and ENTRAINMENT_SNAPSHOT events (the
+trigger to compute rapport). Emits one RAPPORT_SCORE event per snapshot with
+per-pair component scores and a group composite.
+"""
+
+from __future__ import annotations
+
+import logging
+import math
+from collections import deque
+from itertools import combinations
+
+import numpy as np
+
+from forgestream.events.schema import Event, EventType
+
+from .crqa_router import CRQAComputeRouter
+from .disengagement import DisengagementDetector
+from .transfer_entropy import compute_symmetry, compute_transfer_entropy
+
+logger = logging.getLogger(__name__)
+
+AUTHOR = "rapport_engine"
+DEFAULT_WINDOW_MS = 30_000
+MIN_TREND_POINTS = 3
+
+# Weight profiles (Tickle-Degnen & Rosenthal, 1990)
+EARLY_WEIGHTS = {
+    "attentiveness": 0.35,
+    "positivity": 0.30,
+    "coordination": 0.15,
+    "symmetry": 0.20,
+}
+ESTABLISHED_WEIGHTS = {
+    "attentiveness": 0.20,
+    "positivity": 0.15,
+    "coordination": 0.40,
+    "symmetry": 0.25,
+}
+
+
+def interpolate_weights(meeting_count: int) -> dict[str, float]:
+    """Sigmoid interpolation between early and established weight profiles.
+
+    Meeting 1 is ~12% established, meeting 3 is 50%, meeting 5 is ~88%.
+    Both profiles sum to 1.0, so the interpolation does too.
+    """
+    t = 1.0 / (1.0 + math.exp(-(meeting_count - 3)))
+    return {
+        k: EARLY_WEIGHTS[k] * (1 - t) + ESTABLISHED_WEIGHTS[k] * t
+        for k in EARLY_WEIGHTS
+    }
+
+
+def _clamp01(x: float) -> float:
+    return max(0.0, min(1.0, x))
+
+
+class RapportEngine:
+    """Multi-component rapport scoring engine.
+
+    Parameters:
+        orchestrator: The ForgeStream Orchestrator.
+        meeting_count: Number of meetings so far (for weight interpolation).
+        damping_factor: Composite multiplier when either speaker is disengaged.
+        runpod_endpoint: RunPod CRQA endpoint URL (empty = local CRQA only).
+        runpod_timeout: RunPod request timeout in seconds.
+    """
+
+    def __init__(
+        self,
+        orchestrator: "Orchestrator",
+        meeting_count: int = 1,
+        damping_factor: float = 0.3,
+        runpod_endpoint: str = "",
+        runpod_timeout: float = 4.0,
+    ) -> None:
+        self._orchestrator = orchestrator
+        self._meeting_count = meeting_count
+        self._weights = interpolate_weights(meeting_count)
+
+        self._disengagement = DisengagementDetector(damping_factor=damping_factor)
+        self._crqa_router = CRQAComputeRouter(
+            runpod_endpoint=runpod_endpoint, timeout=runpod_timeout,
+        )
+
+        self._arousal_series: dict[str, deque[float]] = {}
+        self._valence_series: dict[str, deque[float]] = {}
+        self._f0_series: dict[str, deque[float]] = {}
+        self._series_maxlen = 60  # ~60 seconds of data
+
+        self._recent_composites: deque[float] = deque(maxlen=10)
+
+    async def on_event(self, event: Event) -> None:
+        """EventBus handler."""
+        if event.author == AUTHOR:
+            return
+
+        if event.event_type == EventType.PROSODIC_FEATURE:
+            self._handle_prosodic(event)
+        elif event.event_type == EventType.ENTRAINMENT_SNAPSHOT:
+            await self._handle_snapshot(event)
+
+    def _handle_prosodic(self, event: Event) -> None:
+        """Update per-speaker series and the disengagement detector."""
+        p = event.payload
+        speaker = p.get("speaker_id", "unknown")
+
+        self._disengagement.update(speaker, p)
+
+        for series_dict, key, default in (
+            (self._arousal_series, "arousal", 0.5),
+            (self._valence_series, "valence", 0.5),
+            (self._f0_series, "f0_mean", 0.0),
+        ):
+            if speaker not in series_dict:
+                series_dict[speaker] = deque(maxlen=self._series_maxlen)
+            series_dict[speaker].append(p.get(key, default))
+
+    async def _handle_snapshot(self, event: Event) -> None:
+        """Compute and emit RAPPORT_SCORE when triggered by ENTRAINMENT_SNAPSHOT."""
+        speakers = list(self._arousal_series.keys())
+        if len(speakers) < 2:
+            return
+
+        pair_scores = [
+            await self._compute_pair_rapport(sp_a, sp_b)
+            for sp_a, sp_b in combinations(speakers, 2)
+        ]
+
+        group_composite = sum(p["composite"] for p in pair_scores) / len(pair_scores)
+
+        self._recent_composites.append(group_composite)
+        group_trend = self._compute_trend()
+
+        payload = {
+            "timestamp_ms": event.payload.get("timestamp_ms", 0),
+            "window_duration_ms": event.payload.get(
+                "window_duration_ms", DEFAULT_WINDOW_MS
+            ),
+            "pair_scores": pair_scores,
+            "group_composite": round(group_composite, 4),
+            "group_trend": round(group_trend, 4),
+            "disengaged_speakers": self._disengagement.disengaged_speakers(),
+            "weights_applied": {k: round(v, 4) for k, v in self._weights.items()},
+            "meeting_count": self._meeting_count,
+        }
+
+        await self._orchestrator.process_event(
+            Event(
+                event_type=EventType.RAPPORT_SCORE,
+                session_id=event.session_id,
+                branch_id=event.branch_id,
+                author=AUTHOR,
+                evaluator=0.0,
+                payload=payload,
+            )
+        )
+
+    async def _compute_pair_rapport(self, sp_a: str, sp_b: str) -> dict:
+        """Compute rapport components for a speaker pair."""
+        arousal_a = list(self._arousal_series[sp_a])
+        arousal_b = list(self._arousal_series[sp_b])
+        attentiveness = self._pearson_clamped(arousal_a, arousal_b)
+
+        positivity = self._valence_proximity(
+            list(self._valence_series[sp_a]), list(self._valence_series[sp_b])
+        )
+
+        f0_a = list(self._f0_series[sp_a])
+        f0_b = list(self._f0_series[sp_b])
+        crqa = await self._crqa_router.compute(f0_a, f0_b)
+        coordination = _clamp01(crqa.det)
+
+        te_a_to_b = compute_transfer_entropy(f0_a, f0_b, lag=1)
+        te_b_to_a = compute_transfer_entropy(f0_b, f0_a, lag=1)
+        symmetry = _clamp01(compute_symmetry(te_a_to_b, te_b_to_a))
+
+        raw_composite = (
+            self._weights["attentiveness"] * attentiveness
+            + self._weights["positivity"] * positivity
+            + self._weights["coordination"] * coordination
+            + self._weights["symmetry"] * symmetry
+        )
+
+        damping = self._disengagement.get_pair_damping(sp_a, sp_b)
+
+        return {
+            "speaker_a": sp_a,
+            "speaker_b": sp_b,
+            "attentiveness": round(attentiveness, 4),
+            "positivity": round(positivity, 4),
+            "coordination": round(coordination, 4),
+            "symmetry": round(symmetry, 4),
+            "composite": round(_clamp01(raw_composite * damping), 4),
+            "disengagement_damped": damping < 1.0,
+            "surrogate_validated": crqa.surrogate_validated,
+        }
+
+    def _compute_trend(self) -> float:
+        """Least-squares slope of recent group composites per snapshot."""
+        values = list(self._recent_composites)
+        if len(values) < MIN_TREND_POINTS:
+            return 0.0
+        x = np.arange(len(values), dtype=np.float64)
+        slope = np.polyfit(x, np.array(values, dtype=np.float64), 1)[0]
+        return float(slope) if math.isfinite(slope) else 0.0
+
+    @staticmethod
+    def _pearson_clamped(a: list[float], b: list[float]) -> float:
+        """Pearson correlation of the most recent aligned samples, clamped to [0, 1]."""
+        n = min(len(a), len(b))
+        if n < 3:
+            return 0.0
+        arr_a = np.array(a[-n:], dtype=np.float64)
+        arr_b = np.array(b[-n:], dtype=np.float64)
+        if arr_a.std() < 1e-10 or arr_b.std() < 1e-10:
+            return 0.0
+        r = np.corrcoef(arr_a, arr_b)[0, 1]
+        return _clamp01(float(r)) if math.isfinite(r) else 0.0
+
+    @staticmethod
+    def _valence_proximity(a: list[float], b: list[float]) -> float:
+        """1 - |mean valence difference|, clamped to [0, 1]."""
+        if not a or not b:
+            return 0.5
+        return _clamp01(1.0 - abs(sum(a) / len(a) - sum(b) / len(b)))
diff --git a/tests/emotion/test_rapport.py b/tests/emotion/test_rapport.py
new file mode 100644
index 0000000..d6fdad7
--- /dev/null
+++ b/tests/emotion/test_rapport.py
@@ -0,0 +1,201 @@
+"""Tests for RapportEngine — multi-component rapport scoring."""
+
+from unittest.mock import AsyncMock, MagicMock
+from uuid import uuid4
+
+import pytest
+
+from forgestream.emotion.rapport import RapportEngine, interpolate_weights
+from forgestream.events.schema import Event, EventType
+
+
+def _prosodic(sid, bid, speaker, ts, arousal=0.5, valence=0.5, f0=200.0,
+              energy=0.1, f0_std=30.0):
+    return Event(
+        event_type=EventType.PROSODIC_FEATURE,
+        session_id=sid, branch_id=bid,
+        author="emotion_extractor", evaluator=0.0,
+        payload={
+            "speaker_id": speaker, "timestamp_ms": ts,
+            "arousal": arousal, "valence": valence,
+            "f0_mean": f0, "f0_std": f0_std, "energy_rms": energy,
+        },
+    )
+
+
+def _snapshot(sid, bid, ts, window_ms=60000):
+    return Event(
+        event_type=EventType.ENTRAINMENT_SNAPSHOT,
+        session_id=sid, branch_id=bid,
+        author="dynamics_engine", evaluator=0.0,
+        payload={"timestamp_ms": ts, "window_duration_ms": window_ms,
+                 "speaker_pairs": [], "group_metrics": {}},
+    )
+
+
+def _orch():
+    orch = MagicMock()
+    orch.session_id = uuid4()
+    orch.process_event = AsyncMock(return_value=True)
+    return orch
+
+
+def _rapport_events(orch):
+    return [
+        c[0][0] for c in orch.process_event.call_args_list
+        if c[0][0].event_type == EventType.RAPPORT_SCORE
+    ]
+
+
+class TestInterpolateWeights:
+    def test_meeting_1_favors_attentiveness_positivity(self):
+        w = interpolate_weights(1)
+        assert w["attentiveness"] > w["coordination"]
+        assert w["positivity"] > w["coordination"]
+
+    def test_meeting_5_favors_coordination(self):
+        w = interpolate_weights(5)
+        assert w["coordination"] > w["attentiveness"]
+        assert w["coordination"] > w["positivity"]
+
+    def test_weights_sum_to_one(self):
+        for mc in [1, 2, 3, 5, 10]:
+            assert sum(interpolate_weights(mc).values()) == pytest.approx(1.0)
+
+    def test_meeting_3_between_profiles(self):
+        w1, w3, w5 = (interpolate_weights(m) for m in (1, 3, 5))
+        for k in w1:
+            lo, hi = sorted((w1[k], w5[k]))
+            assert lo <= w3[k] <= hi
+
+
+class TestRapportEngine:
+    @pytest.mark.asyncio
+    async def test_emits_full_payload_on_snapshot(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch, meeting_count=3)
+        sid, bid = orch.session_id, uuid4()
+
+        for i in range(30):
+            await engine.on_event(_prosodic(
+                sid, bid, "sp0", i * 1000, arousal=0.4 + 0.01 * i,
+                valence=0.5, f0=200 + (i % 7)))
+            await engine.on_event(_prosodic(
+                sid, bid, "sp1", i * 1000 + 500, arousal=0.3 + 0.01 * i,
+                valence=0.6, f0=180 + (i % 5)))
+        await engine.on_event(_snapshot(sid, bid, 30000))
+
+        events = _rapport_events(orch)
+        assert len(events) == 1
+        assert events[0].author == "rapport_engine"
+        p = events[0].payload
+        assert set(p) >= {
+            "pair_scores", "group_composite", "group_trend",
+            "disengaged_speakers", "weights_applied", "meeting_count",
+            "timestamp_ms", "window_duration_ms",
+        }
+        assert p["timestamp_ms"] == 30000
+        assert p["window_duration_ms"] == 60000
+        assert p["meeting_count"] == 3
+        assert 0.0 <= p["group_composite"] <= 1.0
+        assert len(p["pair_scores"]) == 1
+        pair = p["pair_scores"][0]
+        assert {pair["speaker_a"], pair["speaker_b"]} == {"sp0", "sp1"}
+        for k in ("attentiveness", "positivity", "coordination", "symmetry",
+                  "composite"):
+            assert 0.0 <= pair[k] <= 1.0
+        assert pair["disengagement_damped"] is False
+        assert pair["surrogate_validated"] is False
+        assert pair["positivity"] == pytest.approx(0.9)
+
+    @pytest.mark.asyncio
+    async def test_group_composite_is_mean_of_pairs(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        sid, bid = orch.session_id, uuid4()
+        for i in range(20):
+            for n, sp in enumerate(("a", "b", "c")):
+                await engine.on_event(_prosodic(
+                    sid, bid, sp, i * 1000, arousal=0.3 + 0.02 * i * (n + 1),
+                    valence=0.2 * (n + 1), f0=200 + i * (n + 1)))
+        await engine.on_event(_snapshot(sid, bid, 20000))
+
+        p = _rapport_events(orch)[0].payload
+        assert len(p["pair_scores"]) == 3
+        mean = sum(x["composite"] for x in p["pair_scores"]) / 3
+        assert p["group_composite"] == pytest.approx(mean, abs=1e-3)
+
+    @pytest.mark.asyncio
+    async def test_single_speaker_emits_nothing(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        sid, bid = orch.session_id, uuid4()
+        for i in range(5):
+            await engine.on_event(_prosodic(sid, bid, "sp0", i * 1000))
+        await engine.on_event(_snapshot(sid, bid, 5000))
+        assert orch.process_event.call_count == 0
+
+    @pytest.mark.asyncio
+    async def test_ignores_self_authored(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        sid, bid = orch.session_id, uuid4()
+        for i in range(5):
+            await engine.on_event(_prosodic(sid, bid, "sp0", i * 1000))
+            await engine.on_event(_prosodic(sid, bid, "sp1", i * 1000))
+        await engine.on_event(Event(
+            event_type=EventType.ENTRAINMENT_SNAPSHOT,
+            session_id=sid, branch_id=bid, author="rapport_engine",
+            evaluator=0.0, payload={"timestamp_ms": 5000},
+        ))
+        assert orch.process_event.call_count == 0
+
+    @pytest.mark.asyncio
+    async def test_disengagement_damps_pair_composite(self):
+        sid, bid = uuid4(), uuid4()
+
+        async def run(damping_factor: float):
+            orch = _orch()
+            engine = RapportEngine(orchestrator=orch, damping_factor=damping_factor)
+            for i in range(20):
+                for sp in ("sp0", "sp1"):
+                    await engine.on_event(_prosodic(
+                        sid, bid, sp, i * 1000, energy=0.1, f0_std=30.0))
+            # sp0 goes quiet and flat while sp1 stays normal
+            for i in range(20, 40):
+                await engine.on_event(_prosodic(
+                    sid, bid, "sp0", i * 1000, energy=0.01, f0_std=2.0))
+                await engine.on_event(_prosodic(
+                    sid, bid, "sp1", i * 1000, energy=0.1, f0_std=30.0))
+            await engine.on_event(_snapshot(sid, bid, 40000))
+            return _rapport_events(orch)[0].payload
+
+        undamped = await run(1.0)
+        damped = await run(0.3)
+
+        assert damped["disengaged_speakers"] == ["sp0"]
+        pair = damped["pair_scores"][0]
+        assert pair["disengagement_damped"] is True
+        base = undamped["pair_scores"][0]["composite"]
+        assert base > 0.0
+        assert pair["composite"] == pytest.approx(0.3 * base, abs=1e-3)
+        assert damped["group_composite"] == pytest.approx(pair["composite"])
+
+    @pytest.mark.asyncio
+    async def test_trend_follows_composite_direction(self):
+        orch = _orch()
+        engine = RapportEngine(orchestrator=orch)
+        sid, bid = orch.session_id, uuid4()
+        # Widen valence gap each round -> positivity (and composite) falls
+        for rnd in range(5):
+            for i in range(10):
+                await engine.on_event(_prosodic(
+                    sid, bid, "sp0", (rnd * 10 + i) * 1000, valence=0.9))
+                await engine.on_event(_prosodic(
+                    sid, bid, "sp1", (rnd * 10 + i) * 1000,
+                    valence=max(0.0, 0.9 - 0.2 * (rnd + 1))))
+            await engine.on_event(_snapshot(sid, bid, (rnd + 1) * 10000))
+
+        trends = [e.payload["group_trend"] for e in _rapport_events(orch)]
+        assert trends[0] == 0.0
+        assert trends[-1] < 0.0

```
