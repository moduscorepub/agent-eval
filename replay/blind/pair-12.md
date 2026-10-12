# Pair 12 (forgestream-efd54879)

Which patch would you merge? Answer in answers.md as `12: A`, `12: B`, or `12: =` if you cannot tell.

## Issue

Add DisengagementDetector to flag one-sided speaker disengagement from prosodic trends

The emotion module has no way to tell when one speaker has gone quiet and flat while the others stay engaged. We need a `forgestream.emotion.disengagement.DisengagementDetector(damping_factor: float = 0.3)` that consumes per-speaker prosodic snapshots and reports who is disengaged. That lets the rapport composite for affected speaker pairs be scaled down.

Interface:
- `update(speaker_id: str, features: dict) -> None` ingests a snapshot. Relevant keys are `energy_rms` and `f0_std`. Other keys, such as `arousal`, are accepted and ignored. Missing keys count as 0.0.
- `is_disengaged(speaker_id: str) -> bool` returns `False` for unknown speakers.
- `disengaged_speakers() -> list[str]` lists the currently flagged speaker IDs.
- `get_pair_damping(speaker_a: str, speaker_b: str) -> float` returns `damping_factor` if either speaker is flagged, otherwise `1.0`. Unknown speakers are treated as not flagged.

Expected behavior:
- Each speaker has their own baseline for energy and F0 variability. It is built from their early updates and then adapts slowly. Judgement is based on a recent sliding window of snapshots compared with that baseline, so no flag is raised until enough history exists.
- A speaker is flagged when their recent energy and F0 std both drop well below their own baseline (energy under about 60% of baseline, F0 std under about 40%) **and** at least one other speaker is still near their own normal energy level.
- If every speaker goes quiet and flat together, nobody is flagged. That is a group lull, not disengagement.
- Flagging uses hysteresis. Once flagged, the speaker stays flagged until both energy and F0 std recover to about 70% or more of baseline, and only then is the flag cleared.
- A speaker with a zero or near-zero baseline must never be flagged, and the detector must not divide by zero.

Example: two speakers each give 15 steady snapshots (energy 0.10, F0 std 30). Then `sp0` drops to energy 0.03 and F0 std 8 while `sp1` stays steady. After about 12 further updates, `sp0` should be flagged and `sp1` should not. If `sp0` then returns to energy 0.08 and F0 std 25 for about 12 updates, the flag should clear.

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
index 507b9fd..a550a28 100644
--- a/forgestream/emotion/__init__.py
+++ b/forgestream/emotion/__init__.py
@@ -1,6 +1,7 @@
 """Audio emotion detection pipeline for ForgeStream."""
 from .buffer import AudioRingBuffer
 from .correlator import EmotionCorrelator
+from .disengagement import DisengagementDetector
 from .dynamics import GroupDynamicsEngine
 from .extractor import EmotionExtractor
 from .features import EGeMAPSExtractor, PraatExtractor, ProsodicFeatures
