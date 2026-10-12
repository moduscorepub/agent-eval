# Pair 16 (retrieval-harness-259c0bc0)

Which patch would you merge? Answer in answers.md as `16: A`, `16: B`, or `16: =` if you cannot tell.

## Issue

Add opt-in "shield" mode so records excluded or archived later don't appear in as-of answers

As-of (temporal) retrieval currently shows records that were eligible at the requested date even if they have since been archived or excluded from retrieval. A written policy and the code disagreed on whether this is correct, and the ruling is pending from the policy owners. We need both behaviors available, with the current behavior remaining the default until a ruling is made.

Add a deployment setting, `DOOR_RETRO_ELIGIBILITY`. When it is unset (or any value other than `shield`), nothing changes. A record eligible at time T is returned for an as-of-T query even if it has since been archived or excluded.

When `DOOR_RETRO_ELIGIBILITY=shield`, a non-audit temporal query must not return any record that is currently not eligible, whatever its eligibility was at T. This must apply consistently at the main retrieval door, at the per-member check inside evidence bundles, and at the graph join door. For graph joins, a doc is dropped if any of its rows is currently ineligible. Audit mode (`temporal_mode="audit"`) is unaffected by the setting and still shows the record's own state at T. Non-temporal indexes are also unaffected.

To support this, temporal chunk rows must record whether the document is eligible in its latest state, as a new boolean `currently_eligible` column that defaults to true. Temporal indexing (`PgRetriever.index_temporal`) takes interval entries of `(Document, valid_from, valid_to_or_None, currently_privileged, currently_eligible)`. The history simulation must supply the new field, derived from the document's final eligibility state. The per-member check `_member_door_ok` in `bundle.py` gains a `currently_eligible: bool` parameter, placed after `currently_privileged` and before `context`.

Add a one-page policy document for the decision-makers. It should explain Policy A (current default) and Policy B (shield), include an example, and state the switch. Existing temporal indexes must be rebuilt to get the new column.

## Patch A

