# Pair 18 (forgestream-d49ca481)

Which patch would you merge? Answer in answers.md as `18: A`, `18: B`, or `18: =` if you cannot tell.

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
diff --git a/CLAUDE.md b/CLAUDE.md
index c492920..13745a5 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -109,7 +109,7 @@
 
 ## Optional Dependencies
 - `emotion`: opensmile, praat-parselmouth, numpy (always install for emotion pipeline)
-- `emotion-ml`: funasr, torch (SenseVoice — plan written but not yet implemented)
+- `emotion-ml`: funasr, torch (SenseVoice categorical emotion via `emotion/classifier.py`; enabled with `config.emotion_ml_enabled=True`, model from `config.sensevoice_model`; skipped with an info log if funasr is missing)
 - `diarization`: pyannote.audio, torch, torchaudio (opt-in, requires HF token)
 - Lazy loading pattern: check availability in __init__, load model on first use, log if unavailable
 
diff --git a/data/user_profile.json b/data/user_profile.json
index aa5d5cb..2778422 100644
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
+  "last_updated": "2026-10-11T22:11:51.597563+00:00"
 }
\ No newline at end of file
diff --git a/docs/meetings/2026-10-11-test-arch-report.md b/docs/meetings/2026-10-11-test-arch-report.md
new file mode 100644
index 0000000..a76377d
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
+  "spawn_cooldown_seconds": 61.3168420182861,
+  "scaffold_timeout_minutes": 10.491272972797434,
+  "max_concurrent_research": 3.2292658279147477,
+  "max_concurrent_scaffold": 4.1134022117396185,
+  "emotion_stride_seconds": 0.9633249263227757,
+  "emotion_window_seconds": 3.0290023984705132
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
index 0000000..cbf4e88
--- /dev/null
+++ b/forgestream/emotion/classifier.py
@@ -0,0 +1,109 @@
+"""Categorical emotion classification using SenseVoice-Small.
+
+Wraps FunASR's SenseVoice model. Returns emotion tags:
+angry, disgusted, fearful, happy, neutral, other, sad, surprised
+(or "unknown" when classification fails).
+
+Optional — loaded only when funasr is installed and config enables it.
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
+_EMOTIONS = frozenset(
+    {"angry", "disgusted", "fearful", "happy", "neutral", "other", "sad", "surprised"}
+)
+_TAG_RE = re.compile(r"<\|([^|<>]*)\|>")
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
+
+        self._model = AutoModel(model=self._model_name)
+        logger.info("SenseVoice model loaded: %s", self._model_name)
+
+    def classify(self, signal: np.ndarray) -> tuple[str, float]:
+        """Classify emotion from a 1-D int16 PCM array.
+
+        Returns (emotion_tag, confidence). Never raises: any failure yields
+        ("unknown", 0.0) and a logged warning.
+        """
+        tmp_path: str | None = None
+        try:
+            self._ensure_model()
+
+            # SenseVoice takes a file path — write a temp WAV.
+            pcm = np.ascontiguousarray(signal, dtype=np.int16)
+            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
+                tmp_path = f.name
+            with wave.open(tmp_path, "wb") as wf:
+                wf.setnchannels(1)
+                wf.setsampwidth(2)
+                wf.setframerate(self._sample_rate)
+                wf.writeframes(pcm.tobytes())
+
+            result = self._model.generate(input=tmp_path, language="auto")
+            if result:
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
+        """Extract emotion from SenseVoice output text.
+
+        SenseVoice embeds tags like <|HAPPY|>, <|NEUTRAL|>. Matching is
+        case-insensitive. SenseVoice gives no confidence, so a recognised tag
+        yields 0.8 and no recognised tag yields ("neutral", 0.5).
+        """
+        for match in _TAG_RE.finditer(text or ""):
+            label = match.group(1).strip().lower()
+            if label in _EMOTIONS:
+                return label, 0.8
+        return "neutral", 0.5
diff --git a/forgestream/emotion/extractor.py b/forgestream/emotion/extractor.py
index 2a9cf0d..e95725f 100644
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
@@ -140,6 +144,9 @@ class EmotionExtractor:
             spectral_centroid=praat_result["spectral_centroid"],
         )
 
+        # SenseVoice categorical emotion (optional)
+        emotion_tag, emotion_confidence = self._classify_emotion(signal)
+
         return ProsodicFeatures(
             f0_mean=praat_result["f0_mean"],
             f0_std=praat_result["f0_std"],
@@ -153,8 +160,20 @@ class EmotionExtractor:
             arousal=arousal,
             valence=valence,
             dominance=dominance,
+            emotion_tag=emotion_tag,
+            emotion_confidence=emotion_confidence,
         )
 
+    def _classify_emotion(self, signal) -> tuple[str | None, float | None]:
+        """Categorical emotion for a window. (None, None) if no classifier or on failure."""
+        if self._classifier is None:
+            return None, None
+        try:
+            return self._classifier.classify(signal)
+        except Exception as e:
+            logger.warning("Emotion classification failed: %s", e)
+            return None, None
+
     async def _emit_event(
         self, features: ProsodicFeatures, chunk_index: int
     ) -> None:
@@ -165,8 +184,6 @@ class EmotionExtractor:
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
index fc0b115..d821a95 100644
--- a/forgestream/live_stream.py
+++ b/forgestream/live_stream.py
@@ -124,6 +124,16 @@ class GeminiLiveStream:
                     diarizer = SpeakerDiarizer(
                         huggingface_token=config.huggingface_token,
                     )
+            # Categorical emotion via SenseVoice (optional)
+            classifier = None
+            if config.emotion_ml_enabled:
+                from .emotion.classifier import SenseVoiceClassifier
+                if SenseVoiceClassifier.is_available():
+                    classifier = SenseVoiceClassifier(model_name=config.sensevoice_model)
+                else:
+                    logger.info(
+                        "funasr not installed — running without categorical emotion"
+                    )
             self.emotion_extractor: EmotionExtractor | None = EmotionExtractor(
                 orchestrator=orchestrator,
                 audio_buffer=self.audio_buffer,
@@ -131,6 +141,7 @@ class GeminiLiveStream:
                 window_seconds=config.emotion_window_seconds,
                 stride_seconds=config.emotion_stride_seconds,
                 diarizer=diarizer,
+                classifier=classifier,
             )
             self._emotion_queue: asyncio.Queue[tuple[bytes, int]] = asyncio.Queue()
             self.emotion_correlator = orchestrator.attach_emotion_correlator()
diff --git a/tests/emotion/test_classifier.py b/tests/emotion/test_classifier.py
new file mode 100644
index 0000000..c829006
--- /dev/null
+++ b/tests/emotion/test_classifier.py
@@ -0,0 +1,59 @@
+"""Tests for SenseVoiceClassifier (funasr is mocked; no model download)."""
+
+import sys
+import types
+from unittest.mock import MagicMock
+
+import numpy as np
+import pytest
+
+from forgestream.emotion.classifier import SenseVoiceClassifier
+
+
+class TestParseEmotion:
+    @pytest.mark.parametrize("text,tag", [
+        ("<|en|><|HAPPY|><|Speech|>hello", "happy"),
+        ("<|sad|>x", "sad"),
+        ("<|Surprised|>", "surprised"),
+    ])
+    def test_recognised_tag(self, text, tag):
+        assert SenseVoiceClassifier._parse_emotion(text) == (tag, 0.8)
+
+    @pytest.mark.parametrize("text", ["", "no tags", "<|EMO_UNKNOWN|>hi", "HAPPY"])
+    def test_unrecognised_defaults_neutral(self, text):
+        assert SenseVoiceClassifier._parse_emotion(text) == ("neutral", 0.5)
+
+
+class TestClassify:
+    def _install_funasr(self, monkeypatch, model):
+        mod = types.ModuleType("funasr")
+        mod.AutoModel = MagicMock(return_value=model)
+        monkeypatch.setitem(sys.modules, "funasr", mod)
+        return mod
+
+    def test_lazy_load_and_result(self, monkeypatch):
+        model = MagicMock()
+        model.generate.return_value = [{"text": "<|ANGRY|>hi"}]
+        mod = self._install_funasr(monkeypatch, model)
+        clf = SenseVoiceClassifier()
+        mod.AutoModel.assert_not_called()
+        sig = np.zeros(16000, dtype=np.int16)
+        assert clf.classify(sig) == ("angry", 0.8)
+        clf.classify(sig)
+        mod.AutoModel.assert_called_once()
+
+    def test_failure_returns_unknown(self, monkeypatch):
+        model = MagicMock()
+        model.generate.side_effect = RuntimeError("boom")
+        self._install_funasr(monkeypatch, model)
+        assert SenseVoiceClassifier().classify(np.zeros(100, dtype=np.int16)) == ("unknown", 0.0)
+
+    def test_load_failure_returns_unknown(self, monkeypatch):
+        mod = types.ModuleType("funasr")
+        mod.AutoModel = MagicMock(side_effect=OSError("no model"))
+        monkeypatch.setitem(sys.modules, "funasr", mod)
+        assert SenseVoiceClassifier().classify(np.zeros(100, dtype=np.int16)) == ("unknown", 0.0)
+
+    def test_is_available_false_without_funasr(self, monkeypatch):
+        monkeypatch.setitem(sys.modules, "funasr", None)
+        assert SenseVoiceClassifier.is_available() is False
diff --git a/tests/emotion/test_extractor.py b/tests/emotion/test_extractor.py
index 90c869c..c60a3a5 100644
--- a/tests/emotion/test_extractor.py
+++ b/tests/emotion/test_extractor.py
@@ -114,3 +114,41 @@ class TestEmotionExtractor:
 
         event = mock_orchestrator.process_event.call_args[0][0]
         assert event.payload["f0_mean"] == 0.0
+
+
+class TestExtractorClassifier:
+    def _extractor(self, orch, buf, classifier=None):
+        return EmotionExtractor(
+            orchestrator=orch,
+            audio_buffer=buf,
+            branch_id=uuid4(),
+            window_seconds=0.5,
+            stride_seconds=0.5,
+            classifier=classifier,
+        )
+
+    @pytest.mark.asyncio
+    async def test_no_classifier_leaves_tags_none(self, mock_orchestrator, audio_buffer):
+        await self._extractor(mock_orchestrator, audio_buffer).process_chunk(_make_sine_chunk(), 0)
+        payload = mock_orchestrator.process_event.call_args[0][0].payload
+        assert payload["emotion_tag"] is None
+        assert payload["emotion_confidence"] is None
+
+    @pytest.mark.asyncio
+    async def test_classifier_populates_payload(self, mock_orchestrator, audio_buffer):
+        clf = MagicMock()
+        clf.classify.return_value = ("happy", 0.8)
+        await self._extractor(mock_orchestrator, audio_buffer, clf).process_chunk(_make_sine_chunk(), 0)
+        payload = mock_orchestrator.process_event.call_args[0][0].payload
+        assert payload["emotion_tag"] == "happy"
+        assert payload["emotion_confidence"] == 0.8
+
+    @pytest.mark.asyncio
+    async def test_classifier_error_does_not_drop_event(self, mock_orchestrator, audio_buffer):
+        clf = MagicMock()
+        clf.classify.side_effect = RuntimeError("boom")
+        await self._extractor(mock_orchestrator, audio_buffer, clf).process_chunk(_make_sine_chunk(), 0)
+        mock_orchestrator.process_event.assert_called_once()
+        payload = mock_orchestrator.process_event.call_args[0][0].payload
+        assert payload["emotion_tag"] is None
+        assert payload["f0_mean"] > 0
diff --git a/tests/emotion/test_live_stream_wiring.py b/tests/emotion/test_live_stream_wiring.py
index 4779a3f..e18b8c5 100644
--- a/tests/emotion/test_live_stream_wiring.py
+++ b/tests/emotion/test_live_stream_wiring.py
@@ -26,3 +26,33 @@ def test_live_stream_skips_emotion_when_disabled():
     stream = GeminiLiveStream(config, orchestrator, source)
     assert stream.audio_buffer is None
     assert stream.emotion_extractor is None
+
+
+def test_live_stream_no_classifier_by_default():
+    config = ForgeStreamConfig(emotion_enabled=True)
+    stream = GeminiLiveStream(config, Orchestrator(config=config), MagicMock())
+    assert stream.emotion_extractor._classifier is None
+
+
+def test_live_stream_creates_classifier_when_ml_enabled_and_funasr_present():
+    from unittest.mock import patch
+
+    config = ForgeStreamConfig(
+        emotion_enabled=True, emotion_ml_enabled=True, sensevoice_model="custom/model"
+    )
+    with patch("forgestream.emotion.classifier.SenseVoiceClassifier.is_available", return_value=True):
+        stream = GeminiLiveStream(config, Orchestrator(config=config), MagicMock())
+    clf = stream.emotion_extractor._classifier
+    assert clf is not None
+    assert clf._model_name == "custom/model"
+    assert clf._model is None  # lazy
+
+
+def test_live_stream_without_funasr_runs_without_classifier():
+    from unittest.mock import patch
+
+    config = ForgeStreamConfig(emotion_enabled=True, emotion_ml_enabled=True)
+    with patch("forgestream.emotion.classifier.SenseVoiceClassifier.is_available", return_value=False):
+        stream = GeminiLiveStream(config, Orchestrator(config=config), MagicMock())
+    assert stream.emotion_extractor is not None
+    assert stream.emotion_extractor._classifier is None

```

## Patch B

```diff
diff --git a/data/user_profile.json b/data/user_profile.json
index aa5d5cb..c6f062b 100644
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
+  "last_updated": "2026-10-11T22:20:43.556707+00:00"
 }
\ No newline at end of file
diff --git a/docs/meetings/2026-10-11-test-arch-report.md b/docs/meetings/2026-10-11-test-arch-report.md
new file mode 100644
index 0000000..d11a36e
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
+  "spawn_cooldown_seconds": 61.28550329121212,
+  "scaffold_timeout_minutes": 10.092909095305247,
+  "max_concurrent_research": 3.1402777435889764,
+  "max_concurrent_scaffold": 4.0902775493105725,
+  "emotion_stride_seconds": 0.8920810720163386,
+  "emotion_window_seconds": 3.0918727630381997
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
index 0000000..c95f8f2
--- /dev/null
+++ b/forgestream/emotion/classifier.py
@@ -0,0 +1,93 @@
+"""Categorical emotion classification using SenseVoice-Small.
+
+Wraps FunASR's SenseVoice model. Returns one of the emotion tags:
+angry, disgusted, fearful, happy, neutral, other, sad, surprised, or
+"unknown" when classification fails.
+
+Optional — used only when funasr is installed and config enables it.
+"""
+
+from __future__ import annotations
+
+import logging
+import re
+
+import numpy as np
+
+logger = logging.getLogger(__name__)
+
+_EMOTIONS = frozenset(
+    {"angry", "disgusted", "fearful", "happy", "neutral", "other", "sad", "surprised"}
+)
+_TOKEN_RE = re.compile(r"<\|([^|<>]*)\|>")
+
+# SenseVoice does not output a confidence score; use fixed values.
+_TAG_CONFIDENCE = 0.8
+_DEFAULT_CONFIDENCE = 0.5
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
+        """True if FunASR is importable."""
+        try:
+            import funasr  # noqa: F401
+        except ImportError:
+            return False
+        return True
+
+    def _ensure_model(self) -> None:
+        """Lazily load the SenseVoice model on first use."""
+        if self._model is not None:
+            return
+        from funasr import AutoModel
+
+        self._model = AutoModel(model=self._model_name)
+        logger.info("SenseVoice model loaded: %s", self._model_name)
+
+    def classify(self, signal: np.ndarray) -> tuple[str, float]:
+        """Classify emotion from a 1-D int16 PCM array.
+
+        Returns (emotion_tag, confidence). Never raises: any failure yields
+        ("unknown", 0.0) and a logged warning.
+        """
+        try:
+            self._ensure_model()
+            audio = signal.astype(np.float32) / 32768.0
+            result = self._model.generate(input=audio, language="auto")
+            if result:
+                return self._parse_emotion(result[0].get("text", ""))
+            return "unknown", 0.0
+        except Exception as e:
+            logger.warning("SenseVoice classification failed: %s", e)
+            return "unknown", 0.0
+
+    @staticmethod
+    def _parse_emotion(text: str) -> tuple[str, float]:
+        """Extract the emotion from SenseVoice output.
+
+        SenseVoice embeds tokens like <|HAPPY|> alongside language/event tags
+        (e.g. <|en|>, <|Speech|>). Returns the first recognised emotion with
+        confidence 0.8, else ("neutral", 0.5).
+        """
+        for match in _TOKEN_RE.finditer(text):
+            tag = match.group(1).strip().lower()
+            if tag in _EMOTIONS:
+                return tag, _TAG_CONFIDENCE
+        return "neutral", _DEFAULT_CONFIDENCE
diff --git a/forgestream/emotion/extractor.py b/forgestream/emotion/extractor.py
index 2a9cf0d..02dd44a 100644
--- a/forgestream/emotion/extractor.py
+++ b/forgestream/emotion/extractor.py
@@ -40,6 +40,8 @@ class EmotionExtractor:
         window_seconds: Duration of the analysis window (default 3.0s).
         stride_seconds: How often to emit features (default 1.0s).
         chunk_duration: Duration of each incoming chunk (default 0.5s).
+        diarizer: Optional SpeakerDiarizer.
+        classifier: Optional SenseVoiceClassifier for categorical emotion.
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
 
+        # Categorical emotion (optional; failures must not drop the event)
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
index 92110b6..65232ec 100644
--- a/forgestream/emotion/features.py
+++ b/forgestream/emotion/features.py
@@ -40,6 +40,10 @@ class ProsodicFeatures:
     valence: float = 0.5
     dominance: float = 0.5
 
+    # Categorical emotion (SenseVoice, None when no classifier is configured)
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
index 0000000..9aece41
--- /dev/null
+++ b/tests/emotion/test_classifier.py
@@ -0,0 +1,123 @@
+"""Tests for SenseVoiceClassifier and its extractor integration."""
+
+from unittest.mock import MagicMock
+
+import numpy as np
+import pytest
+
+from forgestream.emotion.classifier import SenseVoiceClassifier
+from forgestream.emotion.features import ProsodicFeatures
+
+
+class TestParseEmotion:
+    @pytest.mark.parametrize(
+        "text,expected",
+        [
+            ("<|en|><|HAPPY|><|Speech|>hello", "happy"),
+            ("<|sad|>x", "sad"),
+            ("<|Angry|>", "angry"),
+            ("<|DISGUSTED|>", "disgusted"),
+            ("<|FEARFUL|>", "fearful"),
+            ("<|SURPRISED|>", "surprised"),
+            ("<|OTHER|>", "other"),
+            ("<|NEUTRAL|>", "neutral"),
+        ],
+    )
+    def test_recognised_tag(self, text, expected):
+        assert SenseVoiceClassifier._parse_emotion(text) == (expected, 0.8)
+
+    @pytest.mark.parametrize("text", ["", "plain text", "<|en|><|Speech|>hi"])
+    def test_no_tag_defaults_neutral(self, text):
+        assert SenseVoiceClassifier._parse_emotion(text) == ("neutral", 0.5)
+
+
+class TestClassify:
+    def test_model_not_loaded_in_constructor(self):
+        assert SenseVoiceClassifier()._model is None
+
+    def test_failure_returns_unknown(self):
+        clf = SenseVoiceClassifier()
+        clf._model = MagicMock()
+        clf._model.generate.side_effect = RuntimeError("boom")
+        assert clf.classify(np.zeros(16000, dtype=np.int16)) == ("unknown", 0.0)
+
+    def test_load_failure_returns_unknown(self, monkeypatch):
+        clf = SenseVoiceClassifier()
+
+        def fail():
+            raise ImportError("no funasr")
+
+        monkeypatch.setattr(clf, "_ensure_model", fail)
+        assert clf.classify(np.zeros(16000, dtype=np.int16)) == ("unknown", 0.0)
+
+    def test_classify_parses_model_output(self):
+        clf = SenseVoiceClassifier()
+        clf._model = MagicMock()
+        clf._model.generate.return_value = [{"text": "<|en|><|SAD|>hi"}]
+        assert clf.classify(np.zeros(16000, dtype=np.int16)) == ("sad", 0.8)
+
+
+def _features(**kw):
+    return ProsodicFeatures(
+        f0_mean=0, f0_std=0, f0_contour=[], energy_rms=0,
+        jitter_local=0, shimmer_local=0, hnr=0, spectral_centroid=0, **kw,
+    )
+
+
+class TestPayload:
+    def test_defaults_none(self):
+        p = _features().to_payload()
+        assert p["emotion_tag"] is None and p["emotion_confidence"] is None
+
+    def test_values_in_payload(self):
+        p = _features(emotion_tag="happy", emotion_confidence=0.8).to_payload()
+        assert (p["emotion_tag"], p["emotion_confidence"]) == ("happy", 0.8)
+
+
+class TestExtractorIntegration:
+    @staticmethod
+    async def _run(classifier):
+        from unittest.mock import AsyncMock
+        from uuid import uuid4
+
+        from forgestream.emotion.buffer import AudioRingBuffer
+        from forgestream.emotion.extractor import EmotionExtractor
+
+        orch = MagicMock()
+        orch.session_id = uuid4()
+        orch.process_event = AsyncMock(return_value=True)
+        extractor = EmotionExtractor(
+            orchestrator=orch,
+            audio_buffer=AudioRingBuffer(capacity_seconds=10.0),
+            branch_id=uuid4(),
+            window_seconds=1.5,
+            stride_seconds=1.0,
+            classifier=classifier,
+        )
+        t = np.linspace(0, 0.5, 8000, endpoint=False)
+        chunk = (10000 * np.sin(2 * np.pi * 200 * t)).astype(np.int16).tobytes()
+        await extractor.process_chunk(chunk, 0)
+        await extractor.process_chunk(chunk, 1)
+        assert orch.process_event.call_count == 1
+        return orch.process_event.call_args[0][0].payload
+
+    @pytest.mark.asyncio
+    async def test_classifier_populates_payload(self):
+        clf = MagicMock()
+        clf.classify.return_value = ("happy", 0.8)
+        payload = await self._run(clf)
+        assert (payload["emotion_tag"], payload["emotion_confidence"]) == ("happy", 0.8)
+
+    @pytest.mark.asyncio
+    async def test_no_classifier_leaves_none(self):
+        payload = await self._run(None)
+        assert payload["emotion_tag"] is None
+        assert payload["emotion_confidence"] is None
+
+    @pytest.mark.asyncio
+    async def test_classifier_exception_keeps_event(self):
+        clf = MagicMock()
+        clf.classify.side_effect = RuntimeError("boom")
+        payload = await self._run(clf)
+        assert payload["emotion_tag"] is None
+        assert "f0_mean" in payload

```
