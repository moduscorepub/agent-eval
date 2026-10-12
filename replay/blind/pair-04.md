# Pair 04 (retrieval-harness-894da0d0)

Which patch would you merge? Answer in answers.md as `04: A`, `04: B`, or `04: =` if you cannot tell.

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
diff --git a/src/harness/graph_exec.py b/src/harness/graph_exec.py
index 70917b4..6327a4d 100644
--- a/src/harness/graph_exec.py
+++ b/src/harness/graph_exec.py
@@ -169,3 +169,13 @@ class GraphExecutor:
                 if doc not in out:
                     out.append(doc)
         return self.door_filter(out, context)
+
+
+_executors: dict[str, GraphExecutor] = {}
+
+
+def executor_for(index_version: str) -> GraphExecutor:
+    """One executor per index per process; building one scans the registry."""
+    if index_version not in _executors:
+        _executors[index_version] = GraphExecutor(index_version)
+    return _executors[index_version]
diff --git a/src/harness/serve.py b/src/harness/serve.py
index 671c97c..1226999 100644
--- a/src/harness/serve.py
+++ b/src/harness/serve.py
@@ -17,20 +17,12 @@ from fastapi.responses import HTMLResponse
 from fastapi.staticfiles import StaticFiles
 
 from .db import chunk_table, connect, list_indexes
-from .graph_exec import TRAVERSALS, GraphExecutor
+from .graph_exec import TRAVERSALS, executor_for as _executor
 from .models import GraphPanel, SearchHit, SearchRequest, SearchResponse
 from .ports import QueryContext
 from .retriever_pg import PgRetriever
 from .showroom import build_router
 
-_executors: dict[str, GraphExecutor] = {}
-
-
-def _executor(index_version: str) -> GraphExecutor:
-    if index_version not in _executors:
-        _executors[index_version] = GraphExecutor(index_version)
-    return _executors[index_version]
-
 
 def _graph_panel(query: str, index_version: str, ctx: QueryContext) -> GraphPanel | None:
     ex = _executor(index_version)
diff --git a/src/harness/showroom.py b/src/harness/showroom.py
index 8def6f3..4bd7bb6 100644
--- a/src/harness/showroom.py
+++ b/src/harness/showroom.py
@@ -19,8 +19,13 @@ from fastapi.responses import StreamingResponse
 
 from .answer import REFUSAL, draft_answer, plan_turn
 from .answer_backend import get_backend
-from .models import AnswerRequest, AnswerResult, SearchRequest, SearchResponse
-from .ports import Document
+from .db import chunk_table, connect, is_temporal
+from .door import door_where
+from .graph_exec import TRAVERSALS
+from .graph_exec import executor_for as _executor
+from .models import (AnswerRequest, AnswerResult, RetrievalPlan, SearchHit,
+                     SearchRequest, SearchResponse)
+from .ports import Document, Hit, QueryContext
 from .session import Sitting, export_sitting
 
 ROOT = Path(__file__).resolve().parents[2]
@@ -45,6 +50,81 @@ def write_bait_manifest(docs: list[Document], path: Path) -> int:
     return len(bait)
 
 
+def _graph_hits(question: str, plan: RetrievalPlan,
+                req: AnswerRequest) -> SearchResponse | None:
+    """Execute a graph-routed plan as a join, or return None to fall back.
+
+    Fail-closed: the join runs only when exactly one entity resolves (from
+    the plan's seed_entity, else standalone_query, else the raw question; the
+    first non-empty resolution decides) and exactly one traversal relation is
+    determined for that entity kind. Join output passes the door (privilege,
+    eligibility, as_known_at, temporal mode) in the executor and again when
+    chunks are fetched; bundles apply it per member."""
+    t0 = time.perf_counter()
+    ex = _executor(req.index_version)
+    seeds: list[tuple[str, str]] = []
+    for text in (plan.seed_entity, plan.standalone_query, question):
+        if text and text.strip():
+            seeds = ex.resolve(text)
+            if seeds:
+                break
+    if len(seeds) != 1:
+        return None
+    kind, eid = seeds[0]
+    registered = [rel for k, rel in TRAVERSALS if k == kind]
+    if plan.relation and plan.relation in registered:
+        relation = plan.relation
+    elif len(registered) == 1:
+        relation = registered[0]
+    else:
+        return None
+    ctx = QueryContext(can_see_privileged=req.can_see_privileged,
+                       as_known_at=req.as_known_at,
+                       temporal_mode=req.temporal_mode)
+    docs = ex.execute(seeds, relation, ctx)
+    if not docs:
+        return None
+    temporal = is_temporal(req.index_version)
+    where, params = door_where(ctx, temporal)
+    with connect("harness") as conn:
+        rows = conn.execute(
+            f"""SELECT DISTINCT ON (doc_id) doc_id, chunk_id, subject_type, title,
+                       content, subject_version, eligibility, is_privileged
+                FROM {chunk_table(req.index_version)}
+                WHERE doc_id = ANY(%s) AND {where}
+                ORDER BY doc_id, chunk_index""",
+            [docs, *params]).fetchall()
+    by_doc = {r[0]: r for r in rows if r[6] == "eligible"}
+    hits: list[SearchHit] = []
+    seeds_for_bundles: list[Hit] = []
+    for d in docs:
+        r = by_doc.get(d)
+        if r is None:
+            continue
+        hits.append(SearchHit(
+            doc_id=r[0], chunk_id=r[1], subject_type=r[2], score=1.0,
+            title=r[3], content=r[4][:600], eligibility="eligible",
+            is_privileged=bool(r[7]),
+            version=r[5] if temporal else None))
+        seeds_for_bundles.append(Hit(
+            doc_id=r[0], chunk_id=r[1], subject_type=r[2], score=1.0,
+            eligibility="eligible", is_privileged=bool(r[7])))
+    if not hits:
+        return None
+    from .bundle import assemble
+    bundles, bstats = assemble(seeds_for_bundles, ctx, req.index_version,
+                               {"hop_decay": 0.5, "max_members": 6,
+                                "budget_words": 700})
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
 def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
                  sittings_root: Path | None = None) -> APIRouter:
     router = APIRouter()
