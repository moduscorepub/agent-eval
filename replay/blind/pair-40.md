# Pair 40 (open-seo-acd28749)

Which patch would you merge? Answer in answers.md as `40: A`, `40: B`, or `40: =` if you cannot tell.

## Issue

Search tabs: evict the oldest tab at capacity instead of blocking new searches, and raise the limit to 20

Search tabs on the backlinks, domain overview and keyword research pages are capped at 8. When the cap is reached, a new search is refused. The form shows "Close a tab to open more searches (max 8)." The keyword form also skips extra keywords from a multi-keyword submit. Users must close tabs by hand before they can search again.

Expected behavior:
- The cap is 20 tabs.
- Opening a new search when 20 tabs are already open drops the oldest tab (first in order) and appends the new one as the active tab. The list stays at 20.
- Below the cap, tabs are appended with no eviction.
- Opening a search that matches an existing tab still activates that tab and does not evict anything.
- A multi-keyword submit opens every keyword, evicting the oldest tabs as needed. The URL navigates to the last keyword submitted.
- Capacity errors and the "Close a tab…" and "N keywords skipped" messages are removed from all three search forms.

Persisted tab state is also affected. When stored state has more than 20 tabs, loading it should keep the newest 20, not the first ones.

Add an exported helper `appendTabWithEviction(tabs: SearchTab[], next: SearchTab): SearchTab[]`. It returns `tabs` plus `next`, with the oldest entries removed so the result has at most 20 items. Examples: 19 tabs plus a new one gives 20 with nothing evicted. 20 tabs plus a new one gives 20 with the first tab gone and the new one last.

`parseStoredState` should apply the same "keep newest" rule, so 25 stored tabs load as tabs 5–24.

## Patch A

