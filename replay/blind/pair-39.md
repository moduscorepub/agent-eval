# Pair 39 (retrieval-harness-1ad941fa)

Which patch would you merge? Answer in answers.md as `39: A`, `39: B`, or `39: =` if you cannot tell.

## Issue

Title: Support QIPC/REST client mode for local KDB.AI Server in the live parity path

The live KDB.AI parity path can't reach a local `kdbai-db` container. `LiveKdbaiTransport` only takes an endpoint and optional options, and KDB.AI Cloud (REST with an API key) has been retired. A local server exposes REST on 8081 and QIPC on 8082, so the client has to be told which one to use.

Add an optional `mode: str | None = None` parameter to `LiveKdbaiTransport.__init__(endpoint, database="default", options=None, mode=None)`. Add a public `session_kwargs() -> dict` method that returns the keyword arguments used to open the `kdbai_client` session. The dict always has `endpoint`. It has `mode` only when a mode was given, and `options` only when options were given. For example, `mode="qipc"` with `endpoint="http://localhost:8082"` gives `{"endpoint": "http://localhost:8082", "mode": "qipc"}`. With no mode, the `mode` key must be absent so the client keeps its own default. Construction must still not dial the server.

The `marketparity` command should accept `--mode {qipc,rest}`, with `KDBAI_MODE` as the environment fallback, and pass the mode to the live transport. The live parity test should also read `KDBAI_MODE`. When `--backend kdbai` is run with no `KDBAI_ENDPOINT`, the refusal message should stop pointing at cloud credentials. It should give a local example endpoint (`http://localhost:8082`) and refer to `docs/KDBAI-LIVE-PARITY.md`.

That document should record the current route to a live server. `cloud.kdb.ai` now redirects to the marketing site. KDB.AI Server needs a KDB-X community licence at `~/.kx/kc.lic`. The `kdbai-db` image sits behind a bearer-token registry at `portal.dl.kx.com`. The licence and the token both come from one login on the `devxp` Keycloak realm at `auth.developer.kx.com`. The realm has self-registration and password reset disabled and federated login enabled, so the document should explain why an account can exist but fail to log in, what to try in order, and the steps from login to a passing live parity run. The README's live-path note should match.

## Patch A

```diff
diff --git a/README.md b/README.md
index 3769ffa..96795ad 100644
--- a/README.md
+++ b/README.md
@@ -90,9 +90,12 @@ refusal integrity, temporal leakage) have never regressed.
   1e-6 (artifacts/market-parity-inprocess.json). A deterministically
   detuned transport walls with the divergence named, so the gate is
   proven able to fail. The live path needs what only an operator can
-  supply (a KX portal license or cloud credentials): install with
-  `uv sync --extra kdbai`, set KDBAI_ENDPOINT, and the live tests stop
-  skipping.
+  supply: a local KDB.AI Server (KDB-X community licence plus the
+  `kdbai-db` image; KDB.AI Cloud is retired). Install with
+  `uv sync --extra kdbai`, set KDBAI_ENDPOINT (e.g.
+  `http://localhost:8082`) and KDBAI_MODE (`qipc`; REST is 8081), and the
+  live tests stop skipping. The route to a server, and why a KX account
+  can exist yet fail to log in, is in docs/KDBAI-LIVE-PARITY.md.
 - **Hardens against how feeds actually fail**: sequence gaps are detected
   at the right cutoffs and close when the feed heals (a delayed-knowledge
   span and a held-out span are both planted). Exact redelivery is
