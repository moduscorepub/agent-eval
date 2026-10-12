# Pair 32 (forgestream-55dd23a4)

Which patch would you merge? Answer in answers.md as `32: A`, `32: B`, or `32: =` if you cannot tell.

## Issue

Persist trust region state and close the GRPO loop in GeminiLiveStream

Two parts of the self-improvement loop don't carry over between meetings.

**1. GeminiLiveStream doesn't use persisted learning state.**
- At construction it should load the evaluator weights saved by earlier meetings from `config.data_dir`. With no saved file, the evaluator should keep its defaults, for example engagement = 0.15, and the meeting count should be 1.
- With a saved `weights.json` that has custom weights and `meeting_count: 5`, `orchestrator.evaluator.weights` should reflect those values. `stream._meeting_count` should be 5.
- The loaded meeting count should also be passed as `meeting_count` when the rapport engine is attached.
- The signature should change to `async def stop(self, run_post_meeting: bool = True) -> dict | None`.
  - With the default, `stop()` should shut down as it does now, then run post-meeting synthesis over the orchestrator's buffered events. It should use `config.meeting_name`, or "unnamed" if unset, and the stream's audio buffer.
  - It should return the synthesis result dict, which includes `weights`, `meeting_count`, `rapport_weights` and `e_meso`.
  - With `run_post_meeting=False`, it should skip synthesis and return `None`.

**2. TrustRegion state is lost between sessions.**
- Add `TrustRegion.save(path: str | Path) -> None`. It should write `consecutive_improvements`, `total_violations`, `meeting_count`, `volatility` and `epsilon` to JSON, and create missing parent directories.
- Add `TrustRegion.load(path: str | Path) -> TrustRegion` as a classmethod. After a save and load round trip, the counters and `epsilon` should match the original. If the file doesn't exist, it should return a default `TrustRegion()` without raising. Missing keys in an existing file should fall back to defaults.

## Patch A

```diff
diff --git a/forgestream/governor/trust_region.py b/forgestream/governor/trust_region.py
index 4b4e753..0e9a5fe 100644
--- a/forgestream/governor/trust_region.py
+++ b/forgestream/governor/trust_region.py
@@ -3,6 +3,8 @@
 from __future__ import annotations
 
 import math
+import json
+from pathlib import Path
 
 
 class TrustRegion:
@@ -56,6 +58,34 @@ class TrustRegion:
             0, self._consecutive_improvements - 2
         )
 
+    def save(self, path: str | Path) -> None:
+        """Persist trust region state to JSON, creating parent directories."""
+        path = Path(path)
+        path.parent.mkdir(parents=True, exist_ok=True)
+        path.write_text(json.dumps({
+            "consecutive_improvements": self._consecutive_improvements,
+            "total_violations": self._total_violations,
+            "meeting_count": self._meeting_count,
+            "volatility": self._volatility,
+            "epsilon": self.epsilon,
+        }))
+
+    @classmethod
+    def load(cls, path: str | Path) -> TrustRegion:
+        """Load trust region state; returns a default instance if the file is absent."""
+        tr = cls()
+        path = Path(path)
+        if not path.exists():
+            return tr
+        data = json.loads(path.read_text())
+        tr._consecutive_improvements = data.get(
+            "consecutive_improvements", tr._consecutive_improvements
+        )
+        tr._total_violations = data.get("total_violations", tr._total_violations)
+        tr._meeting_count = data.get("meeting_count", tr._meeting_count)
+        tr._volatility = data.get("volatility", tr._volatility)
+        return tr
+
     def set_volatility(self, volatility: float) -> None:
         """Update the micro-evaluator volatility."""
         self._volatility = max(0.0, min(1.0, volatility))
diff --git a/forgestream/live_stream.py b/forgestream/live_stream.py
index 06d284b..9f69956 100644
--- a/forgestream/live_stream.py
+++ b/forgestream/live_stream.py
@@ -17,6 +17,7 @@ from .gemini.context import ContextBuilder
 from .gemini.extraction import ClaimExtractor
 from .graph.materializer import GraphMaterializer
 from .orchestrator import Orchestrator
+from .post_meeting import PostMeetingSynthesis
 from .synthesis.requirements import RequirementDetector
 
 logger = logging.getLogger(__name__)
@@ -72,6 +73,11 @@ class GeminiLiveStream:
         self.audio_source = audio_source
         self.mode = mode
 
+        # Load learning state persisted by earlier meetings
+        persisted = PostMeetingSynthesis(config, data_dir=config.data_dir)
+        orchestrator.evaluator.weights = persisted.load_weights()
+        self._meeting_count: int = persisted.load_meeting_count()
+
         self._session = None
         self._active = False
         self._tasks: list[asyncio.Task] = []
@@ -111,6 +117,7 @@ class GeminiLiveStream:
             self.dynamics_engine = orchestrator.attach_dynamics_engine()
             if config.rapport_enabled:
                 self.rapport_engine = orchestrator.attach_rapport_engine(
+                    meeting_count=self._meeting_count,
                     damping_factor=config.rapport_damping_factor,
                     runpod_endpoint=config.runpod_crqa_endpoint,
                     runpod_timeout=config.runpod_timeout_seconds,
@@ -181,8 +188,11 @@ class GeminiLiveStream:
                 asyncio.create_task(self._emotion_extraction_loop())
             )
 
-    async def stop(self) -> None:
-        """Stop all loops and disconnect."""
+    async def stop(self, run_post_meeting: bool = True) -> dict | None:
+        """Stop all loops and disconnect, then optionally run post-meeting synthesis.
+
+        Returns the synthesis result dict, or None when run_post_meeting is False.
+        """
         self._active = False
         await self.audio_source.stop()
         for task in self._tasks:
@@ -191,6 +201,16 @@ class GeminiLiveStream:
             await self._session.close()
             self._session = None
 
+        if not run_post_meeting:
+            return None
+
+        synthesis = PostMeetingSynthesis(self.config, data_dir=self.config.data_dir)
+        return await synthesis.run(
+            list(self.orchestrator._event_buffer),
+            meeting_name=self.config.meeting_name or "unnamed",
+            audio_buffer=self.audio_buffer,
+        )
+
     async def _send_loop(self) -> None:
         """Send audio chunks to Gemini and tee into emotion pipeline."""
         try:

```

