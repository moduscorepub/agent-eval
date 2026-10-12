# Pair 20 (retrieval-harness-894da0d0)

Which patch would you merge? Answer in answers.md as `20: A`, `20: B`, or `20: =` if you cannot tell.

## Issue

Title: Answer endpoint should execute graph-routed turns as a join when the entity and relation are unambiguous, otherwise fall back to text retrieval

When the planner routes a turn to `graph`, `/api/answer` still runs ordinary text retrieval. The graph route is never executed, so join-shaped questions such as "which risks does mitigation X treat?" get no relational answer.

Desired behavior: for a `route == "graph"` plan, the answer endpoint tries a graph join first. It uses `_graph_hits(question: str, plan: RetrievalPlan, req: AnswerRequest) -> SearchResponse | None` in `harness.showroom`.

The join runs only when both conditions hold:
- Exactly one entity resolves from the plan's `seed_entity`, falling back to `standalone_query` and then the raw question. Zero or several matches do not qualify.
- A registered traversal relation exists for that entity kind. This is the plan's `relation` if registered for the kind. Otherwise it is the kind's only registered relation, if there is exactly one.

If either condition fails, or the join returns no documents, `_graph_hits` returns `None`. The endpoint then falls closed to the normal text search arm. It must not guess an entity or relation.

Joined results must pass the same eligibility and privilege door as any other hit, including `as_known_at` and temporal mode. Every hit must come back with `eligibility == "eligible"`. Bundles are assembled from those hits, with the door applied per member.

The returned `SearchResponse.config` must include `route_executed: "graph"`, `resolved: "<kind>:<id>"`, `relation`, and `calibration: "unbound"`. When the join is used, the text search arm must not run, and the answer streams as usual with that meta.

In the web UI, the working panel should show an "executed as" row, such as "a join · risk:r1 → matter", when `route_executed` is `"graph"`.

## Patch A