diff --git a/docs/KDBAI-LIVE-PARITY.md b/docs/KDBAI-LIVE-PARITY.md
new file mode 100644
index 0000000..ae9ead7
--- /dev/null
+++ b/docs/KDBAI-LIVE-PARITY.md
@@ -0,0 +1,110 @@
+# Live KDB.AI parity: the current route to a server
+
+The live parity path (`harness marketparity --backend kdbai`, and
+`tests/test_market_kdbai_live.py`) needs a reachable KDB.AI Server. This
+file records what is true now and how to get there. Items marked
+**[unverified]** were not exercised from this repository and need checking
+against the vendor's pages when you do them.
+
+## What changed
+
+- **KDB.AI Cloud is gone.** `cloud.kdb.ai` redirects to the marketing site;
+  there is no REST-plus-API-key endpoint to point at. Cloud credentials are
+  no longer a route.
+- **The route is a local KDB.AI Server** (the `kdbai-db` container). It
+  exposes:
+
+  | Port | Protocol | Client `mode` |
+  |------|----------|---------------|
+  | 8081 | REST     | `rest`        |
+  | 8082 | QIPC     | `qipc`        |
+
+  The client has to be told which one it is talking to, hence `--mode` /
+  `KDBAI_MODE`. With no mode, `LiveKdbaiTransport` passes none and
+  `kdbai_client` keeps its own default.
+
+## What the server needs
+
+1. **A KDB-X community licence** at `~/.kx/kc.lic`. KDB.AI Server will not
+   start without it.
+2. **The `kdbai-db` image**, which sits behind a bearer-token registry at
+   `portal.dl.kx.com`. An unauthenticated pull is refused.
+
+Both come from **one login** on the `devxp` Keycloak realm at
+`auth.developer.kx.com`. If you cannot log in, you have neither.
+
+## Why an account can exist but fail to log in
+
+The `devxp` realm is configured with:
+
+- self-registration **disabled**,
+- password reset **disabled**,
+- federated (identity-provider) login **enabled**.
+
+Consequences:
+
+- An account that was created through a federated provider (or provisioned
+  for you) may have **no local password at all**. Typing an email and a
+  password then fails even though the account exists. [INFERENCE from the
+  realm settings; the realm's provider list was not inspected.]
+- There is no "forgot password" path to give such an account one, and no
+  way to register a fresh account yourself to work around it.
+- So "the account exists" and "the password login works" are independent
+  facts. A failed password login does not mean the account is gone, and
+  retrying the password will not fix it.
+
+## What to try, in order
+
+1. **Use the federated login button, not the password form**, on the login
+   page at `auth.developer.kx.com`. Pick the identity provider you used
+   (or were invited with) when the account was created.
+2. **Try the other federated providers offered**, with the same email
+   address. Providers are matched on the account's linked identity, so only
+   the one that was linked will work. [unverified]
+3. **Check you are on the right realm** (`devxp`) and not an old
+   KX/KDB.AI Cloud sign-in. Cloud credentials do not carry over.
+4. **Ask KX.** Because the realm blocks self-service reset and
+   registration, only KX can fix an account that cannot log in. Contact
+   KX support or the developer-portal contact with the account email and
+   the providers you tried.
+
+Do not keep retrying passwords; a locked-out account does not help you here.
+
+## From login to a passing live parity run
+
+1. Log in at `auth.developer.kx.com` (realm `devxp`) by the route above.
+2. **Get the licence.** Download the KDB-X community licence and save it as
+   `~/.kx/kc.lic`. [unverified: exact download page]
+3. **Get the registry token.** From the same login, obtain the bearer
+   token for `portal.dl.kx.com`. [unverified: where the portal shows it]
+4. **Pull `kdbai-db`** from `portal.dl.kx.com`, authenticating with that
+   token (a bearer-token registry; the usual `docker login` with a
+   username/password may not apply). Use the image name and tag the portal
+   lists. [unverified: exact image path and auth command]
+5. **Run the container** with the licence from `~/.kx/kc.lic` made available
+   to it, publishing 8081 (REST) and 8082 (QIPC). [unverified: licence
+   mount path and env var inside the container; follow the image's own
+   instructions]
+6. **Install the client:** `uv sync --extra kdbai`.
+7. **Run the parity gate**, QIPC against the local server:
+
+   ```sh
+   export KDBAI_ENDPOINT=http://localhost:8082
+   export KDBAI_MODE=qipc
+   uv run harness marketparity --backend kdbai
+   ```
+
+   or explicitly: `uv run harness marketparity --backend kdbai
+   --endpoint http://localhost:8082 --mode qipc`. For REST use
+   `http://localhost:8081` with `--mode rest`.
+8. **Run the live test:**
+
+   ```sh
+   uv run pytest tests/test_market_kdbai_live.py
+   ```
+
+   It skips unless `KDBAI_ENDPOINT` is set, and reads `KDBAI_MODE`. A pass
+   means the gates held with the declared float32 tolerance (`1e-3`).
+
+Without `KDBAI_ENDPOINT`, `marketparity --backend kdbai` refuses and points
+here. The in-process double (`--backend inprocess`) needs no server.
diff --git a/src/harness/cli.py b/src/harness/cli.py
index bebf5d8..69e4793 100644
--- a/src/harness/cli.py
+++ b/src/harness/cli.py
@@ -179,12 +179,15 @@ def cmd_marketparity(args) -> None:
         endpoint = args.endpoint or os.environ.get("KDBAI_ENDPOINT")
         if not endpoint:
             print("the kdbai backend needs a live server: set KDBAI_ENDPOINT "
-                  "(KDB.AI Server wants a KX portal license; cloud wants an "
-                  "API key). The in-process double runs without one.")
+                  "(or pass --endpoint), e.g. http://localhost:8082 for a "
+                  "local KDB.AI Server over QIPC (--mode qipc). See "
+                  "docs/KDBAI-LIVE-PARITY.md. The in-process double runs "
+                  "without one.")
             sys.exit(1)