@@ -63,7 +143,11 @@ def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
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
@@ -164,9 +248,6 @@ def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
             out = json.loads(bait.read_text())
         if index_version:
             # browsable eligible cards, served through the door like anything else
-            from .db import chunk_table, connect, is_temporal
-            from .door import door_where
-            from .ports import QueryContext
             where, params = door_where(QueryContext(), is_temporal(index_version))
             with connect("harness") as conn:
                 rows = conn.execute(
diff --git a/tests/test_showroom_api.py b/tests/test_showroom_api.py
index 5cb5cf9..66578b4 100644
--- a/tests/test_showroom_api.py
+++ b/tests/test_showroom_api.py
@@ -3,7 +3,7 @@ import json
 from fastapi import FastAPI
 from fastapi.testclient import TestClient
 
-from harness.models import RetrievalPlan, SearchHit, SearchRequest, SearchResponse
+from harness.models import AnswerRequest, RetrievalPlan, SearchHit, SearchRequest, SearchResponse
 from harness.showroom import build_router
 
 
@@ -120,3 +120,93 @@ def test_gates_corpus_timeline_endpoints_answer(tmp_path):
     assert "bait" in client.get("/api/corpus").json()
     tl = client.get("/api/timeline").json()
     assert "weeks" in tl or "note" in tl
+
+
+def _graph_plan(**kw) -> RetrievalPlan:
+    base = {"standalone_query": "which risks does the backup mitigation treat",
+            "route": "graph", "seed_entity": "backup mitigation"}
+    base.update(kw)
+    return RetrievalPlan(**base)
+
+
+def test_graph_route_skips_text_search_when_join_answers(tmp_path, monkeypatch):
+    import harness.showroom as sr
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: _graph_plan())
+    joined = SearchResponse(
+        hits=[SearchHit(doc_id="r1", chunk_id="c1", subject_type="risk", score=1.0,
+                        title="Cloud processor risk", content="Body.",
+                        eligibility="eligible", is_privileged=False)],
+        latency_ms=1.0, answerability=None, refused=False,
+        config={"route_executed": "graph", "resolved": "mitigation:m1",
+                "relation": "treats", "calibration": "unbound"})
+    monkeypatch.setattr(sr, "_graph_hits", lambda q, p, r: joined)
+    client, fake = _client(tmp_path)
+    ev = _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "hi"}])).text)
+    assert fake.calls == []
+    assert ev["meta"]["config"]["route_executed"] == "graph"
+    assert ev["final"]["answer"]["status"] == "answered"
+
+
+def test_graph_route_falls_back_to_text_search(tmp_path, monkeypatch):
+    import harness.showroom as sr
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: _graph_plan())
+    monkeypatch.setattr(sr, "_graph_hits", lambda q, p, r: None)
+    client, fake = _client(tmp_path)
+    ev = _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "hi"}])).text)
+    assert len(fake.calls) == 1
+    assert "route_executed" not in ev["meta"]["config"]
+
+
+class _FakeExecutor:
+    def __init__(self, resolutions: dict[str, list[tuple[str, str]]]):
+        self.resolutions = resolutions
+        self.executed: list = []
+
+    def resolve(self, text: str):
+        return self.resolutions.get(text, [])
+
+    def execute(self, seeds, relation, ctx):
+        self.executed.append((seeds, relation))
+        return []   # empty join: caller must fall back without touching the db
+
+
+def _join(monkeypatch, resolutions, plan):
+    import harness.showroom as sr
+    ex = _FakeExecutor(resolutions)
+    monkeypatch.setattr(sr, "_executor", lambda iv: ex)
+    req = AnswerRequest(query="raw question", index_version="iv1")
+    assert sr._graph_hits("raw question", plan, req) is None
+    return ex
+
+
+def test_graph_hits_resolution_and_relation_rules(monkeypatch):
+    m1 = [("mitigation", "m1")]
+    # seed_entity wins; plan relation honored when registered for the kind
+    ex = _join(monkeypatch, {"backup mitigation": m1},
+               _graph_plan(relation="treats"))
+    assert ex.executed == [(m1, "treats")]
+    # unregistered plan relation: the kind's only relation is used
+    ex = _join(monkeypatch, {"backup mitigation": m1},
+               _graph_plan(relation="bogus"))
+    assert ex.executed == [(m1, "treats")]
+    # falls through to standalone_query, then the raw question
+    ex = _join(monkeypatch, {_graph_plan().standalone_query: m1}, _graph_plan())
+    assert ex.executed == [(m1, "treats")]
+    ex = _join(monkeypatch, {"raw question": m1}, _graph_plan())
+    assert ex.executed == [(m1, "treats")]
+
+
+def test_graph_hits_fails_closed_on_ambiguity(monkeypatch):
+    # several entities: no join
+    ex = _join(monkeypatch, {"backup mitigation": [("mitigation", "m1"),
+                                                   ("mitigation", "m2")]},
+               _graph_plan(relation="treats"))
+    assert ex.executed == []
+    # nothing resolves: no join
+    assert _join(monkeypatch, {}, _graph_plan()).executed == []
+    # several registered relations and none named: no guessing
+    ex = _join(monkeypatch, {"backup mitigation": [("risk", "r1")]},
+               _graph_plan(relation=None))
+    assert ex.executed == []
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