```diff
diff --git a/src/harness/showroom.py b/src/harness/showroom.py
index 8def6f3..0e0fad1 100644
--- a/src/harness/showroom.py
+++ b/src/harness/showroom.py
@@ -19,8 +19,15 @@ from fastapi.responses import StreamingResponse
 
 from .answer import REFUSAL, draft_answer, plan_turn
 from .answer_backend import get_backend
-from .models import AnswerRequest, AnswerResult, SearchRequest, SearchResponse
-from .ports import Document
+from .models import (
+    AnswerRequest,
+    AnswerResult,
+    RetrievalPlan,
+    SearchHit,
+    SearchRequest,
+    SearchResponse,
+)
+from .ports import Document, Hit, QueryContext
 from .session import Sitting, export_sitting
 
 ROOT = Path(__file__).resolve().parents[2]
@@ -45,6 +52,97 @@ def write_bait_manifest(docs: list[Document], path: Path) -> int:
     return len(bait)
 
 
+def _graph_hits(question: str, plan: RetrievalPlan,
+                req: AnswerRequest) -> SearchResponse | None:
+    """Execute a graph-routed turn as a join, or return None to fall closed.
+
+    The join runs only when exactly one entity resolves (seed_entity, then the
+    standalone query, then the raw question; the first non-empty resolution
+    decides, and an ambiguous one never falls through to a later guess) and
+    the entity's kind has a registered traversal: the plan's relation, else
+    the kind's only relation. Output passes the same door as any hit."""
+    from . import serve
+    from .bundle import assemble
+    from .db import chunk_table, connect, is_temporal
+    from .graph_exec import TRAVERSALS
+
+    t0 = time.perf_counter()
+    ex = serve._executor(req.index_version)
+    seeds: list[tuple[str, str]] = []
+    for text in (plan.seed_entity, plan.standalone_query, question):
+        if text and text.strip():
+            seeds = ex.resolve(text)
+            if seeds:
+                break
+    if len(seeds) != 1:
+        return None
+    kind, eid = seeds[0]
+    registered = [rel for (k, rel) in TRAVERSALS if k == kind]
+    if plan.relation and plan.relation in registered:
+        relation = plan.relation
+    elif len(registered) == 1:
+        relation = registered[0]
+    else:
+        return None
+
+    ctx = QueryContext(can_see_privileged=req.can_see_privileged,
+                       as_known_at=req.as_known_at,
+                       temporal_mode=req.temporal_mode)
+    docs = ex.execute(seeds, relation, ctx)
+    if not docs:
+        return None
+
+    temporal = is_temporal(req.index_version)
+    params: list = [docs]
+    time_pred = ""
+    if temporal:
+        if req.as_known_at:
+            time_pred = " AND validity @> %s::timestamptz"
+            params.append(req.as_known_at)
+        else:
+            time_pred = " AND validity @> now()"
+    priv_pred = "" if req.can_see_privileged else " AND NOT is_privileged"
+    with connect("harness") as conn:
+        rows = conn.execute(
+            f"""SELECT DISTINCT ON (doc_id) doc_id, chunk_id, subject_type, title,
+                       content, eligibility, is_privileged, subject_version
+                FROM {chunk_table(req.index_version)}
+                WHERE doc_id = ANY(%s) AND eligibility = 'eligible'
+                {priv_pred}{time_pred}
+                ORDER BY doc_id, chunk_index, chunk_id""", params).fetchall()
+    by_doc = {r[0]: r for r in rows}
+    hits: list[SearchHit] = []
+    raw: list[Hit] = []
+    for d in docs:
+        r = by_doc.get(d)
+        if r is None:
+            continue
+        _, chunk_id, stype, title, content, elig, priv, version = r
+        hits.append(SearchHit(
+            doc_id=d, chunk_id=chunk_id, subject_type=stype, score=1.0,
+            title=title, content=content[:600], eligibility=elig,
+            is_privileged=priv, version=version if temporal else None))
+        raw.append(Hit(doc_id=d, chunk_id=chunk_id, subject_type=stype,
+                       score=1.0, eligibility=elig, is_privileged=priv))
+    if not hits:
+        return None
+
+    bundles: list = []
+    door: dict = {}
+    if req.bundles:
+        bundles, bstats = assemble(raw, ctx, req.index_version,
+                                   {"hop_decay": 0.5, "max_members": 6,
+                                    "budget_words": 700})
+        door = {"bundle_blocked": bstats["blocked"],
+                "bundle_violations": len(bstats["violations"])}
+    config = {"route_executed": "graph", "resolved": f"{kind}:{eid}",
+              "relation": relation, "calibration": "unbound"}
+    return SearchResponse(hits=hits, bundles=bundles, graph=None,
+                          latency_ms=round((time.perf_counter() - t0) * 1000, 1),
+                          config=config, answerability=None, refused=False,
+                          door=door)
+
+
 def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
                  sittings_root: Path | None = None) -> APIRouter:
     router = APIRouter()
@@ -63,7 +161,11 @@ def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
                     "query": plan.standalone_query.strip(),
                     "filters": plan.filters or {}})
             sreq = sreq.model_copy(update={"bundles": True})
-            resp = await run_in_threadpool(search_fn, sreq)
+            resp = None
+            if plan and plan.route == "graph":
+                resp = await run_in_threadpool(_graph_hits, req.query, plan, sreq)
+            if resp is None:
+                resp = await run_in_threadpool(search_fn, sreq)
             meta = resp.model_dump()
             if plan:
                 meta["plan"] = plan.model_dump()
diff --git a/tests/test_showroom_api.py b/tests/test_showroom_api.py
index 5cb5cf9..31eda36 100644
--- a/tests/test_showroom_api.py
+++ b/tests/test_showroom_api.py
@@ -79,6 +79,130 @@ def test_answer_plans_conversational_turns(tmp_path, monkeypatch):
     assert fake.calls[0].query == "frankfurt redundancy matter status"
 
 
+def _graph_plan(**kw) -> RetrievalPlan:
+    fields = {"standalone_query": "which risks does the cloud mitigation treat",
+              "route": "graph", "seed_entity": "cloud mitigation",
+              "relation": "treats", **kw}
+    return RetrievalPlan(**fields)
+
+
+def _graph_response() -> SearchResponse:
+    hit = SearchHit(doc_id="r1", chunk_id="c1", subject_type="risk", score=1.0,
+                    title="Cloud processor risk", content="Body.",
+                    eligibility="eligible", is_privileged=False)
+    return SearchResponse(hits=[hit], latency_ms=1.0, refused=False,
+                          config={"route_executed": "graph", "resolved": "mitigation:m1",
+                                  "relation": "treats", "calibration": "unbound"})
+
+
+def test_graph_route_uses_the_join_and_skips_text_search(tmp_path, monkeypatch):
+    import harness.showroom as sr
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: _graph_plan(reasoning="join"))
+    monkeypatch.setattr(sr, "_graph_hits", lambda q, p, r: _graph_response())
+    client, fake = _client(tmp_path)
+    ev = _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "hi"}])).text)
+    assert fake.calls == []
+    assert ev["meta"]["config"]["route_executed"] == "graph"
+    assert ev["final"]["answer"]["status"] == "answered"
+
+
+def test_graph_route_falls_closed_to_text_search(tmp_path, monkeypatch):
+    import harness.showroom as sr
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: _graph_plan(reasoning="join"))
+    monkeypatch.setattr(sr, "_graph_hits", lambda q, p, r: None)
+    client, fake = _client(tmp_path)
+    ev = _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "hi"}])).text)
+    assert len(fake.calls) == 1
+    assert "route_executed" not in ev["meta"]["config"]
+
+
+class _FakeExecutor:
+    def __init__(self, resolutions: dict[str, list[tuple[str, str]]], docs=("r1",)):
+        self.resolutions, self.docs, self.executed = resolutions, list(docs), []
+
+    def resolve(self, text):
+        return self.resolutions.get(text, [])
+
+    def execute(self, seeds, relation, ctx):
+        self.executed.append((seeds, relation))
+        return self.docs
+
+
+def _graph_env(monkeypatch, ex):
+    import harness.bundle as bundle
+    import harness.db as db
+    import harness.serve as serve
+    monkeypatch.setattr(serve, "_executor", lambda iv: ex)
+    monkeypatch.setattr(db, "is_temporal", lambda iv: False)
+
+    class _Conn:
+        def __enter__(self): return self
+        def __exit__(self, *a): return False
+        def execute(self, sql, params):
+            class _R:
+                def fetchall(_):
+                    return [(d, f"c-{d}", "risk", f"title {d}", "body", "eligible",
+                             False, 1) for d in params[0]]
+            return _R()
+
+    monkeypatch.setattr(db, "connect", lambda name: _Conn())
+    monkeypatch.setattr(bundle, "assemble", lambda *a, **k: ([], {"blocked": 0,
+                                                                    "violations": []}))
+
+
+def _req(**kw):
+    from harness.models import AnswerRequest
+    return AnswerRequest(query="which risks does cloud mitigation treat",
+                         index_version="iv1", bundles=True, **kw)
+
+
+def test_graph_hits_resolves_one_entity_and_registered_relation(monkeypatch):
+    import harness.showroom as sr
+    ex = _FakeExecutor({"cloud mitigation": [("mitigation", "m1")]}, docs=("r1", "r2"))
+    _graph_env(monkeypatch, ex)
+    resp = sr._graph_hits("q", _graph_plan(), _req())
+    assert resp is not None
+    assert [h.doc_id for h in resp.hits] == ["r1", "r2"]
+    assert all(h.eligibility == "eligible" for h in resp.hits)
+    assert resp.config == {"route_executed": "graph", "resolved": "mitigation:m1",
+                           "relation": "treats", "calibration": "unbound"}
+    assert ex.executed == [([("mitigation", "m1")], "treats")]
+
+
+def test_graph_hits_falls_back_to_query_then_question_on_zero_matches(monkeypatch):
+    import harness.showroom as sr
+    ex = _FakeExecutor({"raw question": [("mitigation", "m1")]})
+    _graph_env(monkeypatch, ex)
+    assert sr._graph_hits("raw question", _graph_plan(), _req()) is not None
+
+
+def test_graph_hits_refuses_to_guess(monkeypatch):
+    import harness.showroom as sr
+    two = [("mitigation", "m1"), ("mitigation", "m2")]
+    ex = _FakeExecutor({"cloud mitigation": two, "raw question": [("mitigation", "m1")]})
+    _graph_env(monkeypatch, ex)
+    assert sr._graph_hits("raw question", _graph_plan(), _req()) is None  # ambiguous
+    assert sr._graph_hits("none", _graph_plan(seed_entity=None,
+                          standalone_query="nothing here"), _req()) is None  # zero
+    ex.resolutions = {"cloud mitigation": [("risk", "r1")]}
+    plan = _graph_plan().model_copy(update={"relation": "bogus"})
+    # risk has several registered relations; an unregistered one must not be guessed
+    assert sr._graph_hits("q", plan, _req()) is None
+    # a kind with exactly one relation takes it even when the plan names another
+    ex.resolutions = {"cloud mitigation": [("mitigation", "m1")]}
+    resp = sr._graph_hits("q", plan, _req())
+    assert resp is not None and resp.config["relation"] == "treats"
+
+
+def test_graph_hits_empty_join_returns_none(monkeypatch):
+    import harness.showroom as sr
+    ex = _FakeExecutor({"cloud mitigation": [("mitigation", "m1")]}, docs=())
+    _graph_env(monkeypatch, ex)
+    assert sr._graph_hits("q", _graph_plan(), _req()) is None
+
+
 def test_sitting_flow_start_answer_verdict_export(tmp_path):
     client, _ = _client(tmp_path)
     sid = client.post("/api/session/start", json={"author": "Ben"}).json()["sitting_id"]
diff --git a/web/src/components/WorkingPanel.tsx b/web/src/components/WorkingPanel.tsx
index 82c3bff..1c61aa8 100644
--- a/web/src/components/WorkingPanel.tsx
+++ b/web/src/components/WorkingPanel.tsx
@@ -36,10 +36,17 @@ export default function WorkingPanel({ exchange }: { exchange: Exchange }) {
           <Row k="plan.reasoning" v={meta.plan.reasoning} />
         </>
       )}
-      <Row
-        k="search"
-        v={`alpha ${String(cfg.alpha)} · fetch ${String(cfg.fetch_k)} · ${String(cfg.embedder)}`}
-      />
+      {cfg.route_executed === "graph" ? (
+        <Row
+          k="executed as"
+          v={`a join · ${String(cfg.resolved)} → ${String(cfg.relation)}`}
+        />
+      ) : (
+        <Row
+          k="search"
+          v={`alpha ${String(cfg.alpha)} · fetch ${String(cfg.fetch_k)} · ${String(cfg.embedder)}`}
+        />
+      )}
       {typeof cfg.degraded === "string" && (
         <Row k="degraded" v={cfg.degraded} cls="bad" />
       )}

```

