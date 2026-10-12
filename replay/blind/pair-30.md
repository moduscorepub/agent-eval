# Pair 30 (forgestream-d49ca481)

Which patch would you merge? Answer in answers.md as `30: A`, `30: B`, or `30: =` if you cannot tell.

## Issue

Add SenseVoice categorical emotion classification to the emotion pipeline

The emotion pipeline currently emits only continuous prosodic features. The `emotion_tag` and `emotion_confidence` payload fields are hardcoded to `None`, with a "Phase 1.5 adds SenseVoice" placeholder. We need a categorical emotion label per analysis window, produced by FunASR SenseVoice-Small.

Add `forgestream.emotion.classifier.SenseVoiceClassifier(model_name: str = "iic/SenseVoiceSmall", sample_rate: int = 16000)`.
- `SenseVoiceClassifier.is_available() -> bool` is a static method. It returns True only if `funasr` is importable.
- `classify(signal: np.ndarray) -> tuple[str, float]` takes a 1-D int16 PCM array and returns `(emotion_tag, confidence)`. The tag is one of angry, disgusted, fearful, happy, neutral, other, sad, surprised, or unknown. The model must load lazily on the first call, not in the constructor. Any failure during classification must return `("unknown", 0.0)` and log a warning, not raise.
- `SenseVoiceClassifier._parse_emotion(text: str) -> tuple[str, float]` is a static method. It extracts the emotion from `<|TAG|>` tokens in SenseVoice output, case-insensitively. A recognised tag returns confidence 0.8. Text with no recognised tag, including an empty string, returns `("neutral", 0.5)`.

`ProsodicFeatures` gets `emotion_tag: str | None = None` and `emotion_confidence: float | None = None`. Both must appear in `to_payload()`, and `EmotionExtractor` must populate them. `EmotionExtractor.__init__` gains an optional `classifier: SenseVoiceClassifier | None = None` argument. With no classifier, both fields stay `None`. If the classifier raises, log it and keep going without dropping the event.

Add `ForgeStreamConfig.sensevoice_model: str = "iic/SenseVoiceSmall"`. `GeminiLiveStream` should create the classifier only when `emotion_ml_enabled` is true and `funasr` is installed. If `funasr` is missing, it should log at info level and run without categorical emotion, with no error. The prosodic pipeline must keep working either way.

## Patch A