```diff
diff --git a/src/client/features/backlinks/BacklinksPage.tsx b/src/client/features/backlinks/BacklinksPage.tsx
index c38cf98..53aa443 100644
--- a/src/client/features/backlinks/BacklinksPage.tsx
+++ b/src/client/features/backlinks/BacklinksPage.tsx
@@ -193,10 +193,6 @@ export function BacklinksPage({
         <BacklinksSearchCard
           errorMessage={overviewErrorMessage}
           initialValues={searchCardInitialValues}
-          canOpenSearch={(values) =>
-            searchTabs.canOpenTab(toBacklinksTabInput(values))
-          }
-          tabLimit={searchTabs.limit}
           onSubmit={(values) => {
             searchTabs.openTab(toBacklinksTabInput(values));
             navigateToBacklinksSearch(navigate, values);
diff --git a/src/client/features/backlinks/BacklinksSearchCard.tsx b/src/client/features/backlinks/BacklinksSearchCard.tsx
index 92a6e91..201ba82 100644
--- a/src/client/features/backlinks/BacklinksSearchCard.tsx
+++ b/src/client/features/backlinks/BacklinksSearchCard.tsx
@@ -18,14 +18,8 @@ type SearchDraft = Pick<BacklinksSearchState, "target" | "scope">;
 function getBacklinksValidationErrors(
   value: SearchDraft,
   shouldValidateUntouchedField: boolean,
-  canOpenSearch?: (value: SearchDraft) => boolean,
-  tabLimit?: number,
 ) {
-  if (!value.target.trim()) {
-    if (!shouldValidateUntouchedField) {
-      return null;
-    }
-
+  if (!value.target.trim() && shouldValidateUntouchedField) {
     return createFormValidationErrors({
       fields: {
         target: "Enter a domain or URL to analyze.",
@@ -33,34 +27,17 @@ function getBacklinksValidationErrors(
     });
   }
 
-  const normalizedValue = {
-    ...value,
-    target: value.target.trim(),
-  };
-
-  if (canOpenSearch && !canOpenSearch(normalizedValue)) {
-    return createFormValidationErrors({
-      fields: {
-        target: `Close a tab to open more searches (max ${tabLimit ?? 8}).`,
-      },
-    });
-  }
-
   return null;
 }
 
 export function BacklinksSearchCard({
-  canOpenSearch,
   errorMessage,
   initialValues,
   onSubmit,
-  tabLimit,
 }: {
-  canOpenSearch?: (values: SearchDraft) => boolean;
   errorMessage: string | null;
   initialValues: SearchDraft;
   onSubmit: (values: SearchDraft) => void;
-  tabLimit?: number;
 }) {
   const [userSelectedScope, setUserSelectedScope] = useState(false);
   const form = useForm({
@@ -70,11 +47,8 @@ export function BacklinksSearchCard({
         getBacklinksValidationErrors(
           value,
           shouldValidateFieldOnChange(formApi, "target"),
-          canOpenSearch,
-          tabLimit,
         ),
-      onSubmit: ({ value }) =>
-        getBacklinksValidationErrors(value, true, canOpenSearch, tabLimit),
+      onSubmit: ({ value }) => getBacklinksValidationErrors(value, true),
     },
     onSubmit: ({ value }) => {
       const target = value.target.trim();
diff --git a/src/client/features/domain/DomainOverviewPage.tsx b/src/client/features/domain/DomainOverviewPage.tsx
index c782046..fb51f8f 100644
--- a/src/client/features/domain/DomainOverviewPage.tsx
+++ b/src/client/features/domain/DomainOverviewPage.tsx
@@ -482,39 +482,6 @@ export function DomainOverviewPage({
     navigateToInput: navigateToSearchTab,
   });
 
-  const handleSearchSubmit = useCallback(
-    (event: FormEvent) => {
-      const values = state.controlsForm.state.values;
-      const target = normalizeDomainTarget(values.domain);
-      if (!target) {
-        state.handleSearchSubmit(event);
-        return;
-      }
-
-      const nextTabInput: SearchTabInput = {
-        type: "domain",
-        domain: target,
-        subdomains: values.subdomains,
-        locationCode: values.locationCode,
-      };
-
-      if (!searchTabs.canOpenTab(nextTabInput)) {
-        event.preventDefault();
-        state.controlsForm.setErrorMap({
-          onSubmit: createFormValidationErrors({
-            fields: {
-              domain: `Close a tab to open more searches (max ${searchTabs.limit}).`,
-            },
-          }),
-        });
-        return;
-      }
-
-      state.handleSearchSubmit(event);
-    },
-    [searchTabs, state],
-  );
-
   const tabControls = routeState.domain ? (
     <div className="flex flex-col gap-2">
       <div>
@@ -555,7 +522,7 @@ export function DomainOverviewPage({
         <DomainSearchCard
           controlsForm={state.controlsForm}
           isLoading={state.isLoading}
-          onSubmit={handleSearchSubmit}
+          onSubmit={state.handleSearchSubmit}
           onSortChange={(sort) =>
             state.applySort(sort, getDefaultSortOrder(sort))
           }
diff --git a/src/client/features/keywords/hooks/useKeywordControlsForm.ts b/src/client/features/keywords/hooks/useKeywordControlsForm.ts
index 92d381a..024fed5 100644
--- a/src/client/features/keywords/hooks/useKeywordControlsForm.ts
+++ b/src/client/features/keywords/hooks/useKeywordControlsForm.ts
@@ -11,22 +11,12 @@ import {
 } from "@/client/features/keywords/keywordResearchTypes";
 import { parseKeywordInput } from "@/client/features/keywords/state/keywordControllerActions";
 
-type KeywordTabValidationInput = {
-  keyword: string;
-  locationCode: number | undefined;
-  resultLimit: ResultLimit;
-  mode: KeywordMode;
-  clickstream: boolean;
-};
-
 type UseKeywordControlsFormInput = {
   keywordInput: string;
   locationCode: number;
   resultLimit: ResultLimit;
   keywordMode: KeywordMode;
   clickstream: boolean;
-  getOpenKeywordTabs?: () => readonly KeywordTabValidationInput[];
-  keywordTabsLimit?: number;
 };
 
 export type KeywordControlsValues = {
@@ -66,62 +56,6 @@ function getKeywordSearchValidationErrors(
   return null;
 }
 
-function getKeywordTabCapacityError(
-  value: KeywordControlsValues,
-  openKeywordTabs: readonly KeywordTabValidationInput[] | undefined,
-  keywordTabsLimit: number | undefined,
-) {
-  if (!openKeywordTabs || keywordTabsLimit == null) return null;
-
-  const keywords = parseKeywordInput(value.keyword);
-  if (keywords.length === 0) return null;
-
-  let simulatedOpenTabs = [...openKeywordTabs];
-  let skippedCount = 0;
-
-  for (const keyword of keywords) {
-    const input = {
-      keyword,
-      locationCode: value.locationCode,
-      resultLimit: value.resultLimit,
-      mode: value.mode,
-      clickstream: value.clickstream,
-    };
-    const alreadyOpen = simulatedOpenTabs.some((tab) =>
-      keywordTabMatches(tab, input),
-    );
-    if (alreadyOpen) continue;
-
-    if (simulatedOpenTabs.length >= keywordTabsLimit) {
-      skippedCount += 1;
-      continue;
-    }
-
-    simulatedOpenTabs = [...simulatedOpenTabs, input];
-  }
-
-  if (skippedCount === 0) return null;
-
-  return createFormValidationErrors({
-    fields: {
-      keyword: `${skippedCount} keyword${skippedCount === 1 ? "" : "s"} skipped - close a tab to open more (max ${keywordTabsLimit}).`,
-    },
-  });
-}
-
-function keywordTabMatches(
-  tab: KeywordTabValidationInput,
-  input: KeywordTabValidationInput,
-) {
-  return (
-    tab.keyword === input.keyword &&
-    tab.locationCode === input.locationCode &&
-    tab.resultLimit === input.resultLimit &&
-    tab.mode === input.mode &&
-    tab.clickstream === input.clickstream
-  );
-}
-
 export function useKeywordControlsForm(
   input: UseKeywordControlsFormInput,
   onSubmit: (value: KeywordControlsValues) => void,
@@ -142,12 +76,7 @@ export function useKeywordControlsForm(
           false,
         ),
       onSubmit: ({ value }) =>
-        getKeywordSearchValidationErrors(value, true, true) ??
-        getKeywordTabCapacityError(
-          value,
-          input.getOpenKeywordTabs?.(),
-          input.keywordTabsLimit,
-        ),
+        getKeywordSearchValidationErrors(value, true, true),
     },
     onSubmit: ({ value }) => {
       onSubmit(value);
diff --git a/src/client/features/keywords/page/KeywordResearchPage.tsx b/src/client/features/keywords/page/KeywordResearchPage.tsx
index a9ea173..3ccbd12 100644
--- a/src/client/features/keywords/page/KeywordResearchPage.tsx
+++ b/src/client/features/keywords/page/KeywordResearchPage.tsx
@@ -1,5 +1,5 @@
 import { Link } from "@tanstack/react-router";
-import { useCallback, useEffect, useMemo } from "react";
+import { useCallback, useMemo } from "react";
 import { AlertCircle, ArrowLeft } from "lucide-react";
 import { getErrorCode } from "@/client/lib/error-messages";
 import { BILLING_ROUTE } from "@/shared/billing";
@@ -147,24 +147,6 @@ export function KeywordResearchPage(input: Props) {
     searchTabs.setActiveTab(null);
     navigateToKeywordInput(null);
   }, [navigateToKeywordInput, searchTabs]);
-  const getOpenKeywordTabs = useCallback(
-    () =>
-      searchTabs.tabs.flatMap((tab) =>
-        tab.input.type === "keyword"
-          ? [
-              {
-                keyword: tab.input.keyword,
-                locationCode: tab.input.locationCode,
-                resultLimit: tab.input.resultLimit,
-                mode: tab.input.mode,
-                clickstream: tab.input.clickstream,
-              },
-            ]
-          : [],
-      ),
-    [searchTabs.tabs],
-  );
-
   const controllerInput = useMemo<ControllerProps>(
     () =>
       activeTab
@@ -178,24 +160,18 @@ export function KeywordResearchPage(input: Props) {
             resultLimit: activeTab.input.resultLimit,
             keywordMode: activeTab.input.mode,
             clickstream: activeTab.input.clickstream,
-            getOpenKeywordTabs,
-            keywordTabsLimit: searchTabs.limit,
           }
         : {
             ...input,
             locationCode,
             displayedLocationCode,
             setPreferredLocationCode,
-            getOpenKeywordTabs,
-            keywordTabsLimit: searchTabs.limit,
           },
     [
       activeTab,
-      getOpenKeywordTabs,
       input,
       displayedLocationCode,
       locationCode,
-      searchTabs.limit,
       setPreferredLocationCode,
     ],
   );
@@ -203,20 +179,6 @@ export function KeywordResearchPage(input: Props) {
     ...controllerInput,
     onFormSubmit,
   });
-  useEffect(() => {
-    controller.controlsForm.setErrorMap({ onSubmit: undefined });
-    controller.controlsForm.setFieldMeta("keyword", (meta) => ({
-      ...meta,
-      errorMap: {
-        ...meta.errorMap,
-        onSubmit: undefined,
-      },
-      errorSourceMap: {
-        ...meta.errorSourceMap,
-        onSubmit: undefined,
-      },
-    }));
-  }, [controller.controlsForm, searchTabs.tabs]);
 
   return (
     <div className="px-4 py-4 md:px-6 md:py-6 pb-24 md:pb-8 overflow-auto">
diff --git a/src/client/features/keywords/state/useKeywordResearchController.ts b/src/client/features/keywords/state/useKeywordResearchController.ts
index 9fed9c1..7a3ed5a 100644
--- a/src/client/features/keywords/state/useKeywordResearchController.ts
+++ b/src/client/features/keywords/state/useKeywordResearchController.ts
@@ -28,14 +28,6 @@ import {
 } from "./keywordControllerInternals";
 import { useKeywordOverviewState } from "./useKeywordOverviewState";
 
-type OpenKeywordTabInput = {
-  keyword: string;
-  locationCode: number | undefined;
-  resultLimit: ResultLimit;
-  mode: KeywordMode;
-  clickstream: boolean;
-};
-
 export type KeywordResearchControllerInput = {
   projectId: string;
   keywordInput: string;
@@ -47,8 +39,6 @@ export type KeywordResearchControllerInput = {
   clickstream: boolean;
   sortField: SortField;
   sortDir: SortDir;
-  getOpenKeywordTabs?: () => readonly OpenKeywordTabInput[];
-  keywordTabsLimit?: number;
   /**
    * Called when the user submits the search form. Lets the caller decide
    * whether the submission opens tabs or just rewrites the URL — the
@@ -150,8 +140,6 @@ export function useKeywordResearchController(
     {
       ...input,
       locationCode: displayedLocationCode,
-      getOpenKeywordTabs: input.getOpenKeywordTabs,
-      keywordTabsLimit: input.keywordTabsLimit,
     },
     (value) => {
       setPreferredLocationCode(value.locationCode);
diff --git a/src/client/features/search-tabs/useSearchTabNavigation.ts b/src/client/features/search-tabs/useSearchTabNavigation.ts
index d46f0e1..2ca2646 100644
--- a/src/client/features/search-tabs/useSearchTabNavigation.ts
+++ b/src/client/features/search-tabs/useSearchTabNavigation.ts
@@ -50,13 +50,10 @@ export function useSearchTabNavigation({
       return;
     }
 
-    const result = openTab({
+    openTab({
       label: getLabel(urlInput),
       input: urlInput,
     });
-    if (result.dropped) {
-      setActiveTab(null);
-    }
   }, [activeTabId, findMatchingTab, getLabel, openTab, setActiveTab, urlInput]);
 
   const selectTab = useCallback(
@@ -104,9 +101,7 @@ export function useSearchTabNavigation({
   return {
     activeTabId: tabs.activeTabId,
     tabs: visibleTabs,
-    canOpenTab: tabs.canOpenTab,
     closeTab: closeSearchTab,
-    limit: tabs.limit,
     markTabViewed,
     openTab: openSearchTab,
     selectTab,
diff --git a/src/client/features/search-tabs/useSearchTabs.test.ts b/src/client/features/search-tabs/useSearchTabs.test.ts
index 5f5fbfb..cdbb3ac 100644
--- a/src/client/features/search-tabs/useSearchTabs.test.ts
+++ b/src/client/features/search-tabs/useSearchTabs.test.ts
@@ -1,5 +1,6 @@
 import { describe, expect, it } from "vitest";
-import { parseStoredState } from "./useSearchTabs";
+import type { SearchTab } from "./types";
+import { appendTabWithEviction, parseStoredState } from "./useSearchTabs";
 
 function persistedTab(input: unknown) {
   return {
@@ -100,4 +101,49 @@ describe("parseStoredState", () => {
 
     expect(state.tabs).toHaveLength(0);
   });
+
+  it("keeps the newest 20 tabs when stored state exceeds the cap", () => {
+    const state = parseStoredState({
+      activeTabId: "tab-0",
+      tabs: Array.from({ length: 25 }, (_, i) => ({
+        ...persistedTab({
+          type: "backlinks",
+          target: `t${i}.com`,
+          scope: "domain",
+        }),
+        id: `tab-${i}`,
+      })),
+    });
+
+    expect(state.tabs.map((tab) => tab.id)).toEqual(
+      Array.from({ length: 20 }, (_, i) => `tab-${i + 5}`),
+    );
+    expect(state.activeTabId).toBeNull();
+  });
+});
+
+const makeTabs = (count: number): SearchTab[] =>
+  Array.from({ length: count }, (_, i) => ({
+    id: `tab-${i}`,
+    label: `t${i}`,
+    input: { type: "backlinks", target: `t${i}.com`, scope: "domain" },
+    createdAt: i,
+    viewedAt: null,
+  }));
+describe("appendTabWithEviction", () => {
+  const next = makeTabs(1)[0];
+
+  it("appends without eviction below the cap", () => {
+    const result = appendTabWithEviction(makeTabs(19), next);
+    expect(result).toHaveLength(20);
+    expect(result[0].id).toBe("tab-0");
+    expect(result[19]).toBe(next);
+  });
+
+  it("drops the oldest tab at the cap", () => {
+    const result = appendTabWithEviction(makeTabs(20), next);
+    expect(result).toHaveLength(20);
+    expect(result[0].id).toBe("tab-1");
+    expect(result[19]).toBe(next);
+  });
 });
diff --git a/src/client/features/search-tabs/useSearchTabs.ts b/src/client/features/search-tabs/useSearchTabs.ts
index 4815308..f53827f 100644
--- a/src/client/features/search-tabs/useSearchTabs.ts
+++ b/src/client/features/search-tabs/useSearchTabs.ts
@@ -13,7 +13,6 @@ type OpenTabInput = {
 
 type OpenTabResult = {
   tab: SearchTab | null;
-  dropped: boolean;
 };
 
 const EMPTY_STATE: TabsState = {
@@ -23,7 +22,7 @@ const EMPTY_STATE: TabsState = {
 
 const CHANGE_EVENT = "search-tabs-change";
 const stateCache = new Map<string, TabsState>();
-const SEARCH_TABS_LIMIT = 8;
+const SEARCH_TABS_LIMIT = 20;
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null;
@@ -109,6 +108,13 @@ function tabInputKey(value: unknown): string {
   return JSON.stringify(value);
 }
 
+export function appendTabWithEviction(
+  tabs: SearchTab[],
+  next: SearchTab,
+): SearchTab[] {
+  return [...tabs, next].slice(-SEARCH_TABS_LIMIT);
+}
+
 // Exported for unit tests.
 export function parseStoredState(value: unknown): TabsState {
   if (!isRecord(value)) return EMPTY_STATE;
@@ -136,7 +142,7 @@ export function parseStoredState(value: unknown): TabsState {
         },
       ];
     })
-    .slice(0, SEARCH_TABS_LIMIT);
+    .slice(-SEARCH_TABS_LIMIT);
   const activeTabId =
     typeof value.activeTabId === "string" &&
     tabs.some((tab) => tab.id === value.activeTabId)
@@ -211,7 +217,6 @@ export function useSearchTabs(key: string) {
   const openTab = useCallback(
     ({ label, input }: OpenTabInput): OpenTabResult => {
       let result: SearchTab | null = null;
-      let dropped = false;
       update(key, (current) => {
         const inputKey = tabInputKey(input);
         const existing = current.tabs.find(
@@ -221,10 +226,6 @@ export function useSearchTabs(key: string) {
           result = existing;
           return { ...current, activeTabId: existing.id };
         }
-        if (current.tabs.length >= SEARCH_TABS_LIMIT) {
-          dropped = true;
-          return current;
-        }
         const next: SearchTab = {
           id: generateTabId(),
           label,
@@ -234,11 +235,11 @@ export function useSearchTabs(key: string) {
         };
         result = next;
         return {
-          tabs: [...current.tabs, next],
+          tabs: appendTabWithEviction(current.tabs, next),
           activeTabId: next.id,
         };
       });
-      return { tab: result, dropped };
+      return { tab: result };
     },
     [key],
   );
@@ -314,12 +315,6 @@ export function useSearchTabs(key: string) {
     [state.tabs],
   );
 
-  const canOpenTab = useCallback(
-    (input: SearchTabInput) =>
-      Boolean(findMatchingTab(input)) || state.tabs.length < SEARCH_TABS_LIMIT,
-    [findMatchingTab, state.tabs.length],
-  );
-
   const activeTab = useMemo(
     () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
     [state.activeTabId, state.tabs],
@@ -329,10 +324,8 @@ export function useSearchTabs(key: string) {
     activeTab,
     activeTabId: state.activeTabId,
     tabs: state.tabs,
-    canOpenTab,
     closeTab,
     findMatchingTab,
-    limit: SEARCH_TABS_LIMIT,
     markTabViewed,
     openTab,
     setActiveTab,

```