## Patch B

```diff
diff --git a/forgestream/governor/trust_region.py b/forgestream/governor/trust_region.py
index 4b4e753..20dcaa2 100644
--- a/forgestream/governor/trust_region.py
+++ b/forgestream/governor/trust_region.py
@@ -3,6 +3,8 @@
 from __future__ import annotations
 
 import math
+import json
+from pathlib import Path
 
 
 class TrustRegion:
@@ -23,6 +25,38 @@ class TrustRegion:
         self._meeting_count: int = 0
         self._volatility: float = 0.0
 
+    def save(self, path: str | Path) -> None:
+        """Persist trust region state to JSON, creating parent dirs."""
+        path = Path(path)
+        path.parent.mkdir(parents=True, exist_ok=True)
+        data = {
+            "consecutive_improvements": self._consecutive_improvements,
+            "total_violations": self._total_violations,
+            "meeting_count": self._meeting_count,
+            "volatility": self._volatility,
+            "epsilon": self.epsilon,
+        }
+        path.write_text(json.dumps(data, indent=2))
+
+    @classmethod
+    def load(cls, path: str | Path) -> TrustRegion:
+        """Load trust region state from JSON; defaults if the file is absent.
+
+        epsilon is derived from the other fields, so it is not restored directly.
+        """
+        tr = cls()
+        path = Path(path)
+        if not path.exists():
+            return tr
+        data = json.loads(path.read_text())
+        tr._consecutive_improvements = data.get(
+            "consecutive_improvements", tr._consecutive_improvements
+        )
+        tr._total_violations = data.get("total_violations", tr._total_violations)
+        tr._meeting_count = data.get("meeting_count", tr._meeting_count)
+        tr._volatility = data.get("volatility", tr._volatility)
+        return tr
+
     @property
     def epsilon(self) -> float:
         """Current trust region value."""
diff --git a/forgestream/live_stream.py b/forgestream/live_stream.py
index 06d284b..079765d 100644
--- a/forgestream/live_stream.py
+++ b/forgestream/live_stream.py
@@ -17,6 +17,7 @@ from .gemini.context import ContextBuilder
 from .gemini.extraction import ClaimExtractor
 from .graph.materializer import GraphMaterializer
 from .orchestrator import Orchestrator
+from .post_meeting import PostMeetingSynthesis
 from .synthesis.requirements import RequirementDetector
 
 logger = logging.getLogger(__name__)
@@ -72,6 +73,11 @@ class GeminiLiveStream:
         self.audio_source = audio_source
         self.mode = mode
 
+        # Load learning state persisted by earlier meetings
+        persisted = PostMeetingSynthesis(config, data_dir=config.data_dir)
+        orchestrator.evaluator.weights = persisted.load_weights()
+        self._meeting_count = persisted.load_meeting_count()
+
         self._session = None
         self._active = False
         self._tasks: list[asyncio.Task] = []
@@ -111,6 +117,7 @@ class GeminiLiveStream:
             self.dynamics_engine = orchestrator.attach_dynamics_engine()
             if config.rapport_enabled:
                 self.rapport_engine = orchestrator.attach_rapport_engine(
+                    meeting_count=self._meeting_count,
                     damping_factor=config.rapport_damping_factor,
                     runpod_endpoint=config.runpod_crqa_endpoint,
                     runpod_timeout=config.runpod_timeout_seconds,
@@ -181,8 +188,11 @@ class GeminiLiveStream:
                 asyncio.create_task(self._emotion_extraction_loop())
             )
 
-    async def stop(self) -> None:
-        """Stop all loops and disconnect."""
+    async def stop(self, run_post_meeting: bool = True) -> dict | None:
+        """Stop all loops and disconnect, then run post-meeting synthesis.
+
+        Returns the synthesis result, or None if run_post_meeting is False.
+        """
         self._active = False
         await self.audio_source.stop()
         for task in self._tasks:
@@ -191,6 +201,16 @@ class GeminiLiveStream:
             await self._session.close()
             self._session = None
 
+        if not run_post_meeting:
+            return None
+
+        synthesis = PostMeetingSynthesis(self.config, data_dir=self.config.data_dir)
+        return await synthesis.run(
+            self.orchestrator._event_buffer,
+            meeting_name=self.config.meeting_name or "unnamed",
+            audio_buffer=self.audio_buffer,
+        )
+
     async def _send_loop(self) -> None:
         """Send audio chunks to Gemini and tee into emotion pipeline."""
         try:

```
