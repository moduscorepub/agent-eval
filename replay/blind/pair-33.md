# Pair 33 (open-seo-14532413)

Which patch would you merge? Answer in answers.md as `33: A`, `33: B`, or `33: =` if you cannot tell.

## Issue

Site-audit crawls run out of memory on fast sites; cap in-flight HTML

Production site audits have died with `exceededMemory`. The workflow shares a 128 MB isolate with the rest of the worker. When a site answers quickly, the adaptive crawl window grows to 40 concurrent fetches. Each in-flight page holds its body, decoded to a UTF-16 string, so memory use is about double the HTML size. Pages fetched but not yet written can also pile up without limit, because persistence runs one batch at a time and a fast site can outpace the database.

Desired behavior:

- `adjustCrawlWindow(windowSize, recent)` should keep the window small enough that average page size times window size stays within a 16 MiB in-flight HTML budget.
  - 1 MiB average pages should cap the window at 16.
  - The window should never drop below the minimum of 5, even for very large pages (4 MiB average gives 5).
  - For the budget calculation, treat the average page size as at least 64 KiB, so tiny pages can't disable the cap.
  - Small pages should still be able to use the full window cap.
- Heavy pages should no longer count as "trouble" that halves the window or blocks growth. Only non-ok fetches and very slow responses should do that. The byte budget now handles heavy pages.
- The initial window should be 10 instead of 25, and the maximum should be 20 instead of 40. Growth steps stay at +5 on clean, fast batches.
- The per-page HTML read cap should drop from 2 MiB to 1 MiB.
- Blocked and error pages are also fetched and buffered, so they should report their body size as `htmlBytes` instead of 0. The byte budget then counts them.
- The crawl loop should stop launching new fetches while more than 2 persist sub-batches are queued. It should resume once the queue drains, and it must not end the chunk early just because nothing is in flight while it waits.

## Patch A

