# Pair 22 (retrieval-harness-1ad941fa)

Which patch would you merge? Answer in answers.md as `22: A`, `22: B`, or `22: =` if you cannot tell.

## Issue

Title: Support QIPC/REST client mode for local KDB.AI Server in the live parity path

The live KDB.AI parity path can't reach a local `kdbai-db` container. `LiveKdbaiTransport` only takes an endpoint and optional options, and KDB.AI Cloud (REST with an API key) has been retired. A local server exposes REST on 8081 and QIPC on 8082, so the client has to be told which one to use.

Add an optional `mode: str | None = None` parameter to `LiveKdbaiTransport.__init__(endpoint, database="default", options=None, mode=None)`. Add a public `session_kwargs() -> dict` method that returns the keyword arguments used to open the `kdbai_client` session. The dict always has `endpoint`. It has `mode` only when a mode was given, and `options` only when options were given. For example, `mode="qipc"` with `endpoint="http://localhost:8082"` gives `{"endpoint": "http://localhost:8082", "mode": "qipc"}`. With no mode, the `mode` key must be absent so the client keeps its own default. Construction must still not dial the server.

The `marketparity` command should accept `--mode {qipc,rest}`, with `KDBAI_MODE` as the environment fallback, and pass the mode to the live transport. The live parity test should also read `KDBAI_MODE`. When `--backend kdbai` is run with no `KDBAI_ENDPOINT`, the refusal message should stop pointing at cloud credentials. It should give a local example endpoint (`http://localhost:8082`) and refer to `docs/KDBAI-LIVE-PARITY.md`.

That document should record the current route to a live server. `cloud.kdb.ai` now redirects to the marketing site. KDB.AI Server needs a KDB-X community licence at `~/.kx/kc.lic`. The `kdbai-db` image sits behind a bearer-token registry at `portal.dl.kx.com`. The licence and the token both come from one login on the `devxp` Keycloak realm at `auth.developer.kx.com`. The realm has self-registration and password reset disabled and federated login enabled, so the document should explain why an account can exist but fail to log in, what to try in order, and the steps from login to a passing live parity run. The README's live-path note should match.

## Patch A

```diff
diff --git a/README.md b/README.md
index 3769ffa..17073c4 100644
--- a/README.md
+++ b/README.md
@@ -89,10 +89,14 @@ refusal integrity, temporal leakage) have never regressed.
   semantics with independent math and agrees at 1.0 with drift under
   1e-6 (artifacts/market-parity-inprocess.json). A deterministically
   detuned transport walls with the divergence named, so the gate is
-  proven able to fail. The live path needs what only an operator can
-  supply (a KX portal license or cloud credentials): install with
-  `uv sync --extra kdbai`, set KDBAI_ENDPOINT, and the live tests stop
-  skipping.
+  proven able to fail. The live path needs a local KDB.AI Server, which
+  needs a KDB-X community licence (`~/.kx/kc.lic`) and the `kdbai-db`
+  image from the bearer-token registry at `portal.dl.kx.com`, both from
+  one login on the KX developer portal (KDB.AI Cloud is retired). Install
+  with `uv sync --extra kdbai`, run the server, set
+  `KDBAI_ENDPOINT=http://localhost:8082` and `KDBAI_MODE=qipc`, and the
+  live tests stop skipping. Steps and login troubleshooting:
+  docs/KDBAI-LIVE-PARITY.md.
 - **Hardens against how feeds actually fail**: sequence gaps are detected
   at the right cutoffs and close when the feed heals (a delayed-knowledge
   span and a held-out span are both planted). Exact redelivery is