+        mode = args.mode or os.environ.get("KDBAI_MODE") or None
 
         def factory():
-            return KdbaiWindowEngine(LiveKdbaiTransport(endpoint))
+            return KdbaiWindowEngine(LiveKdbaiTransport(endpoint, mode=mode))
 
         # live servers store float32; the tolerance is declared, not hidden
         outcome = run_backend_parity(factory, "kdbai",
@@ -378,6 +381,9 @@ def main() -> None:
                     default="inprocess")
     mp.add_argument("--endpoint", default=None,
                     help="KDB.AI endpoint (or set KDBAI_ENDPOINT)")
+    mp.add_argument("--mode", choices=["qipc", "rest"], default=None,
+                    help="client mode: qipc (local server, port 8082) or "
+                         "rest (port 8081); or set KDBAI_MODE")
     mp.set_defaults(fn=cmd_marketparity)
 
     c2 = sub.add_parser("calibrate")
diff --git a/src/harness/market/kdbai_backend.py b/src/harness/market/kdbai_backend.py
index eb09b88..65c8317 100644
--- a/src/harness/market/kdbai_backend.py
+++ b/src/harness/market/kdbai_backend.py
@@ -5,10 +5,10 @@ The seam is a thin transport with two verbs: ensure a series table exists
 TSS search over it. LiveKdbaiTransport maps those verbs onto kdbai_client
 2.1 as installed (Session -> Database -> Table, schema plus a tss index,
 DataFrame inserts, vectors keyed by the tss column). A live round trip
-needs what only an operator can supply: a KX portal license for KDB.AI
-Server or cloud credentials; until then the mapping is validated against
-the installed client's signatures and the live tests skip, the same way
-Postgres tests skip when that database is down.
+needs what only an operator can supply: a KDB-X community licence for
+KDB.AI Server (see docs/KDBAI-LIVE-PARITY.md); until then the mapping is
+validated against the installed client's signatures and the live tests
+skip, the same way Postgres tests skip when that database is down.
 
 InProcessTssTransport is the contract double, implementing the documented
 non-transformed TSS semantics with independent math: z-normalise every
