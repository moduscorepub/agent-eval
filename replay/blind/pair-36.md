# Pair 36 (retrieval-harness-259c0bc0)

Which patch would you merge? Answer in answers.md as `36: A`, `36: B`, or `36: =` if you cannot tell.

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
index 29360bd..dfe1780 100644
--- a/README.md
+++ b/README.md
@@ -83,7 +83,10 @@ The standing contract with per-phase gates and as-built status lives in
   add a second predicate.
 - The temporal columns are the fourth seam's reference implementation:
   validity tstzranges, currently_privileged, the disclosure-safe/audit
-  policy in `_filters`.
+  policy in `_filters`. `currently_eligible` plus the opt-in
+  `DOOR_RETRO_ELIGIBILITY=shield` setting hides records archived or excluded
+  after T (see `docs/POLICY-retro-eligibility.md`); rebuild temporal indexes
+  to get the column.
 - The calibration artifact, champion configs and analyst proposals promote
   through ai_configs and the agent_runs/agent_findings quarantine flow.
 - Per-epoch embedding identity ships in index_registry.
diff --git a/docs/POLICY-retro-eligibility.md b/docs/POLICY-retro-eligibility.md
new file mode 100644
index 0000000..e9fa3f7
--- /dev/null
+++ b/docs/POLICY-retro-eligibility.md
@@ -0,0 +1,71 @@
+# Decision needed: should as-of answers show records archived or excluded later?
+
+**Status:** ruling pending from policy owners. The written policy and the code
+disagreed, so both behaviours are built. **Policy A is the default** until a
+ruling is made.
+
+## The question
+
+A record was eligible for retrieval on 15 January. On 1 March it was archived
+(excluded from retrieval). Someone now asks, "what did we know as of
+15 January?" Do we show that record?
+
+## Policy A: show it (current default)
+
+The answer reflects eligibility **as it was at the requested date**. A record
+eligible on 15 January is returned, even though it has since been archived or
+excluded.
+
+- Pro: the as-of answer matches what was retrievable on that date.
+- Con: content we have since withdrawn from retrieval can still surface in
+  today's answers.
+
+## Policy B: shield (opt-in)
+
+The answer returns only records that are **eligible today**, whatever their
+eligibility on the requested date. A record archived or excluded after
+15 January is not returned.
+
+- Pro: nothing withdrawn from retrieval ever reappears through a date query.
+- Con: as-of answers can be incomplete relative to what was available then.
+
+## Example
+
+| Record | Eligible on 15 Jan | Eligible today |
+|--------|--------------------|----------------|
+| R-1    | yes                | yes            |
+| R-2    | yes                | no (archived 1 Mar) |
+
+Query "as of 15 January":
+
+- Policy A returns R-1 and R-2.
+- Policy B returns R-1 only.
+
+## Unaffected under both policies
+
+- **Audit mode** (`temporal_mode="audit"`) always shows the record's own state
+  at the requested date.
+- **Non-temporal indexes** (no as-of date) are unchanged.
+- Privilege handling is unchanged.
+
+Under Policy B the rule applies at all three doors: main retrieval, each
+member of an evidence bundle, and graph joins (a document is dropped if any of
+its rows is currently ineligible).
+
+## The switch
+
+Deployment setting `DOOR_RETRO_ELIGIBILITY`:
+
+| Value                           | Policy      |
+|---------------------------------|-------------|
+| unset, or anything but `shield` | A (default) |
+| `shield`                        | B           |
+
+The setting is read on each query.
+
+## Operational note
+
+Temporal chunk rows now carry a `currently_eligible` column (default true),
+filled at indexing time from the document's latest state. **Existing temporal
+indexes must be rebuilt** (for example `uv run harness timegate`) to get it.
+Until rebuilt, Policy A keeps working; Policy B requires the rebuild.
diff --git a/src/harness/bundle.py b/src/harness/bundle.py
index 20f8109..b159289 100644
--- a/src/harness/bundle.py
+++ b/src/harness/bundle.py
@@ -20,32 +20,39 @@ from __future__ import annotations
 from typing import Any
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_enabled
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
-    return not (temporal and currently_privileged and not context.can_see_privileged
+    if (temporal and currently_privileged and not context.can_see_privileged
+            and context.temporal_mode != "audit"):
+        return False
+    return not (temporal and shield_enabled() and not currently_eligible
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
     table = chunk_table(index_version)
     with connect("harness") as conn:
         if temporal:
+            # old temporal indexes lack the column; only read it under shield
+            elig_col = "currently_eligible" if shield_enabled() else "true"
             params: list = [list(neighbor_ids)]
             if context.as_known_at:
                 time_pred = "validity @> %s::timestamptz"
@@ -54,14 +61,14 @@ def _neighbor_info(neighbor_ids: set[str], index_version: str,
                 time_pred = "validity @> now()"
             rows = conn.execute(
                 f"""SELECT DISTINCT ON (doc_id) doc_id, subject_type, eligibility,
-                           is_privileged, currently_privileged, title, content
+                           is_privileged, currently_privileged, {elig_col}, title, content
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
@@ -94,8 +101,8 @@ def assemble(hits: list[Hit], context: QueryContext, index_version: str,
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
@@ -114,8 +121,8 @@ def assemble(hits: list[Hit], context: QueryContext, index_version: str,
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
index 840513b..b1545a7 100644
--- a/src/harness/door.py
+++ b/src/harness/door.py
@@ -7,8 +7,20 @@ graph executor all build their filters here so the door cannot drift apart.
 """
 from __future__ import annotations
 
+import os
+
 from .ports import QueryContext
 
+RETRO_ELIGIBILITY_ENV = "DOOR_RETRO_ELIGIBILITY"
+
+
+def shield_enabled() -> bool:
+    """Policy B: as-of answers hide records that are currently ineligible.
+
+    Read per call so the deployment setting is honoured without a reimport.
+    Anything other than exactly `shield` keeps Policy A (the default)."""
+    return os.environ.get(RETRO_ELIGIBILITY_ENV) == "shield"
+
 
 def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
     """WHERE fragment (no leading WHERE) plus positional params.
@@ -17,7 +29,8 @@ def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
     add validity containment (T, or now when unscoped), and privilege
     follows the temporal_mode policy: disclosure_safe intersects T's state
     with the present (later privilege marks retro-shield history), audit
-    applies T's state alone."""
+    applies T's state alone. With DOOR_RETRO_ELIGIBILITY=shield, non-audit
+    queries also require currently_eligible, whatever the privilege view."""
     if not temporal:
         f = "eligibility = 'eligible'"
         if not context.can_see_privileged:
@@ -34,4 +47,6 @@ def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
         f += " AND is_privileged = false"
         if context.temporal_mode != "audit":
             f += " AND currently_privileged = false"
+    if context.temporal_mode != "audit" and shield_enabled():
+        f += " AND currently_eligible = true"
     return f, params
diff --git a/src/harness/graph_exec.py b/src/harness/graph_exec.py
index 184db2b..7c00ada 100644
--- a/src/harness/graph_exec.py
+++ b/src/harness/graph_exec.py
@@ -17,6 +17,7 @@ from __future__ import annotations
 import re
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_enabled
 from .ports import QueryContext
 
 V1_DB = "v1raw"
@@ -131,18 +132,22 @@ class GraphExecutor:
             else:
                 time_pred = " AND validity @> now()"
         curr_col = "bool_or(currently_privileged)" if temporal else "false"
+        # old temporal indexes lack currently_eligible; read it only under shield
+        shield = temporal and shield_enabled()
+        elig_now_col = "bool_and(currently_eligible)" if shield else "true"
         with connect("harness") as conn:
             rows = conn.execute(
                 f"""SELECT doc_id,
                            bool_and(eligibility = 'eligible'),
                            bool_or(is_privileged),
-                           {curr_col}
+                           {curr_col},
+                           {elig_now_col}
                     FROM {chunk_table(self._index_version)}
                     WHERE doc_id = ANY(%s){time_pred}
                     GROUP BY doc_id""",
                 params).fetchall()
         allowed = set()
-        for doc_id, elig_ok, any_priv, any_curr in rows:
+        for doc_id, elig_ok, any_priv, any_curr, all_elig_now in rows:
             if not elig_ok:
                 continue
             if any_priv and not context.can_see_privileged:
@@ -150,6 +155,8 @@ class GraphExecutor:
             if (temporal and any_curr and not context.can_see_privileged
                     and context.temporal_mode != "audit"):
                 continue
+            if shield and not all_elig_now and context.temporal_mode != "audit":
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
index 1102bbd..9187e40 100644
--- a/src/harness/retriever_pg.py
+++ b/src/harness/retriever_pg.py
@@ -60,7 +60,7 @@ class PgRetriever:
     def index_temporal(self, interval_docs: list, index_version: str,
                        embedder_name: str) -> None:
         """Index constant-state intervals: each entry is (Document, valid_from,
-        valid_to_or_None, currently_privileged). Rows are the SCD-2 projection
+        valid_to_or_None, currently_privileged, currently_eligible). Rows are the SCD-2 projection
         of the ledger: for any T exactly one interval per living subject
         contains it. Embeddings dedupe by content through the cache."""
         from .chunking import chunk_documents
@@ -69,25 +69,27 @@ class PgRetriever:
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
index 01d4118..479ac24 100644
--- a/tests/test_door.py
+++ b/tests/test_door.py
@@ -36,3 +36,17 @@ def test_temporal_unscoped_uses_now():
     where, params = door_where(QueryContext(), temporal=True)
     assert where.startswith("validity @> now()")
     assert params == []
+
+
+def test_shield_requires_current_eligibility_for_non_audit(monkeypatch):
+    monkeypatch.delenv("DOOR_RETRO_ELIGIBILITY", raising=False)
+    assert "currently_eligible" not in door_where(QueryContext(as_known_at=T), True)[0]
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "shield")
+    assert "currently_eligible = true" in door_where(QueryContext(as_known_at=T), True)[0]
+    priv = QueryContext(as_known_at=T, can_see_privileged=True)
+    assert "currently_eligible = true" in door_where(priv, True)[0]
+    audit = QueryContext(as_known_at=T, temporal_mode="audit")
+    assert "currently_eligible" not in door_where(audit, True)[0]
+    assert "currently_eligible" not in door_where(QueryContext(), False)[0]
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "Shield")
+    assert "currently_eligible" not in door_where(QueryContext(as_known_at=T), True)[0]
diff --git a/tests/test_temporal_bundles.py b/tests/test_temporal_bundles.py
index 07f8a36..59943c7 100644
--- a/tests/test_temporal_bundles.py
+++ b/tests/test_temporal_bundles.py
@@ -11,15 +11,34 @@ KNOBS = {"hop_decay": 0.5, "max_members": 6, "budget_words": 700}
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
+def test_member_door_shield_blocks_currently_ineligible(monkeypatch):
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
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "other")
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is True
 
 
 def _temporal_index() -> str:

```

## Patch B

```diff
diff --git a/README.md b/README.md
index 29360bd..09123cc 100644
--- a/README.md
+++ b/README.md
@@ -83,7 +83,10 @@ The standing contract with per-phase gates and as-built status lives in
   add a second predicate.
 - The temporal columns are the fourth seam's reference implementation:
   validity tstzranges, currently_privileged, the disclosure-safe/audit
-  policy in `_filters`.
+  policy in `_filters`. `DOOR_RETRO_ELIGIBILITY=shield` (opt-in) also hides
+  records archived/excluded after T from non-audit as-of queries via
+  `currently_eligible`; see `docs/POLICY-retro-eligibility.md`. Temporal
+  indexes built before that column existed must be rebuilt.
 - The calibration artifact, champion configs and analyst proposals promote
   through ai_configs and the agent_runs/agent_findings quarantine flow.
 - Per-epoch embedding identity ships in index_registry.
diff --git a/docs/POLICY-retro-eligibility.md b/docs/POLICY-retro-eligibility.md
new file mode 100644
index 0000000..b8d544c
--- /dev/null
+++ b/docs/POLICY-retro-eligibility.md
@@ -0,0 +1,68 @@
+# Decision needed: should as-of answers show records archived or excluded later?
+
+**Audience:** policy owners. **Status:** ruling pending. **Default until ruled:** Policy A.
+
+## The question
+
+A user asks "what did we know on date T?". Some records were eligible for retrieval on T
+but have **since been archived or excluded from retrieval**. Should the as-of answer
+include them?
+
+The written policy and the code disagreed. The system now supports both answers; you
+choose which one a deployment runs.
+
+## Policy A: history as it was (current default)
+
+A record that was eligible at T is returned for an as-of-T query, even if it has since
+been archived or excluded.
+
+- Matches the record's own state at T.
+- Risk: the answer surfaces material the organisation has since withdrawn from retrieval.
+
+## Policy B: shield
+
+A record that is **not eligible today** is never returned to a normal as-of query,
+whatever its state at T.
+
+- Withdrawal from retrieval takes effect retroactively.
+- Cost: as-of answers can omit records that genuinely existed and were eligible at T.
+- Applies at all three doors: the main retrieval door, the per-member check inside
+  evidence bundles, and the graph join door (a joined doc is dropped if any of its rows
+  is currently ineligible).
+
+## Example
+
+Risk R-17 was eligible from week 1. In week 5 it was archived (excluded from retrieval).
+Today is week 8.
+
+| Query | Policy A | Policy B |
+|---|---|---|
+| as-of week 3 (normal) | R-17 returned | R-17 **not** returned |
+| as-of week 6 (normal) | not returned (already excluded at T) | not returned |
+| as-of week 3, audit mode | R-17 returned | R-17 returned |
+
+Audit mode (`temporal_mode="audit"`) is unaffected by either policy: it always shows the
+record's own state at T. Non-temporal (current-state) indexes are also unaffected.
+
+## The switch
+
+Set the deployment environment variable:
+
+```
+DOOR_RETRO_ELIGIBILITY=shield    # Policy B
+```
+
+Unset, or any other value, means Policy A. The variable is read on every query; no code
+change is needed to flip it.
+
+## Operational note
+
+Policy B depends on a new `currently_eligible` column (default true) on temporal chunk
+tables. **Existing temporal indexes must be rebuilt** (e.g. `harness timegate`) to get the
+column. Bundle assembly and graph joins read the column under either policy, so rebuild
+regardless of which policy is chosen; an old index fails on the missing column.
+
+## What we need from you
+
+Reply with "A" or "B". We will set the deployment value accordingly and, once ruled,
+remove the unused path.
diff --git a/src/harness/bundle.py b/src/harness/bundle.py
index 20f8109..18e53ec 100644
--- a/src/harness/bundle.py
+++ b/src/harness/bundle.py
@@ -20,18 +20,22 @@ from __future__ import annotations
 from typing import Any
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_applies
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
+    if shield_applies(context, temporal) and not currently_eligible:
+        return False
     return not (temporal and currently_privileged and not context.can_see_privileged
                 and context.temporal_mode != "audit")
 
@@ -39,8 +43,9 @@ def _member_door_ok(eligibility: str, is_privileged: bool, currently_privileged:
 def _neighbor_info(neighbor_ids: set[str], index_version: str,
                    context: QueryContext, temporal: bool) -> dict[str, tuple]:
     """doc_id -> (subject_type, eligibility, is_privileged,
-    currently_privileged, title, content). On temporal tables the row is the
-    interval containing T (or now), so state and text are version-correct."""
+    currently_privileged, currently_eligible, title, content). On temporal
+    tables the row is the interval containing T (or now), so state and text
+    are version-correct."""
     if not neighbor_ids:
         return {}
     table = chunk_table(index_version)
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
index 840513b..5df95ef 100644
--- a/src/harness/door.py
+++ b/src/harness/door.py
@@ -7,8 +7,24 @@ graph executor all build their filters here so the door cannot drift apart.
 """
 from __future__ import annotations
 
+import os
+
 from .ports import QueryContext
 
+RETRO_ELIGIBILITY_ENV = "DOOR_RETRO_ELIGIBILITY"
+
+
+def retro_shield() -> bool:
+    """Policy B switch, read per call so a deployment change needs no code
+    reload. Only the exact value 'shield' enables it; anything else is Policy A."""
+    return os.environ.get(RETRO_ELIGIBILITY_ENV) == "shield"
+
+
+def shield_applies(context: QueryContext, temporal: bool) -> bool:
+    """True when later archival/exclusion must hide a record at every door:
+    shield mode on, temporal index, and not an audit query."""
+    return temporal and context.temporal_mode != "audit" and retro_shield()
+
 
 def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
     """WHERE fragment (no leading WHERE) plus positional params.
@@ -34,4 +50,6 @@ def door_where(context: QueryContext, temporal: bool) -> tuple[str, list]:
         f += " AND is_privileged = false"
         if context.temporal_mode != "audit":
             f += " AND currently_privileged = false"
+    if shield_applies(context, True):
+        f += " AND currently_eligible"
     return f, params
diff --git a/src/harness/graph_exec.py b/src/harness/graph_exec.py
index 184db2b..4a84731 100644
--- a/src/harness/graph_exec.py
+++ b/src/harness/graph_exec.py
@@ -17,6 +17,7 @@ from __future__ import annotations
 import re
 
 from .db import chunk_table, connect, is_temporal
+from .door import shield_applies
 from .ports import QueryContext
 
 V1_DB = "v1raw"
@@ -131,18 +132,20 @@ class GraphExecutor:
             else:
                 time_pred = " AND validity @> now()"
         curr_col = "bool_or(currently_privileged)" if temporal else "false"
+        curr_elig_col = "bool_and(currently_eligible)" if temporal else "true"
         with connect("harness") as conn:
             rows = conn.execute(
                 f"""SELECT doc_id,
                            bool_and(eligibility = 'eligible'),
                            bool_or(is_privileged),
-                           {curr_col}
+                           {curr_col},
+                           {curr_elig_col}
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
@@ -150,6 +153,8 @@ class GraphExecutor:
             if (temporal and any_curr and not context.can_see_privileged
                     and context.temporal_mode != "audit"):
                 continue
+            if shield_applies(context, temporal) and not all_curr_elig:
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
index 1102bbd..9aec360 100644
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
+        eligibility in its latest state (read only under the shield policy).
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
index 01d4118..bca9564 100644
--- a/tests/test_door.py
+++ b/tests/test_door.py
@@ -36,3 +36,26 @@ def test_temporal_unscoped_uses_now():
     where, params = door_where(QueryContext(), temporal=True)
     assert where.startswith("validity @> now()")
     assert params == []
+
+
+def test_retro_eligibility_default_has_no_predicate(monkeypatch):
+    monkeypatch.delenv("DOOR_RETRO_ELIGIBILITY", raising=False)
+    where, _ = door_where(QueryContext(as_known_at=T), temporal=True)
+    assert "currently_eligible" not in where
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "SHIELD")
+    where, _ = door_where(QueryContext(as_known_at=T), temporal=True)
+    assert "currently_eligible" not in where
+
+
+def test_retro_eligibility_shield_adds_predicate_except_audit_and_plain(monkeypatch):
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "shield")
+    where, _ = door_where(QueryContext(as_known_at=T), temporal=True)
+    assert where.endswith(" AND currently_eligible")
+    where, _ = door_where(QueryContext(as_known_at=T, can_see_privileged=True),
+                          temporal=True)
+    assert where.endswith(" AND currently_eligible")
+    where, _ = door_where(QueryContext(as_known_at=T, temporal_mode="audit"),
+                          temporal=True)
+    assert "currently_eligible" not in where
+    where, _ = door_where(QueryContext(), temporal=False)
+    assert "currently_eligible" not in where
diff --git a/tests/test_temporal_bundles.py b/tests/test_temporal_bundles.py
index 07f8a36..abc2257 100644
--- a/tests/test_temporal_bundles.py
+++ b/tests/test_temporal_bundles.py
@@ -11,15 +11,39 @@ KNOBS = {"hop_decay": 0.5, "max_members": 6, "budget_words": 700}
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
+    # Policy A: eligible at T, archived since -> still shown
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is True
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "other")
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is True
+    monkeypatch.setenv("DOOR_RETRO_ELIGIBILITY", "shield")
+    # Policy B: hidden, even for privileged-capable callers
+    assert _member_door_ok("eligible", False, False, False, ctx, temporal=True) is False
+    priv = QueryContext(as_known_at=ctx.as_known_at, can_see_privileged=True)
+    assert _member_door_ok("eligible", False, False, False, priv, temporal=True) is False
+    assert _member_door_ok("eligible", False, False, True, ctx, temporal=True) is True
+    # audit and non-temporal unaffected
+    assert _member_door_ok("eligible", False, False, False, ctx_audit,
+                           temporal=True) is True
+    assert _member_door_ok("eligible", False, False, False, QueryContext(),
+                           temporal=False) is True
 
 
 def _temporal_index() -> str:

```
