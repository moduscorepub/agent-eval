# Pair 13 (retrieval-harness-894da0d0)

Which patch would you merge? Answer in answers.md as `13: A`, `13: B`, or `13: =` if you cannot tell.

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
index 8def6f3..2f12900 100644
--- a/src/harness/showroom.py
+++ b/src/harness/showroom.py
@@ -19,8 +19,19 @@ from fastapi.responses import StreamingResponse
 
 from .answer import REFUSAL, draft_answer, plan_turn
 from .answer_backend import get_backend
-from .models import AnswerRequest, AnswerResult, SearchRequest, SearchResponse
-from .ports import Document
+from .db import chunk_table, connect, is_temporal
+from .door import door_where
+from .graph_exec import TRAVERSALS, GraphExecutor
+from .models import (
+    AnswerRequest,
+    AnswerResult,
+    RetrievalPlan,
+    SearchHit,
+    SearchRequest,
+    SearchResponse,
+)
+from .ports import Document, QueryContext
+from .ports import Hit as PortHit
 from .session import Sitting, export_sitting
 
 ROOT = Path(__file__).resolve().parents[2]
@@ -28,6 +39,92 @@ ARTIFACTS = ROOT / "artifacts"
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
+def _resolve_seed(ex: GraphExecutor, question: str,
+                  plan: RetrievalPlan) -> tuple[str, str] | None:
+    """The first non-empty text that resolves anything decides. Exactly one
+    entity qualifies; several is ambiguity and fails closed, never a guess."""
+    for text in (plan.seed_entity, plan.standalone_query, question):
+        if not text or not text.strip():
+            continue
+        found = ex.resolve(text)
+        if found:
+            return found[0] if len(found) == 1 else None
+    return None
+
+
+def _pick_relation(kind: str, wanted: str | None) -> str | None:
+    registered = [rel for (k, rel) in TRAVERSALS if k == kind]
+    if wanted in registered:
+        return wanted
+    return registered[0] if len(registered) == 1 else None
+
+
+def _graph_hits(question: str, plan: RetrievalPlan,
+                req: AnswerRequest) -> SearchResponse | None:
+    """Run a graph-routed turn as a join. None means the caller must run the
+    text arm: no unique entity, no unambiguous relation, or an empty join.
+    Joined docs pass the same door as any retrieval hit (eligibility,
+    privilege, validity at as_known_at, temporal mode)."""
+    t0 = time.perf_counter()
+    ex = _executor(req.index_version)
+    seed = _resolve_seed(ex, question, plan)
+    if seed is None:
+        return None
+    kind, eid = seed
+    relation = _pick_relation(kind, plan.relation)
+    if relation is None:
+        return None
+    ctx = QueryContext(can_see_privileged=req.can_see_privileged,
+                       as_known_at=req.as_known_at,
+                       temporal_mode=req.temporal_mode)
+    docs = ex.execute([seed], relation, ctx)
+    if not docs:
+        return None
+    temporal = is_temporal(req.index_version)
+    where, params = door_where(ctx, temporal)
+    with connect("harness") as conn:
+        rows = conn.execute(
+            f"""SELECT DISTINCT ON (doc_id) doc_id, chunk_id, subject_type, title,
+                       content, eligibility, is_privileged, subject_version
+                FROM {chunk_table(req.index_version)}
+                WHERE {where} AND doc_id = ANY(%s)
+                ORDER BY doc_id, chunk_index""",
+            [*params, docs]).fetchall()
+    by_doc = {r[0]: r for r in rows}
+    ordered = [by_doc[d] for d in docs if d in by_doc]
+    if not ordered:
+        return None
+    hits = [SearchHit(doc_id=r[0], chunk_id=r[1], subject_type=r[2], score=1.0,
+                      title=r[3], content=r[4][:600], eligibility=r[5],
+                      is_privileged=r[6], version=r[7] if temporal else None)
+            for r in ordered[:req.top_k]]
+    from .bundle import assemble
+    bundles, bstats = assemble(
+        [PortHit(doc_id=h.doc_id, chunk_id=h.chunk_id, subject_type=h.subject_type,
+                 score=h.score, eligibility=h.eligibility,
+                 is_privileged=h.is_privileged) for h in hits],
+        ctx, req.index_version,
+        {"hop_decay": 0.5, "max_members": 6, "budget_words": 700})
+    config = {"route_executed": "graph", "resolved": f"{kind}:{eid}",
+              "relation": relation, "calibration": "unbound",
+              "joined": len(ordered)}
+    return SearchResponse(
+        hits=hits, bundles=bundles, graph=None,
+        latency_ms=round((time.perf_counter() - t0) * 1000, 1), config=config,
+        answerability=None, refused=False,
+        door={"bundle_blocked": bstats["blocked"],
+              "bundle_violations": len(bstats["violations"])})
+
+
 def _sse(event: str, data: dict) -> str:
     return f"event: {event}\ndata: {json.dumps(data)}\n\n"
 