```diff
diff --git a/data/user_profile.json b/data/user_profile.json
index aa5d5cb..aac2759 100644
--- a/data/user_profile.json
+++ b/data/user_profile.json
@@ -1,16 +1,16 @@
 {
-  "avg_arousal": 0.48965243863040014,
+  "avg_arousal": 0.4893775607234562,
   "avg_f0_variability": 0.0,
   "preferred_energy": 0.10000000000000002,
-  "expressiveness_score": 0.24441523417088004,
+  "expressiveness_score": 0.23762574986936327,
   "peak_engagement_topics": [],
   "disengagement_triggers": [
     "x"
   ],
-  "avg_meeting_engagement": 0.4935607501541607,
+  "avg_meeting_engagement": 0.4935031040789303,
   "engagement_trend": 0.0,
   "topic_frequency": {
-    "x": 18
+    "x": 21
   },
   "topic_depth": {
     "x": 1.0
@@ -22,6 +22,6 @@
   "ignored_categories": [],
   "avg_meeting_duration_minutes": 30.0,
   "preferred_mode": "collaborative",
-  "meetings_count": 24,
-  "last_updated": "2026-03-29T04:57:37.305406+00:00"
+  "meetings_count": 28,
+  "last_updated": "2026-10-11T23:44:33.858611+00:00"
 }
\ No newline at end of file
diff --git a/docs/meetings/2026-10-11-test-arch-report.md b/docs/meetings/2026-10-11-test-arch-report.md
new file mode 100644
index 0000000..87c9543
--- /dev/null
+++ b/docs/meetings/2026-10-11-test-arch-report.md
@@ -0,0 +1,27 @@
+# Architectural Analysis: test
+**Date:** 2026-10-11
+
+## Bottlenecks
+- No claim processing gaps > 10s detected.
+
+## Emotion-Quality Correlation
+- No emotion data available for correlation analysis.
+
+## Agent Performance
+- No agent timeouts recorded.
+- Claims per minute: 0.0
+
+## Config Suggestions
+- No configuration changes suggested.
+
+## Tuned Config (saved to data/config_overrides.json)
+```json
+{
+  "spawn_cooldown_seconds": 60.897709501837625,
+  "scaffold_timeout_minutes": 9.79999990521675,
+  "max_concurrent_research": 2.884844428001738,
+  "max_concurrent_scaffold": 4.074390432452313,
+  "emotion_stride_seconds": 0.9836574247694272,
+  "emotion_window_seconds": 2.9208540646149697
+}
+```
\ No newline at end of file
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
diff --git a/forgestream/config.py b/forgestream/config.py
index db83e32..500f610 100644
--- a/forgestream/config.py
+++ b/forgestream/config.py
@@ -50,6 +50,7 @@ class ForgeStreamConfig:
     emotion_window_seconds: float = 3.0   # analysis window duration
     emotion_stride_seconds: float = 1.0   # emit interval
     emotion_ml_enabled: bool = False       # SenseVoice/emotion2vec (requires torch)
+    sensevoice_model: str = "iic/SenseVoiceSmall"  # FunASR model for categorical emotion
     emotion_buffer_seconds: float = 30.0   # ring buffer capacity
 
     # Speaker diarization
diff --git a/forgestream/emotion/classifier.py b/forgestream/emotion/classifier.py
new file mode 100644
index 0000000..1f16236
--- /dev/null
+++ b/forgestream/emotion/classifier.py
@@ -0,0 +1,110 @@
+"""Categorical emotion classification using FunASR SenseVoice-Small.
+
+SenseVoice embeds an emotion token (e.g. ``<|HAPPY|>``) in its transcript
+output. This module extracts it and returns a (tag, confidence) pair.
+
+Optional — requires the ``funasr`` package. The model loads lazily on the
+first ``classify()`` call.
+"""
+
+from __future__ import annotations
+
+import logging
+import os
+import re
+import tempfile
+import wave
+
+import numpy as np
+
+logger = logging.getLogger(__name__)
+
+EMOTION_TAGS = frozenset(
+    {"angry", "disgusted", "fearful", "happy", "neutral", "other", "sad", "surprised"}
+)
+_TOKEN_RE = re.compile(r"<\|([^|<>]*)\|>")
+
+_PARSED_CONFIDENCE = 0.8  # SenseVoice emits no confidence; fixed for recognised tags
+_DEFAULT_TAG = ("neutral", 0.5)
+_FAILED = ("unknown", 0.0)
+
+
+class SenseVoiceClassifier:
+    """Categorical emotion classifier backed by SenseVoice-Small.
+
+    Parameters:
+        model_name: FunASR model identifier.
+        sample_rate: Sample rate of the int16 PCM passed to ``classify``.
+    """
+
+    def __init__(
+        self,
+        model_name: str = "iic/SenseVoiceSmall",
+        sample_rate: int = 16000,
+    ) -> None:
+        self._model_name = model_name
+        self._sample_rate = sample_rate
+        self._model = None
+
+    @staticmethod
+    def is_available() -> bool:
+        """True if ``funasr`` is importable."""
+        try:
+            import funasr  # noqa: F401
+        except ImportError:
+            return False
+        return True
+
+    def _ensure_model(self) -> None:
+        """Lazily load the SenseVoice model."""
+        if self._model is not None:
+            return
+        from funasr import AutoModel
+
+        self._model = AutoModel(model=self._model_name)
+        logger.info("SenseVoice model loaded: %s", self._model_name)
+
+    def classify(self, signal: np.ndarray) -> tuple[str, float]:
+        """Classify emotion of a 1-D int16 PCM array.
+
+        Returns ``(emotion_tag, confidence)``; ``("unknown", 0.0)`` on any failure.
+        """
+        tmp_path: str | None = None
+        try:
+            self._ensure_model()
+
+            # SenseVoice input is a WAV path.
+            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
+                tmp_path = f.name
+            pcm = np.ascontiguousarray(signal, dtype=np.int16)
+            with wave.open(tmp_path, "wb") as wf:
+                wf.setnchannels(1)
+                wf.setsampwidth(2)
+                wf.setframerate(self._sample_rate)
+                wf.writeframes(pcm.tobytes())
+
+            result = self._model.generate(input=tmp_path, language="auto")
+            if not result:
+                return _FAILED
+            return self._parse_emotion(result[0].get("text", ""))
+        except Exception as e:
+            logger.warning("SenseVoice classification failed: %s", e)
+            return _FAILED
+        finally:
+            if tmp_path is not None:
+                try:
+                    os.unlink(tmp_path)
+                except OSError:
+                    pass
+
+    @staticmethod
+    def _parse_emotion(text: str) -> tuple[str, float]:
+        """Extract the emotion from ``<|TAG|>`` tokens in SenseVoice output.
+
+        Returns ``(tag, 0.8)`` for the first recognised tag, else ``("neutral", 0.5)``.
+        """
+        for match in _TOKEN_RE.finditer(text):
+            tag = match.group(1).lower()
+            if tag in EMOTION_TAGS:
+                return tag, _PARSED_CONFIDENCE
+        return _DEFAULT_TAG
diff --git a/forgestream/emotion/extractor.py b/forgestream/emotion/extractor.py
index 2a9cf0d..6489ab2 100644
--- a/forgestream/emotion/extractor.py
+++ b/forgestream/emotion/extractor.py
@@ -14,6 +14,7 @@ import logging
 from collections import deque
 from concurrent.futures import ThreadPoolExecutor
 from uuid import UUID
+from typing import TYPE_CHECKING
 
 from forgestream.events.schema import Event, EventType
 
@@ -25,6 +26,9 @@ from .features import (
     derive_dimensional_emotion,
 )
 
+if TYPE_CHECKING:
+    from .classifier import SenseVoiceClassifier
+
 logger = logging.getLogger(__name__)
 
 AUTHOR = "emotion_extractor"
@@ -40,6 +44,9 @@ class EmotionExtractor:
         window_seconds: Duration of the analysis window (default 3.0s).
         stride_seconds: How often to emit features (default 1.0s).
         chunk_duration: Duration of each incoming chunk (default 0.5s).
+        diarizer: Optional SpeakerDiarizer.
+        classifier: Optional SenseVoiceClassifier for categorical emotion.
+            When None, emotion_tag / emotion_confidence stay None.
     """
 
     def __init__(
@@ -51,11 +58,13 @@ class EmotionExtractor:
         stride_seconds: float = 1.0,
         chunk_duration: float = 0.5,
         diarizer: "SpeakerDiarizer | None" = None,
+        classifier: "SenseVoiceClassifier | None" = None,
     ) -> None:
         self._orchestrator = orchestrator
         self._audio_buffer = audio_buffer
         self._branch_id = branch_id
         self._diarizer = diarizer
+        self._classifier = classifier
 
         self._window_seconds = window_seconds
         self._stride_seconds = stride_seconds
@@ -140,6 +149,15 @@ class EmotionExtractor:
             spectral_centroid=praat_result["spectral_centroid"],
         )
 
+        # Categorical emotion (optional; failure must not drop the event)
+        emotion_tag: str | None = None
+        emotion_confidence: float | None = None
+        if self._classifier is not None:
+            try:
+                emotion_tag, emotion_confidence = self._classifier.classify(signal)
+            except Exception as e:
+                logger.warning("Emotion classification failed: %s", e)
+
         return ProsodicFeatures(
             f0_mean=praat_result["f0_mean"],
             f0_std=praat_result["f0_std"],
@@ -153,6 +171,8 @@ class EmotionExtractor:
             arousal=arousal,
             valence=valence,
             dominance=dominance,
+            emotion_tag=emotion_tag,
+            emotion_confidence=emotion_confidence,
         )
 
     async def _emit_event(
@@ -165,8 +185,6 @@ class EmotionExtractor:
             "timestamp_ms": self._audio_buffer.chunk_timestamp_ms(chunk_index),
             "chunk_index": chunk_index,
             "window_duration_ms": int(self._window_seconds * 1000),
-            "emotion_tag": None,       # Phase 1.5 adds SenseVoice
-            "emotion_confidence": None,
         })
 
         event = Event(
diff --git a/forgestream/emotion/features.py b/forgestream/emotion/features.py
index 92110b6..9fefafc 100644
--- a/forgestream/emotion/features.py
+++ b/forgestream/emotion/features.py
@@ -40,6 +40,10 @@ class ProsodicFeatures:
     valence: float = 0.5
     dominance: float = 0.5
 
+    # Categorical emotion (SenseVoice; None when no classifier is configured)
+    emotion_tag: str | None = None
+    emotion_confidence: float | None = None
+
     def to_payload(self) -> dict:
         """Convert to ECEF event payload dict."""
         return {
@@ -55,6 +59,8 @@ class ProsodicFeatures:
             "arousal": self.arousal,
             "valence": self.valence,
             "dominance": self.dominance,
+            "emotion_tag": self.emotion_tag,
+            "emotion_confidence": self.emotion_confidence,
         }
 
 
diff --git a/forgestream/live_stream.py b/forgestream/live_stream.py
index fc0b115..b28cd1a 100644
--- a/forgestream/live_stream.py
+++ b/forgestream/live_stream.py
@@ -124,6 +124,18 @@ class GeminiLiveStream:
                     diarizer = SpeakerDiarizer(
                         huggingface_token=config.huggingface_token,
                     )
+            # Categorical emotion via SenseVoice (optional)
+            classifier = None
+            if config.emotion_ml_enabled:
+                from .emotion.classifier import SenseVoiceClassifier
+                if SenseVoiceClassifier.is_available():
+                    classifier = SenseVoiceClassifier(
+                        model_name=config.sensevoice_model,
+                    )
+                else:
+                    logger.info(
+                        "funasr not installed — running without categorical emotion"
+                    )
             self.emotion_extractor: EmotionExtractor | None = EmotionExtractor(
                 orchestrator=orchestrator,
                 audio_buffer=self.audio_buffer,
@@ -131,6 +143,7 @@ class GeminiLiveStream:
                 window_seconds=config.emotion_window_seconds,
                 stride_seconds=config.emotion_stride_seconds,
                 diarizer=diarizer,
+                classifier=classifier,
             )
             self._emotion_queue: asyncio.Queue[tuple[bytes, int]] = asyncio.Queue()
             self.emotion_correlator = orchestrator.attach_emotion_correlator()
diff --git a/tests/emotion/test_classifier.py b/tests/emotion/test_classifier.py
new file mode 100644
index 0000000..fa29e22
--- /dev/null
+++ b/tests/emotion/test_classifier.py
@@ -0,0 +1,124 @@
+"""Tests for SenseVoiceClassifier and its integration with EmotionExtractor."""
+
+import sys
+from unittest.mock import AsyncMock, MagicMock
+from uuid import uuid4
+
+import numpy as np
+import pytest
+
+from forgestream.emotion.buffer import AudioRingBuffer
+from forgestream.emotion.classifier import SenseVoiceClassifier
+from forgestream.emotion.extractor import EmotionExtractor
+
+
+class TestParseEmotion:
+    @pytest.mark.parametrize(
+        "text,tag",
+        [
+            ("<|en|><|HAPPY|><|Speech|>hello", "happy"),
+            ("<|zh|><|sad|><|Speech|>", "sad"),
+            ("<|Angry|>", "angry"),
+            ("<|DISGUSTED|>", "disgusted"),
+            ("<|FEARFUL|>", "fearful"),
+            ("<|SURPRISED|>", "surprised"),
+            ("<|OTHER|>", "other"),
+            ("<|NEUTRAL|>", "neutral"),
+        ],
+    )
+    def test_recognised_tag(self, text, tag):
+        assert SenseVoiceClassifier._parse_emotion(text) == (tag, 0.8)
+
+    @pytest.mark.parametrize("text", ["", "plain text", "<|en|><|Speech|>hi", "HAPPY"])
+    def test_no_recognised_tag_is_neutral(self, text):
+        assert SenseVoiceClassifier._parse_emotion(text) == ("neutral", 0.5)
+
+
+class TestClassify:
+    def test_constructor_does_not_load_model(self):
+        assert SenseVoiceClassifier()._model is None
+
+    def test_load_failure_returns_unknown(self, monkeypatch, caplog):
+        # Setting the module to None makes `from funasr import ...` raise ImportError
+        monkeypatch.setitem(sys.modules, "funasr", None)
+        classifier = SenseVoiceClassifier()
+        with caplog.at_level("WARNING"):
+            result = classifier.classify(np.zeros(1600, dtype=np.int16))
+        assert result == ("unknown", 0.0)
+        assert "SenseVoice classification failed" in caplog.text
+
+    def test_model_loaded_lazily_once_and_output_parsed(self):
+        classifier = SenseVoiceClassifier()
+        model = MagicMock()
+        model.generate.return_value = [{"text": "<|en|><|ANGRY|>x"}]
+        classifier._model = model
+        signal = np.zeros(1600, dtype=np.int16)
+        assert classifier.classify(signal) == ("angry", 0.8)
+        assert classifier.classify(signal) == ("angry", 0.8)
+        assert model.generate.call_count == 2
+
+    def test_generate_failure_returns_unknown(self):
+        classifier = SenseVoiceClassifier()
+        classifier._model = MagicMock()
+        classifier._model.generate.side_effect = RuntimeError("boom")
+        assert classifier.classify(np.zeros(1600, dtype=np.int16)) == ("unknown", 0.0)
+
+    def test_empty_result_returns_unknown(self):
+        classifier = SenseVoiceClassifier()
+        classifier._model = MagicMock()
+        classifier._model.generate.return_value = []
+        assert classifier.classify(np.zeros(1600, dtype=np.int16)) == ("unknown", 0.0)
+
+    def test_is_available_false_without_funasr(self, monkeypatch):
+        monkeypatch.setitem(sys.modules, "funasr", None)
+        assert SenseVoiceClassifier.is_available() is False
+
+
+def _chunk() -> bytes:
+    t = np.linspace(0, 0.5, 8000, endpoint=False)
+    return (10000 * np.sin(2 * np.pi * 200 * t)).astype(np.int16).tobytes()
+
+
+async def _run(classifier):
+    orch = MagicMock()
+    orch.session_id = uuid4()
+    orch.process_event = AsyncMock(return_value=True)
+    extractor = EmotionExtractor(
+        orchestrator=orch,
+        audio_buffer=AudioRingBuffer(capacity_seconds=10.0),
+        branch_id=uuid4(),
+        window_seconds=1.0,
+        stride_seconds=1.0,
+        classifier=classifier,
+    )
+    await extractor.process_chunk(_chunk(), 0)
+    await extractor.process_chunk(_chunk(), 1)
+    assert orch.process_event.call_count == 1
+    return orch.process_event.call_args[0][0].payload
+
+
+class TestExtractorIntegration:
+    @pytest.mark.asyncio
+    async def test_no_classifier_leaves_none(self):
+        payload = await _run(None)
+        assert payload["emotion_tag"] is None
+        assert payload["emotion_confidence"] is None
+
+    @pytest.mark.asyncio
+    async def test_classifier_populates_payload(self):
+        classifier = MagicMock()
+        classifier.classify.return_value = ("happy", 0.8)
+        payload = await _run(classifier)
+        assert payload["emotion_tag"] == "happy"
+        assert payload["emotion_confidence"] == 0.8
+        sig = classifier.classify.call_args[0][0]
+        assert sig.dtype == np.int16 and sig.shape == (16000,)
+
+    @pytest.mark.asyncio
+    async def test_classifier_exception_does_not_drop_event(self):
+        classifier = MagicMock()
+        classifier.classify.side_effect = RuntimeError("boom")
+        payload = await _run(classifier)
+        assert payload["emotion_tag"] is None
+        assert payload["emotion_confidence"] is None
+        assert "f0_mean" in payload
diff --git a/tests/emotion/test_config.py b/tests/emotion/test_config.py
index 26e8ff4..0631fe3 100644
--- a/tests/emotion/test_config.py
+++ b/tests/emotion/test_config.py
@@ -9,4 +9,5 @@ def test_emotion_config_defaults():
     assert config.emotion_window_seconds == 3.0
     assert config.emotion_stride_seconds == 1.0
     assert config.emotion_ml_enabled is False
+    assert config.sensevoice_model == "iic/SenseVoiceSmall"
     assert config.emotion_buffer_seconds == 30.0

```

