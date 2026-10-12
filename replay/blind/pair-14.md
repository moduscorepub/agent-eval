# Pair 14 (forgestream-efd54879)

Which patch would you merge? Answer in answers.md as `14: A`, `14: B`, or `14: =` if you cannot tell.

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
index 0000000..fb0b90c
--- /dev/null
+++ b/forgestream/emotion/disengagement.py
@@ -0,0 +1,119 @@
+"""One-sided disengagement detection from per-speaker prosodic trends.
+
+A speaker is flagged when their recent energy and F0 variability both fall well
+below their own baseline while at least one other speaker is still near their
+own normal energy. A group-wide lull is not disengagement.
+"""
+
+from __future__ import annotations
+
+import math
+from collections import deque
+
+BASELINE_UPDATES = 10      # early updates averaged into the baseline
+WINDOW_SIZE = 8            # recent snapshots compared with the baseline
+BASELINE_ALPHA = 0.02      # slow EMA adaptation after the baseline is built
+ENERGY_DROP_RATIO = 0.6    # flag when window energy < 60% of baseline
+F0_DROP_RATIO = 0.4        # flag when window F0 std < 40% of baseline
+RECOVERY_RATIO = 0.7       # clear when both >= 70% of baseline
+PEER_ENGAGED_RATIO = 0.8   # "near normal" energy for another speaker
+MIN_BASELINE = 1e-6        # at or below this a baseline is unusable
+
+
+def _value(features: dict, key: str) -> float:
+    try:
+        v = float(features.get(key, 0.0) or 0.0)
+    except (TypeError, ValueError):
+        return 0.0
+    return v if math.isfinite(v) else 0.0
+
+
+class _SpeakerState:
+    __slots__ = ("count", "base_energy", "base_f0", "window", "flagged")
+
+    def __init__(self) -> None:
+        self.count = 0
+        self.base_energy = 0.0
+        self.base_f0 = 0.0
+        self.window: deque[tuple[float, float]] = deque(maxlen=WINDOW_SIZE)
+        self.flagged = False
+
+    def add(self, energy: float, f0_std: float) -> None:
+        self.window.append((energy, f0_std))
+        if self.count < BASELINE_UPDATES:
+            n = self.count + 1
+            self.base_energy += (energy - self.base_energy) / n
+            self.base_f0 += (f0_std - self.base_f0) / n
+        elif not self.flagged:
+            self.base_energy += BASELINE_ALPHA * (energy - self.base_energy)
+            self.base_f0 += BASELINE_ALPHA * (f0_std - self.base_f0)
+        self.count += 1
+
+    @property
+    def ready(self) -> bool:
+        return (
+            self.count >= BASELINE_UPDATES
+            and len(self.window) >= WINDOW_SIZE
+            and self.base_energy > MIN_BASELINE
+            and self.base_f0 > MIN_BASELINE
+        )
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
+    """Tracks per-speaker prosodic baselines and flags one-sided disengagement."""
+
+    def __init__(self, damping_factor: float = 0.3) -> None:
+        self.damping_factor = damping_factor
+        self._speakers: dict[str, _SpeakerState] = {}
+
+    def update(self, speaker_id: str, features: dict) -> None:
+        state = self._speakers.setdefault(speaker_id, _SpeakerState())
+        state.add(_value(features, "energy_rms"), _value(features, "f0_std"))
+        self._reevaluate(speaker_id, state)
+
+    def is_disengaged(self, speaker_id: str) -> bool:
+        state = self._speakers.get(speaker_id)
+        return state is not None and state.flagged
+
+    def disengaged_speakers(self) -> list[str]:
+        return [sid for sid, s in self._speakers.items() if s.flagged]
+
+    def get_pair_damping(self, speaker_a: str, speaker_b: str) -> float:
+        if self.is_disengaged(speaker_a) or self.is_disengaged(speaker_b):
+            return self.damping_factor
+        return 1.0
+
+    def _reevaluate(self, speaker_id: str, state: _SpeakerState) -> None:
+        if not state.ready:
+            state.flagged = False
+            return
+        energy, f0_std = state.window_means()
+        if state.flagged:
+            if (
+                energy >= RECOVERY_RATIO * state.base_energy
+                and f0_std >= RECOVERY_RATIO * state.base_f0
+            ):
+                state.flagged = False
+            return
+        if (
+            energy < ENERGY_DROP_RATIO * state.base_energy
+            and f0_std < F0_DROP_RATIO * state.base_f0
+            and self._peer_engaged(speaker_id)
+        ):
+            state.flagged = True
+
+    def _peer_engaged(self, speaker_id: str) -> bool:
+        for sid, other in self._speakers.items():
+            if sid == speaker_id or not other.ready:
+                continue
+            energy, _ = other.window_means()
+            if energy >= PEER_ENGAGED_RATIO * other.base_energy:
+                return True
+        return False
diff --git a/tests/emotion/test_disengagement.py b/tests/emotion/test_disengagement.py
new file mode 100644
index 0000000..1c973fc
--- /dev/null
+++ b/tests/emotion/test_disengagement.py
@@ -0,0 +1,55 @@
+from forgestream.emotion.disengagement import DisengagementDetector
+
+STEADY = {"energy_rms": 0.10, "f0_std": 30.0}
+QUIET = {"energy_rms": 0.03, "f0_std": 8.0}
+RECOVERED = {"energy_rms": 0.08, "f0_std": 25.0}
+
+
+def _feed(det, a, b, n):
+    for _ in range(n):
+        det.update("sp0", a)
+        det.update("sp1", b)
+
+
+def _warm():
+    det = DisengagementDetector()
+    _feed(det, STEADY, STEADY, 15)
+    return det
+
+
+def test_unknown_speaker_not_disengaged():
+    det = DisengagementDetector()
+    assert det.is_disengaged("x") is False
+    assert det.get_pair_damping("x", "y") == 1.0
+
+
+def test_no_flag_without_history():
+    det = DisengagementDetector()
+    _feed(det, QUIET, STEADY, 5)
+    assert det.disengaged_speakers() == []
+
+
+def test_one_sided_drop_flags_then_recovers():
+    det = _warm()
+    _feed(det, QUIET, STEADY, 12)
+    assert det.disengaged_speakers() == ["sp0"]
+    assert det.get_pair_damping("sp0", "sp1") == 0.3
+    # partial recovery (energy only) keeps the flag
+    _feed(det, {"energy_rms": 0.10, "f0_std": 8.0}, STEADY, 12)
+    assert det.is_disengaged("sp0")
+    _feed(det, RECOVERED, STEADY, 12)
+    assert not det.is_disengaged("sp0")
+    assert det.get_pair_damping("sp0", "sp1") == 1.0
+
+
+def test_group_lull_not_flagged():
+    det = _warm()
+    _feed(det, QUIET, QUIET, 20)
+    assert det.disengaged_speakers() == []
+
+
+def test_zero_baseline_never_flagged():
+    det = DisengagementDetector()
+    _feed(det, {}, STEADY, 15)
+    _feed(det, {"arousal": 0.9}, STEADY, 15)
+    assert not det.is_disengaged("sp0")