```diff
diff --git a/src/server/lib/audit/crawl-window.test.ts b/src/server/lib/audit/crawl-window.test.ts
index c5c5a39..743b2c5 100644
--- a/src/server/lib/audit/crawl-window.test.ts
+++ b/src/server/lib/audit/crawl-window.test.ts
@@ -51,7 +51,7 @@ function page(
 
 describe("adjustCrawlWindow", () => {
   it("keeps the window on an empty batch", () => {
-    expect(adjustCrawlWindow(25, [])).toBe(25);
+    expect(adjustCrawlWindow(10, [])).toBe(10);
   });
 
   it("halves the window when a third of the batch is troubled", () => {
@@ -59,7 +59,7 @@ describe("adjustCrawlWindow", () => {
       ...Array.from({ length: 9 }, () => page("error", 15_000)),
       ...Array.from({ length: 16 }, () => page("ok", 500)),
     ];
-    expect(adjustCrawlWindow(25, recent)).toBe(12);
+    expect(adjustCrawlWindow(20, recent)).toBe(10);
   });
 
   it("treats blocked fetches as trouble", () => {
@@ -72,29 +72,45 @@ describe("adjustCrawlWindow", () => {
     expect(adjustCrawlWindow(6, recent)).toBe(5);
   });
 
-  it("grows on a clean, fast batch up to the cap", () => {
+  it("grows by 5 on a clean, fast batch up to the cap", () => {
     const recent = Array.from({ length: 25 }, () => page("ok", 400));
-    expect(adjustCrawlWindow(25, recent)).toBe(30);
-    expect(adjustCrawlWindow(40, recent)).toBe(40);
+    expect(adjustCrawlWindow(10, recent)).toBe(15);
+    expect(adjustCrawlWindow(18, recent)).toBe(20);
+    expect(adjustCrawlWindow(20, recent)).toBe(20);
+  });
+
+  it("caps the window by the in-flight HTML budget", () => {
+    const mib = Array.from({ length: 10 }, () => page("ok", 300, 1024 * 1024));
+    expect(adjustCrawlWindow(20, mib)).toBe(16);
+    expect(adjustCrawlWindow(10, mib)).toBe(15);
   });
 
-  it("treats heavy pages as trouble even when they respond fast", () => {
-    const recent = Array.from({ length: 25 }, () =>
-      page("ok", 300, 2 * 1024 * 1024),
+  it("never drops below the minimum for very large pages", () => {
+    const huge = Array.from({ length: 10 }, () =>
+      page("ok", 300, 4 * 1024 * 1024),
     );
-    expect(adjustCrawlWindow(25, recent)).toBe(12);
+    expect(adjustCrawlWindow(20, huge)).toBe(5);
   });
 
-  it("does not grow when some pages are heavy", () => {
-    const recent = [
-      ...Array.from({ length: 4 }, () => page("ok", 300, 1024 * 1024)),
-      ...Array.from({ length: 21 }, () => page("ok", 300)),
-    ];
-    expect(adjustCrawlWindow(25, recent)).toBe(25);
+  it("does not let tiny pages disable the cap or the full window", () => {
+    const tiny = Array.from({ length: 10 }, () => page("ok", 300, 0));
+    expect(adjustCrawlWindow(20, tiny)).toBe(20);
+  });
+
+  it("does not treat heavy fast pages as trouble", () => {
+    const recent = Array.from({ length: 10 }, () =>
+      page("ok", 300, 512 * 1024),
+    );
+    expect(adjustCrawlWindow(10, recent)).toBe(15);
   });
 
   it("holds steady on a clean but slow batch", () => {
     const recent = Array.from({ length: 25 }, () => page("ok", 5_000));
-    expect(adjustCrawlWindow(25, recent)).toBe(25);
+    expect(adjustCrawlWindow(10, recent)).toBe(10);
+  });
+
+  it("shrinks on very slow responses", () => {
+    const recent = Array.from({ length: 10 }, () => page("ok", 12_000));
+    expect(adjustCrawlWindow(20, recent)).toBe(10);
   });
 });
diff --git a/src/server/lib/audit/crawl-window.ts b/src/server/lib/audit/crawl-window.ts
index 59fca1e..7546358 100644
--- a/src/server/lib/audit/crawl-window.ts
+++ b/src/server/lib/audit/crawl-window.ts
@@ -5,38 +5,44 @@ import type { CrawledPageResult } from "@/server/lib/audit/types";
  * slow page only occupies one slot instead of stalling a whole batch. The
  * window adapts to the site: it shrinks when fetches error/block/crawl
  * slowly (politeness toward struggling or defensive sites) and grows when
- * the site answers fast.
+ * the site answers fast. A byte budget additionally caps the window so
+ * in-flight HTML bodies fit in the workflow's shared 128 MB isolate.
  */
-export const INITIAL_CRAWL_WINDOW = 25;
+export const INITIAL_CRAWL_WINDOW = 10;
 const MIN_WINDOW = 5;
-const MAX_WINDOW = 40;
+const MAX_WINDOW = 20;
 const SLOW_RESPONSE_MS = 10_000;
 const FAST_RESPONSE_MS = 1_500;
-/**
- * Pages at/above this HTML size count as trouble: each in-flight page
- * buffers its body, so a wide window on a heavy-page site is memory
- * pressure the response time can't see (it's measured at headers).
- */
-const HEAVY_PAGE_BYTES = 1024 * 1024;
+/** Budget for HTML held by in-flight fetches (average page bytes × window). */
+const IN_FLIGHT_HTML_BUDGET_BYTES = 16 * 1024 * 1024;
+/** Floor for the average page size so tiny pages can't disable the cap. */
+const MIN_AVG_PAGE_BYTES = 64 * 1024;
 
 /**
  * Adapt the window to the last persisted sub-batch. Shrinks on trouble
- * (errors, blocks, very slow responses, heavy bodies), grows only on a
- * clean and mostly-fast batch.
+ * (errors, blocks, very slow responses), grows only on a clean and
+ * mostly-fast batch, and is always capped by the in-flight HTML budget.
  */
 export function adjustCrawlWindow(
   windowSize: number,
   recent: CrawledPageResult[],
 ): number {
   if (recent.length === 0) return windowSize;
+
+  const totalBytes = recent.reduce((sum, page) => sum + page.htmlBytes, 0);
+  const avgBytes = Math.max(MIN_AVG_PAGE_BYTES, totalBytes / recent.length);
+  const byteCap = Math.max(
+    MIN_WINDOW,
+    Math.min(MAX_WINDOW, Math.floor(IN_FLIGHT_HTML_BUDGET_BYTES / avgBytes)),
+  );
+
   const troubled = recent.filter(
     (page) =>
       page.fetchClass !== "ok" ||
-      (page.responseTimeMs ?? 0) >= SLOW_RESPONSE_MS ||
-      page.htmlBytes >= HEAVY_PAGE_BYTES,
+      (page.responseTimeMs ?? 0) >= SLOW_RESPONSE_MS,
   ).length;
   if (troubled * 3 >= recent.length) {
-    return Math.max(MIN_WINDOW, Math.floor(windowSize / 2));
+    return Math.min(byteCap, Math.max(MIN_WINDOW, Math.floor(windowSize / 2)));
   }
   const fast = recent.filter(
     (page) =>
@@ -44,7 +50,7 @@ export function adjustCrawlWindow(
       (page.responseTimeMs ?? Infinity) <= FAST_RESPONSE_MS,
   ).length;
   if (troubled === 0 && fast * 2 >= recent.length) {
-    return Math.min(MAX_WINDOW, windowSize + 5);
+    return Math.min(byteCap, windowSize + 5);
   }
-  return windowSize;
+  return Math.min(byteCap, windowSize);
 }
diff --git a/src/server/workflows/site-audit-workflow-helpers.ts b/src/server/workflows/site-audit-workflow-helpers.ts
index cf46382..5b9b0e1 100644
--- a/src/server/workflows/site-audit-workflow-helpers.ts
+++ b/src/server/workflows/site-audit-workflow-helpers.ts
@@ -6,7 +6,7 @@ import { sha256Hex } from "@/server/lib/audit/ids";
 import { normalizeUrl } from "@/server/lib/audit/url-utils";
 
 const CRAWL_USER_AGENT = "OpenSEO-Audit/1.0";
-const MAX_HTML_BYTES = 2 * 1024 * 1024;
+const MAX_HTML_BYTES = 1024 * 1024;
 
 /**
  * Markers of a bot-mitigation challenge page. We classify these honestly as
@@ -99,12 +99,13 @@ export async function crawlPage(
         headerCanonicalUrl,
         crawlDepth,
         inSitemap,
+        htmlBytes: 0,
       });
     }
 
     const contentType = response.headers.get("content-type") ?? "";
     const isHtml = contentType.includes("text/html");
-    // Cap what we read: the first 2 MiB still contains the SEO metadata and
+    // Cap what we read: the first 1 MiB still contains the SEO metadata and
     // navigation needed by the audit in normal documents.
     const body = isHtml ? await readTextUpTo(response, MAX_HTML_BYTES) : "";
     const fetchClass = classifyFetch(
@@ -124,6 +125,7 @@ export async function crawlPage(
         headerCanonicalUrl,
         crawlDepth,
         inSitemap,
+        htmlBytes: body.length,
       });
     }
 
@@ -198,6 +200,7 @@ export async function crawlPage(
       headerCanonicalUrl: null,
       crawlDepth,
       inSitemap,
+      htmlBytes: 0,
     });
   }
 }
@@ -244,6 +247,7 @@ function emptyPageResult(input: {
   headerCanonicalUrl: string | null;
   crawlDepth: number | null;
   inSitemap: boolean;
+  htmlBytes: number;
 }): CrawledPageResult {
   return {
     id: crypto.randomUUID(),
@@ -270,7 +274,7 @@ function emptyPageResult(input: {
     wordCount: 0,
     contentHash: null,
     isHtml: false,
-    htmlBytes: 0,
+    htmlBytes: input.htmlBytes,
     imagesTotal: 0,
     imagesMissingAlt: 0,
     images: [],
diff --git a/src/server/workflows/siteAuditWorkflowCrawl.ts b/src/server/workflows/siteAuditWorkflowCrawl.ts
index 0be7859..edad788 100644
--- a/src/server/workflows/siteAuditWorkflowCrawl.ts
+++ b/src/server/workflows/siteAuditWorkflowCrawl.ts
@@ -34,6 +34,8 @@ const CHUNK_TARGET_PAGES = 200;
 const CHUNK_SOFT_DEADLINE_MS = 90_000;
 /** Crawled pages are persisted in sub-batches of this size. */
 const PERSIST_BATCH_SIZE = 25;
+/** Stop launching fetches while more than this many sub-batches await persistence. */
+const MAX_QUEUED_BATCHES = 2;
 
 /**
  * Mega-menu/footer-heavy sites can carry 1000+ links per page; cap what we
@@ -145,25 +147,33 @@ async function runCrawlChunk(
   let batch: CrawledPageResult[] = [];
   // Persistence runs concurrently with fetching (pipelined) but sequentially
   // with itself, so DB write pressure stays bounded at one batch at a time.
+  // `queuedBatches` counts sub-batches queued or running; the fetch loop
+  // pauses while more than MAX_QUEUED_BATCHES are waiting.
   let persistChain: Promise<unknown> = Promise.resolve();
+  let queuedBatches = 0;
 
   const flush = () => {
     if (batch.length === 0) return;
     const pages = batch;
     batch = [];
     windowSize = adjustCrawlWindow(windowSize, pages);
-    persistChain = persistChain.then(() =>
-      persistCrawledPages({
-        auditId,
-        workflowInstanceId,
-        origin,
-        robots,
-        scratchpad,
-        pages,
-        depthByUrl,
-        maxPages,
-      }),
-    );
+    queuedBatches += 1;
+    persistChain = persistChain.then(async () => {
+      try {
+        await persistCrawledPages({
+          auditId,
+          workflowInstanceId,
+          origin,
+          robots,
+          scratchpad,
+          pages,
+          depthByUrl,
+          maxPages,
+        });
+      } finally {
+        queuedBatches -= 1;
+      }
+    });
   };
 
   const launch = (entry: ClaimedUrl) => {
@@ -180,16 +190,23 @@ async function runCrawlChunk(
   };
 
   while (true) {
+    // Backpressure: don't launch more fetches while the DB is behind, or
+    // fetched pages pile up in memory.
     while (
       inFlight.size < windowSize &&
+      queuedBatches <= MAX_QUEUED_BATCHES &&
       nextIndex < claimed.length &&
       Date.now() < deadlineAt
     ) {
       launch(claimed[nextIndex]);
       nextIndex += 1;
     }
-    if (inFlight.size === 0) break;
-    await Promise.race(inFlight);
+    const canLaunchMore = nextIndex < claimed.length && Date.now() < deadlineAt;
+    if (inFlight.size === 0 && !canLaunchMore) break;
+    // Launching paused by backpressure: also wake when the queue drains, so
+    // an empty in-flight set doesn't end the chunk early.
+    const paused = queuedBatches > MAX_QUEUED_BATCHES;
+    await Promise.race([...inFlight, ...(paused ? [persistChain] : [])]);
   }
   flush();
   await persistChain;

```