## Patch B

```diff
diff --git a/data/user_profile.json b/data/user_profile.json
index aa5d5cb..b892ce8 100644
--- a/data/user_profile.json
+++ b/data/user_profile.json
@@ -1,16 +1,16 @@
 {
-  "avg_arousal": 0.48965243863040014,
+  "avg_arousal": 0.4893775607234562,
   "avg_f0_variability": 0.0,
   "preferred_energy": 0.10000000000000002,
-  "expressiveness_score": 0.24441523417088004,
+  "expressiveness_score": 0.23762574986936327,
   "peak_engagement_topics": [],
   "disengagement_triggers": [
     "x"
   ],
-  "avg_meeting_engagement": 0.4935607501541607,
+  "avg_meeting_engagement": 0.4935031040789303,
   "engagement_trend": 0.0,
   "topic_frequency": {
-    "x": 18
+    "x": 21
   },
   "topic_depth": {
     "x": 1.0
@@ -22,6 +22,6 @@
   "ignored_categories": [],
   "avg_meeting_duration_minutes": 30.0,
   "preferred_mode": "collaborative",
-  "meetings_count": 24,
-  "last_updated": "2026-03-29T04:57:37.305406+00:00"
+  "meetings_count": 28,
+  "last_updated": "2026-10-11T23:32:26.285463+00:00"
 }
\ No newline at end of file
diff --git a/docs/meetings/2026-10-11-test-arch-report.md b/docs/meetings/2026-10-11-test-arch-report.md
new file mode 100644
index 0000000..4bd5e4d
--- /dev/null
+++ b/docs/meetings/2026-10-11-test-arch-report.md
@@ -0,0 +1,27 @@
+# Architectural Analysis: test
+**Date:** 2026-10-11
+
+## Bottlenecks
+- No claim processing gaps > 10s detected.
+
+## Emotion-Quality Correlation
+- No emotion data available for correlation analysis.
+
+## Agent Performance
+- No agent timeouts recorded.
+- Claims per minute: 0.0
+
+## Config Suggestions
+- No configuration changes suggested.
+
+## Tuned Config (saved to data/config_overrides.json)
+```json
+{
+  "spawn_cooldown_seconds": 59.203733452346725,
+  "scaffold_timeout_minutes": 10.180020181927318,
+  "max_concurrent_research": 3.122364616969239,
+  "max_concurrent_scaffold": 3.9188161531171213,
+  "emotion_stride_seconds": 0.9749292835364485,
+  "emotion_window_seconds": 3.003281988122664
+}
+```
\ No newline at end of file
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
diff --git a/forgestream/config.py b/forgestream/config.py
index db83e32..500f610 100644
--- a/forgestream/config.py
+++ b/forgestream/config.py
@@ -50,6 +50,7 @@ class ForgeStreamConfig:
     emotion_window_seconds: float = 3.0   # analysis window duration
     emotion_stride_seconds: float = 1.0   # emit interval
     emotion_ml_enabled: bool = False       # SenseVoice/emotion2vec (requires torch)
+    sensevoice_model: str = "iic/SenseVoiceSmall"  # FunASR model for categorical emotion
     emotion_buffer_seconds: float = 30.0   # ring buffer capacity
 
     # Speaker diarization
diff --git a/forgestream/emotion/classifier.py b/forgestream/emotion/classifier.py
new file mode 100644
index 0000000..5705c2a
--- /dev/null
+++ b/forgestream/emotion/classifier.py
@@ -0,0 +1,111 @@
+"""Categorical emotion classification using SenseVoice-Small.
+
+Wraps FunASR's SenseVoice model. Returns emotion tags:
+angry, disgusted, fearful, happy, neutral, other, sad, surprised
+(or "unknown" when classification fails).
+
+Optional — loaded only when funasr is installed and config enables it.
+The model is loaded lazily on the first classify() call.
+"""
+
+from __future__ import annotations
+
+import logging
+import os
+import re
+import tempfile
+import wave
+
+import numpy as np
+
+logger = logging.getLogger(__name__)
+
+_EMOTION_TAGS = frozenset({
+    "angry", "disgusted", "fearful", "happy",
+    "neutral", "other", "sad", "surprised",
+})
+_TOKEN_RE = re.compile(r"<\|([^|<>]*)\|>")
+
+
+class SenseVoiceClassifier:
+    """Categorical emotion classifier using SenseVoice-Small.
+
+    Parameters:
+        model_name: FunASR model identifier (default: iic/SenseVoiceSmall).
+        sample_rate: Expected audio sample rate.
+    """
+
+    def __init__(
+        self,
+        model_name: str = "iic/SenseVoiceSmall",
+        sample_rate: int = 16000,
+    ) -> None:
+        self._model_name = model_name
+        self._sample_rate = sample_rate
+        self._model = None
+
+    @staticmethod
+    def is_available() -> bool:
+        """Check if FunASR is installed."""
+        try:
+            import funasr  # noqa: F401
+            return True
+        except ImportError:
+            return False
+
+    def _ensure_model(self) -> None:
+        """Lazily load the SenseVoice model."""
+        if self._model is not None:
+            return
+        from funasr import AutoModel
+        self._model = AutoModel(model=self._model_name)
+        logger.info("SenseVoice model loaded: %s", self._model_name)
+
+    def classify(self, signal: np.ndarray) -> tuple[str, float]:
+        """Classify emotion from a 1-D int16 PCM array.
+
+        Returns (emotion_tag, confidence). Never raises: any failure yields
+        ("unknown", 0.0).
+        """
+        tmp_path: str | None = None
+        try:
+            self._ensure_model()
+
+            # SenseVoice takes a WAV path — write a temp file.
+            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
+                tmp_path = f.name
+            pcm = np.ascontiguousarray(signal, dtype=np.int16)
+            with wave.open(tmp_path, "wb") as wf:
+                wf.setnchannels(1)
+                wf.setsampwidth(2)
+                wf.setframerate(self._sample_rate)
+                wf.writeframes(pcm.tobytes())
+
+            result = self._model.generate(input=tmp_path, language="auto")
+            if result:
+                # SenseVoice embeds emotion in text output as <|EMOTION|> tags
+                return self._parse_emotion(result[0].get("text", ""))
+            return "unknown", 0.0
+        except Exception as e:
+            logger.warning("SenseVoice classification failed: %s", e)
+            return "unknown", 0.0
+        finally:
+            if tmp_path is not None:
+                try:
+                    os.unlink(tmp_path)
+                except OSError:
+                    pass
+
+    @staticmethod
+    def _parse_emotion(text: str) -> tuple[str, float]:
+        """Extract emotion tag from SenseVoice output text.
+
+        SenseVoice embeds tags like <|HAPPY|>, <|NEUTRAL|>, etc. It does not
+        output a confidence, so a recognised tag gets a fixed 0.8; text with
+        no recognised tag is ("neutral", 0.5).
+        """
+        for match in _TOKEN_RE.finditer(text or ""):
+            label = match.group(1).lower()
+            if label in _EMOTION_TAGS:
+                return label, 0.8
+        return "neutral", 0.5
diff --git a/forgestream/emotion/extractor.py b/forgestream/emotion/extractor.py
index 2a9cf0d..8465702 100644
--- a/forgestream/emotion/extractor.py
+++ b/forgestream/emotion/extractor.py
@@ -40,6 +40,8 @@ class EmotionExtractor:
         window_seconds: Duration of the analysis window (default 3.0s).
         stride_seconds: How often to emit features (default 1.0s).
         chunk_duration: Duration of each incoming chunk (default 0.5s).
+        diarizer: Optional speaker diarizer.
+        classifier: Optional SenseVoice categorical emotion classifier.
     """
 
     def __init__(
@@ -51,11 +53,13 @@ class EmotionExtractor:
         stride_seconds: float = 1.0,
         chunk_duration: float = 0.5,
         diarizer: "SpeakerDiarizer | None" = None,
+        classifier: "SenseVoiceClassifier | None" = None,
     ) -> None:
         self._orchestrator = orchestrator
         self._audio_buffer = audio_buffer
         self._branch_id = branch_id
         self._diarizer = diarizer
+        self._classifier = classifier
 
         self._window_seconds = window_seconds
         self._stride_seconds = stride_seconds
@@ -131,6 +135,16 @@ class EmotionExtractor:
         egemaps = self._get_egemaps()
         egemaps_vector = egemaps.extract(signal) if egemaps else [0.0] * 88
 
+        # Categorical emotion (SenseVoice), optional
+        emotion_tag: str | None = None
+        emotion_confidence: float | None = None
+        if self._classifier is not None:
+            try:
+                emotion_tag, emotion_confidence = self._classifier.classify(signal)
+            except Exception as e:
+                logger.warning("Emotion classification failed: %s", e)
+                emotion_tag, emotion_confidence = None, None
+
         # Derive dimensional emotion
         arousal, valence, dominance = derive_dimensional_emotion(
             f0_mean=praat_result["f0_mean"],
@@ -153,6 +167,8 @@ class EmotionExtractor:
             arousal=arousal,
             valence=valence,
             dominance=dominance,
+            emotion_tag=emotion_tag,
+            emotion_confidence=emotion_confidence,
         )
 
     async def _emit_event(
@@ -165,8 +181,6 @@ class EmotionExtractor:
             "timestamp_ms": self._audio_buffer.chunk_timestamp_ms(chunk_index),
             "chunk_index": chunk_index,
             "window_duration_ms": int(self._window_seconds * 1000),
-            "emotion_tag": None,       # Phase 1.5 adds SenseVoice
-            "emotion_confidence": None,
         })
 
         event = Event(
diff --git a/forgestream/emotion/features.py b/forgestream/emotion/features.py
index 92110b6..57d8af8 100644
--- a/forgestream/emotion/features.py
+++ b/forgestream/emotion/features.py
@@ -40,6 +40,10 @@ class ProsodicFeatures:
     valence: float = 0.5
     dominance: float = 0.5
 
+    # Categorical emotion (SenseVoice, optional — None if no classifier)
+    emotion_tag: str | None = None
+    emotion_confidence: float | None = None
+
     def to_payload(self) -> dict:
         """Convert to ECEF event payload dict."""
         return {
@@ -55,6 +59,8 @@ class ProsodicFeatures:
             "arousal": self.arousal,
             "valence": self.valence,
             "dominance": self.dominance,
+            "emotion_tag": self.emotion_tag,
+            "emotion_confidence": self.emotion_confidence,
         }
 
 
diff --git a/forgestream/live_stream.py b/forgestream/live_stream.py
index fc0b115..b28cd1a 100644
--- a/forgestream/live_stream.py
+++ b/forgestream/live_stream.py
@@ -124,6 +124,18 @@ class GeminiLiveStream:
                     diarizer = SpeakerDiarizer(
                         huggingface_token=config.huggingface_token,
                     )
+            # Categorical emotion via SenseVoice (optional)
+            classifier = None
+            if config.emotion_ml_enabled:
+                from .emotion.classifier import SenseVoiceClassifier
+                if SenseVoiceClassifier.is_available():
+                    classifier = SenseVoiceClassifier(
+                        model_name=config.sensevoice_model,
+                    )
+                else:
+                    logger.info(
+                        "funasr not installed — running without categorical emotion"
+                    )
             self.emotion_extractor: EmotionExtractor | None = EmotionExtractor(
                 orchestrator=orchestrator,
                 audio_buffer=self.audio_buffer,
@@ -131,6 +143,7 @@ class GeminiLiveStream:
                 window_seconds=config.emotion_window_seconds,
                 stride_seconds=config.emotion_stride_seconds,
                 diarizer=diarizer,
+                classifier=classifier,
             )
             self._emotion_queue: asyncio.Queue[tuple[bytes, int]] = asyncio.Queue()
             self.emotion_correlator = orchestrator.attach_emotion_correlator()
diff --git a/tests/emotion/test_classifier.py b/tests/emotion/test_classifier.py
new file mode 100644
index 0000000..1884a16
--- /dev/null
+++ b/tests/emotion/test_classifier.py
@@ -0,0 +1,127 @@
+"""Tests for SenseVoiceClassifier and its EmotionExtractor integration."""
+
+import sys
+from unittest.mock import AsyncMock, MagicMock
+from uuid import uuid4
+
+import numpy as np
+import pytest
+
+from forgestream.emotion.buffer import AudioRingBuffer
+from forgestream.emotion.classifier import SenseVoiceClassifier
+from forgestream.emotion.extractor import EmotionExtractor
+
+
+class TestParseEmotion:
+    @pytest.mark.parametrize(
+        "tag",
+        ["angry", "disgusted", "fearful", "happy", "neutral", "other", "sad", "surprised"],
+    )
+    def test_recognised_tags(self, tag):
+        assert SenseVoiceClassifier._parse_emotion(f"<|en|><|{tag.upper()}|>hi") == (tag, 0.8)
+
+    def test_case_insensitive(self):
+        assert SenseVoiceClassifier._parse_emotion("<|Happy|>") == ("happy", 0.8)
+
+    @pytest.mark.parametrize("text", ["", "plain text", "<|en|><|EMO_UNKNOWN|>hello"])
+    def test_no_recognised_tag_is_neutral(self, text):
+        assert SenseVoiceClassifier._parse_emotion(text) == ("neutral", 0.5)
+
+
+class TestClassifier:
+    def test_is_available_false_without_funasr(self, monkeypatch):
+        monkeypatch.setitem(sys.modules, "funasr", None)
+        assert SenseVoiceClassifier.is_available() is False
+
+    def test_is_available_true_with_funasr(self, monkeypatch):
+        monkeypatch.setitem(sys.modules, "funasr", MagicMock())
+        assert SenseVoiceClassifier.is_available() is True
+
+    def test_model_not_loaded_in_constructor(self, monkeypatch):
+        fake = MagicMock()
+        monkeypatch.setitem(sys.modules, "funasr", fake)
+        SenseVoiceClassifier()
+        fake.AutoModel.assert_not_called()
+
+    def test_classify_lazy_loads_once_and_parses(self, monkeypatch):
+        fake = MagicMock()
+        fake.AutoModel.return_value.generate.return_value = [{"text": "<|SAD|>hello"}]
+        monkeypatch.setitem(sys.modules, "funasr", fake)
+        clf = SenseVoiceClassifier(model_name="m")
+        signal = np.zeros(1600, dtype=np.int16)
+        assert clf.classify(signal) == ("sad", 0.8)
+        assert clf.classify(signal) == ("sad", 0.8)
+        fake.AutoModel.assert_called_once_with(model="m")
+
+    def test_model_load_failure_returns_unknown(self, monkeypatch, caplog):
+        fake = MagicMock()
+        fake.AutoModel.side_effect = RuntimeError("boom")
+        monkeypatch.setitem(sys.modules, "funasr", fake)
+        with caplog.at_level("WARNING"):
+            assert SenseVoiceClassifier().classify(np.zeros(1600, dtype=np.int16)) == (
+                "unknown",
+                0.0,
+            )
+        assert "boom" in caplog.text
+
+    def test_generate_failure_returns_unknown(self, monkeypatch):
+        fake = MagicMock()
+        fake.AutoModel.return_value.generate.side_effect = ValueError("bad")
+        monkeypatch.setitem(sys.modules, "funasr", fake)
+        assert SenseVoiceClassifier().classify(np.zeros(1600, dtype=np.int16)) == (
+            "unknown",
+            0.0,
+        )
+
+
+def _extractor(classifier):
+    orch = MagicMock()
+    orch.session_id = uuid4()
+    orch.process_event = AsyncMock(return_value=True)
+    ex = EmotionExtractor(
+        orchestrator=orch,
+        audio_buffer=AudioRingBuffer(capacity_seconds=10.0),
+        branch_id=uuid4(),
+        window_seconds=1.5,
+        stride_seconds=1.0,
+        classifier=classifier,
+    )
+    return ex, orch
+
+
+async def _feed(ex):
+    t = np.linspace(0, 0.5, 8000, endpoint=False)
+    chunk = (10000 * np.sin(2 * np.pi * 200 * t)).astype(np.int16).tobytes()
+    await ex.process_chunk(chunk, 0)
+    await ex.process_chunk(chunk, 1)
+
+
+class TestExtractorIntegration:
+    @pytest.mark.asyncio
+    async def test_payload_has_classifier_output(self):
+        clf = MagicMock()
+        clf.classify.return_value = ("happy", 0.8)
+        ex, orch = _extractor(clf)
+        await _feed(ex)
+        payload = orch.process_event.call_args[0][0].payload
+        assert payload["emotion_tag"] == "happy"
+        assert payload["emotion_confidence"] == 0.8
+
+    @pytest.mark.asyncio
+    async def test_no_classifier_leaves_none(self):
+        ex, orch = _extractor(None)
+        await _feed(ex)
+        payload = orch.process_event.call_args[0][0].payload
+        assert payload["emotion_tag"] is None
+        assert payload["emotion_confidence"] is None
+
+    @pytest.mark.asyncio
+    async def test_classifier_exception_does_not_drop_event(self):
+        clf = MagicMock()
+        clf.classify.side_effect = RuntimeError("x")
+        ex, orch = _extractor(clf)
+        await _feed(ex)
+        assert orch.process_event.call_count == 1
+        payload = orch.process_event.call_args[0][0].payload
+        assert payload["emotion_tag"] is None
+        assert "f0_mean" in payload
diff --git a/tests/emotion/test_config.py b/tests/emotion/test_config.py
index 26e8ff4..0631fe3 100644
--- a/tests/emotion/test_config.py
+++ b/tests/emotion/test_config.py
@@ -9,4 +9,5 @@ def test_emotion_config_defaults():
     assert config.emotion_window_seconds == 3.0
     assert config.emotion_stride_seconds == 1.0
     assert config.emotion_ml_enabled is False
+    assert config.sensevoice_model == "iic/SenseVoiceSmall"
     assert config.emotion_buffer_seconds == 30.0

```