@@ -9,6 +10,7 @@ from .speaker import SpeakerTimeSeries
 
 __all__ = [
     "AudioRingBuffer",
+    "DisengagementDetector",
     "EGeMAPSExtractor",
     "EmotionCorpus",
     "EmotionCorrelator",
diff --git a/forgestream/emotion/disengagement.py b/forgestream/emotion/disengagement.py
new file mode 100644
index 0000000..ed61ebd
--- /dev/null
+++ b/forgestream/emotion/disengagement.py
@@ -0,0 +1,109 @@
+"""One-sided disengagement detection from per-speaker prosodic trends.
+
+A speaker is flagged when their recent energy and F0 variability both fall well
+below their own baseline while at least one other speaker is still near their
+own normal energy. A group-wide lull flags nobody. Flags use hysteresis.
+"""
+
+from __future__ import annotations
+
+from collections import deque
+from dataclasses import dataclass, field
+
+BASELINE_UPDATES = 10  # early snapshots averaged to form the baseline
+WINDOW_SIZE = 10  # recent snapshots judged against the baseline
+BASELINE_ALPHA = 0.02  # EMA rate once the baseline is established
+ENERGY_DROP_RATIO = 0.6  # flag when window energy < 60% of baseline ...
+F0_DROP_RATIO = 0.4  # ... and window F0 std < 40% of baseline
+RECOVERY_RATIO = 0.7  # clear when both are >= 70% of baseline
+PEER_ENGAGED_RATIO = 0.7  # another speaker "near normal" energy
+MIN_BASELINE = 1e-6  # baselines at or below this are never flagged
+
+
+@dataclass
+class _SpeakerState:
+    energy_window: deque[float] = field(default_factory=lambda: deque(maxlen=WINDOW_SIZE))
+    f0_window: deque[float] = field(default_factory=lambda: deque(maxlen=WINDOW_SIZE))
+    count: int = 0
+    energy_base: float = 0.0
+    f0_base: float = 0.0
+    flagged: bool = False
+
+    @property
+    def ready(self) -> bool:
+        return (
+            self.count >= BASELINE_UPDATES
+            and len(self.energy_window) == WINDOW_SIZE
+            and self.energy_base > MIN_BASELINE
+            and self.f0_base > MIN_BASELINE
+        )
+
+    def energy_ratio(self) -> float:
+        return (sum(self.energy_window) / len(self.energy_window)) / self.energy_base
+
+    def f0_ratio(self) -> float:
+        return (sum(self.f0_window) / len(self.f0_window)) / self.f0_base
+
+
+class DisengagementDetector:
+    """Tracks per-speaker baselines and flags one-sided disengagement."""
+
+    def __init__(self, damping_factor: float = 0.3) -> None:
+        self._damping_factor = damping_factor
+        self._speakers: dict[str, _SpeakerState] = {}
+
+    def update(self, speaker_id: str, features: dict) -> None:
+        energy = float(features.get("energy_rms") or 0.0)
+        f0_std = float(features.get("f0_std") or 0.0)
+
+        st = self._speakers.setdefault(speaker_id, _SpeakerState())
+        st.energy_window.append(energy)
+        st.f0_window.append(f0_std)
+        st.count += 1
+
+        if st.count <= BASELINE_UPDATES:
+            # Running mean over the early snapshots.
+            n = st.count
+            st.energy_base += (energy - st.energy_base) / n
+            st.f0_base += (f0_std - st.f0_base) / n
+        elif not st.flagged:
+            # Frozen while flagged so the baseline can't erode toward the lull.
+            st.energy_base += BASELINE_ALPHA * (energy - st.energy_base)
+            st.f0_base += BASELINE_ALPHA * (f0_std - st.f0_base)
+
+        self._reevaluate()
+
+    def is_disengaged(self, speaker_id: str) -> bool:
+        st = self._speakers.get(speaker_id)
+        return st is not None and st.flagged
+
+    def disengaged_speakers(self) -> list[str]:
+        return [sid for sid, st in self._speakers.items() if st.flagged]
+
+    def get_pair_damping(self, speaker_a: str, speaker_b: str) -> float:
+        if self.is_disengaged(speaker_a) or self.is_disengaged(speaker_b):
+            return self._damping_factor
+        return 1.0
+
+    def _reevaluate(self) -> None:
+        for sid, st in self._speakers.items():
+            if not st.ready:
+                continue
+            e_ratio = st.energy_ratio()
+            f_ratio = st.f0_ratio()
+            if st.flagged:
+                if e_ratio >= RECOVERY_RATIO and f_ratio >= RECOVERY_RATIO:
+                    st.flagged = False
+            elif (
+                e_ratio < ENERGY_DROP_RATIO
+                and f_ratio < F0_DROP_RATIO
+                and self._peer_engaged(sid)
+            ):
+                st.flagged = True
+
+    def _peer_engaged(self, speaker_id: str) -> bool:
+        return any(
+            other.ready and other.energy_ratio() >= PEER_ENGAGED_RATIO
+            for sid, other in self._speakers.items()
+            if sid != speaker_id
+        )
diff --git a/tests/emotion/test_disengagement.py b/tests/emotion/test_disengagement.py
new file mode 100644
index 0000000..8747e55
--- /dev/null
+++ b/tests/emotion/test_disengagement.py
@@ -0,0 +1,59 @@
+from forgestream.emotion.disengagement import DisengagementDetector
+
+STEADY = {"energy_rms": 0.10, "f0_std": 30.0, "arousal": 0.5}
+QUIET = {"energy_rms": 0.03, "f0_std": 8.0}
+RECOVERED = {"energy_rms": 0.08, "f0_std": 25.0}
+
+
+def _warm(det, speakers=("sp0", "sp1"), n=15):
+    for _ in range(n):
+        for s in speakers:
+            det.update(s, STEADY)
+
+
+def _feed(det, feats: dict[str, dict], n=12):
+    for _ in range(n):
+        for s, f in feats.items():
+            det.update(s, f)
+
+
+def test_one_sided_drop_flags_and_recovery_clears():
+    det = DisengagementDetector(damping_factor=0.25)
+    _warm(det)
+    _feed(det, {"sp0": QUIET, "sp1": STEADY})
+    assert det.disengaged_speakers() == ["sp0"]
+    assert det.get_pair_damping("sp0", "sp1") == 0.25
+    assert det.get_pair_damping("sp1", "ghost") == 1.0
+
+    _feed(det, {"sp0": RECOVERED, "sp1": STEADY})
+    assert not det.is_disengaged("sp0")
+    assert det.get_pair_damping("sp0", "sp1") == 1.0
+
+
+def test_group_lull_flags_nobody():
+    det = DisengagementDetector()
+    _warm(det)
+    _feed(det, {"sp0": QUIET, "sp1": QUIET}, n=20)
+    assert det.disengaged_speakers() == []
+
+
+def test_hysteresis_holds_between_thresholds():
+    det = DisengagementDetector()
+    _warm(det)
+    _feed(det, {"sp0": QUIET, "sp1": STEADY})
+    # 50% energy / 50% f0: above drop thresholds but below recovery.
+    _feed(det, {"sp0": {"energy_rms": 0.05, "f0_std": 15.0}, "sp1": STEADY})
+    assert det.is_disengaged("sp0")
+
+
+def test_no_flag_without_history_or_with_zero_baseline():
+    det = DisengagementDetector()
+    for _ in range(5):
+        det.update("sp0", QUIET)
+        det.update("sp1", STEADY)
+    assert det.disengaged_speakers() == []
+
+    det = DisengagementDetector()
+    _feed(det, {"sp0": {}, "sp1": STEADY}, n=30)
+    assert det.disengaged_speakers() == []
+    assert not det.is_disengaged("unknown")

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
diff --git a/forgestream/emotion/__init__.py b/forgestream/emotion/__init__.py
index 507b9fd..a550a28 100644
--- a/forgestream/emotion/__init__.py
+++ b/forgestream/emotion/__init__.py
@@ -1,6 +1,7 @@
 """Audio emotion detection pipeline for ForgeStream."""
 from .buffer import AudioRingBuffer
 from .correlator import EmotionCorrelator
+from .disengagement import DisengagementDetector
 from .dynamics import GroupDynamicsEngine
 from .extractor import EmotionExtractor
 from .features import EGeMAPSExtractor, PraatExtractor, ProsodicFeatures
@@ -9,6 +10,7 @@ from .speaker import SpeakerTimeSeries
 
 __all__ = [
     "AudioRingBuffer",
+    "DisengagementDetector",
     "EGeMAPSExtractor",
     "EmotionCorpus",
     "EmotionCorrelator",
diff --git a/forgestream/emotion/disengagement.py b/forgestream/emotion/disengagement.py
new file mode 100644
index 0000000..808e479
--- /dev/null
+++ b/forgestream/emotion/disengagement.py
@@ -0,0 +1,128 @@
+"""One-sided disengagement detection from per-speaker prosodic trends.
+
+A speaker is flagged when their recent energy AND F0 variability both fall well
+below their own baseline while at least one other speaker is still near their
+own normal energy. A group-wide lull flags nobody. Flags use hysteresis.
+"""
+
+from __future__ import annotations
+
+from collections import deque
+from dataclasses import dataclass, field
+
+WINDOW_SIZE = 10
+BASELINE_WARMUP = 10
+BASELINE_ALPHA = 0.02
+ENERGY_DROP_RATIO = 0.6
+F0_DROP_RATIO = 0.4
+RECOVERY_RATIO = 0.7
+PEER_NORMAL_RATIO = 0.8
+MIN_BASELINE = 1e-3
+
+
+@dataclass
+class _SpeakerState:
+    window: deque[tuple[float, float]] = field(
+        default_factory=lambda: deque(maxlen=WINDOW_SIZE)
+    )
+    warmup_count: int = 0
+    energy_sum: float = 0.0
+    f0_sum: float = 0.0
+    energy_base: float = 0.0
+    f0_base: float = 0.0
+    flagged: bool = False
+
+    @property
+    def has_baseline(self) -> bool:
+        return self.warmup_count >= BASELINE_WARMUP
+
+    @property
+    def ready(self) -> bool:
+        return self.has_baseline and len(self.window) >= WINDOW_SIZE
+
+    @property
+    def usable_baseline(self) -> bool:
+        return self.energy_base >= MIN_BASELINE and self.f0_base >= MIN_BASELINE
+
+    def window_means(self) -> tuple[float, float]:
+        n = len(self.window)
+        return (
+            sum(e for e, _ in self.window) / n,
+            sum(f for _, f in self.window) / n,
+        )
+
+
+class DisengagementDetector:
+    """Flags speakers whose prosody has dropped while others stay engaged."""
+
+    def __init__(self, damping_factor: float = 0.3) -> None:
+        self.damping_factor = damping_factor
+        self._speakers: dict[str, _SpeakerState] = {}
+
+    def update(self, speaker_id: str, features: dict) -> None:
+        energy = float(features.get("energy_rms", 0.0) or 0.0)
+        f0_std = float(features.get("f0_std", 0.0) or 0.0)
+
+        st = self._speakers.setdefault(speaker_id, _SpeakerState())
+        st.window.append((energy, f0_std))
+
+        if not st.has_baseline:
+            st.warmup_count += 1
+            st.energy_sum += energy
+            st.f0_sum += f0_std
+            if st.warmup_count == BASELINE_WARMUP:
+                st.energy_base = st.energy_sum / BASELINE_WARMUP
+                st.f0_base = st.f0_sum / BASELINE_WARMUP
+        elif not st.flagged and not self._is_low(st, energy, f0_std):
+            # Slow adaptation, only from samples that are not part of a drop,
+            # so a disengagement episode cannot drag the baseline down.
+            st.energy_base += BASELINE_ALPHA * (energy - st.energy_base)
+            st.f0_base += BASELINE_ALPHA * (f0_std - st.f0_base)
+
+        self._reevaluate()
+
+    def is_disengaged(self, speaker_id: str) -> bool:
+        st = self._speakers.get(speaker_id)
+        return st is not None and st.flagged
+
+    def disengaged_speakers(self) -> list[str]:
+        return [sid for sid, st in self._speakers.items() if st.flagged]
+
+    def get_pair_damping(self, speaker_a: str, speaker_b: str) -> float:
+        if self.is_disengaged(speaker_a) or self.is_disengaged(speaker_b):
+            return self.damping_factor
+        return 1.0
+
+    @staticmethod
+    def _is_low(st: _SpeakerState, energy: float, f0_std: float) -> bool:
+        if not st.usable_baseline:
+            return False
+        return (
+            energy < ENERGY_DROP_RATIO * st.energy_base
+            and f0_std < F0_DROP_RATIO * st.f0_base
+        )
+
+    def _reevaluate(self) -> None:
+        # Peer engagement is computed from the pre-evaluation state so that the
+        # result does not depend on speaker iteration order.
+        engaged = {
+            sid
+            for sid, st in self._speakers.items()
+            if st.ready
+            and st.usable_baseline
+            and st.window_means()[0] >= PEER_NORMAL_RATIO * st.energy_base
+        }
+
+        for sid, st in self._speakers.items():
+            if not st.ready or not st.usable_baseline:
+                st.flagged = False
+                continue
+            energy, f0_std = st.window_means()
+            if st.flagged:
+                if (
+                    energy >= RECOVERY_RATIO * st.energy_base
+                    and f0_std >= RECOVERY_RATIO * st.f0_base
+                ):
+                    st.flagged = False
+            elif self._is_low(st, energy, f0_std) and (engaged - {sid}):
+                st.flagged = True
diff --git a/tests/emotion/test_disengagement.py b/tests/emotion/test_disengagement.py
new file mode 100644
index 0000000..597d990
--- /dev/null
+++ b/tests/emotion/test_disengagement.py
@@ -0,0 +1,55 @@
+from forgestream.emotion.disengagement import DisengagementDetector
+
+STEADY = {"energy_rms": 0.10, "f0_std": 30.0}
+
+
+def _warm(det, speakers, n=15):
+    for _ in range(n):
+        for s in speakers:
+            det.update(s, STEADY)
+
+
+def test_one_sided_drop_flags_then_recovers():
+    det = DisengagementDetector()
+    _warm(det, ["sp0", "sp1"])
+    for _ in range(12):
+        det.update("sp0", {"energy_rms": 0.03, "f0_std": 8.0, "arousal": 0.1})
+        det.update("sp1", STEADY)
+    assert det.disengaged_speakers() == ["sp0"]
+    assert det.get_pair_damping("sp0", "sp1") == 0.3
+    assert det.get_pair_damping("sp1", "ghost") == 1.0
+
+    for _ in range(12):
+        det.update("sp0", {"energy_rms": 0.08, "f0_std": 25.0})
+        det.update("sp1", STEADY)
+    assert det.disengaged_speakers() == []
+
+
+def test_group_lull_flags_nobody():
+    det = DisengagementDetector()
+    _warm(det, ["a", "b"])
+    for _ in range(20):
+        for s in ("a", "b"):
+            det.update(s, {"energy_rms": 0.02, "f0_std": 5.0})
+    assert det.disengaged_speakers() == []
+
+
+def test_hysteresis_holds_between_thresholds():
+    det = DisengagementDetector()
+    _warm(det, ["a", "b"])
+    for _ in range(12):
+        det.update("a", {"energy_rms": 0.03, "f0_std": 8.0})
+        det.update("b", STEADY)
+    for _ in range(12):  # energy recovered, F0 std not
+        det.update("a", {"energy_rms": 0.09, "f0_std": 10.0})
+        det.update("b", STEADY)
+    assert det.is_disengaged("a")
+
+
+def test_zero_baseline_never_flagged_and_unknown_false():
+    det = DisengagementDetector()
+    for _ in range(40):
+        det.update("z", {})
+        det.update("y", STEADY)
+    assert det.disengaged_speakers() == []
+    assert det.is_disengaged("nobody") is False

```