diff --git a/docs/KDBAI-LIVE-PARITY.md b/docs/KDBAI-LIVE-PARITY.md
new file mode 100644
index 0000000..0151cba
--- /dev/null
+++ b/docs/KDBAI-LIVE-PARITY.md
@@ -0,0 +1,128 @@
+# Running the live KDB.AI parity path
+
+The live parity path runs `LiveKdbaiTransport` against a real KDB.AI server
+and holds it to the same gates as the oracle
+(`tests/test_market_kdbai_live.py`, `harness marketparity --backend kdbai`).
+Everything else in the repo runs against the in-process double; this is the
+only part that needs a server.
+
+Items marked **[unverified]** were not exercised from this repository. Check
+them against the current KX documentation before relying on them.
+
+## Current route to a live server
+
+- **KDB.AI Cloud is gone.** `cloud.kdb.ai` now redirects to the marketing
+  site, so REST-with-an-API-key against the cloud no longer works. No cloud
+  endpoint or API key will get you a live run.
+- **Use KDB.AI Server locally.** It runs as the `kdbai-db` container and
+  exposes:
+  - REST on `8081` (`--mode rest`)
+  - QIPC on `8082` (`--mode qipc`)
+- **It needs a KDB-X community licence** at `~/.kx/kc.lic`.
+- **The `kdbai-db` image is behind a bearer-token registry** at
+  `portal.dl.kx.com`. You cannot `docker pull` it anonymously.
+- **The licence and the registry token come from one login**: the `devxp`
+  Keycloak realm at `auth.developer.kx.com`. No login, no licence and no
+  image.
+
+## Why an account can exist but fail to log in
+
+The `devxp` realm is configured with:
+
+| Setting | Value |
+| --- | --- |
+| Self-registration | disabled |
+| Password reset | disabled |
+| Federated (identity-provider) login | enabled |
+
+Consequences:
+
+- You cannot create an account from the login page, so there is no
+  "sign up" route if you do not already have one.
+- A "forgot password" flow does not exist, so a forgotten or never-set
+  password cannot be recovered on the page.
+- An account that was created through a federated identity provider (or
+  provisioned by an admin) may have no local password at all. The account
+  exists in the realm, but username/password login fails because there is
+  no password to match. The same email typed into the password form and
+  rejected is the usual symptom.
+- Federated login is the path that is actually enabled. It only works if the
+  identity provider account is linked to, or matches, the realm account.
+
+A failed password login therefore does not mean the account is missing or
+the credentials were mistyped. It can mean the account was never meant to be
+used with a password.
+
+## What to try, in order
+
+1. **Use the federated login button** on the realm login page (the identity
+   provider offered there) instead of typing a username and password. This
+   is the enabled path and the most likely to work for an existing account.
+2. **Use the identity provider account that matches the email** on the KX
+   account. A different provider account, or a different email, creates no
+   link to the existing realm account and fails.
+3. **Try the password form only if you were given a password** by the
+   realm's administrators. Do not expect password reset to work; it is off.
+4. **Ask KX to provision or repair the account.** Self-registration and
+   reset are disabled, so an administrator is the only route when 1-3 fail.
+   Say which email you use, which provider you tried, and that password
+   login fails. KX developer support is the contact **[unverified]**.
+5. **Stop and report the blocker** if none of the above works. There is no
+   alternative live backend: the cloud is retired and the image and licence
+   are both gated by this login. The in-process double
+   (`harness marketparity --backend inprocess`) keeps running meanwhile.
+
+## From login to a passing live parity run
+
+1. **Log in** to `auth.developer.kx.com` (realm `devxp`) using the order
+   above.
+2. **Get the KDB-X community licence** from the KX developer portal and save
+   it as `~/.kx/kc.lic`. **[unverified]**: the exact portal page.
+3. **Get the registry bearer token** for `portal.dl.kx.com` from the same
+   login. **[unverified]**: the exact portal page.
+4. **Log in to the registry and pull the image:**
+
+   ```sh
+   docker login portal.dl.kx.com -u <your-email> --password-stdin   # paste the bearer token
+   docker pull portal.dl.kx.com/kdbai-db:latest
+   ```
+
+   **[unverified]**: the exact username convention and image tag; use what
+   the portal shows.
+5. **Start the server** with the licence mounted and both ports published
+   (`8081` REST, `8082` QIPC). **[unverified]**: the licence mount path and
+   env var; follow the current `kdbai-db` documentation. Example shape:
+
+   ```sh
+   docker run -d --name kdbai -p 8081:8081 -p 8082:8082 \
+     -v ~/.kx/kc.lic:/tmp/license/kc.lic \
+     -e KDBAI_LICENSE_FILE=/tmp/license/kc.lic \
+     portal.dl.kx.com/kdbai-db:latest
+   ```
+
+6. **Install the client:** `uv sync --extra kdbai`.
+7. **Point the harness at the server.** QIPC is the port used in the
+   examples:
+
+   ```sh
+   export KDBAI_ENDPOINT=http://localhost:8082
+   export KDBAI_MODE=qipc
+   ```
+
+   For REST use `http://localhost:8081` with `KDBAI_MODE=rest`. If
+   `KDBAI_MODE` is unset, no `mode` is passed and `kdbai_client` keeps its
+   own default, which may not match the port you chose.
+8. **Run the parity gate:**
+
+   ```sh
+   uv run harness marketparity --backend kdbai            # reads the env vars
+   uv run harness marketparity --backend kdbai --endpoint http://localhost:8082 --mode qipc
+   ```
+
+   `--mode` overrides `KDBAI_MODE`; `--endpoint` overrides `KDBAI_ENDPOINT`.
+   The command exits non-zero (2) if the gate fails and 1 if no endpoint is
+   set.
+9. **Run the live test:** `uv run pytest tests/test_market_kdbai_live.py`.
+   It skips without `KDBAI_ENDPOINT` and reads `KDBAI_MODE`. A pass means the
+   live backend agrees with the oracle within the declared float32 tolerance
+   (`1e-3`).
diff --git a/src/harness/cli.py b/src/harness/cli.py
index bebf5d8..1b9e002 100644
--- a/src/harness/cli.py
+++ b/src/harness/cli.py
@@ -179,12 +179,15 @@ def cmd_marketparity(args) -> None:
         endpoint = args.endpoint or os.environ.get("KDBAI_ENDPOINT")
         if not endpoint:
             print("the kdbai backend needs a live server: set KDBAI_ENDPOINT "
-                  "(KDB.AI Server wants a KX portal license; cloud wants an "
-                  "API key). The in-process double runs without one.")
+                  "or pass --endpoint, e.g. http://localhost:8082 for a "
+                  "local KDB.AI Server (with --mode qipc). See "
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
+                    help="client transport: qipc (local port 8082) or rest "
+                         "(local port 8081); or set KDBAI_MODE")
     mp.set_defaults(fn=cmd_marketparity)
 
     c2 = sub.add_parser("calibrate")