@@ -144,18 +144,30 @@ class LiveKdbaiTransport:
     which skip without KDBAI_ENDPOINT."""
 
     def __init__(self, endpoint: str, database: str = "default",
-                 options: dict[str, Any] | None = None):
+                 options: dict[str, Any] | None = None,
+                 mode: str | None = None):
         self._endpoint = endpoint
         self._database = database
         self._options = options
+        self._mode = mode
         self._db: Any = None
         self.connected = False
 
+    def session_kwargs(self) -> dict[str, Any]:
+        """Keyword arguments for kdbai_client.Session. `mode` ("qipc" or
+        "rest") and `options` appear only when given, so the client keeps
+        its own defaults otherwise."""
+        kwargs: dict[str, Any] = {"endpoint": self._endpoint}
+        if self._mode is not None:
+            kwargs["mode"] = self._mode
+        if self._options is not None:
+            kwargs["options"] = self._options
+        return kwargs
+
     def _database_handle(self) -> Any:
         if self._db is None:
             import kdbai_client as kdbai
-            session = kdbai.Session(endpoint=self._endpoint,
-                                    options=self._options)
+            session = kdbai.Session(**self.session_kwargs())
             try:
                 self._db = session.database(self._database)
             except kdbai.KDBAIException:
diff --git a/tests/test_market_backend.py b/tests/test_market_backend.py
index 5c3eec8..1e158ac 100644
--- a/tests/test_market_backend.py
+++ b/tests/test_market_backend.py
@@ -102,3 +102,17 @@ def test_the_backend_keeps_the_door_and_the_refusals():
 def test_the_live_transport_constructs_lazily_without_a_server():
     transport = LiveKdbaiTransport(endpoint="http://127.0.0.1:9")
     assert transport.connected is False       # nothing dialed at construction
+
+
+def test_session_kwargs_carry_mode_and_options_only_when_given():
+    assert LiveKdbaiTransport("http://localhost:8082").session_kwargs() == {
+        "endpoint": "http://localhost:8082"}
+    qipc = LiveKdbaiTransport("http://localhost:8082", mode="qipc")
+    assert qipc.session_kwargs() == {
+        "endpoint": "http://localhost:8082", "mode": "qipc"}
+    both = LiveKdbaiTransport("http://localhost:8081", mode="rest",
+                              options={"read_timeout": 5})
+    assert both.session_kwargs() == {
+        "endpoint": "http://localhost:8081", "mode": "rest",
+        "options": {"read_timeout": 5}}
+    assert qipc.connected is False
diff --git a/tests/test_market_kdbai_live.py b/tests/test_market_kdbai_live.py
index 22c30e5..afefdf0 100644
--- a/tests/test_market_kdbai_live.py
+++ b/tests/test_market_kdbai_live.py
@@ -2,8 +2,9 @@
 
 The pgskip doctrine applied to KDB.AI: the live path exists, is wired, and
 proves itself the moment an operator supplies what only an operator can
-(a KX portal license for KDB.AI Server, or cloud credentials) and sets
-KDBAI_ENDPOINT. Until then this file skips rather than pretends.
+(a local KDB.AI Server, see docs/KDBAI-LIVE-PARITY.md) and sets
+KDBAI_ENDPOINT (and KDBAI_MODE: qipc or rest). Until then this file skips
+rather than pretends.
 """
 from __future__ import annotations
 
@@ -22,9 +23,10 @@ def test_live_kdbai_parity_holds_on_the_same_gates(tmp_path):
     from harness.market.parity import run_backend_parity
 
     endpoint = os.environ["KDBAI_ENDPOINT"]
+    mode = os.environ.get("KDBAI_MODE") or None
 
     def factory():
-        return KdbaiWindowEngine(LiveKdbaiTransport(endpoint))
+        return KdbaiWindowEngine(LiveKdbaiTransport(endpoint, mode=mode))
 
     # live servers store float32; the relaxed tolerance is declared up front
     res = run_backend_parity(factory, "kdbai", log=lambda *a, **k: None,

```

## Patch B

```diff
diff --git a/README.md b/README.md
index 3769ffa..49cf21e 100644
--- a/README.md
+++ b/README.md
@@ -89,10 +89,11 @@ refusal integrity, temporal leakage) have never regressed.
   semantics with independent math and agrees at 1.0 with drift under
   1e-6 (artifacts/market-parity-inprocess.json). A deterministically
   detuned transport walls with the divergence named, so the gate is