```

## Patch B

```diff
diff --git a/forgestream/emotion/__init__.py b/forgestream/emotion/__init__.py
index 507b9fd..a4c04ef 100644
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
@@ -12,6 +13,7 @@ __all__ = [
     "EGeMAPSExtractor",
     "EmotionCorpus",
     "EmotionCorrelator",
+    "DisengagementDetector",
     "EmotionExtractor",
     "GroupDynamicsEngine",
     "PraatExtractor",
diff --git a/forgestream/emotion/disengagement.py b/forgestream/emotion/disengagement.py
new file mode 100644
index 0000000..313cce9
--- /dev/null
+++ b/forgestream/emotion/disengagement.py
@@ -0,0 +1,120 @@
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
+BASELINE_UPDATES = 10  # early snapshots that build the baseline
+WINDOW_SIZE = 10  # recent snapshots compared against the baseline
+BASELINE_ALPHA = 0.02  # slow EMA once the baseline is established
+ENERGY_FLAG_RATIO = 0.6
+F0_FLAG_RATIO = 0.4
+RECOVERY_RATIO = 0.7
+PEER_NORMAL_RATIO = 0.8  # "near normal" energy for the other speakers
+MIN_BASELINE = 1e-6
+
+
+@dataclass
+class _SpeakerState:
+    count: int = 0
+    energy_base: float = 0.0
+    f0_base: float = 0.0
+    window: deque[tuple[float, float]] = field(
+        default_factory=lambda: deque(maxlen=WINDOW_SIZE)
+    )
+    flagged: bool = False
+
+    @property
+    def ready(self) -> bool:
+        return self.count >= BASELINE_UPDATES and len(self.window) == WINDOW_SIZE
+
+    @property
+    def usable(self) -> bool:
+        return self.energy_base > MIN_BASELINE and self.f0_base > MIN_BASELINE
+
+    def recent(self) -> tuple[float, float]:
+        n = len(self.window)
+        return (
+            sum(e for e, _ in self.window) / n,
+            sum(f for _, f in self.window) / n,
+        )
+
+
+class DisengagementDetector:
+    """Tracks per-speaker prosodic baselines and flags one-sided disengagement."""
+
+    def __init__(self, damping_factor: float = 0.3) -> None:
+        self._damping_factor = damping_factor
+        self._speakers: dict[str, _SpeakerState] = {}
+
+    def update(self, speaker_id: str, features: dict) -> None:
+        energy = float(features.get("energy_rms", 0.0) or 0.0)
+        f0_std = float(features.get("f0_std", 0.0) or 0.0)
+
+        st = self._speakers.setdefault(speaker_id, _SpeakerState())
+        st.window.append((energy, f0_std))
+        st.count += 1
+
+        if st.count <= BASELINE_UPDATES:
+            # Running mean over the early updates.
+            st.energy_base += (energy - st.energy_base) / st.count
+            st.f0_base += (f0_std - st.f0_base) / st.count
+        elif not st.flagged and not (
+            energy < ENERGY_FLAG_RATIO * st.energy_base
+            and f0_std < F0_FLAG_RATIO * st.f0_base
+        ):
+            # Adapt slowly, but never learn the disengaged state as normal.
+            st.energy_base += BASELINE_ALPHA * (energy - st.energy_base)
+            st.f0_base += BASELINE_ALPHA * (f0_std - st.f0_base)
+
+        self._reevaluate()
+
+    def _reevaluate(self) -> None:
+        recent = {
+            sid: st.recent() for sid, st in self._speakers.items() if st.ready
+        }
+        # Snapshot of who is near normal, taken before any flag changes this pass.
+        near_normal = {
+            sid
+            for sid, st in self._speakers.items()
+            if st.ready
+            and st.usable
+            and not st.flagged
+            and recent[sid][0] >= PEER_NORMAL_RATIO * st.energy_base
+        }
+
+        for sid, st in self._speakers.items():
+            if not st.ready or not st.usable:
+                st.flagged = False
+                continue
+            energy, f0_std = recent[sid]
+            if st.flagged:
+                if (
+                    energy >= RECOVERY_RATIO * st.energy_base
+                    and f0_std >= RECOVERY_RATIO * st.f0_base
+                ):
+                    st.flagged = False
+            elif (
+                energy < ENERGY_FLAG_RATIO * st.energy_base
+                and f0_std < F0_FLAG_RATIO * st.f0_base
+                and (near_normal - {sid})
+            ):
+                st.flagged = True
+
+    def is_disengaged(self, speaker_id: str) -> bool:
+        st = self._speakers.get(speaker_id)
+        return st.flagged if st is not None else False
+
+    def disengaged_speakers(self) -> list[str]:
+        return [sid for sid, st in self._speakers.items() if st.flagged]
+
+    def get_pair_damping(self, speaker_a: str, speaker_b: str) -> float:
+        if self.is_disengaged(speaker_a) or self.is_disengaged(speaker_b):
+            return self._damping_factor
+        return 1.0
diff --git a/tests/emotion/test_disengagement.py b/tests/emotion/test_disengagement.py
new file mode 100644
index 0000000..6153abd
--- /dev/null
+++ b/tests/emotion/test_disengagement.py
@@ -0,0 +1,56 @@
+from forgestream.emotion.disengagement import DisengagementDetector
+
+STEADY = {"energy_rms": 0.10, "f0_std": 30.0}
+QUIET = {"energy_rms": 0.03, "f0_std": 8.0}
+RECOVERED = {"energy_rms": 0.08, "f0_std": 25.0}
+
+
+def _feed(det, speakers, n, **per_speaker):
+    for _ in range(n):
+        for s in speakers:
+            det.update(s, per_speaker.get(s, STEADY))
+
+
+def test_one_sided_drop_flags_and_recovers():
+    det = DisengagementDetector()
+    _feed(det, ["sp0", "sp1"], 15)
+    assert det.disengaged_speakers() == []
+    _feed(det, ["sp0", "sp1"], 12, sp0=QUIET)
+    assert det.is_disengaged("sp0")
+    assert not det.is_disengaged("sp1")
+    assert det.get_pair_damping("sp0", "sp1") == 0.3
+    _feed(det, ["sp0", "sp1"], 12, sp0=RECOVERED)
+    assert det.disengaged_speakers() == []
+    assert det.get_pair_damping("sp0", "sp1") == 1.0
+
+
+def test_group_lull_flags_nobody():
+    det = DisengagementDetector()
+    _feed(det, ["sp0", "sp1"], 15)
+    _feed(det, ["sp0", "sp1"], 15, sp0=QUIET, sp1=QUIET)
+    assert det.disengaged_speakers() == []
+
+
+def test_hysteresis_holds_between_thresholds():
+    det = DisengagementDetector()
+    _feed(det, ["sp0", "sp1"], 15)
+    _feed(det, ["sp0", "sp1"], 12, sp0=QUIET)
+    mid = {"energy_rms": 0.065, "f0_std": 20.0}  # above flag, below recovery
+    _feed(det, ["sp0", "sp1"], 12, sp0=mid)
+    assert det.is_disengaged("sp0")
+
+
+def test_zero_baseline_never_flagged():
+    det = DisengagementDetector()
+    _feed(det, ["sp0", "sp1"], 15, sp0={})
+    _feed(det, ["sp0", "sp1"], 15, sp0={})
+    assert not det.is_disengaged("sp0")
+
+
+def test_unknown_speaker_and_insufficient_history():
+    det = DisengagementDetector()
+    assert not det.is_disengaged("nobody")
+    assert det.get_pair_damping("a", "b") == 1.0
+    _feed(det, ["sp0", "sp1"], 3)
+    _feed(det, ["sp0", "sp1"], 3, sp0=QUIET)
+    assert det.disengaged_speakers() == []

```