diff --git a/src/harness/market/kdbai_backend.py b/src/harness/market/kdbai_backend.py
index eb09b88..dc99e3a 100644
--- a/src/harness/market/kdbai_backend.py
+++ b/src/harness/market/kdbai_backend.py
@@ -6,9 +6,9 @@ TSS search over it. LiveKdbaiTransport maps those verbs onto kdbai_client
 2.1 as installed (Session -> Database -> Table, schema plus a tss index,
 DataFrame inserts, vectors keyed by the tss column). A live round trip
 needs what only an operator can supply: a KX portal license for KDB.AI
-Server or cloud credentials; until then the mapping is validated against
-the installed client's signatures and the live tests skip, the same way
-Postgres tests skip when that database is down.
+Server (docs/KDBAI-LIVE-PARITY.md); until then the mapping is validated
+against the installed client's signatures and the live tests skip, the same
+way Postgres tests skip when that database is down.
 
 InProcessTssTransport is the contract double, implementing the documented
 non-transformed TSS semantics with independent math: z-normalise every
@@ -140,22 +140,35 @@ class LiveKdbaiTransport:
     Construction dials nothing; the session opens on first use. The schema
     is (pos int32, val float64) with a tss index on val, and searches key
     the vectors dict by the tss column, per the installed client's own
-    documentation. The server round trip is validated by the live tests,
-    which skip without KDBAI_ENDPOINT."""
+    documentation. A local KDB.AI Server exposes REST on 8081 and QIPC on
+    8082; `mode` ("qipc" or "rest") tells the client which one the endpoint
+    speaks, and is left to the client's default when None. The server round
+    trip is validated by the live tests, which skip without KDBAI_ENDPOINT."""
 
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
+        """Keyword arguments for kdbai_client.Session; optional keys appear
+        only when given so the client keeps its own defaults."""
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
index 5c3eec8..f55003f 100644
--- a/tests/test_market_backend.py
+++ b/tests/test_market_backend.py
@@ -102,3 +102,16 @@ def test_the_backend_keeps_the_door_and_the_refusals():
 def test_the_live_transport_constructs_lazily_without_a_server():
     transport = LiveKdbaiTransport(endpoint="http://127.0.0.1:9")
     assert transport.connected is False       # nothing dialed at construction
+
+
+def test_session_kwargs_carry_mode_and_options_only_when_given():
+    qipc = LiveKdbaiTransport(endpoint="http://localhost:8082", mode="qipc")
+    assert qipc.session_kwargs() == {"endpoint": "http://localhost:8082",
+                                     "mode": "qipc"}
+    assert qipc.connected is False
+    assert LiveKdbaiTransport(endpoint="http://x").session_kwargs() == {
+        "endpoint": "http://x"}
+    both = LiveKdbaiTransport(endpoint="http://x", options={"a": 1},
+                              mode="rest")
+    assert both.session_kwargs() == {"endpoint": "http://x", "mode": "rest",
+                                     "options": {"a": 1}}
diff --git a/tests/test_market_kdbai_live.py b/tests/test_market_kdbai_live.py
index 22c30e5..95fc29d 100644
--- a/tests/test_market_kdbai_live.py
+++ b/tests/test_market_kdbai_live.py
@@ -2,8 +2,9 @@
 
 The pgskip doctrine applied to KDB.AI: the live path exists, is wired, and
 proves itself the moment an operator supplies what only an operator can
-(a KX portal license for KDB.AI Server, or cloud credentials) and sets
-KDBAI_ENDPOINT. Until then this file skips rather than pretends.
+(a KX-licensed local KDB.AI Server; see docs/KDBAI-LIVE-PARITY.md) and sets
+KDBAI_ENDPOINT (and KDBAI_MODE for a local server). Until then this file
+skips rather than pretends.
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