-  proven able to fail. The live path needs what only an operator can
-  supply (a KX portal license or cloud credentials): install with
-  `uv sync --extra kdbai`, set KDBAI_ENDPOINT, and the live tests stop
-  skipping.
+  proven able to fail. The live path needs a local KDB.AI Server (a KDB-X
+  community licence plus the registry image; cloud is retired): install
+  with `uv sync --extra kdbai`, set KDBAI_ENDPOINT (and KDBAI_MODE,
+  `qipc` or `rest`), and the live tests stop skipping. Steps and the
+  login caveats are in docs/KDBAI-LIVE-PARITY.md.
 - **Hardens against how feeds actually fail**: sequence gaps are detected
   at the right cutoffs and close when the feed heals (a delayed-knowledge
   span and a held-out span are both planted). Exact redelivery is
diff --git a/docs/KDBAI-LIVE-PARITY.md b/docs/KDBAI-LIVE-PARITY.md
new file mode 100644
index 0000000..1d70a79
--- /dev/null
+++ b/docs/KDBAI-LIVE-PARITY.md
@@ -0,0 +1,81 @@
+# KDB.AI live parity
+
+The in-process double (`harness marketparity`) needs nothing. The live path
+runs the same gates against a real KDB.AI Server and needs a local one.
+
+## Current route to a live server
+
+- **KDB.AI Cloud is retired.** `cloud.kdb.ai` now redirects to the marketing
+  site, so there is no REST-with-API-key endpoint to point at.
+- **KDB.AI Server is the target.** It needs a KDB-X community licence at
+  `~/.kx/kc.lic`.
+- **The `kdbai-db` image** sits behind a bearer-token registry at
+  `portal.dl.kx.com`; an anonymous `docker pull` is refused.
+- **One login yields both** the licence and the registry token: the `devxp`
+  Keycloak realm at `auth.developer.kx.com`.
+
+A local server exposes REST on **8081** and QIPC on **8082**. The client has
+to be told which: pass `--mode {qipc,rest}` (or `KDBAI_MODE`) together with the
+matching port. QIPC on 8082 is the example used below.
+
+## When an account exists but login fails
+
+The `devxp` realm has self-registration disabled, password reset disabled,
+and federated (identity-provider) login enabled. Consequences
+[INFERENCE from those realm settings, not observed against the realm]:
+
+- An account can exist without a usable local password, for example one
+  created through a federated provider or provisioned by an admin. The
+  username/password form then rejects it, and "forgot password" is not
+  available to repair it.
+- You cannot register a fresh account yourself, so creating another is not a
+  fallback.
+
+Try, in order:
+
+1. **Federated login.** Use the identity-provider button on the login page,
+   with the provider the account was created through, instead of typing a
+   password.
+2. **Local password**, only if you know one was set for this account.
+3. **Ask the realm operator** (KX developer support) to attach a credential
+   or link the account to your provider. Password reset and
+   self-registration are off, so this is the only route that changes the
+   account.
+
+## From login to a passing live parity run
+
+1. Log in to `auth.developer.kx.com` (realm `devxp`) as above and obtain the
+   KDB-X community licence. Save it as `~/.kx/kc.lic`.
+2. From the same login, obtain the registry bearer token for
+   `portal.dl.kx.com`, and authenticate Docker against that registry with it.
+3. Pull the `kdbai-db` image from `portal.dl.kx.com`. Take the exact image
+   path and tag from the portal; they are not recorded here.
+4. Start the container with the licence mounted from `~/.kx/kc.lic` and ports
+   8081 (REST) and 8082 (QIPC) published to localhost. Consult the image's
+   own documentation for the licence mount path and environment variables.
+5. Install the client: `uv sync --extra kdbai`.
+6. Run parity against QIPC:
+
+   ```
+   export KDBAI_ENDPOINT=http://localhost:8082
+   export KDBAI_MODE=qipc
+   uv run harness marketparity --backend kdbai
+   ```
+
+   or pass `--endpoint http://localhost:8082 --mode qipc`. For REST use
+   `http://localhost:8081` with `rest`. If neither `--mode` nor `KDBAI_MODE`
+   is given, no mode is sent and `kdbai_client` uses its own default.
+7. Run the live test, which skips without `KDBAI_ENDPOINT` and also reads
+   `KDBAI_MODE`:
+
+   ```
+   uv run pytest tests/test_market_kdbai_live.py
+   ```
+
+The gate passes when the command exits 0 (it exits 2 on a failed gate, 1 when
+no endpoint is set). Live servers store float32, so the live run declares a
+distance tolerance of `1e-3`.
+
+`LiveKdbaiTransport.session_kwargs()` shows exactly what is passed to
+`kdbai_client.Session`: `endpoint` always, `mode` and `options` only when
+given.
diff --git a/src/harness/cli.py b/src/harness/cli.py
index bebf5d8..9adbd0a 100644
--- a/src/harness/cli.py
+++ b/src/harness/cli.py
@@ -179,12 +179,15 @@ def cmd_marketparity(args) -> None:
         endpoint = args.endpoint or os.environ.get("KDBAI_ENDPOINT")
         if not endpoint:
             print("the kdbai backend needs a live server: set KDBAI_ENDPOINT "
-                  "(KDB.AI Server wants a KX portal license; cloud wants an "
-                  "API key). The in-process double runs without one.")
+                  "or pass --endpoint, e.g. http://localhost:8082 for a "
+                  "local KDB.AI Server over QIPC. See "
+                  "docs/KDBAI-LIVE-PARITY.md. The in-process double runs "
+                  "without one.")
             sys.exit(1)