## Patch B

```diff
diff --git a/src/harness/serve.py b/src/harness/serve.py
index 671c97c..13f8fd9 100644
--- a/src/harness/serve.py
+++ b/src/harness/serve.py
@@ -17,19 +17,11 @@ from fastapi.responses import HTMLResponse
 from fastapi.staticfiles import StaticFiles
 
 from .db import chunk_table, connect, list_indexes
-from .graph_exec import TRAVERSALS, GraphExecutor
+from .graph_exec import TRAVERSALS
 from .models import GraphPanel, SearchHit, SearchRequest, SearchResponse
 from .ports import QueryContext
 from .retriever_pg import PgRetriever
-from .showroom import build_router
-
-_executors: dict[str, GraphExecutor] = {}
-
-
-def _executor(index_version: str) -> GraphExecutor:
-    if index_version not in _executors:
-        _executors[index_version] = GraphExecutor(index_version)
-    return _executors[index_version]
+from .showroom import _executor, build_router
 
 
 def _graph_panel(query: str, index_version: str, ctx: QueryContext) -> GraphPanel | None:
diff --git a/src/harness/showroom.py b/src/harness/showroom.py
index 8def6f3..0edab10 100644
--- a/src/harness/showroom.py
+++ b/src/harness/showroom.py
@@ -19,8 +19,12 @@ from fastapi.responses import StreamingResponse
 
 from .answer import REFUSAL, draft_answer, plan_turn
 from .answer_backend import get_backend
-from .models import AnswerRequest, AnswerResult, SearchRequest, SearchResponse
-from .ports import Document
+from .bundle import assemble
+from .db import chunk_table, connect, is_temporal
+from .graph_exec import TRAVERSALS, GraphExecutor
+from .models import (AnswerRequest, AnswerResult, RetrievalPlan, SearchHit,
+                     SearchRequest, SearchResponse)
+from .ports import Document, Hit, QueryContext
 from .session import Sitting, export_sitting
 
 ROOT = Path(__file__).resolve().parents[2]
@@ -28,6 +32,93 @@ ARTIFACTS = ROOT / "artifacts"
 SITTINGS = ROOT / "sittings"
 
 
+_executors: dict[str, GraphExecutor] = {}
+
+
+def _executor(index_version: str) -> GraphExecutor:
+    if index_version not in _executors:
+        _executors[index_version] = GraphExecutor(index_version)
+    return _executors[index_version]
+
+
+def _graph_hits(question: str, plan: RetrievalPlan,
+                req: AnswerRequest) -> SearchResponse | None:
+    """Execute a graph-routed turn as a join, or return None (text retrieval).
+
+    Fail closed: runs only when exactly one entity resolves (seed_entity, then
+    the standalone query, then the raw question; the first source that
+    resolves anything decides) and the entity's kind has a registered
+    relation: the plan's, else the kind's only one. Never guesses either."""
+    t0 = time.perf_counter()
+    ex = _executor(req.index_version)
+    seeds: list[tuple[str, str]] = []
+    for source in (plan.seed_entity, plan.standalone_query, question):
+        if source and source.strip():
+            seeds = ex.resolve(source)
+            if seeds:
+                break
+    if len(seeds) != 1:
+        return None
+    kind, eid = seeds[0]
+    registered = [r for (k, r) in TRAVERSALS if k == kind]
+    if plan.relation and plan.relation in registered:
+        relation = plan.relation
+    elif len(registered) == 1:
+        relation = registered[0]
+    else:
+        return None
+
+    ctx = QueryContext(can_see_privileged=req.can_see_privileged,
+                       as_known_at=req.as_known_at,
+                       temporal_mode=req.temporal_mode)
+    docs = ex.execute(seeds, relation, ctx)   # door-filtered
+    if not docs:
+        return None
+
+    temporal = is_temporal(req.index_version)
+    params: list = [docs]
+    if temporal:
+        time_pred = "validity @> %s::timestamptz" if ctx.as_known_at else "validity @> now()"
+        if ctx.as_known_at:
+            params.append(ctx.as_known_at)
+    else:
+        time_pred = "true"
+    with connect("harness") as conn:
+        rows = conn.execute(
+            f"""SELECT DISTINCT ON (doc_id) chunk_id, doc_id, subject_type,
+                       title, content, eligibility, is_privileged, subject_version
+                FROM {chunk_table(req.index_version)}
+                WHERE doc_id = ANY(%s) AND {time_pred} AND eligibility = 'eligible'
+                ORDER BY doc_id, chunk_index""", params).fetchall()
+    by_doc = {r[1]: r for r in rows}
+    hits: list[SearchHit] = []
+    for doc in docs:
+        r = by_doc.get(doc)
+        if r is None:
+            continue
+        hits.append(SearchHit(
+            doc_id=r[1], chunk_id=r[0], subject_type=r[2], score=1.0,
+            title=r[3], content=r[4][:600], eligibility=r[5],
+            is_privileged=r[6], version=r[7] if temporal else None))
+    if not hits:
+        return None
+
+    bundles, bstats = assemble(
+        [Hit(doc_id=h.doc_id, chunk_id=h.chunk_id, subject_type=h.subject_type,
+             score=h.score, eligibility=h.eligibility,
+             is_privileged=h.is_privileged) for h in hits],
+        ctx, req.index_version,
+        {"hop_decay": 0.5, "max_members": 6, "budget_words": 700})
+    return SearchResponse(
+        hits=hits, bundles=bundles, graph=None,
+        latency_ms=round((time.perf_counter() - t0) * 1000, 1),
+        config={"route_executed": "graph", "resolved": f"{kind}:{eid}",
+                "relation": relation, "calibration": "unbound"},
+        answerability=None, refused=False,
+        door={"bundle_blocked": bstats["blocked"],
+              "bundle_violations": len(bstats["violations"])})
+
+
 def _sse(event: str, data: dict) -> str:
     return f"event: {event}\ndata: {json.dumps(data)}\n\n"
 
@@ -63,7 +154,11 @@ def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
                     "query": plan.standalone_query.strip(),
                     "filters": plan.filters or {}})
             sreq = sreq.model_copy(update={"bundles": True})
-            resp = await run_in_threadpool(search_fn, sreq)
+            resp = None
+            if plan and plan.route == "graph":
+                resp = await run_in_threadpool(_graph_hits, req.query, plan, req)
+            if resp is None:
+                resp = await run_in_threadpool(search_fn, sreq)
             meta = resp.model_dump()
             if plan:
                 meta["plan"] = plan.model_dump()
diff --git a/tests/test_showroom_api.py b/tests/test_showroom_api.py
index 5cb5cf9..c531506 100644
--- a/tests/test_showroom_api.py
+++ b/tests/test_showroom_api.py
@@ -3,7 +3,8 @@ import json
 from fastapi import FastAPI
 from fastapi.testclient import TestClient
 
-from harness.models import RetrievalPlan, SearchHit, SearchRequest, SearchResponse
+from harness.models import (AnswerRequest, RetrievalPlan, SearchHit, SearchRequest,
+                            SearchResponse)
 from harness.showroom import build_router
 
 
@@ -79,6 +80,85 @@ def test_answer_plans_conversational_turns(tmp_path, monkeypatch):
     assert fake.calls[0].query == "frankfurt redundancy matter status"
 
 
+def _graph_plan(**kw) -> RetrievalPlan:
+    base = dict(standalone_query="which matters does risk r1 sit in", route="graph",
+                seed_entity="risk r1 cloud processor", relation="matter")
+    base.update(kw)
+    return RetrievalPlan(**base)
+
+
+def _graph_response() -> SearchResponse:
+    hit = SearchHit(doc_id="m1", chunk_id="c9", subject_type="matter", score=1.0,
+                    title="Frankfurt matter", content="Body.",
+                    eligibility="eligible", is_privileged=False)
+    return SearchResponse(hits=[hit], latency_ms=1.0, refused=False,
+                          config={"route_executed": "graph", "resolved": "risk:r1",
+                                  "relation": "matter", "calibration": "unbound"})
+
+
+def test_graph_route_joined_skips_text_search(tmp_path, monkeypatch):
+    import harness.showroom as sr
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: _graph_plan())
+    monkeypatch.setattr(sr, "_graph_hits", lambda q, p, r: _graph_response())
+    client, fake = _client(tmp_path)
+    ev = _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "x"}])).text)
+    assert fake.calls == []
+    assert ev["meta"]["config"]["route_executed"] == "graph"
+    assert ev["final"]["answer"]["citations"] == {"m1": "m1"}
+
+
+def test_graph_route_unresolved_falls_back_to_text(tmp_path, monkeypatch):
+    import harness.showroom as sr
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: _graph_plan())
+    monkeypatch.setattr(sr, "_graph_hits", lambda q, p, r: None)
+    client, fake = _client(tmp_path)
+    ev = _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "x"}])).text)
+    assert len(fake.calls) == 1
+    assert "route_executed" not in ev["meta"]["config"]
+
+
+class _FakeExecutor:
+    def __init__(self, resolved, docs=("m1",)):
+        self.resolved, self.docs = resolved, list(docs)
+        self.seen: list[str] = []
+
+    def resolve(self, text):
+        self.seen.append(text)
+        return self.resolved.get(text, [])
+
+    def execute(self, seeds, relation, ctx):
+        return self.docs
+
+
+def _req() -> AnswerRequest:
+    return AnswerRequest(query="raw question", index_version="iv1")
+
+
+def test_graph_hits_fails_closed_on_ambiguity_and_missing_relation(monkeypatch):
+    import harness.showroom as sr
+    plan = _graph_plan(seed_entity="a")
+    for resolved in ({"a": [("risk", "r1"), ("risk", "r2")]}, {}):
+        monkeypatch.setattr(sr, "_executor", lambda iv, r=resolved: _FakeExecutor(r))
+        assert sr._graph_hits("raw question", plan, _req()) is None
+    # risk has several relations; an unregistered plan relation must not be guessed
+    monkeypatch.setattr(sr, "_executor",
+                        lambda iv: _FakeExecutor({"a": [("risk", "r1")]}))
+    assert sr._graph_hits("raw question", _graph_plan(seed_entity="a", relation="nope"),
+                          _req()) is None
+    assert sr._graph_hits("raw question", _graph_plan(seed_entity="a", relation=None),
+                          _req()) is None
+
+
+def test_graph_hits_entity_fallback_order_and_empty_join(monkeypatch):
+    import harness.showroom as sr
+    ex = _FakeExecutor({"raw question": [("risk", "r1")]}, docs=[])
+    monkeypatch.setattr(sr, "_executor", lambda iv: ex)
+    assert sr._graph_hits("raw question", _graph_plan(seed_entity="zzz"), _req()) is None
+    assert ex.seen == ["zzz", "which matters does risk r1 sit in", "raw question"]
+
+
 def test_sitting_flow_start_answer_verdict_export(tmp_path):
     client, _ = _client(tmp_path)
     sid = client.post("/api/session/start", json={"author": "Ben"}).json()["sitting_id"]
diff --git a/web/src/components/WorkingPanel.tsx b/web/src/components/WorkingPanel.tsx
index 82c3bff..c7f5e5b 100644
--- a/web/src/components/WorkingPanel.tsx
+++ b/web/src/components/WorkingPanel.tsx
@@ -36,10 +36,18 @@ export default function WorkingPanel({ exchange }: { exchange: Exchange }) {
           <Row k="plan.reasoning" v={meta.plan.reasoning} />
         </>
       )}
-      <Row
-        k="search"
-        v={`alpha ${String(cfg.alpha)} · fetch ${String(cfg.fetch_k)} · ${String(cfg.embedder)}`}
-      />
+      {cfg.route_executed === "graph" && (
+        <Row
+          k="executed as"
+          v={`a join · ${String(cfg.resolved)} → ${String(cfg.relation)}`}
+        />
+      )}
+      {cfg.route_executed !== "graph" && (
+        <Row
+          k="search"
+          v={`alpha ${String(cfg.alpha)} · fetch ${String(cfg.fetch_k)} · ${String(cfg.embedder)}`}
+        />
+      )}
       {typeof cfg.degraded === "string" && (
         <Row k="degraded" v={cfg.degraded} cls="bad" />
       )}

```