@@ -63,7 +160,11 @@ def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
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
index 5cb5cf9..7dca7eb 100644
--- a/tests/test_showroom_api.py
+++ b/tests/test_showroom_api.py
@@ -79,6 +79,100 @@ def test_answer_plans_conversational_turns(tmp_path, monkeypatch):
     assert fake.calls[0].query == "frankfurt redundancy matter status"
 
 
+class _FakeExec:
+    """Stands in for GraphExecutor: resolve by substring, door-filter nothing."""
+    def __init__(self, entities: dict[str, list[tuple[str, str]]], docs: list[str]):
+        self.entities, self.docs = entities, docs
+        self.executed: list[tuple] = []
+
+    def resolve(self, text):
+        for needle, found in self.entities.items():
+            if needle in text:
+                return found
+        return []
+
+    def execute(self, seeds, relation, context):
+        self.executed.append((seeds, relation))
+        return self.docs
+
+
+class _FakeConn:
+    def __init__(self, rows):
+        self.rows = rows
+
+    def __enter__(self):
+        return self
+
+    def __exit__(self, *a):
+        return False
+
+    def execute(self, sql, params):
+        assert "eligibility = 'eligible'" in sql   # the door is in the join's SQL
+        return self
+
+    def fetchall(self):
+        return self.rows
+
+
+def _graph_client(tmp_path, monkeypatch, ex, plan):
+    import harness.bundle as bundle
+    import harness.showroom as sr
+    rows = [("m1", "c-m1", "matter", "Matter one", "Body.", "eligible", False, 1)]
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: plan)
+    monkeypatch.setattr(sr, "_executor", lambda iv: ex)
+    monkeypatch.setattr(sr, "is_temporal", lambda iv: False)
+    monkeypatch.setattr(sr, "connect", lambda name: _FakeConn(rows))
+    monkeypatch.setattr(bundle, "assemble",
+                        lambda hits, ctx, iv, knobs: ([], {"blocked": 0, "violations": []}))
+    return _client(tmp_path)
+
+
+def _graph_plan(**kw):
+    return RetrievalPlan(standalone_query="which matters does risk alpha touch",
+                         route="graph", **kw)
+
+
+def _ask_graph(client):
+    return _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "hi"}])).text)
+
+
+def test_graph_route_executes_join_and_skips_text_arm(tmp_path, monkeypatch):
+    ex = _FakeExec({"risk alpha": [("risk", "r1")]}, ["m1"])
+    client, fake = _graph_client(tmp_path, monkeypatch, ex, _graph_plan(relation="matter"))
+    ev = _ask_graph(client)
+    assert fake.calls == []
+    assert ex.executed == [([("risk", "r1")], "matter")]
+    cfg = ev["meta"]["config"]
+    assert (cfg["route_executed"], cfg["resolved"], cfg["relation"], cfg["calibration"]) \
+        == ("graph", "risk:r1", "matter", "unbound")
+    assert [h["eligibility"] for h in ev["meta"]["hits"]] == ["eligible"]
+    assert ev["final"]["answer"]["status"] in ("answered", "withdrawn")
+
+
+def test_graph_route_uses_the_only_registered_relation(tmp_path, monkeypatch):
+    ex = _FakeExec({"risk alpha": [("mitigation", "x1")]}, ["m1"])
+    client, fake = _graph_client(tmp_path, monkeypatch, ex, _graph_plan(relation="bogus"))
+    ev = _ask_graph(client)
+    assert fake.calls == [] and ev["meta"]["config"]["relation"] == "treats"
+
+
+def test_graph_route_falls_closed_to_text(tmp_path, monkeypatch):
+    cases = [
+        ({"risk alpha": [("risk", "r1"), ("risk", "r2")]}, ["m1"], "matter"),  # several
+        ({}, ["m1"], "matter"),                                                # zero
+        ({"risk alpha": [("risk", "r1")]}, ["m1"], "bogus"),     # relation ambiguous
+        ({"risk alpha": [("risk", "r1")]}, [], "matter"),                      # empty join
+    ]
+    for entities, docs, relation in cases:
+        ex = _FakeExec(entities, docs)
+        client, fake = _graph_client(tmp_path, monkeypatch, ex,
+                                     _graph_plan(relation=relation))
+        ev = _ask_graph(client)
+        assert len(fake.calls) == 1
+        assert "route_executed" not in ev["meta"]["config"]
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
diff --git a/src/harness/graph_exec.py b/src/harness/graph_exec.py
index 70917b4..e6dc581 100644
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
+def get_executor(index_version: str) -> GraphExecutor:
+    """One process-wide executor per index; building one scans the registry."""
+    if index_version not in _executors:
+        _executors[index_version] = GraphExecutor(index_version)
+    return _executors[index_version]
diff --git a/src/harness/serve.py b/src/harness/serve.py
index 671c97c..ee40e71 100644
--- a/src/harness/serve.py
+++ b/src/harness/serve.py
@@ -17,23 +17,15 @@ from fastapi.responses import HTMLResponse
 from fastapi.staticfiles import StaticFiles
 
 from .db import chunk_table, connect, list_indexes
