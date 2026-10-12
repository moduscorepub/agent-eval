# Pair 11 (forgestream-ac0e3178)

Which patch would you merge? Answer in answers.md as `11: A`, `11: B`, or `11: =` if you cannot tell.

## Issue

Governor should use rapport signals: evaluator, axiom checker, trust region

The SOS governor ignores rapport. `RAPPORT_SCORE` events are not used when scoring emotional engagement, the axiom checker cannot flag rapport degradation, and the trust region can't use rapport trend when recording meeting outcomes. Three changes are needed.

1. **Evaluator.** `Evaluator.compute_metrics` should include `RAPPORT_SCORE` events in `emotional_engagement`. When at least one exists, use the `group_composite` value from the most recent one (default 0.5 if missing) with weight 0.4. The rest of the score comes from the prosodic features, with arousal weighted 0.3 and F0 variability weighted 0.3. When no `RAPPORT_SCORE` events exist, keep the current prosodic-only calculation: 0.4 arousal, 0.3 F0 variability, 0.3 energy. With neither event type, return 0.5. If rapport is present but prosodic events are absent, the prosodic parts take neutral defaults. The result stays clamped to [0, 1]. For example, a high `group_composite` of 0.85 with moderate prosody should give engagement above 0.6.

2. **Axiom checker.** Add `AxiomChecker.check_rapport_trend(rapport_trajectory: list[float], disengaged: bool) -> AxiomResult`. It returns an advisory result with `axiom="rapport_advisory"`. The result has `holds=False` only if `disengaged` is true, the trajectory has at least 3 entries, and rapport declines for at least 3 consecutive windows. The reason string reports the number of declines. In every other case, including no disengagement or a short trajectory, it returns `holds=True`. This is a warning, not a formal axiom violation.

3. **Trust region.** Add an optional parameter to `TrustRegion.record_meeting_result(e_macro_improved: bool, axiom_violations: int, rapport_trend: float = 0.0)`. When `e_macro_improved` is true and `rapport_trend > 0.1`, `consecutive_improvements` should increase by 1.5 rather than 1. Otherwise it increases by 1 as before. Existing callers that omit `rapport_trend` must see no change in behavior.

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
diff --git a/forgestream/governor/axioms.py b/forgestream/governor/axioms.py
index dd8dbaa..14fa3e1 100644
--- a/forgestream/governor/axioms.py
+++ b/forgestream/governor/axioms.py
@@ -91,6 +91,33 @@ class AxiomChecker:
             )
         return AxiomResult(axiom="bounded_step", holds=True)
 