+        mode = args.mode or os.environ.get("KDBAI_MODE") or None
 
         def factory():
-            return KdbaiWindowEngine(LiveKdbaiTransport(endpoint))
+            return KdbaiWindowEngine(LiveKdbaiTransport(endpoint, mode=mode))
 
         # live servers store float32; the tolerance is declared, not hidden
         outcome = run_backend_parity(factory, "kdbai",
@@ -378,6 +381,9 @@ def main() -> None:
                     default="inprocess")
     mp.add_argument("--endpoint", default=None,
                     help="KDB.AI endpoint (or set KDBAI_ENDPOINT)")
+    mp.add_argument("--mode", choices=["qipc", "rest"], default=None,
+                    help="KDB.AI client mode (or set KDBAI_MODE); a local "
+                         "server serves REST on 8081 and QIPC on 8082")
     mp.set_defaults(fn=cmd_marketparity)
 
     c2 = sub.add_parser("calibrate")
diff --git a/src/harness/market/kdbai_backend.py b/src/harness/market/kdbai_backend.py
index eb09b88..aa33067 100644
--- a/src/harness/market/kdbai_backend.py
+++ b/src/harness/market/kdbai_backend.py
@@ -5,10 +5,11 @@ The seam is a thin transport with two verbs: ensure a series table exists
 TSS search over it. LiveKdbaiTransport maps those verbs onto kdbai_client
 2.1 as installed (Session -> Database -> Table, schema plus a tss index,
 DataFrame inserts, vectors keyed by the tss column). A live round trip
-needs what only an operator can supply: a KX portal license for KDB.AI
-Server or cloud credentials; until then the mapping is validated against
-the installed client's signatures and the live tests skip, the same way
-Postgres tests skip when that database is down.
+needs what only an operator can supply: a KDB.AI Server (KDB-X community
+licence plus the registry image, see docs/KDBAI-LIVE-PARITY.md); until
+then the mapping is validated against the installed client's signatures
+and the live tests skip, the same way Postgres tests skip when that
+database is down.
 
 InProcessTssTransport is the contract double, implementing the documented
 non-transformed TSS semantics with independent math: z-normalise every