-from .graph_exec import TRAVERSALS, GraphExecutor
+from .graph_exec import TRAVERSALS, get_executor
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
-    ex = _executor(index_version)
+    ex = get_executor(index_version)
     seeds = ex.resolve(query)
     if not seeds:
         return None
diff --git a/src/harness/showroom.py b/src/harness/showroom.py
index 8def6f3..e25af16 100644
--- a/src/harness/showroom.py
+++ b/src/harness/showroom.py
@@ -19,8 +19,11 @@ from fastapi.responses import StreamingResponse
 
 from .answer import REFUSAL, draft_answer, plan_turn
 from .answer_backend import get_backend
-from .models import AnswerRequest, AnswerResult, SearchRequest, SearchResponse
-from .ports import Document
+from .db import chunk_table, connect, is_temporal
+from .graph_exec import TRAVERSALS, get_executor as _executor
+from .models import (AnswerRequest, AnswerResult, RetrievalPlan, SearchHit,
+                     SearchRequest, SearchResponse)
+from .ports import Document, Hit, QueryContext
 from .session import Sitting, export_sitting
 
 ROOT = Path(__file__).resolve().parents[2]
@@ -32,6 +35,85 @@ def _sse(event: str, data: dict) -> str:
     return f"event: {event}\ndata: {json.dumps(data)}\n\n"
 
 