```diff
diff --git a/README.md b/README.md
index 29360bd..f93fc12 100644
--- a/README.md
+++ b/README.md
@@ -82,8 +82,11 @@ The standing contract with per-phase gates and as-built status lives in
   matters doubly here because the door always filters and temporal queries
   add a second predicate.
 - The temporal columns are the fourth seam's reference implementation:
-  validity tstzranges, currently_privileged, the disclosure-safe/audit
-  policy in `_filters`.
+  validity tstzranges, currently_privileged, currently_eligible, the
+  disclosure-safe/audit policy in `_filters`. `DOOR_RETRO_ELIGIBILITY=shield`
+  hides records ineligible now from non-audit as-of answers (default off;
+  see `docs/POLICY-retro-eligibility.md`; rebuild temporal indexes to get
+  `currently_eligible`).
 - The calibration artifact, champion configs and analyst proposals promote
   through ai_configs and the agent_runs/agent_findings quarantine flow.
 - Per-epoch embedding identity ships in index_registry.
diff --git a/docs/POLICY-retro-eligibility.md b/docs/POLICY-retro-eligibility.md
new file mode 100644
index 0000000..9ca804b
--- /dev/null
+++ b/docs/POLICY-retro-eligibility.md
@@ -0,0 +1,63 @@
+# Decision needed: should as-of answers show records archived or excluded later?
+
+**Audience:** policy owners. **Status:** ruling pending. **Default until ruled:** Policy A.
+
+## The question
+
+A user asks "what did we know on date T?" A record was eligible for retrieval
+on T, but has since been archived or excluded from retrieval. Do we show it?
+
+## Policy A: history as it stood (current default)
+
+A record that was eligible at T is returned for an as-of-T query, even if it
+has since been archived or excluded. Only its state at T decides.
+
+- Pro: the answer matches what the organisation could have retrieved on T.
+- Con: a record we have deliberately withdrawn from retrieval can still
+  surface through a dated question.
+
+## Policy B: shield
+
+A non-audit as-of query never returns a record that is **not eligible now**,
+whatever its state was at T.
+
+- Pro: withdrawing a record from retrieval withdraws it from every
+  non-audit answer, dated or not.
+- Con: as-of answers can omit records that really were live on T.
+
+Both policies apply at all three doors: main retrieval, the per-member check
+inside evidence bundles, and graph joins. For a graph join, a document is
+dropped if any of its rows is currently ineligible.
+
+Unchanged under both policies: audit mode (`temporal_mode="audit"`) still shows
+the record's own state at T; non-temporal (current-state) indexes are not
+affected.
+
+## Example
+
+Record R is eligible from 1 March. It is excluded from retrieval on 1 June.
+A user asks on 1 July: "what did we know on 15 March?"
+
+| Policy | R returned? |
+| --- | --- |
+| A (default) | Yes. R was eligible on 15 March. |
+| B (shield) | No. R is excluded now. |
+| Either, audit mode | Yes. Audit shows R's own state on 15 March. |
+
+## The switch
+
+Deployment setting `DOOR_RETRO_ELIGIBILITY`:
+
+- unset, or any value other than `shield`: Policy A.
+- `shield`: Policy B.
+
+The setting is read per query. It needs no rebuild once the index has the
+column below.
+
+## Operational note
+
+Temporal chunk rows carry a new column, `currently_eligible` (default true),
+which records whether the document is eligible in its latest state. **Existing
+temporal indexes must be rebuilt** (e.g. `uv run harness timegate`) to get it.
+Until rebuilt, an old index has no such column and `shield` cannot be used
+with it.
diff --git a/src/harness/bundle.py b/src/harness/bundle.py
index 20f8109..4b5c615 100644
--- a/src/harness/bundle.py
+++ b/src/harness/bundle.py
@@ -20,26 +20,30 @@ from __future__ import annotations
 from typing import Any
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_active
 from .graph import edges
 from .models import Bundle, BundleMember
 from .ports import Hit, QueryContext
 
 
 def _member_door_ok(eligibility: str, is_privileged: bool, currently_privileged: bool,
-                    context: QueryContext, temporal: bool) -> bool:
+                    currently_eligible: bool, context: QueryContext,
+                    temporal: bool) -> bool:
     """The per-member door decision, shared by the filter and the bug guard."""
     if eligibility != "eligible":
         return False
     if is_privileged and not context.can_see_privileged:
         return False
+    if shield_active(context, temporal) and not currently_eligible:
+        return False
     return not (temporal and currently_privileged and not context.can_see_privileged
                 and context.temporal_mode != "audit")
 
 
 def _neighbor_info(neighbor_ids: set[str], index_version: str,
                    context: QueryContext, temporal: bool) -> dict[str, tuple]:
-    """doc_id -> (subject_type, eligibility, is_privileged,
-    currently_privileged, title, content). On temporal tables the row is the
+    """doc_id -> (subject_type, eligibility, is_privileged, currently_privileged,
+    currently_eligible, title, content). On temporal tables the row is the
     interval containing T (or now), so state and text are version-correct."""
     if not neighbor_ids:
         return {}
@@ -54,14 +58,15 @@ def _neighbor_info(neighbor_ids: set[str], index_version: str,
                 time_pred = "validity @> now()"
             rows = conn.execute(
                 f"""SELECT DISTINCT ON (doc_id) doc_id, subject_type, eligibility,
-                           is_privileged, currently_privileged, title, content
+                           is_privileged, currently_privileged, currently_eligible,
+                           title, content
                     FROM {table} WHERE doc_id = ANY(%s) AND {time_pred}
                     ORDER BY doc_id, chunk_index""",
                 params).fetchall()
         else:
             rows = conn.execute(
                 f"""SELECT DISTINCT ON (doc_id) doc_id, subject_type, eligibility,
-                           is_privileged, false, title, content
+                           is_privileged, false, true, title, content
                     FROM {table} WHERE doc_id = ANY(%s)
                     ORDER BY doc_id, chunk_index""",
                 (list(neighbor_ids),)).fetchall()
@@ -94,8 +99,8 @@ def assemble(hits: list[Hit], context: QueryContext, index_version: str,
         for nbr, rel in graph.get(s.doc_id, []):
             if nbr in seen or nbr not in info:
                 continue
-            stype, elig, priv, curr_priv, title, content = info[nbr]
-            if not _member_door_ok(elig, priv, curr_priv, context, temporal):
+            stype, elig, priv, curr_priv, curr_elig, title, content = info[nbr]
+            if not _member_door_ok(elig, priv, curr_priv, curr_elig, context, temporal):
                 stats["blocked"] += 1          # the door, per member
                 continue
             members.append(BundleMember(
@@ -114,8 +119,8 @@ def assemble(hits: list[Hit], context: QueryContext, index_version: str,
             words += w
             kept.append(m)
         for m in kept:                          # bug guard: must stay empty
-            stype, elig, priv, curr_priv, *_ = info[m.doc_id]
-            if not _member_door_ok(elig, priv, curr_priv, context, temporal):
+            stype, elig, priv, curr_priv, curr_elig, *_ = info[m.doc_id]
+            if not _member_door_ok(elig, priv, curr_priv, curr_elig, context, temporal):
                 stats["violations"].append(m.doc_id)
         bundles.append(Bundle(seed_doc_id=s.doc_id, seed_chunk_id=s.chunk_id,
                               seed_score=round(s.score, 6), members=kept))
diff --git a/src/harness/db.py b/src/harness/db.py
index dca0dc8..d052979 100644
--- a/src/harness/db.py
+++ b/src/harness/db.py
@@ -96,7 +96,8 @@ def create_chunk_table(index_version: str, dim: int, temporal: bool = False) ->
     if temporal:
         temporal_cols = """
                 validity tstzrange NOT NULL,
-                currently_privileged boolean NOT NULL DEFAULT false,"""
+                currently_privileged boolean NOT NULL DEFAULT false,
+                currently_eligible boolean NOT NULL DEFAULT true,"""
     with connect("harness") as conn:
         conn.execute(f"DROP TABLE IF EXISTS {table}")
         conn.execute(f"""
diff --git a/src/harness/door.py b/src/harness/door.py
index 840513b..f0bac1d 100644
--- a/src/harness/door.py
+++ b/src/harness/door.py
@@ -7,8 +7,21 @@ graph executor all build their filters here so the door cannot drift apart.
 """
 from __future__ import annotations
 
+import os
+
 from .ports import QueryContext
 
+RETRO_ELIGIBILITY_ENV = "DOOR_RETRO_ELIGIBILITY"
+
+
+def shield_active(context: QueryContext, temporal: bool) -> bool:
+    """Policy B ("shield"): a non-audit temporal query must not return a record
+    that is not eligible NOW, whatever its eligibility was at T. Read from the
+    environment on every call so a deployment flip needs no re-import. Any
+    value other than "shield" keeps Policy A (the default)."""
+    return (temporal and context.temporal_mode != "audit"
+            and os.environ.get(RETRO_ELIGIBILITY_ENV) == "shield")
+
 
 def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
     """WHERE fragment (no leading WHERE) plus positional params.
@@ -34,4 +47,6 @@ def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
         f += " AND is_privileged = false"
         if context.temporal_mode != "audit":
             f += " AND currently_privileged = false"
+    if shield_active(context, temporal):
+        f += " AND currently_eligible = true"
     return f, params
diff --git a/src/harness/graph_exec.py b/src/harness/graph_exec.py
index 184db2b..57d6362 100644
--- a/src/harness/graph_exec.py
+++ b/src/harness/graph_exec.py
@@ -17,6 +17,7 @@ from __future__ import annotations
 import re
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_active
 from .ports import QueryContext
 
 V1_DB = "v1raw"
@@ -131,18 +132,21 @@ class GraphExecutor:
             else:
                 time_pred = " AND validity @> now()"
         curr_col = "bool_or(currently_privileged)" if temporal else "false"
+        elig_col = "bool_and(currently_eligible)" if temporal else "true"
+        shield = shield_active(context, temporal)
         with connect("harness") as conn:
             rows = conn.execute(
                 f"""SELECT doc_id,
                            bool_and(eligibility = 'eligible'),
                            bool_or(is_privileged),
-                           {curr_col}
+                           {curr_col},
+                           {elig_col}
                     FROM {chunk_table(self._index_version)}
                     WHERE doc_id = ANY(%s){time_pred}
                     GROUP BY doc_id""",
                 params).fetchall()
         allowed = set()
-        for doc_id, elig_ok, any_priv, any_curr in rows:
+        for doc_id, elig_ok, any_priv, any_curr, all_curr_elig in rows:
             if not elig_ok:
                 continue
             if any_priv and not context.can_see_privileged:
@@ -150,6 +154,8 @@ class GraphExecutor:
             if (temporal and any_curr and not context.can_see_privileged
                     and context.temporal_mode != "audit"):
                 continue
+            if shield and not all_curr_elig:
+                continue
             allowed.add(doc_id)
         return [d for d in doc_ids if d in allowed]
 
diff --git a/src/harness/history_sim.py b/src/harness/history_sim.py
index 920396c..62d0a21 100644
--- a/src/harness/history_sim.py
+++ b/src/harness/history_sim.py
@@ -142,6 +142,7 @@ def simulate(docs: list[Document]) -> dict:
                 state["privileged"] = True
             cursor = w
         segments.append((cursor, None, dict(state)))
+        currently_elig = state["eligibility"] == "eligible"
 
         for vfrom_w, vto_w, seg in segments:
             if vto_w is not None and vfrom_w >= vto_w:
@@ -152,7 +153,7 @@ def simulate(docs: list[Document]) -> dict:
                            is_privileged=seg["privileged"])
             interval_docs.append((vdoc, week(vfrom_w),
                                   week(vto_w) if vto_w is not None else None,
-                                  currently_priv))
+                                  currently_priv, currently_elig))
 
     # ---- probes ----------------------------------------------------------
     for doc_id in edited:
diff --git a/src/harness/retriever_pg.py b/src/harness/retriever_pg.py
index 1102bbd..6e46c0c 100644
--- a/src/harness/retriever_pg.py
+++ b/src/harness/retriever_pg.py
@@ -60,34 +60,38 @@ class PgRetriever:
     def index_temporal(self, interval_docs: list, index_version: str,
                        embedder_name: str) -> None:
         """Index constant-state intervals: each entry is (Document, valid_from,
-        valid_to_or_None, currently_privileged). Rows are the SCD-2 projection
-        of the ledger: for any T exactly one interval per living subject
-        contains it. Embeddings dedupe by content through the cache."""
+        valid_to_or_None, currently_privileged, currently_eligible). Rows are
+        the SCD-2 projection of the ledger: for any T exactly one interval per
+        living subject contains it. currently_eligible is the document's
+        eligibility in its LATEST state (used by DOOR_RETRO_ELIGIBILITY=shield).
+        Embeddings dedupe by content through the cache."""
         from .chunking import chunk_documents
         emb = self._embedder(embedder_name)
         rows: list[tuple] = []
         policy = {"long_size": 400, "long_overlap": 0.15,
                   "note_whole_below": 400, "parent_context": "none",
                   "child_context": "dates"}
-        for doc, vfrom, vto, curr_priv in interval_docs:
+        for doc, vfrom, vto, curr_priv, curr_elig in interval_docs:
             validity = f"[{vfrom},{vto})" if vto else f"[{vfrom},)"
             for c in chunk_documents([doc], policy):
                 rows.append((f"{c.doc_id}@{vfrom}::{c.chunk_index}", c, validity,
-                             curr_priv))
-        vectors = emb.embed([c.content for _, c, _, _ in rows])
+                             curr_priv, curr_elig))
+        vectors = emb.embed([c.content for _, c, _, _, _ in rows])
         table = create_chunk_table(index_version, emb.dim, temporal=True)
         with connect("harness") as conn, conn.cursor() as cur:
-            for (chunk_id, c, validity, curr_priv), v in zip(rows, vectors, strict=True):
+            for (chunk_id, c, validity, curr_priv, curr_elig), v in zip(
+                    rows, vectors, strict=True):
                 parent = c.meta.get("parent") or c.meta.get("parent_id") or c.meta.get("about")
                 cur.execute(
                     f"""INSERT INTO {table} (chunk_id, doc_id, subject_type,
                             subject_version, validity, currently_privileged,
-                            title, content, eligibility, confidentiality,
-                            is_privileged, chunk_index, parent_id, meta, tsv, embedding)
-                        VALUES (%s,%s,%s,%s,%s::tstzrange,%s,%s,%s,%s,%s,%s,%s,%s,%s,
+                            currently_eligible, title, content, eligibility,
+                            confidentiality, is_privileged, chunk_index, parent_id,
+                            meta, tsv, embedding)
+                        VALUES (%s,%s,%s,%s,%s::tstzrange,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                                 to_tsvector('english', %s || ' ' || %s), %s)""",
                     (chunk_id, c.doc_id, c.subject_type, c.subject_version,
-                     validity, curr_priv, c.title, c.content, c.eligibility,
+                     validity, curr_priv, curr_elig, c.title, c.content, c.eligibility,
                      c.confidentiality, c.is_privileged, c.chunk_index, parent,
                      json.dumps(c.meta), c.title, c.content, str(v)))
         self._families.pop(index_version, None)
diff --git a/tests/test_door.py b/tests/test_door.py
index 01d4118..c17459b 100644
--- a/tests/test_door.py
+++ b/tests/test_door.py
@@ -36,3 +36,26 @@ def test_temporal_unscoped_uses_now():
     where, params = door_where(QueryContext(), temporal=True)
     assert where.startswith("validity @> now()")
     assert params == []
+
+
+def test_shield_adds_currently_eligible_predicate(monkeypatch):
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "shield")
+    where, _ = door_where(QueryContext(as_known_at=T), temporal=True)
+    assert "currently_eligible = true" in where
+    priv, _ = door_where(QueryContext(as_known_at=T, can_see_privileged=True),
+                         temporal=True)
+    assert "currently_eligible = true" in priv
+    audit, _ = door_where(QueryContext(as_known_at=T, temporal_mode="audit"),
+                          temporal=True)
+    assert "currently_eligible" not in audit
+    flat, _ = door_where(QueryContext(), temporal=False)
+    assert "currently_eligible" not in flat
+
+
+def test_default_and_unknown_values_leave_door_unchanged(monkeypatch):
+    monkeypatch.delenv("DOOR_RETRO_ELIGIBILITY", raising=False)
+    default, _ = door_where(QueryContext(as_known_at=T), temporal=True)
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "Shield ")
+    other, _ = door_where(QueryContext(as_known_at=T), temporal=True)
+    assert default == other
+    assert "currently_eligible" not in default
diff --git a/tests/test_temporal_bundles.py b/tests/test_temporal_bundles.py
index 07f8a36..e668579 100644
--- a/tests/test_temporal_bundles.py
+++ b/tests/test_temporal_bundles.py
@@ -11,15 +11,41 @@ KNOBS = {"hop_decay": 0.5, "max_members": 6, "budget_words": 700}
 def test_member_door_blocks_retro_shield_in_disclosure_safe():
     ctx = QueryContext(as_known_at="2026-01-15T00:00:00+00:00")
     # eligible at T, not privileged at T, but privileged NOW -> blocked
-    assert _member_door_ok("eligible", False, True, ctx, temporal=True) is False
+    assert _member_door_ok("eligible", False, True, True, ctx, temporal=True) is False
     # audit mode applies T's state alone -> allowed
     ctx_audit = QueryContext(as_known_at="2026-01-15T00:00:00+00:00",
                              temporal_mode="audit")
-    assert _member_door_ok("eligible", False, True, ctx_audit, temporal=True) is True
+    assert _member_door_ok("eligible", False, True, True, ctx_audit, temporal=True) is True
     # quarantined at T -> blocked in every mode
-    assert _member_door_ok("quarantined", False, False, ctx_audit, temporal=True) is False
+    assert _member_door_ok("quarantined", False, False, True, ctx_audit,
+                           temporal=True) is False
     # non-temporal ignores currently_privileged
-    assert _member_door_ok("eligible", False, True, QueryContext(), temporal=False) is True
+    assert _member_door_ok("eligible", False, True, True, QueryContext(),
+                           temporal=False) is True
+
+
+def test_member_door_retro_eligibility_policy(monkeypatch):
+    ctx = QueryContext(as_known_at="2026-01-15T00:00:00+00:00")
+    ctx_audit = QueryContext(as_known_at="2026-01-15T00:00:00+00:00",
+                             temporal_mode="audit")
+    monkeypatch.delenv("DOOR_RETRO_ELIGIBILITY", raising=False)
+    # Policy A (default): eligible at T, excluded since -> still shown
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is True
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "other")
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is True
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "shield")
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is False
+    assert _member_door_ok("eligible", False, False, True, ctx, temporal=True) is True
+    # shield applies even to privileged-entitled callers
+    ctx_priv = QueryContext(as_known_at="2026-01-15T00:00:00+00:00",
+                            can_see_privileged=True)
+    assert _member_door_ok("eligible", False, False, False, ctx_priv,
+                           temporal=True) is False
+    # audit and non-temporal are unaffected
+    assert _member_door_ok("eligible", False, False, False, ctx_audit,
+                           temporal=True) is True
+    assert _member_door_ok("eligible", False, False, False, QueryContext(),
+                           temporal=False) is True
 
 
 def _temporal_index() -> str:

```