## Patch B

```diff
diff --git a/src/client/features/backlinks/BacklinksPage.tsx b/src/client/features/backlinks/BacklinksPage.tsx
index c38cf98..53aa443 100644
--- a/src/client/features/backlinks/BacklinksPage.tsx
+++ b/src/client/features/backlinks/BacklinksPage.tsx
@@ -193,10 +193,6 @@ export function BacklinksPage({
         <BacklinksSearchCard
           errorMessage={overviewErrorMessage}
           initialValues={searchCardInitialValues}
-          canOpenSearch={(values) =>
-            searchTabs.canOpenTab(toBacklinksTabInput(values))
-          }
-          tabLimit={searchTabs.limit}
           onSubmit={(values) => {
             searchTabs.openTab(toBacklinksTabInput(values));
             navigateToBacklinksSearch(navigate, values);
diff --git a/src/client/features/backlinks/BacklinksSearchCard.tsx b/src/client/features/backlinks/BacklinksSearchCard.tsx
index 92a6e91..8c6b301 100644
--- a/src/client/features/backlinks/BacklinksSearchCard.tsx
+++ b/src/client/features/backlinks/BacklinksSearchCard.tsx
@@ -18,8 +18,6 @@ type SearchDraft = Pick<BacklinksSearchState, "target" | "scope">;
 function getBacklinksValidationErrors(
   value: SearchDraft,
   shouldValidateUntouchedField: boolean,
-  canOpenSearch?: (value: SearchDraft) => boolean,
-  tabLimit?: number,
 ) {
   if (!value.target.trim()) {
     if (!shouldValidateUntouchedField) {
@@ -33,34 +31,17 @@ function getBacklinksValidationErrors(
     });
   }
 
-  const normalizedValue = {
-    ...value,
-    target: value.target.trim(),
-  };
-
-  if (canOpenSearch && !canOpenSearch(normalizedValue)) {
-    return createFormValidationErrors({
-      fields: {
-        target: `Close a tab to open more searches (max ${tabLimit ?? 8}).`,
-      },
-    });
-  }
-
   return null;
 }
 
 export function BacklinksSearchCard({
-  canOpenSearch,
   errorMessage,
   initialValues,
   onSubmit,
-  tabLimit,
 }: {
-  canOpenSearch?: (values: SearchDraft) => boolean;
   errorMessage: string | null;
   initialValues: SearchDraft;
   onSubmit: (values: SearchDraft) => void;
-  tabLimit?: number;
 }) {
   const [userSelectedScope, setUserSelectedScope] = useState(false);
   const form = useForm({
@@ -70,11 +51,8 @@ export function BacklinksSearchCard({
         getBacklinksValidationErrors(
           value,
           shouldValidateFieldOnChange(formApi, "target"),
-          canOpenSearch,
-          tabLimit,
         ),
-      onSubmit: ({ value }) =>
-        getBacklinksValidationErrors(value, true, canOpenSearch, tabLimit),
+      onSubmit: ({ value }) => getBacklinksValidationErrors(value, true),
     },
     onSubmit: ({ value }) => {
       const target = value.target.trim();
diff --git a/src/client/features/domain/DomainOverviewPage.tsx b/src/client/features/domain/DomainOverviewPage.tsx
index c782046..fb51f8f 100644
--- a/src/client/features/domain/DomainOverviewPage.tsx
+++ b/src/client/features/domain/DomainOverviewPage.tsx
@@ -482,39 +482,6 @@ export function DomainOverviewPage({
     navigateToInput: navigateToSearchTab,
   });
 
-  const handleSearchSubmit = useCallback(
-    (event: FormEvent) => {
-      const values = state.controlsForm.state.values;
-      const target = normalizeDomainTarget(values.domain);
-      if (!target) {
-        state.handleSearchSubmit(event);
-        return;
-      }
-
-      const nextTabInput: SearchTabInput = {
-        type: "domain",
-        domain: target,
-        subdomains: values.subdomains,
-        locationCode: values.locationCode,
-      };
-
-      if (!searchTabs.canOpenTab(nextTabInput)) {
-        event.preventDefault();
-        state.controlsForm.setErrorMap({
-          onSubmit: createFormValidationErrors({
-            fields: {
-              domain: `Close a tab to open more searches (max ${searchTabs.limit}).`,
-            },
-          }),
-        });
-        return;
-      }
-
-      state.handleSearchSubmit(event);
-    },
-    [searchTabs, state],
-  );
-
   const tabControls = routeState.domain ? (
     <div className="flex flex-col gap-2">
       <div>
@@ -555,7 +522,7 @@ export function DomainOverviewPage({
         <DomainSearchCard
           controlsForm={state.controlsForm}
           isLoading={state.isLoading}
-          onSubmit={handleSearchSubmit}
+          onSubmit={state.handleSearchSubmit}
           onSortChange={(sort) =>
             state.applySort(sort, getDefaultSortOrder(sort))
           }
diff --git a/src/client/features/keywords/hooks/useKeywordControlsForm.ts b/src/client/features/keywords/hooks/useKeywordControlsForm.ts
index 92d381a..024fed5 100644
--- a/src/client/features/keywords/hooks/useKeywordControlsForm.ts
+++ b/src/client/features/keywords/hooks/useKeywordControlsForm.ts
@@ -11,22 +11,12 @@ import {
 } from "@/client/features/keywords/keywordResearchTypes";
 import { parseKeywordInput } from "@/client/features/keywords/state/keywordControllerActions";
 
-type KeywordTabValidationInput = {
-  keyword: string;
-  locationCode: number | undefined;
-  resultLimit: ResultLimit;
-  mode: KeywordMode;
-  clickstream: boolean;
-};
-
 type UseKeywordControlsFormInput = {
   keywordInput: string;
   locationCode: number;
   resultLimit: ResultLimit;
   keywordMode: KeywordMode;
   clickstream: boolean;
-  getOpenKeywordTabs?: () => readonly KeywordTabValidationInput[];
-  keywordTabsLimit?: number;
 };
 
 export type KeywordControlsValues = {
@@ -66,62 +56,6 @@ function getKeywordSearchValidationErrors(
   return null;
 }
 
-function getKeywordTabCapacityError(
-  value: KeywordControlsValues,
-  openKeywordTabs: readonly KeywordTabValidationInput[] | undefined,
-  keywordTabsLimit: number | undefined,
-) {
-  if (!openKeywordTabs || keywordTabsLimit == null) return null;
-
-  const keywords = parseKeywordInput(value.keyword);
-  if (keywords.length === 0) return null;
-
-  let simulatedOpenTabs = [...openKeywordTabs];
-  let skippedCount = 0;
-
-  for (const keyword of keywords) {
-    const input = {
-      keyword,
-      locationCode: value.locationCode,
-      resultLimit: value.resultLimit,
-      mode: value.mode,
-      clickstream: value.clickstream,
-    };
-    const alreadyOpen = simulatedOpenTabs.some((tab) =>
-      keywordTabMatches(tab, input),
-    );
-    if (alreadyOpen) continue;
-
-    if (simulatedOpenTabs.length >= keywordTabsLimit) {
-      skippedCount += 1;
-      continue;
-    }
-
-    simulatedOpenTabs = [...simulatedOpenTabs, input];
-  }
-
-  if (skippedCount === 0) return null;
-
-  return createFormValidationErrors({
-    fields: {
-      keyword: `${skippedCount} keyword${skippedCount === 1 ? "" : "s"} skipped - close a tab to open more (max ${keywordTabsLimit}).`,
-    },
-  });
-}
-
-function keywordTabMatches(
-  tab: KeywordTabValidationInput,
-  input: KeywordTabValidationInput,
-) {
-  return (
-    tab.keyword === input.keyword &&
-    tab.locationCode === input.locationCode &&
-    tab.resultLimit === input.resultLimit &&
-    tab.mode === input.mode &&
-    tab.clickstream === input.clickstream
-  );
-}
-
 export function useKeywordControlsForm(
   input: UseKeywordControlsFormInput,
   onSubmit: (value: KeywordControlsValues) => void,
@@ -142,12 +76,7 @@ export function useKeywordControlsForm(
           false,
         ),
       onSubmit: ({ value }) =>
-        getKeywordSearchValidationErrors(value, true, true) ??
-        getKeywordTabCapacityError(
-          value,
-          input.getOpenKeywordTabs?.(),
-          input.keywordTabsLimit,
-        ),
+        getKeywordSearchValidationErrors(value, true, true),
     },
     onSubmit: ({ value }) => {
       onSubmit(value);
diff --git a/src/client/features/keywords/page/KeywordResearchPage.tsx b/src/client/features/keywords/page/KeywordResearchPage.tsx
index a9ea173..e598669 100644
--- a/src/client/features/keywords/page/KeywordResearchPage.tsx
+++ b/src/client/features/keywords/page/KeywordResearchPage.tsx
@@ -1,5 +1,5 @@
 import { Link } from "@tanstack/react-router";
-import { useCallback, useEffect, useMemo } from "react";
+import { useCallback, useMemo } from "react";
 import { AlertCircle, ArrowLeft } from "lucide-react";
 import { getErrorCode } from "@/client/lib/error-messages";
 import { BILLING_ROUTE } from "@/shared/billing";
@@ -132,14 +132,14 @@ export function KeywordResearchPage(input: Props) {
         clickstream: value.clickstream,
       }));
 
-      let activeInput: KeywordSearchTabInput | null = null;
+      let lastInput: KeywordSearchTabInput | null = null;
       for (const tabInput of inputs) {
         const result = searchTabs.openTab(tabInput);
         if (result.tab?.input.type === "keyword") {
-          activeInput = result.tab.input;
+          lastInput = result.tab.input;
         }
       }
-      if (activeInput) navigateToKeywordInput(activeInput);
+      if (lastInput) navigateToKeywordInput(lastInput);
     },
     [navigateToKeywordInput, searchTabs],
   );
@@ -147,23 +147,6 @@ export function KeywordResearchPage(input: Props) {
     searchTabs.setActiveTab(null);
     navigateToKeywordInput(null);
   }, [navigateToKeywordInput, searchTabs]);
-  const getOpenKeywordTabs = useCallback(
-    () =>
-      searchTabs.tabs.flatMap((tab) =>
-        tab.input.type === "keyword"
-          ? [
-              {
-                keyword: tab.input.keyword,
-                locationCode: tab.input.locationCode,
-                resultLimit: tab.input.resultLimit,
-                mode: tab.input.mode,
-                clickstream: tab.input.clickstream,
-              },
-            ]
-          : [],
-      ),
-    [searchTabs.tabs],
-  );
 
   const controllerInput = useMemo<ControllerProps>(
     () =>
@@ -178,24 +161,18 @@ export function KeywordResearchPage(input: Props) {
             resultLimit: activeTab.input.resultLimit,
             keywordMode: activeTab.input.mode,
             clickstream: activeTab.input.clickstream,
-            getOpenKeywordTabs,
-            keywordTabsLimit: searchTabs.limit,
           }
         : {
             ...input,
             locationCode,
             displayedLocationCode,
             setPreferredLocationCode,
-            getOpenKeywordTabs,
-            keywordTabsLimit: searchTabs.limit,
           },
     [
       activeTab,
-      getOpenKeywordTabs,
       input,
       displayedLocationCode,
       locationCode,
-      searchTabs.limit,
       setPreferredLocationCode,
     ],
   );
@@ -203,20 +180,6 @@ export function KeywordResearchPage(input: Props) {
     ...controllerInput,
     onFormSubmit,
   });
-  useEffect(() => {
-    controller.controlsForm.setErrorMap({ onSubmit: undefined });
-    controller.controlsForm.setFieldMeta("keyword", (meta) => ({
-      ...meta,
-      errorMap: {
-        ...meta.errorMap,
-        onSubmit: undefined,
-      },
-      errorSourceMap: {
-        ...meta.errorSourceMap,
-        onSubmit: undefined,
-      },
-    }));
-  }, [controller.controlsForm, searchTabs.tabs]);
 
   return (
     <div className="px-4 py-4 md:px-6 md:py-6 pb-24 md:pb-8 overflow-auto">
diff --git a/src/client/features/keywords/state/useKeywordResearchController.ts b/src/client/features/keywords/state/useKeywordResearchController.ts
index 9fed9c1..7a3ed5a 100644
--- a/src/client/features/keywords/state/useKeywordResearchController.ts
+++ b/src/client/features/keywords/state/useKeywordResearchController.ts
@@ -28,14 +28,6 @@ import {
 } from "./keywordControllerInternals";
 import { useKeywordOverviewState } from "./useKeywordOverviewState";
 
-type OpenKeywordTabInput = {
-  keyword: string;
-  locationCode: number | undefined;
-  resultLimit: ResultLimit;
-  mode: KeywordMode;
-  clickstream: boolean;
-};
-
 export type KeywordResearchControllerInput = {
   projectId: string;
   keywordInput: string;
@@ -47,8 +39,6 @@ export type KeywordResearchControllerInput = {
   clickstream: boolean;
   sortField: SortField;
   sortDir: SortDir;
-  getOpenKeywordTabs?: () => readonly OpenKeywordTabInput[];
-  keywordTabsLimit?: number;
   /**
    * Called when the user submits the search form. Lets the caller decide
    * whether the submission opens tabs or just rewrites the URL — the
@@ -150,8 +140,6 @@ export function useKeywordResearchController(
     {
       ...input,
       locationCode: displayedLocationCode,
-      getOpenKeywordTabs: input.getOpenKeywordTabs,
-      keywordTabsLimit: input.keywordTabsLimit,
     },
     (value) => {
       setPreferredLocationCode(value.locationCode);
diff --git a/src/client/features/search-tabs/useSearchTabNavigation.ts b/src/client/features/search-tabs/useSearchTabNavigation.ts
index d46f0e1..2ca2646 100644
--- a/src/client/features/search-tabs/useSearchTabNavigation.ts
+++ b/src/client/features/search-tabs/useSearchTabNavigation.ts
@@ -50,13 +50,10 @@ export function useSearchTabNavigation({
       return;
     }
 
-    const result = openTab({
+    openTab({
       label: getLabel(urlInput),
       input: urlInput,
     });
-    if (result.dropped) {
-      setActiveTab(null);
-    }
   }, [activeTabId, findMatchingTab, getLabel, openTab, setActiveTab, urlInput]);
 
   const selectTab = useCallback(
@@ -104,9 +101,7 @@ export function useSearchTabNavigation({
   return {
     activeTabId: tabs.activeTabId,
     tabs: visibleTabs,
-    canOpenTab: tabs.canOpenTab,
     closeTab: closeSearchTab,
-    limit: tabs.limit,
     markTabViewed,
     openTab: openSearchTab,
     selectTab,
diff --git a/src/client/features/search-tabs/useSearchTabs.test.ts b/src/client/features/search-tabs/useSearchTabs.test.ts
index 5f5fbfb..a9ee53d 100644
--- a/src/client/features/search-tabs/useSearchTabs.test.ts
+++ b/src/client/features/search-tabs/useSearchTabs.test.ts
@@ -1,5 +1,6 @@
 import { describe, expect, it } from "vitest";
-import { parseStoredState } from "./useSearchTabs";
+import type { SearchTab } from "./types";
+import { appendTabWithEviction, parseStoredState } from "./useSearchTabs";
 
 function persistedTab(input: unknown) {
   return {
@@ -101,3 +102,44 @@ describe("parseStoredState", () => {
     expect(state.tabs).toHaveLength(0);
   });
 });
+
+function makeTabs(count: number): SearchTab[] {
+  return Array.from({ length: count }, (_, i) => ({
+    id: `tab-${i}`,
+    label: `kw ${i}`,
+    createdAt: i,
+    viewedAt: null,
+    input: { type: "domain", domain: `d${i}.com`, subdomains: true },
+  }));
+}
+
+describe("appendTabWithEviction", () => {
+  it("appends without eviction below the cap", () => {
+    const [next] = makeTabs(1);
+    const result = appendTabWithEviction(makeTabs(19), next);
+    expect(result).toHaveLength(20);
+    expect(result[0].id).toBe("tab-0");
+    expect(result[19]).toBe(next);
+  });
+
+  it("drops the oldest tab at the cap", () => {
+    const next = { ...makeTabs(1)[0], id: "new" };
+    const result = appendTabWithEviction(makeTabs(20), next);
+    expect(result).toHaveLength(20);
+    expect(result[0].id).toBe("tab-1");
+    expect(result[19].id).toBe("new");
+  });
+});
+
+describe("parseStoredState tab cap", () => {
+  it("keeps the newest 20 stored tabs", () => {
+    const state = parseStoredState({
+      activeTabId: "tab-24",
+      tabs: makeTabs(25),
+    });
+    expect(state.tabs.map((tab) => tab.id)).toEqual(
+      Array.from({ length: 20 }, (_, i) => `tab-${i + 5}`),
+    );
+    expect(state.activeTabId).toBe("tab-24");
+  });
+});
diff --git a/src/client/features/search-tabs/useSearchTabs.ts b/src/client/features/search-tabs/useSearchTabs.ts
index 4815308..f53827f 100644
--- a/src/client/features/search-tabs/useSearchTabs.ts
+++ b/src/client/features/search-tabs/useSearchTabs.ts
@@ -13,7 +13,6 @@ type OpenTabInput = {
 
 type OpenTabResult = {
   tab: SearchTab | null;
-  dropped: boolean;
 };
 
 const EMPTY_STATE: TabsState = {
@@ -23,7 +22,7 @@ const EMPTY_STATE: TabsState = {
 
 const CHANGE_EVENT = "search-tabs-change";
 const stateCache = new Map<string, TabsState>();
-const SEARCH_TABS_LIMIT = 8;
+const SEARCH_TABS_LIMIT = 20;
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null;
@@ -109,6 +108,13 @@ function tabInputKey(value: unknown): string {
   return JSON.stringify(value);
 }
 
+export function appendTabWithEviction(
+  tabs: SearchTab[],
+  next: SearchTab,
+): SearchTab[] {
+  return [...tabs, next].slice(-SEARCH_TABS_LIMIT);
+}
+
 // Exported for unit tests.
 export function parseStoredState(value: unknown): TabsState {
   if (!isRecord(value)) return EMPTY_STATE;
@@ -136,7 +142,7 @@ export function parseStoredState(value: unknown): TabsState {
         },
       ];
     })
-    .slice(0, SEARCH_TABS_LIMIT);
+    .slice(-SEARCH_TABS_LIMIT);
   const activeTabId =
     typeof value.activeTabId === "string" &&
     tabs.some((tab) => tab.id === value.activeTabId)
@@ -211,7 +217,6 @@ export function useSearchTabs(key: string) {
   const openTab = useCallback(
     ({ label, input }: OpenTabInput): OpenTabResult => {
       let result: SearchTab | null = null;
-      let dropped = false;
       update(key, (current) => {
         const inputKey = tabInputKey(input);
         const existing = current.tabs.find(
@@ -221,10 +226,6 @@ export function useSearchTabs(key: string) {
           result = existing;
           return { ...current, activeTabId: existing.id };
         }
-        if (current.tabs.length >= SEARCH_TABS_LIMIT) {
-          dropped = true;
-          return current;
-        }
         const next: SearchTab = {
           id: generateTabId(),
           label,
@@ -234,11 +235,11 @@ export function useSearchTabs(key: string) {
         };
         result = next;
         return {
-          tabs: [...current.tabs, next],
+          tabs: appendTabWithEviction(current.tabs, next),
           activeTabId: next.id,
         };
       });
-      return { tab: result, dropped };
+      return { tab: result };
     },
     [key],
   );
@@ -314,12 +315,6 @@ export function useSearchTabs(key: string) {
     [state.tabs],
   );
 
-  const canOpenTab = useCallback(
-    (input: SearchTabInput) =>
-      Boolean(findMatchingTab(input)) || state.tabs.length < SEARCH_TABS_LIMIT,
-    [findMatchingTab, state.tabs.length],
-  );
-
   const activeTab = useMemo(
     () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
     [state.activeTabId, state.tabs],
@@ -329,10 +324,8 @@ export function useSearchTabs(key: string) {
     activeTab,
     activeTabId: state.activeTabId,
     tabs: state.tabs,
-    canOpenTab,
     closeTab,
     findMatchingTab,
-    limit: SEARCH_TABS_LIMIT,
     markTabViewed,
     openTab,
     setActiveTab,

```