## Patch B

```diff
diff --git a/src/server/lib/audit/crawl-window.test.ts b/src/server/lib/audit/crawl-window.test.ts
index c5c5a39..4dea330 100644
--- a/src/server/lib/audit/crawl-window.test.ts
+++ b/src/server/lib/audit/crawl-window.test.ts
@@ -51,7 +51,7 @@ function page(
 
 describe("adjustCrawlWindow", () => {
   it("keeps the window on an empty batch", () => {
-    expect(adjustCrawlWindow(25, [])).toBe(25);
+    expect(adjustCrawlWindow(10, [])).toBe(10);
   });
 
   it("halves the window when a third of the batch is troubled", () => {
@@ -59,7 +59,7 @@ describe("adjustCrawlWindow", () => {
       ...Array.from({ length: 9 }, () => page("error", 15_000)),
       ...Array.from({ length: 16 }, () => page("ok", 500)),
     ];
-    expect(adjustCrawlWindow(25, recent)).toBe(12);
+    expect(adjustCrawlWindow(20, recent)).toBe(10);
   });
 
   it("treats blocked fetches as trouble", () => {
@@ -72,29 +72,35 @@ describe("adjustCrawlWindow", () => {
     expect(adjustCrawlWindow(6, recent)).toBe(5);
   });
 
-  it("grows on a clean, fast batch up to the cap", () => {
+  it("grows by 5 on a clean, fast batch up to the cap", () => {
     const recent = Array.from({ length: 25 }, () => page("ok", 400));
-    expect(adjustCrawlWindow(25, recent)).toBe(30);
-    expect(adjustCrawlWindow(40, recent)).toBe(40);
+    expect(adjustCrawlWindow(10, recent)).toBe(15);
+    expect(adjustCrawlWindow(20, recent)).toBe(20);
   });
 
-  it("treats heavy pages as trouble even when they respond fast", () => {
+  it("does not treat heavy pages as trouble", () => {
     const recent = Array.from({ length: 25 }, () =>
-      page("ok", 300, 2 * 1024 * 1024),
+      page("ok", 300, 512 * 1024),
     );
-    expect(adjustCrawlWindow(25, recent)).toBe(12);
+    expect(adjustCrawlWindow(10, recent)).toBe(15);
   });
 
-  it("does not grow when some pages are heavy", () => {
-    const recent = [
-      ...Array.from({ length: 4 }, () => page("ok", 300, 1024 * 1024)),
-      ...Array.from({ length: 21 }, () => page("ok", 300)),
-    ];
-    expect(adjustCrawlWindow(25, recent)).toBe(25);
+  it("caps the window by the in-flight HTML byte budget", () => {
+    const mib = 1024 * 1024;
+    const clean = (bytes: number) =>
+      Array.from({ length: 25 }, () => page("ok", 300, bytes));
+    expect(adjustCrawlWindow(20, clean(mib))).toBe(16);
+    expect(adjustCrawlWindow(10, clean(4 * mib))).toBe(5);
+    expect(adjustCrawlWindow(20, clean(10_000))).toBe(20);
+  });
+
+  it("floors the average page size at 64 KiB for the budget", () => {
+    const recent = Array.from({ length: 25 }, () => page("ok", 5_000, 0));
+    expect(adjustCrawlWindow(20, recent)).toBe(20);
   });
 
   it("holds steady on a clean but slow batch", () => {
     const recent = Array.from({ length: 25 }, () => page("ok", 5_000));
-    expect(adjustCrawlWindow(25, recent)).toBe(25);
+    expect(adjustCrawlWindow(10, recent)).toBe(10);
   });
 });
diff --git a/src/server/lib/audit/crawl-window.ts b/src/server/lib/audit/crawl-window.ts
index 59fca1e..bc058bd 100644
--- a/src/server/lib/audit/crawl-window.ts
+++ b/src/server/lib/audit/crawl-window.ts
@@ -5,24 +5,26 @@ import type { CrawledPageResult } from "@/server/lib/audit/types";
  * slow page only occupies one slot instead of stalling a whole batch. The
  * window adapts to the site: it shrinks when fetches error/block/crawl
  * slowly (politeness toward struggling or defensive sites) and grows when
- * the site answers fast.
+ * the site answers fast. It is also capped so in-flight HTML stays within
+ * a fixed byte budget.
  */
-export const INITIAL_CRAWL_WINDOW = 25;
+export const INITIAL_CRAWL_WINDOW = 10;
 const MIN_WINDOW = 5;
-const MAX_WINDOW = 40;
+const MAX_WINDOW = 20;
 const SLOW_RESPONSE_MS = 10_000;
 const FAST_RESPONSE_MS = 1_500;
 /**
- * Pages at/above this HTML size count as trouble: each in-flight page
- * buffers its body, so a wide window on a heavy-page site is memory
- * pressure the response time can't see (it's measured at headers).
+ * Budget for HTML buffered by in-flight fetches. The workflow shares a
+ * 128 MB isolate and each body is held as a UTF-16 string (~2x its size).
  */
-const HEAVY_PAGE_BYTES = 1024 * 1024;
+const IN_FLIGHT_HTML_BUDGET_BYTES = 16 * 1024 * 1024;
+/** Floor on the assumed average page size so tiny pages can't disable the cap. */
+const MIN_AVG_PAGE_BYTES = 64 * 1024;
 
 /**
  * Adapt the window to the last persisted sub-batch. Shrinks on trouble
- * (errors, blocks, very slow responses, heavy bodies), grows only on a
- * clean and mostly-fast batch.
+ * (errors, blocks, very slow responses), grows only on a clean and
+ * mostly-fast batch, and is always capped by the in-flight HTML budget.
  */
 export function adjustCrawlWindow(
   windowSize: number,
@@ -32,19 +34,27 @@ export function adjustCrawlWindow(
   const troubled = recent.filter(
     (page) =>
       page.fetchClass !== "ok" ||
-      (page.responseTimeMs ?? 0) >= SLOW_RESPONSE_MS ||
-      page.htmlBytes >= HEAVY_PAGE_BYTES,
+      (page.responseTimeMs ?? 0) >= SLOW_RESPONSE_MS,
   ).length;
+  let next = windowSize;
   if (troubled * 3 >= recent.length) {
-    return Math.max(MIN_WINDOW, Math.floor(windowSize / 2));
+    next = Math.max(MIN_WINDOW, Math.floor(windowSize / 2));
+  } else {
+    const fast = recent.filter(
+      (page) =>
+        page.fetchClass === "ok" &&
+        (page.responseTimeMs ?? Infinity) <= FAST_RESPONSE_MS,
+    ).length;
+    if (troubled === 0 && fast * 2 >= recent.length) {
+      next = Math.min(MAX_WINDOW, windowSize + 5);
+    }
   }
-  const fast = recent.filter(
-    (page) =>
-      page.fetchClass === "ok" &&
-      (page.responseTimeMs ?? Infinity) <= FAST_RESPONSE_MS,
-  ).length;
-  if (troubled === 0 && fast * 2 >= recent.length) {
-    return Math.min(MAX_WINDOW, windowSize + 5);
-  }
-  return windowSize;
+
+  const totalBytes = recent.reduce((sum, page) => sum + page.htmlBytes, 0);
+  const avgBytes = Math.max(MIN_AVG_PAGE_BYTES, totalBytes / recent.length);
+  const byteCap = Math.max(
+    MIN_WINDOW,
+    Math.floor(IN_FLIGHT_HTML_BUDGET_BYTES / avgBytes),
+  );
+  return Math.min(next, byteCap);
 }
diff --git a/src/server/workflows/site-audit-workflow-helpers.ts b/src/server/workflows/site-audit-workflow-helpers.ts
index cf46382..ed12dae 100644
--- a/src/server/workflows/site-audit-workflow-helpers.ts
+++ b/src/server/workflows/site-audit-workflow-helpers.ts
@@ -6,7 +6,7 @@ import { sha256Hex } from "@/server/lib/audit/ids";
 import { normalizeUrl } from "@/server/lib/audit/url-utils";
 
 const CRAWL_USER_AGENT = "OpenSEO-Audit/1.0";
-const MAX_HTML_BYTES = 2 * 1024 * 1024;
+const MAX_HTML_BYTES = 1024 * 1024;
 
 /**
  * Markers of a bot-mitigation challenge page. We classify these honestly as
@@ -104,7 +104,7 @@ export async function crawlPage(
 
     const contentType = response.headers.get("content-type") ?? "";
     const isHtml = contentType.includes("text/html");
-    // Cap what we read: the first 2 MiB still contains the SEO metadata and
+    // Cap what we read: the first 1 MiB still contains the SEO metadata and
     // navigation needed by the audit in normal documents.
     const body = isHtml ? await readTextUpTo(response, MAX_HTML_BYTES) : "";
     const fetchClass = classifyFetch(
@@ -124,6 +124,7 @@ export async function crawlPage(
         headerCanonicalUrl,
         crawlDepth,
         inSitemap,
+        htmlBytes: body.length,
       });
     }
 
@@ -244,6 +245,7 @@ function emptyPageResult(input: {
   headerCanonicalUrl: string | null;
   crawlDepth: number | null;
   inSitemap: boolean;
+  htmlBytes?: number;
 }): CrawledPageResult {
   return {
     id: crypto.randomUUID(),
@@ -270,7 +272,7 @@ function emptyPageResult(input: {
     wordCount: 0,
     contentHash: null,
     isHtml: false,
-    htmlBytes: 0,
+    htmlBytes: input.htmlBytes ?? 0,
     imagesTotal: 0,
     imagesMissingAlt: 0,
     images: [],
diff --git a/src/server/workflows/siteAuditWorkflowCrawl.ts b/src/server/workflows/siteAuditWorkflowCrawl.ts
index 0be7859..cced034 100644
--- a/src/server/workflows/siteAuditWorkflowCrawl.ts
+++ b/src/server/workflows/siteAuditWorkflowCrawl.ts
@@ -34,6 +34,8 @@ const CHUNK_TARGET_PAGES = 200;
 const CHUNK_SOFT_DEADLINE_MS = 90_000;
 /** Crawled pages are persisted in sub-batches of this size. */
 const PERSIST_BATCH_SIZE = 25;
+/** Stop launching fetches while more than this many sub-batches await persistence. */
+const MAX_QUEUED_PERSIST_BATCHES = 2;
 
 /**
  * Mega-menu/footer-heavy sites can carry 1000+ links per page; cap what we
@@ -146,13 +148,17 @@ async function runCrawlChunk(
   // Persistence runs concurrently with fetching (pipelined) but sequentially
   // with itself, so DB write pressure stays bounded at one batch at a time.
   let persistChain: Promise<unknown> = Promise.resolve();
+  // Sub-batches queued or running; each settles (never rejects) when done.
+  // Fetching pauses while too many are waiting so fetched pages can't pile
+  // up in memory faster than the database absorbs them.
+  const queuedPersists = new Set<Promise<void>>();
 
   const flush = () => {
     if (batch.length === 0) return;
     const pages = batch;
     batch = [];
     windowSize = adjustCrawlWindow(windowSize, pages);
-    persistChain = persistChain.then(() =>
+    const persisted = persistChain.then(() =>
       persistCrawledPages({
         auditId,
         workflowInstanceId,
@@ -164,6 +170,16 @@ async function runCrawlChunk(
         maxPages,
       }),
     );
+    persistChain = persisted;
+    const settled: Promise<void> = persisted
+      .then(
+        () => undefined,
+        () => undefined,
+      )
+      .then(() => {
+        queuedPersists.delete(settled);
+      });
+    queuedPersists.add(settled);
   };
 
   const launch = (entry: ClaimedUrl) => {
@@ -180,16 +196,22 @@ async function runCrawlChunk(
   };
 
   while (true) {
-    while (
-      inFlight.size < windowSize &&
-      nextIndex < claimed.length &&
-      Date.now() < deadlineAt
-    ) {
-      launch(claimed[nextIndex]);
-      nextIndex += 1;
+    const persistBacklogged = queuedPersists.size > MAX_QUEUED_PERSIST_BATCHES;
+    if (!persistBacklogged) {
+      while (
+        inFlight.size < windowSize &&
+        nextIndex < claimed.length &&
+        Date.now() < deadlineAt
+      ) {
+        launch(claimed[nextIndex]);
+        nextIndex += 1;
+      }
     }
-    if (inFlight.size === 0) break;
-    await Promise.race(inFlight);
+    const canLaunchMore = nextIndex < claimed.length && Date.now() < deadlineAt;
+    // Nothing in flight is only the end of the chunk when we aren't merely
+    // waiting for the persist queue to drain.
+    if (inFlight.size === 0 && !(persistBacklogged && canLaunchMore)) break;
+    await Promise.race([...inFlight, ...queuedPersists]);
   }
   flush();
   await persistChain;

```