## Patch B

```diff
diff --git a/README.md b/README.md
index 29360bd..0ef27d4 100644
--- a/README.md
+++ b/README.md
@@ -82,8 +82,10 @@ The standing contract with per-phase gates and as-built status lives in
   matters doubly here because the door always filters and temporal queries
   add a second predicate.
 - The temporal columns are the fourth seam's reference implementation:
-  validity tstzranges, currently_privileged, the disclosure-safe/audit
-  policy in `_filters`.
+  validity tstzranges, currently_privileged, currently_eligible, the
+  disclosure-safe/audit policy in `_filters`. `DOOR_RETRO_ELIGIBILITY=shield`
+  opts into hiding currently-ineligible records from as-of answers
+  (see `docs/POLICY-retro-eligibility.md`).
 - The calibration artifact, champion configs and analyst proposals promote
   through ai_configs and the agent_runs/agent_findings quarantine flow.
 - Per-epoch embedding identity ships in index_registry.
diff --git a/docs/POLICY-retro-eligibility.md b/docs/POLICY-retro-eligibility.md
new file mode 100644
index 0000000..fdb576a
--- /dev/null
+++ b/docs/POLICY-retro-eligibility.md
@@ -0,0 +1,67 @@
+# Decision needed: should as-of answers show records archived or excluded since?
+
+**Status:** ruling pending from the policy owners. The system ships with Policy A
+(today's behavior) until a ruling is made.
+
+## The question
+
+An as-of query asks "what did the corpus say on date T?". A record may have been
+eligible for retrieval on T and then archived or excluded from retrieval later.
+Should an as-of-T answer still show it?
+
+Privilege is already settled: a record marked privileged after T is hidden from
+ordinary as-of answers. This decision is only about **eligibility** (archived /
+excluded from retrieval).
+
+## Policy A: show what was eligible on T (current default)
+
+A record eligible on T is returned for an as-of-T query, even if it has since
+been archived or excluded.
+
+- For: faithful reconstruction of the past; what a reader could see then, they
+  can see now when asking about then.
+- Against: surfaces content the organization has since withdrawn from retrieval.
+
+## Policy B: shield (opt-in)
+
+A non-audit as-of query returns no record that is **not eligible today**,
+whatever its status was on T.
+
+- For: withdrawn content cannot be reached through a date query.
+- Against: as-of answers are incomplete reconstructions of the past.
+
+Under both policies, audit mode (`temporal_mode="audit"`) shows the record's own
+state on T and is unaffected. Non-temporal indexes are unaffected.
+
+## Example
+
+Risk R-104 is eligible from week 1. In week 5 it is excluded from retrieval.
+
+| Query | Policy A | Policy B (shield) | Audit mode |
+|---|---|---|---|
+| as of week 3 | R-104 returned | **not returned** | R-104 returned |
+| as of week 7 | not returned | not returned | not returned (ineligible at T) |
+| today | not returned | not returned | not returned |
+
+Shield applies the same way to evidence-bundle members and to graph joins. For
+graph joins, a document is dropped if any of its rows is currently ineligible.
+
+## The switch
+
+Deployment environment variable:
+
+```
+DOOR_RETRO_ELIGIBILITY=shield    # Policy B
+```
+
+Unset, or any other value, means Policy A. The variable is read per query; the
+service does not need rebuilding to change it, but the process environment must
+carry the new value (restart if the host does not hot-reload it).
+
+## Operational note
+
+Shield relies on a `currently_eligible` column on temporal chunk tables. Existing
+temporal indexes lack it with correct values and **must be rebuilt** (re-run the
+temporal gate / `PgRetriever.index_temporal`) before enabling shield. Until
+rebuilt, the column does not exist and shield queries on old indexes will error
+rather than silently show withdrawn records.
diff --git a/src/harness/bundle.py b/src/harness/bundle.py
index 20f8109..b70931c 100644
--- a/src/harness/bundle.py
+++ b/src/harness/bundle.py
@@ -20,18 +20,22 @@ from __future__ import annotations
 from typing import Any
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_blocks
 from .graph import edges
 from .models import Bundle, BundleMember
 from .ports import Hit, QueryContext
 
 
 def _member_door_ok(eligibility: str, is_privileged: bool, currently_privileged: bool,
-                    context: QueryContext, temporal: bool) -> bool:
+                    currently_eligible: bool, context: QueryContext,
+                    temporal: bool) -> bool:
     """The per-member door decision, shared by the filter and the bug guard."""
     if eligibility != "eligible":
         return False
     if is_privileged and not context.can_see_privileged:
         return False
+    if temporal and shield_blocks(context, currently_eligible):
+        return False
     return not (temporal and currently_privileged and not context.can_see_privileged
                 and context.temporal_mode != "audit")
 
@@ -39,7 +43,8 @@ def _member_door_ok(eligibility: str, is_privileged: bool, currently_privileged:
 def _neighbor_info(neighbor_ids: set[str], index_version: str,
                    context: QueryContext, temporal: bool) -> dict[str, tuple]:
     """doc_id -> (subject_type, eligibility, is_privileged,
-    currently_privileged, title, content). On temporal tables the row is the
+    currently_privileged, currently_eligible, title, content). On temporal
+    tables the row is the
     interval containing T (or now), so state and text are version-correct."""
     if not neighbor_ids:
         return {}
@@ -54,14 +59,15 @@ def _neighbor_info(neighbor_ids: set[str], index_version: str,
                 time_pred = "validity @> now()"
             rows = conn.execute(
                 f"""SELECT DISTINCT ON (doc_id) doc_id, subject_type, eligibility,
-                           is_privileged, currently_privileged, title, content
+                           is_privileged, currently_privileged, currently_eligible,
+                           title, content
                     FROM {table} WHERE doc_id = ANY(%s) AND {time_pred}
                     ORDER BY doc_id, chunk_index""",
                 params).fetchall()
         else:
             rows = conn.execute(
                 f"""SELECT DISTINCT ON (doc_id) doc_id, subject_type, eligibility,
-                           is_privileged, false, title, content
+                           is_privileged, false, true, title, content
                     FROM {table} WHERE doc_id = ANY(%s)
                     ORDER BY doc_id, chunk_index""",
                 (list(neighbor_ids),)).fetchall()
@@ -94,8 +100,8 @@ def assemble(hits: list[Hit], context: QueryContext, index_version: str,
         for nbr, rel in graph.get(s.doc_id, []):
             if nbr in seen or nbr not in info:
                 continue
-            stype, elig, priv, curr_priv, title, content = info[nbr]
-            if not _member_door_ok(elig, priv, curr_priv, context, temporal):
+            stype, elig, priv, curr_priv, curr_elig, title, content = info[nbr]
+            if not _member_door_ok(elig, priv, curr_priv, curr_elig, context, temporal):
                 stats["blocked"] += 1          # the door, per member
                 continue
             members.append(BundleMember(
@@ -114,8 +120,8 @@ def assemble(hits: list[Hit], context: QueryContext, index_version: str,
             words += w
             kept.append(m)
         for m in kept:                          # bug guard: must stay empty
-            stype, elig, priv, curr_priv, *_ = info[m.doc_id]
-            if not _member_door_ok(elig, priv, curr_priv, context, temporal):
+            stype, elig, priv, curr_priv, curr_elig, *_ = info[m.doc_id]
+            if not _member_door_ok(elig, priv, curr_priv, curr_elig, context, temporal):
                 stats["violations"].append(m.doc_id)
         bundles.append(Bundle(seed_doc_id=s.doc_id, seed_chunk_id=s.chunk_id,
                               seed_score=round(s.score, 6), members=kept))
diff --git a/src/harness/db.py b/src/harness/db.py
index dca0dc8..d052979 100644
--- a/src/harness/db.py
+++ b/src/harness/db.py
@@ -96,7 +96,8 @@ def create_chunk_table(index_version: str, dim: int, temporal: bool = False) ->
     if temporal:
         temporal_cols = """
                 validity tstzrange NOT NULL,
-                currently_privileged boolean NOT NULL DEFAULT false,"""
+                currently_privileged boolean NOT NULL DEFAULT false,
+                currently_eligible boolean NOT NULL DEFAULT true,"""
     with connect("harness") as conn:
         conn.execute(f"DROP TABLE IF EXISTS {table}")
         conn.execute(f"""
diff --git a/src/harness/door.py b/src/harness/door.py
index 840513b..50b5f40 100644
--- a/src/harness/door.py
+++ b/src/harness/door.py
@@ -7,8 +7,25 @@ graph executor all build their filters here so the door cannot drift apart.
 """
 from __future__ import annotations
 
+import os
+
 from .ports import QueryContext
 
+ELIGIBILITY_ENV = "DOOR_RETRO_ELIGIBILITY"
+
+
+def shield_enabled() -> bool:
+    """Policy B switch, read per call so a deployment can flip it without a
+    code change. Anything other than exactly 'shield' is Policy A."""
+    return os.environ.get(ELIGIBILITY_ENV) == "shield"
+
+
+def shield_blocks(context: QueryContext, currently_eligible: bool) -> bool:
+    """True when Policy B hides a temporal row: non-audit query on a record
+    that is not eligible in its latest state. Independent of privilege."""
+    return (shield_enabled() and context.temporal_mode != "audit"
+            and not currently_eligible)
+
 
 def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
     """WHERE fragment (no leading WHERE) plus positional params.
@@ -30,6 +47,8 @@ def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
     else:
         f = "validity @> now()"
     f += " AND eligibility = 'eligible'"
+    if shield_enabled() and context.temporal_mode != "audit":
+        f += " AND currently_eligible = true"
     if not context.can_see_privileged:
         f += " AND is_privileged = false"
         if context.temporal_mode != "audit":
diff --git a/src/harness/graph_exec.py b/src/harness/graph_exec.py
index 184db2b..8c3583f 100644
--- a/src/harness/graph_exec.py
+++ b/src/harness/graph_exec.py
@@ -17,6 +17,7 @@ from __future__ import annotations
 import re
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_blocks
 from .ports import QueryContext
 
 V1_DB = "v1raw"
@@ -118,7 +119,8 @@ class GraphExecutor:
         Temporal indexes read state at T (validity containment); the
         disclosure-safe policy retro-shields docs privileged now. Aggregation
         is conservative: every surviving row must be eligible, and any
-        surviving privileged row blocks the doc."""
+        surviving privileged row blocks the doc. Under DOOR_RETRO_ELIGIBILITY=shield
+        a doc is also dropped if any of its rows is currently ineligible."""
         if not doc_ids:
             return []
         temporal = is_temporal(self._index_version)
@@ -131,18 +133,20 @@ class GraphExecutor:
             else:
                 time_pred = " AND validity @> now()"
         curr_col = "bool_or(currently_privileged)" if temporal else "false"
+        elig_col = "bool_and(currently_eligible)" if temporal else "true"
         with connect("harness") as conn:
             rows = conn.execute(
                 f"""SELECT doc_id,
                            bool_and(eligibility = 'eligible'),
                            bool_or(is_privileged),
-                           {curr_col}
+                           {curr_col},
+                           {elig_col}
                     FROM {chunk_table(self._index_version)}
                     WHERE doc_id = ANY(%s){time_pred}
                     GROUP BY doc_id""",
                 params).fetchall()
         allowed = set()
-        for doc_id, elig_ok, any_priv, any_curr in rows:
+        for doc_id, elig_ok, any_priv, any_curr, all_curr_elig in rows:
             if not elig_ok:
                 continue
             if any_priv and not context.can_see_privileged:
@@ -150,6 +154,8 @@ class GraphExecutor:
             if (temporal and any_curr and not context.can_see_privileged
                     and context.temporal_mode != "audit"):
                 continue
+            if temporal and shield_blocks(context, all_curr_elig):
+                continue
             allowed.add(doc_id)
         return [d for d in doc_ids if d in allowed]
 
diff --git a/src/harness/history_sim.py b/src/harness/history_sim.py
index 920396c..62d0a21 100644
--- a/src/harness/history_sim.py
+++ b/src/harness/history_sim.py
@@ -142,6 +142,7 @@ def simulate(docs: list[Document]) -> dict:
                 state["privileged"] = True
             cursor = w
         segments.append((cursor, None, dict(state)))
+        currently_elig = state["eligibility"] == "eligible"
 
         for vfrom_w, vto_w, seg in segments:
             if vto_w is not None and vfrom_w >= vto_w:
@@ -152,7 +153,7 @@ def simulate(docs: list[Document]) -> dict:
                            is_privileged=seg["privileged"])
             interval_docs.append((vdoc, week(vfrom_w),
                                   week(vto_w) if vto_w is not None else None,
-                                  currently_priv))
+                                  currently_priv, currently_elig))
 
     # ---- probes ----------------------------------------------------------
     for doc_id in edited:
diff --git a/src/harness/retriever_pg.py b/src/harness/retriever_pg.py
index 1102bbd..43929fa 100644
--- a/src/harness/retriever_pg.py
+++ b/src/harness/retriever_pg.py
@@ -60,7 +60,8 @@ class PgRetriever:
     def index_temporal(self, interval_docs: list, index_version: str,
                        embedder_name: str) -> None:
         """Index constant-state intervals: each entry is (Document, valid_from,
-        valid_to_or_None, currently_privileged). Rows are the SCD-2 projection
+        valid_to_or_None, currently_privileged, currently_eligible). Rows are
+        the SCD-2 projection
         of the ledger: for any T exactly one interval per living subject
         contains it. Embeddings dedupe by content through the cache."""
         from .chunking import chunk_documents
@@ -69,25 +70,27 @@ class PgRetriever:
         policy = {"long_size": 400, "long_overlap": 0.15,
                   "note_whole_below": 400, "parent_context": "none",
                   "child_context": "dates"}
-        for doc, vfrom, vto, curr_priv in interval_docs:
+        for doc, vfrom, vto, curr_priv, curr_elig in interval_docs:
             validity = f"[{vfrom},{vto})" if vto else f"[{vfrom},)"
             for c in chunk_documents([doc], policy):
                 rows.append((f"{c.doc_id}@{vfrom}::{c.chunk_index}", c, validity,
-                             curr_priv))
-        vectors = emb.embed([c.content for _, c, _, _ in rows])
+                             curr_priv, curr_elig))
+        vectors = emb.embed([c.content for _, c, _, _, _ in rows])
         table = create_chunk_table(index_version, emb.dim, temporal=True)
         with connect("harness") as conn, conn.cursor() as cur:
-            for (chunk_id, c, validity, curr_priv), v in zip(rows, vectors, strict=True):
+            for (chunk_id, c, validity, curr_priv, curr_elig), v in zip(
+                    rows, vectors, strict=True):
                 parent = c.meta.get("parent") or c.meta.get("parent_id") or c.meta.get("about")
                 cur.execute(
                     f"""INSERT INTO {table} (chunk_id, doc_id, subject_type,
                             subject_version, validity, currently_privileged,
+                            currently_eligible,
                             title, content, eligibility, confidentiality,
                             is_privileged, chunk_index, parent_id, meta, tsv, embedding)
-                        VALUES (%s,%s,%s,%s,%s::tstzrange,%s,%s,%s,%s,%s,%s,%s,%s,%s,
+                        VALUES (%s,%s,%s,%s,%s::tstzrange,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                                 to_tsvector('english', %s || ' ' || %s), %s)""",
                     (chunk_id, c.doc_id, c.subject_type, c.subject_version,
-                     validity, curr_priv, c.title, c.content, c.eligibility,
+                     validity, curr_priv, curr_elig, c.title, c.content, c.eligibility,
                      c.confidentiality, c.is_privileged, c.chunk_index, parent,
                      json.dumps(c.meta), c.title, c.content, str(v)))
         self._families.pop(index_version, None)
diff --git a/tests/test_door.py b/tests/test_door.py
index 01d4118..56cf23b 100644
--- a/tests/test_door.py
+++ b/tests/test_door.py
@@ -36,3 +36,18 @@ def test_temporal_unscoped_uses_now():
     where, params = door_where(QueryContext(), temporal=True)
     assert where.startswith("validity @> now()")
     assert params == []
+
+
+def test_shield_adds_currently_eligible_predicate_only_when_set(monkeypatch):
+    ctx = QueryContext(as_known_at=T)
+    monkeypatch.delenv("DOOR_RETRO_ELIGIBILITY", raising=False)
+    assert "currently_eligible" not in door_where(ctx, temporal=True)[0]
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "off")
+    assert "currently_eligible" not in door_where(ctx, temporal=True)[0]
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "shield")
+    assert "currently_eligible = true" in door_where(ctx, temporal=True)[0]
+    audit = QueryContext(as_known_at=T, temporal_mode="audit")
+    assert "currently_eligible" not in door_where(audit, temporal=True)[0]
+    assert "currently_eligible" not in door_where(QueryContext(), temporal=False)[0]
+    priv = QueryContext(as_known_at=T, can_see_privileged=True)
+    assert "currently_eligible = true" in door_where(priv, temporal=True)[0]
diff --git a/tests/test_temporal_bundles.py b/tests/test_temporal_bundles.py
index 07f8a36..49daf15 100644
--- a/tests/test_temporal_bundles.py
+++ b/tests/test_temporal_bundles.py
@@ -11,15 +11,32 @@ KNOBS = {"hop_decay": 0.5, "max_members": 6, "budget_words": 700}
 def test_member_door_blocks_retro_shield_in_disclosure_safe():
     ctx = QueryContext(as_known_at="2026-01-15T00:00:00+00:00")
     # eligible at T, not privileged at T, but privileged NOW -> blocked
-    assert _member_door_ok("eligible", False, True, ctx, temporal=True) is False
+    assert _member_door_ok("eligible", False, True, True, ctx, temporal=True) is False
     # audit mode applies T's state alone -> allowed
     ctx_audit = QueryContext(as_known_at="2026-01-15T00:00:00+00:00",
                              temporal_mode="audit")
-    assert _member_door_ok("eligible", False, True, ctx_audit, temporal=True) is True
+    assert _member_door_ok("eligible", False, True, True, ctx_audit, temporal=True) is True
     # quarantined at T -> blocked in every mode
-    assert _member_door_ok("quarantined", False, False, ctx_audit, temporal=True) is False
+    assert _member_door_ok("quarantined", False, False, True, ctx_audit,
+                           temporal=True) is False
     # non-temporal ignores currently_privileged
-    assert _member_door_ok("eligible", False, True, QueryContext(), temporal=False) is True
+    assert _member_door_ok("eligible", False, True, True, QueryContext(),
+                           temporal=False) is True
+
+
+def test_member_door_currently_ineligible_needs_shield(monkeypatch):
+    ctx = QueryContext(as_known_at="2026-01-15T00:00:00+00:00")
+    ctx_audit = QueryContext(as_known_at="2026-01-15T00:00:00+00:00",
+                             temporal_mode="audit")
+    monkeypatch.delenv("DOOR_RETRO_ELIGIBILITY", raising=False)
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is True
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "shield")
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is False
+    assert _member_door_ok("eligible", False, False, True, ctx, temporal=True) is True
+    assert _member_door_ok("eligible", False, False, False, ctx_audit,
+                           temporal=True) is True
+    assert _member_door_ok("eligible", False, False, False, QueryContext(),
+                           temporal=False) is True
 
 
 def _temporal_index() -> str:

```