@@ -144,18 +145,29 @@ class LiveKdbaiTransport:
     which skip without KDBAI_ENDPOINT."""
 
     def __init__(self, endpoint: str, database: str = "default",
-                 options: dict[str, Any] | None = None):
+                 options: dict[str, Any] | None = None,
+                 mode: str | None = None):
         self._endpoint = endpoint
         self._database = database
         self._options = options
+        self._mode = mode
         self._db: Any = None
         self.connected = False
 
+    def session_kwargs(self) -> dict[str, Any]:
+        """Keyword arguments for kdbai_client.Session. `mode` and `options`
+        appear only when given, so the client keeps its own defaults."""
+        kwargs: dict[str, Any] = {"endpoint": self._endpoint}
+        if self._mode is not None:
+            kwargs["mode"] = self._mode
+        if self._options is not None:
+            kwargs["options"] = self._options
+        return kwargs
+
     def _database_handle(self) -> Any:
         if self._db is None:
             import kdbai_client as kdbai
-            session = kdbai.Session(endpoint=self._endpoint,
-                                    options=self._options)
+            session = kdbai.Session(**self.session_kwargs())
             try:
                 self._db = session.database(self._database)
             except kdbai.KDBAIException:
diff --git a/tests/test_market_backend.py b/tests/test_market_backend.py
index 5c3eec8..baf9622 100644
--- a/tests/test_market_backend.py
+++ b/tests/test_market_backend.py
@@ -102,3 +102,13 @@ def test_the_backend_keeps_the_door_and_the_refusals():
 def test_the_live_transport_constructs_lazily_without_a_server():
     transport = LiveKdbaiTransport(endpoint="http://127.0.0.1:9")
     assert transport.connected is False       # nothing dialed at construction
+
+
+def test_session_kwargs_omit_mode_and_options_unless_given():
+    ep = "http://localhost:8082"
+    assert LiveKdbaiTransport(ep).session_kwargs() == {"endpoint": ep}
+    assert LiveKdbaiTransport(ep, mode="qipc").session_kwargs() == {
+        "endpoint": ep, "mode": "qipc"}
+    assert LiveKdbaiTransport(
+        ep, options={"k": 1}, mode="rest").session_kwargs() == {
+        "endpoint": ep, "mode": "rest", "options": {"k": 1}}
diff --git a/tests/test_market_kdbai_live.py b/tests/test_market_kdbai_live.py
index 22c30e5..1f09053 100644
--- a/tests/test_market_kdbai_live.py
+++ b/tests/test_market_kdbai_live.py
@@ -2,8 +2,9 @@
 
 The pgskip doctrine applied to KDB.AI: the live path exists, is wired, and
 proves itself the moment an operator supplies what only an operator can
-(a KX portal license for KDB.AI Server, or cloud credentials) and sets
-KDBAI_ENDPOINT. Until then this file skips rather than pretends.
+(a local KDB.AI Server; see docs/KDBAI-LIVE-PARITY.md) and sets
+KDBAI_ENDPOINT (and KDBAI_MODE when needed). Until then this file skips
+rather than pretends.
 """
 from __future__ import annotations
 
@@ -22,9 +23,10 @@ def test_live_kdbai_parity_holds_on_the_same_gates(tmp_path):
     from harness.market.parity import run_backend_parity
 
     endpoint = os.environ["KDBAI_ENDPOINT"]
+    mode = os.environ.get("KDBAI_MODE") or None
 
     def factory():
-        return KdbaiWindowEngine(LiveKdbaiTransport(endpoint))
+        return KdbaiWindowEngine(LiveKdbaiTransport(endpoint, mode=mode))
 
     # live servers store float32; the relaxed tolerance is declared up front
     res = run_backend_parity(factory, "kdbai", log=lambda *a, **k: None,

```