+    def check_rapport_trend(
+        self, rapport_trajectory: list[float], disengaged: bool
+    ) -> AxiomResult:
+        """Advisory check for rapport degradation (not a formal axiom).
+
+        holds=False only when disengaged, the trajectory has >= 3 entries,
+        and rapport declined for >= 3 consecutive windows.
+        """
+        if not disengaged or len(rapport_trajectory) < 3:
+            return AxiomResult(axiom="rapport_advisory", holds=True)
+
+        run = longest = 0
+        for prev, cur in zip(rapport_trajectory, rapport_trajectory[1:]):
+            run = run + 1 if cur < prev else 0
+            longest = max(longest, run)
+
+        if longest >= 3:
+            return AxiomResult(
+                axiom="rapport_advisory",
+                holds=False,
+                reason=(
+                    f"{longest} consecutive declining rapport windows "
+                    "with active disengagement"
+                ),
+            )
+        return AxiomResult(axiom="rapport_advisory", holds=True)
+
     def check_constraint(
         self,
         verified_claims_intact: bool,
diff --git a/forgestream/governor/evaluator.py b/forgestream/governor/evaluator.py
index a404156..1e4fb63 100644
--- a/forgestream/governor/evaluator.py
+++ b/forgestream/governor/evaluator.py
@@ -112,35 +112,52 @@ class Evaluator:
 
     @staticmethod
     def _emotional_engagement(events: list[Event]) -> float:
-        """Compute emotional engagement from PROSODIC_FEATURE events.
+        """Compute emotional engagement from RAPPORT_SCORE and PROSODIC_FEATURE events.
 
-        Combines:
-        - Mean arousal across speakers (weighted 0.4)
-        - F0 variability across speakers (weighted 0.3)
-        - Energy level (weighted 0.3)
+        With rapport (latest group_composite, weighted 0.4):
+          0.4 * rapport + 0.3 * arousal + 0.3 * F0 variability
+        Without rapport (prosodic only):
+          0.4 * arousal + 0.3 * F0 variability + 0.3 * energy
 
-        Returns 0.5 if no prosodic events exist (graceful default).
+        Returns 0.5 if neither event type exists. When rapport exists but
+        prosodic events do not, prosodic components default to neutral (0.5).
         """
+        rapport_events = [
+            e for e in events
+            if e.event_type == EventType.RAPPORT_SCORE
+        ]
         prosodic = [
             e for e in events
             if e.event_type == EventType.PROSODIC_FEATURE
         ]
-        if not prosodic:
+        if not prosodic and not rapport_events:
             return 0.5
 
-        arousals = [e.payload.get("arousal", 0.5) for e in prosodic]
-        f0_stds = [e.payload.get("f0_std", 0.0) for e in prosodic]
-        energies = [e.payload.get("energy_rms", 0.0) for e in prosodic]
-
-        mean_arousal = sum(arousals) / len(arousals)
-        # Normalize F0 std: typical range 0-80 Hz
-        mean_f0_var = min(1.0, (sum(f0_stds) / len(f0_stds)) / 80.0)
-        # Normalize energy: typical range 0-0.15
-        mean_energy = min(1.0, (sum(energies) / len(energies)) / 0.15)
-
-        engagement = (
-            0.4 * mean_arousal
-            + 0.3 * mean_f0_var
-            + 0.3 * mean_energy
-        )
+        if prosodic:
+            arousals = [e.payload.get("arousal", 0.5) for e in prosodic]
+            f0_stds = [e.payload.get("f0_std", 0.0) for e in prosodic]
+            energies = [e.payload.get("energy_rms", 0.0) for e in prosodic]
+            mean_arousal = sum(arousals) / len(arousals)
+            # Normalize F0 std: typical range 0-80 Hz
+            mean_f0_var = min(1.0, (sum(f0_stds) / len(f0_stds)) / 80.0)
+            # Normalize energy: typical range 0-0.15
+            mean_energy = min(1.0, (sum(energies) / len(energies)) / 0.15)
+        else:
+            mean_arousal = 0.5
+            mean_f0_var = 0.5
+            mean_energy = 0.5
+
+        if rapport_events:
+            composite = rapport_events[-1].payload.get("group_composite", 0.5)
+            engagement = (
+                0.4 * composite
+                + 0.3 * mean_arousal
+                + 0.3 * mean_f0_var
+            )
+        else:
+            engagement = (
+                0.4 * mean_arousal
+                + 0.3 * mean_f0_var
+                + 0.3 * mean_energy
+            )
         return max(0.0, min(1.0, engagement))
diff --git a/forgestream/governor/trust_region.py b/forgestream/governor/trust_region.py
index 1a4f034..13340cd 100644
--- a/forgestream/governor/trust_region.py
+++ b/forgestream/governor/trust_region.py
@@ -18,7 +18,7 @@ class TrustRegion:
     AUTO_SPAWN_THRESHOLD = 0.6
 
     def __init__(self) -> None:
-        self._consecutive_improvements: int = 0
+        self._consecutive_improvements: float = 0
         self._total_violations: int = 0
         self._meeting_count: int = 0
         self._volatility: float = 0.0
@@ -32,14 +32,20 @@ class TrustRegion:
         return max(self.EPSILON_FLOOR, min(self.EPSILON_CEILING, raw))
 
     def record_meeting_result(
-        self, e_macro_improved: bool, axiom_violations: int
+        self,
+        e_macro_improved: bool,
+        axiom_violations: int,
+        rapport_trend: float = 0.0,
     ) -> None:
-        """Record the outcome of a meeting."""
+        """Record the outcome of a meeting.
+
+        An improving E with rising rapport (trend > 0.1) counts as 1.5.
+        """
         self._meeting_count += 1
         self._total_violations += axiom_violations
 
         if e_macro_improved:
-            self._consecutive_improvements += 1
+            self._consecutive_improvements += 1.5 if rapport_trend > 0.1 else 1
         else:
             self._consecutive_improvements = max(
                 0, self._consecutive_improvements - 1

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
diff --git a/forgestream/governor/axioms.py b/forgestream/governor/axioms.py
index dd8dbaa..874d33e 100644
--- a/forgestream/governor/axioms.py
+++ b/forgestream/governor/axioms.py
@@ -61,6 +61,36 @@ class AxiomChecker:
 
         return AxiomResult(axiom="monotone", holds=True)
 
+    def check_rapport_trend(
+        self, rapport_trajectory: list[float], disengaged: bool
+    ) -> AxiomResult:
+        """Advisory check for rapport degradation (not a formal axiom).
+
+        holds=False only when disengagement is active, the trajectory has
+        at least 3 entries, and rapport has declined for at least 3
+        consecutive windows.
+        """
+        if not disengaged or len(rapport_trajectory) < 3:
+            return AxiomResult(axiom="rapport_advisory", holds=True)
+
+        consecutive_declines = 0
+        for i in range(1, len(rapport_trajectory)):
+            if rapport_trajectory[i] < rapport_trajectory[i - 1]:
+                consecutive_declines += 1
+            else:
+                consecutive_declines = 0
+
+        if consecutive_declines >= 3:
+            return AxiomResult(
+                axiom="rapport_advisory",
+                holds=False,
+                reason=(
+                    f"{consecutive_declines} consecutive declining rapport "
+                    "windows with active disengagement"
+                ),
+            )
+        return AxiomResult(axiom="rapport_advisory", holds=True)
+
     def check_bounded_step(
         self,
         semantic_drift: float,
diff --git a/forgestream/governor/evaluator.py b/forgestream/governor/evaluator.py
index a404156..f50175b 100644
--- a/forgestream/governor/evaluator.py
+++ b/forgestream/governor/evaluator.py
@@ -112,35 +112,54 @@ class Evaluator:
 
     @staticmethod
     def _emotional_engagement(events: list[Event]) -> float:
-        """Compute emotional engagement from PROSODIC_FEATURE events.
+        """Compute emotional engagement from RAPPORT_SCORE and PROSODIC_FEATURE events.
 
-        Combines:
-        - Mean arousal across speakers (weighted 0.4)
-        - F0 variability across speakers (weighted 0.3)
-        - Energy level (weighted 0.3)
+        With RAPPORT_SCORE events: 0.4 * latest group_composite (default 0.5)
+        + 0.3 * mean arousal + 0.3 * F0 variability. Missing prosodic events
+        use neutral 0.5 defaults.
 
-        Returns 0.5 if no prosodic events exist (graceful default).
+        Without RAPPORT_SCORE events: 0.4 * arousal + 0.3 * F0 variability
+        + 0.3 * energy.
+
+        Returns 0.5 if neither event type exists.
         """
+        rapport_events = [
+            e for e in events
+            if e.event_type == EventType.RAPPORT_SCORE
+        ]
         prosodic = [
             e for e in events
             if e.event_type == EventType.PROSODIC_FEATURE
         ]
-        if not prosodic:
+        if not rapport_events and not prosodic:
             return 0.5
 
-        arousals = [e.payload.get("arousal", 0.5) for e in prosodic]
-        f0_stds = [e.payload.get("f0_std", 0.0) for e in prosodic]
-        energies = [e.payload.get("energy_rms", 0.0) for e in prosodic]
-
-        mean_arousal = sum(arousals) / len(arousals)
-        # Normalize F0 std: typical range 0-80 Hz
-        mean_f0_var = min(1.0, (sum(f0_stds) / len(f0_stds)) / 80.0)
-        # Normalize energy: typical range 0-0.15
-        mean_energy = min(1.0, (sum(energies) / len(energies)) / 0.15)
-
-        engagement = (
-            0.4 * mean_arousal
-            + 0.3 * mean_f0_var
-            + 0.3 * mean_energy
-        )
+        if prosodic:
+            arousals = [e.payload.get("arousal", 0.5) for e in prosodic]
+            f0_stds = [e.payload.get("f0_std", 0.0) for e in prosodic]
+            energies = [e.payload.get("energy_rms", 0.0) for e in prosodic]
+
+            mean_arousal = sum(arousals) / len(arousals)
+            # Normalize F0 std: typical range 0-80 Hz
+            mean_f0_var = min(1.0, (sum(f0_stds) / len(f0_stds)) / 80.0)
+            # Normalize energy: typical range 0-0.15
+            mean_energy = min(1.0, (sum(energies) / len(energies)) / 0.15)
+        else:
+            mean_arousal = 0.5
+            mean_f0_var = 0.5
+            mean_energy = 0.5
+
+        if rapport_events:
+            composite = rapport_events[-1].payload.get("group_composite", 0.5)
+            engagement = (
+                0.4 * composite
+                + 0.3 * mean_arousal
+                + 0.3 * mean_f0_var
+            )
+        else:
+            engagement = (
+                0.4 * mean_arousal
+                + 0.3 * mean_f0_var
+                + 0.3 * mean_energy
+            )
         return max(0.0, min(1.0, engagement))
diff --git a/forgestream/governor/trust_region.py b/forgestream/governor/trust_region.py
index 1a4f034..a51b687 100644
--- a/forgestream/governor/trust_region.py
+++ b/forgestream/governor/trust_region.py
@@ -18,7 +18,7 @@ class TrustRegion:
     AUTO_SPAWN_THRESHOLD = 0.6
 
     def __init__(self) -> None:
-        self._consecutive_improvements: int = 0
+        self._consecutive_improvements: float = 0
         self._total_violations: int = 0
         self._meeting_count: int = 0
         self._volatility: float = 0.0
@@ -32,14 +32,20 @@ class TrustRegion:
         return max(self.EPSILON_FLOOR, min(self.EPSILON_CEILING, raw))
 
     def record_meeting_result(
-        self, e_macro_improved: bool, axiom_violations: int
+        self,
+        e_macro_improved: bool,
+        axiom_violations: int,
+        rapport_trend: float = 0.0,
     ) -> None:
-        """Record the outcome of a meeting."""
+        """Record the outcome of a meeting.
+
+        An improvement counts 1.5 instead of 1 when rapport_trend > 0.1.
+        """
         self._meeting_count += 1
         self._total_violations += axiom_violations
 
         if e_macro_improved:
-            self._consecutive_improvements += 1
+            self._consecutive_improvements += 1.5 if rapport_trend > 0.1 else 1
         else:
             self._consecutive_improvements = max(
                 0, self._consecutive_improvements - 1

```