+def _graph_relation(kind: str, planned: str | None) -> str | None:
+    """The planned relation if registered for the kind, else the kind's only
+    registered relation; ambiguity returns None (never guess)."""
+    registered = [rel for (k, rel) in TRAVERSALS if k == kind]
+    if planned and planned in registered:
+        return planned
+    return registered[0] if len(registered) == 1 else None
+
+
+def _graph_hits(question: str, plan: RetrievalPlan,
+                req: AnswerRequest) -> SearchResponse | None:
+    """Execute a graph-routed turn as a join, or None to fall back to text
+    retrieval. Runs only when exactly one entity resolves (plan seed_entity,
+    then standalone_query, then the raw question) and a traversal relation is
+    unambiguous for its kind. Join output passes the door twice: the
+    executor's door_filter, then the eligibility read of the chunk rows."""
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
+    relation = _graph_relation(kind, plan.relation)
+    if relation is None:
+        return None
+    ctx = QueryContext(can_see_privileged=req.can_see_privileged,
+                       as_known_at=req.as_known_at,
+                       temporal_mode=req.temporal_mode)
+    doc_ids = ex.execute(seeds, relation, ctx)
+    if not doc_ids:
+        return None
+
+    temporal = is_temporal(req.index_version)
+    params: list = [doc_ids]
+    time_pred = ""
+    if temporal:
+        if ctx.as_known_at:
+            time_pred = " AND validity @> %s::timestamptz"
+            params.append(ctx.as_known_at)
+        else:
+            time_pred = " AND validity @> now()"
+    with connect("harness") as conn:
+        rows = conn.execute(
+            f"""SELECT DISTINCT ON (doc_id) doc_id, chunk_id, subject_type, title,
+                       content, is_privileged, subject_version
+                FROM {chunk_table(req.index_version)}
+                WHERE doc_id = ANY(%s) AND eligibility = 'eligible'{time_pred}
+                ORDER BY doc_id, chunk_index""", params).fetchall()
+    by_doc = {r[0]: r for r in rows}
+    ordered = [by_doc[d] for d in doc_ids if d in by_doc][:req.top_k]
+    if not ordered:
+        return None
+
+    out = [SearchHit(doc_id=r[0], chunk_id=r[1], subject_type=r[2], score=1.0,
+                     title=r[3], content=r[4][:600], eligibility="eligible",
+                     is_privileged=bool(r[5]),
+                     version=r[6] if temporal else None) for r in ordered]
+    from .bundle import assemble
+    bundles, bstats = assemble(
+        [Hit(doc_id=h.doc_id, chunk_id=h.chunk_id, subject_type=h.subject_type,
+             score=h.score, eligibility=h.eligibility,
+             is_privileged=h.is_privileged) for h in out],
+        ctx, req.index_version,
+        {"hop_decay": 0.5, "max_members": 6, "budget_words": 700})
+    return SearchResponse(
+        hits=out, bundles=bundles, graph=None,
+        latency_ms=round((time.perf_counter() - t0) * 1000, 1),
+        config={"route_executed": "graph", "resolved": f"{kind}:{eid}",
+                "relation": relation, "calibration": "unbound"},
+        answerability=None, refused=False,
+        door={"bundle_blocked": bstats["blocked"],
+              "bundle_violations": len(bstats["violations"])})
+
+
 def write_bait_manifest(docs: list[Document], path: Path) -> int:
     """Offline builder for the attack chapter's answer key: which privileged
     and quarantined records exist (titles and classification only). Written
@@ -63,7 +145,12 @@ def build_router(search_fn: Callable[[SearchRequest], SearchResponse],
                     "query": plan.standalone_query.strip(),
                     "filters": plan.filters or {}})
             sreq = sreq.model_copy(update={"bundles": True})
-            resp = await run_in_threadpool(search_fn, sreq)
+            resp = None
+            if plan and plan.route == "graph":
+                resp = await run_in_threadpool(
+                    _graph_hits, req.query, plan, req)
+            if resp is None:
+                resp = await run_in_threadpool(search_fn, sreq)
             meta = resp.model_dump()
             if plan:
                 meta["plan"] = plan.model_dump()
diff --git a/tests/test_showroom_api.py b/tests/test_showroom_api.py
index 5cb5cf9..3547840 100644
--- a/tests/test_showroom_api.py
+++ b/tests/test_showroom_api.py
@@ -79,6 +79,76 @@ def test_answer_plans_conversational_turns(tmp_path, monkeypatch):
     assert fake.calls[0].query == "frankfurt redundancy matter status"
 
 
+def _graph_plan(**kw) -> RetrievalPlan:
+    return RetrievalPlan(standalone_query="which matters does risk r1 own",
+                         route="graph", seed_entity="risk r1 surface",
+                         relation="matter", **kw)
+
+
+def test_graph_route_executes_join_and_skips_text_search(tmp_path, monkeypatch):
+    import harness.showroom as sr
+    joined = SearchResponse(
+        hits=[SearchHit(doc_id="m1", chunk_id="m1c0", subject_type="matter",
+                        score=1.0, title="Matter one", content="Body.",
+                        eligibility="eligible", is_privileged=False)],
+        latency_ms=1.0, config={"route_executed": "graph", "resolved": "risk:r1",
+                                "relation": "matter", "calibration": "unbound"})
+    monkeypatch.setattr(sr, "plan_turn", lambda q, h: _graph_plan())
+    monkeypatch.setattr(sr, "_graph_hits", lambda q, p, r: joined)
+    client, fake = _client(tmp_path)
+    ev = _events(client.post("/api/answer", json=_answer_body(
+        history=[{"role": "user", "text": "x"}])).text)
+    assert fake.calls == []
+    assert ev["meta"]["config"]["route_executed"] == "graph"
+    assert ev["final"]["answer"]["citations"] == {"m1": "m1"}
+
+
+def test_graph_route_falls_back_to_text_search_when_no_join(tmp_path, monkeypatch):
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
+    def __init__(self, by_text):
+        self.by_text = by_text
+
+    def resolve(self, text):
+        return self.by_text.get(text, [])
+
+
+def test_graph_hits_fails_closed_on_ambiguous_entity_or_relation(monkeypatch):
+    import harness.showroom as sr
+    from harness.models import AnswerRequest
+    req = AnswerRequest(query="q", index_version="iv1")
+    plan = RetrievalPlan(standalone_query="sq", route="graph",
+                         seed_entity="seed", relation="nonsense")
+    # several entities: no join
+    monkeypatch.setattr(sr, "_executor", lambda iv: _FakeExecutor(
+        {"seed": [("risk", "r1"), ("risk", "r2")]}))
+    assert sr._graph_hits("q", plan, req) is None
+    # nothing resolves anywhere: no join
+    monkeypatch.setattr(sr, "_executor", lambda iv: _FakeExecutor({}))
+    assert sr._graph_hits("q", plan, req) is None
+    # one risk, unregistered relation, kind has several relations: no join
+    monkeypatch.setattr(sr, "_executor", lambda iv: _FakeExecutor(
+        {"seed": [("risk", "r1")]}))
+    assert sr._graph_hits("q", plan, req) is None
+
+
+def test_graph_relation_prefers_plan_then_sole_relation():
+    import harness.showroom as sr
+    assert sr._graph_relation("risk", "feed") == "feed"
+    assert sr._graph_relation("risk", "bogus") is None
+    assert sr._graph_relation("mitigation", "bogus") == "treats"
+    assert sr._graph_relation("mitigation", None) == "treats"
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
