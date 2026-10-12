# Pair 19 (retrieval-harness-edd95af0)

Which patch would you merge? Answer in answers.md as `19: A`, `19: B`, or `19: =` if you cannot tell.

## Issue

Route OpenAI query embeddings through the Moot relay when MOOT_EMBED_VIA_RELAY is set

Devices that run the harness without any OpenAI key on disk have no way to compute query embeddings. Answers already go through the relay tier, but `get_embedder("openai:...")` always builds the direct OpenAI embedder, which needs `OPENAI_API_KEY`.

Add a `RelayEmbedder(proxied_spec: str, dims: int | None)` in `harness.embedders`. `get_embedder(spec)` should return it for any `openai:*` spec (with or without an `@dims` suffix) when the `MOOT_EMBED_VIA_RELAY` environment variable is set. When the variable is unset, `get_embedder` must keep returning `OpenAIEmbedder` with the same dims as before.

The relay embedder reads `MOOT_RELAY_URL` and raises a `RuntimeError` if it is missing. It reads `MOOT_RELAY_TOKEN` as a bearer token. `embed(texts)` POSTs JSON `{"spec": <full spec>, "texts": [...]}` to `<MOOT_RELAY_URL>/v1/embed`, with any trailing slash on the URL stripped. The request carries `Authorization: Bearer <token>` and `Content-Type: application/json`. The response is `{"embeddings": [[...], ...]}`, and those vectors are returned. Transient failures should be retried the same way the other network embedders retry them.

The embedder's `name`, which keys the embedding cache, must be the proxied spec (for example `openai:text-embedding-3-large@1024`), not a relay-specific name. Vectors already cached with the real OpenAI embedder then still hit, and only uncached query strings go to the relay. `dim` should be the requested dims, defaulting to 1024 when no `@dims` is given.

## Patch A

```diff
diff --git a/src/harness/embedders.py b/src/harness/embedders.py
index b6eb9c0..a9ca4d1 100644
--- a/src/harness/embedders.py
+++ b/src/harness/embedders.py
@@ -154,6 +154,38 @@ class OpenAIEmbedder(_Cached):
         return out
 
 
+class RelayEmbedder(_Cached):
+    """OpenAI embeddings through the Moot relay, for devices with no key.
+    Named after the proxied spec so cached vectors from the direct embedder
+    still hit."""
+
+    def __init__(self, proxied_spec: str, dims: int | None):
+        url = os.environ.get("MOOT_RELAY_URL")
+        if not url:
+            raise RuntimeError("MOOT_RELAY_URL is not set.")
+        super().__init__()
+        self._url = url.rstrip("/") + "/v1/embed"
+        self._token = os.environ.get("MOOT_RELAY_TOKEN", "")
+        self._spec = proxied_spec
+        self.dim = dims or 1024
+        self.name = proxied_spec
+
+    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
+        req = urllib.request.Request(
+            self._url,
+            data=json.dumps({"spec": self._spec, "texts": texts}).encode(),
+            headers={"Content-Type": "application/json",
+                     "Authorization": f"Bearer {self._token}"},
+        )
+
+        def _call():
+            with urllib.request.urlopen(req, timeout=120) as resp:
+                return json.loads(resp.read())
+
+        data = _with_retries(_call, self.name)
+        return data["embeddings"]
+
+
 class OllamaEmbedder(_Cached):
     def __init__(self, model: str, dims: int | None):
         super().__init__()
@@ -209,6 +241,8 @@ def get_embedder(spec: str):
         body, dims_s = spec.rsplit("@", 1)
         dims = int(dims_s)
     if body.startswith("openai:"):
+        if os.environ.get("MOOT_EMBED_VIA_RELAY"):
+            return RelayEmbedder(spec, dims)
         return OpenAIEmbedder(body.split(":", 1)[1], dims)
     if body.startswith("ollama:"):
         return OllamaEmbedder(body.split(":", 1)[1], dims)

```

## Patch B

```diff
diff --git a/src/harness/embedders.py b/src/harness/embedders.py
index b6eb9c0..e712751 100644
--- a/src/harness/embedders.py
+++ b/src/harness/embedders.py
@@ -6,6 +6,10 @@ Specs:
   openai:<model>[@dims]             OpenAI API. @dims uses the native MRL
                                     dimensions parameter on 3-series models.
                                     Dev twin of the Azure OpenAI production tier.
+                                    With MOOT_EMBED_VIA_RELAY set, embeds via
+                                    POST $MOOT_RELAY_URL/v1/embed (bearer
+                                    $MOOT_RELAY_TOKEN) instead; no OpenAI key
+                                    needed and the cache name is unchanged.
   ollama:<model>[@dims]             Local Ollama server. @dims truncates and
                                     renormalizes client-side (MRL style).
                                     Dev twin of the self-hosted AKS tier.
@@ -154,6 +158,38 @@ class OpenAIEmbedder(_Cached):
         return out
 
 
+class RelayEmbedder(_Cached):
+    """Query embeddings via the Moot relay, for devices with no OpenAI key.
+    Named after the proxied spec so cache entries are shared with the direct
+    OpenAIEmbedder."""
+
+    def __init__(self, proxied_spec: str, dims: int | None):
+        super().__init__()
+        url = os.environ.get("MOOT_RELAY_URL")
+        if not url:
+            raise RuntimeError("MOOT_RELAY_URL not set.")
+        self._url = url.rstrip("/") + "/v1/embed"
+        self._token = os.environ.get("MOOT_RELAY_TOKEN", "")
+        self._spec = proxied_spec
+        self.dim = dims or 1024
+        self.name = proxied_spec
+
+    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
+        req = urllib.request.Request(
+            self._url,
+            data=json.dumps({"spec": self._spec, "texts": texts}).encode(),
+            headers={"Content-Type": "application/json",
+                     "Authorization": f"Bearer {self._token}"},
+            method="POST",
+        )
+
+        def _call():
+            with urllib.request.urlopen(req, timeout=120) as resp:
+                return json.loads(resp.read())
+
+        return _with_retries(_call, self.name)["embeddings"]
+
+
 class OllamaEmbedder(_Cached):
     def __init__(self, model: str, dims: int | None):
         super().__init__()
@@ -209,6 +245,8 @@ def get_embedder(spec: str):
         body, dims_s = spec.rsplit("@", 1)
         dims = int(dims_s)
     if body.startswith("openai:"):
+        if os.environ.get("MOOT_EMBED_VIA_RELAY"):
+            return RelayEmbedder(spec, dims)
         return OpenAIEmbedder(body.split(":", 1)[1], dims)
     if body.startswith("ollama:"):
         return OllamaEmbedder(body.split(":", 1)[1], dims)

```
