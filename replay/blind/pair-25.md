# Pair 25 (open-seo-b0b5528a)

Which patch would you merge? Answer in answers.md as `25: A`, `25: B`, or `25: =` if you cannot tell.

## Issue

Add a `create_project` MCP tool

MCP clients can list projects with `list_projects`, but they can't create one. A user working through an MCP client has to leave it and use the dashboard before any project-scoped tool will work. Please add an MCP tool named `create_project` that creates a project in the caller's organization.

Input is `{ name: string; domain?: string; locationCode?: number; languageCode?: string }`.
- `name` is required, trimmed, and 1–120 characters.
- `domain` is an optional host-only root domain. It's normalized the same way as when a project is created in the dashboard.
- `locationCode` is an optional DataForSEO location code. If it's omitted, the organization's default market applies.
- `languageCode` is optional, but it requires `locationCode`. Passing a `languageCode` without a `locationCode` must be rejected, with the same rule the dashboard uses. When only `locationCode` is given, the language is resolved from the location.

On success the tool returns the created project as `{ id, name, domain, locationCode, languageCode, url }`. `url` is the dashboard link `<baseUrl>/p/<id>`. The structured output carries this under `project`. The text response should include the new project id, name, domain if there is one, and the market. The `id` can then be passed as `projectId` to other OpenSEO tools.

The tool must:
- be scoped to the authenticated caller's organization
- not call DataForSEO or use credits
- be registered with the other tools on the OpenSEO MCP server
- be annotated as non-read-only, non-destructive and not open-world

The description should tell clients to call `list_projects` first to avoid duplicates.

## Patch A

```diff
diff --git a/src/server/mcp/server.ts b/src/server/mcp/server.ts
index 2cdc9de..9420d6d 100644
--- a/src/server/mcp/server.ts
+++ b/src/server/mcp/server.ts
@@ -6,6 +6,7 @@ import { getDomainKeywordSuggestionsTool } from "@/server/mcp/tools/get-domain-k
 import { getDomainOverviewTool } from "@/server/mcp/tools/get-domain-overview";
 import { getRankTrackerTool } from "@/server/mcp/tools/get-rank-tracker";
 import { getSerpResultsTool } from "@/server/mcp/tools/get-serp-results";
+import { createProjectTool } from "@/server/mcp/tools/create-project";
 import { listProjectsTool } from "@/server/mcp/tools/list-projects";
 import { listSavedKeywordsTool } from "@/server/mcp/tools/list-saved-keywords";
 import {
@@ -54,6 +55,15 @@ export function registerOpenSeoMcpTools(server: McpServer) {
       listProjectsTool.handler,
     ),
   );
+  server.registerTool(
+    createProjectTool.name,
+    createProjectTool.config,
+    instrumentMcpToolHandler(
+      createProjectTool.name,
+      createProjectTool.config.outputSchema,
+      createProjectTool.handler,
+    ),
+  );
   server.registerTool(
     listSavedKeywordsTool.name,
     listSavedKeywordsTool.config,
diff --git a/src/server/mcp/tools/create-project.test.ts b/src/server/mcp/tools/create-project.test.ts
new file mode 100644
index 0000000..de8342b
--- /dev/null
+++ b/src/server/mcp/tools/create-project.test.ts
@@ -0,0 +1,92 @@
+import { beforeEach, describe, expect, it, vi } from "vitest";
+import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
+import type { ToolExtra } from "@/server/mcp/context";
+import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";
+import { createProjectTool } from "./create-project";
+
+const mocks = vi.hoisted(() => ({
+  createProject: vi.fn(),
+}));
+
+vi.mock("cloudflare:workers", () => ({
+  env: {},
+}));
+
+vi.mock("@/server/features/projects/services/ProjectService", () => ({
+  ProjectService: { createProject: mocks.createProject },
+}));
+
+const authExtra: ToolExtra = {
+  signal: new AbortController().signal,
+  requestId: 1,
+  sendNotification: vi.fn(),
+  sendRequest: vi.fn(),
+  authInfo: {
+    token: "token",
+    clientId: "client_123",
+    scopes: ["mcp"],
+    resource: new URL("https://app.example.com/mcp"),
+    extra: {
+      [MCP_AUTH_CONTEXT_PROP]: {
+        userId: "user_123",
+        userEmail: "team@example.com",
+        organizationId: "org_123",
+        clientId: "client_123",
+        scopes: ["mcp"],
+        audience: "open-seo",
+        subject: "user_123",
+        baseUrl: "https://app.example.com",
+      },
+    },
+  } satisfies AuthInfo,
+};
+
+const created = {
+  id: "proj_1",
+  name: "Acme",
+  domain: "acme.com",
+  locationCode: 2704,
+  languageCode: "vi",
+  createdAt: "2026-01-01T00:00:00.000Z",
+};
+
+describe("create_project MCP tool", () => {
+  beforeEach(() => {
+    mocks.createProject.mockReset();
+  });
+
+  it("creates in the caller's organization and returns the dashboard url", async () => {
+    mocks.createProject.mockResolvedValue(created);
+
+    const result = await createProjectTool.handler(
+      { name: "Acme", domain: "acme.com", locationCode: 2704 },
+      authExtra,
+    );
+
+    expect(mocks.createProject).toHaveBeenCalledWith("org_123", {
+      name: "Acme",
+      domain: "acme.com",
+      locationCode: 2704,
+    });
+    expect(result.structuredContent?.project).toEqual({
+      id: "proj_1",
+      name: "Acme",
+      domain: "acme.com",
+      locationCode: 2704,
+      languageCode: "vi",
+      url: "https://app.example.com/p/proj_1",
+    });
+    expect(result.content[0]).toHaveProperty("text");
+    expect(JSON.stringify(result.content[0])).toContain("proj_1");
+  });
+
+  it("rejects a language without a location before creating", async () => {
+    await expect(
+      createProjectTool.handler(
+        { name: "Acme", languageCode: "vi" },
+        authExtra,
+      ),
+    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
+    expect(mocks.createProject).not.toHaveBeenCalled();
+  });
+});
diff --git a/src/server/mcp/tools/create-project.ts b/src/server/mcp/tools/create-project.ts
new file mode 100644
index 0000000..fc063d2
--- /dev/null
+++ b/src/server/mcp/tools/create-project.ts
@@ -0,0 +1,106 @@
+import { z } from "zod";
+import { ProjectService } from "@/server/features/projects/services/ProjectService";
+import { AppError } from "@/server/lib/errors";
+import {
+  requireMcpToolAuthContext,
+  type ToolExtra,
+} from "@/server/mcp/context";
+import { mcpResponse } from "@/server/mcp/formatters";
+import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
+import { buildDashboardUrl } from "@/server/mcp/urls";
+import { createProjectSchema } from "@/types/schemas/projects";
+
+const inputSchema = {
+  name: z
+    .string()
+    .trim()
+    .min(1)
+    .max(120)
+    .describe("Project name (1-120 chars)."),
+  domain: z
+    .string()
+    .optional()
+    .describe(
+      "Optional host-only root domain of the site, e.g. 'example.com'. Normalized like the dashboard (lowercase, no protocol/path/www).",
+    ),
+  locationCode: z
+    .number()
+    .optional()
+    .describe(
+      "Optional DataForSEO location code for the project's default market. Omit to use the organization's default market. See dataforseo.com/help-center/locations.",
+    ),
+  languageCode: z
+    .string()
+    .optional()
+    .describe(
+      "Optional language code (e.g. 'en'). Requires locationCode. When only locationCode is given, the language is resolved from the location.",
+    ),
+} as const;
+
+type Args = z.infer<z.ZodObject<typeof inputSchema>>;
+
+export const createProjectTool = {
+  name: "create_project",
+  config: {
+    title: "Create project",
+    description:
+      "Creates a project in the user's organization. Uses no credits — does not call DataForSEO. Call `list_projects` first to avoid creating duplicates. `languageCode` requires `locationCode`; if only `locationCode` is passed the language is resolved from it, and if both are omitted the organization's default market applies. Returns {id, name, domain, locationCode, languageCode, url}; pass the `id` value as `projectId` to other OpenSEO tools.",
+    inputSchema,
+    outputSchema: {
+      project: z.object({
+        id: z.string(),
+        name: z.string(),
+        domain: z.string().nullable(),
+        locationCode: z.number(),
+        languageCode: z.string(),
+        url: z.string(),
+      }),
+      ...optionalMetaOutputSchema,
+    },
+    annotations: {
+      readOnlyHint: false,
+      openWorldHint: false,
+      destructiveHint: false,
+    },
+  },
+  handler: async (args: Args, extra: ToolExtra) => {
+    const { baseUrl, ...auth } = requireMcpToolAuthContext(extra);
+
+    // Same schema as the dashboard: enforces supported codes and that a
+    // language comes with a location (not expressible in an MCP raw shape).
+    const parsed = createProjectSchema.safeParse(args);
+    if (!parsed.success) {
+      throw new AppError(
+        "VALIDATION_ERROR",
+        parsed.error.issues
+          .map((issue) =>
+            issue.path.length > 0
+              ? `${issue.path.join(".")}: ${issue.message}`
+              : issue.message,
+          )
+          .join("; "),
+      );
+    }
+
+    const created = await ProjectService.createProject(
+      auth.organizationId,
+      parsed.data,
+    );
+    const url = buildDashboardUrl(baseUrl, `/p/${created.id}`);
+
+    return mcpResponse({
+      text: `Created project ${created.id}  ${created.name}${created.domain ? ` (${created.domain})` : ""}  market:${created.locationCode}/${created.languageCode}\nUse "${created.id}" as projectId in other OpenSEO tools.`,
+      meta: { organizationId: auth.organizationId, url },
+      structuredContent: {
+        project: {
+          id: created.id,
+          name: created.name,
+          domain: created.domain,
+          locationCode: created.locationCode,
+          languageCode: created.languageCode,
+          url,
+        },
+      },
+    });
+  },
+};

```

## Patch B

```diff
diff --git a/src/server/mcp/server.ts b/src/server/mcp/server.ts
index 2cdc9de..9420d6d 100644
--- a/src/server/mcp/server.ts
+++ b/src/server/mcp/server.ts
@@ -6,6 +6,7 @@ import { getDomainKeywordSuggestionsTool } from "@/server/mcp/tools/get-domain-k
 import { getDomainOverviewTool } from "@/server/mcp/tools/get-domain-overview";
 import { getRankTrackerTool } from "@/server/mcp/tools/get-rank-tracker";
 import { getSerpResultsTool } from "@/server/mcp/tools/get-serp-results";
+import { createProjectTool } from "@/server/mcp/tools/create-project";
 import { listProjectsTool } from "@/server/mcp/tools/list-projects";
 import { listSavedKeywordsTool } from "@/server/mcp/tools/list-saved-keywords";
 import {
@@ -54,6 +55,15 @@ export function registerOpenSeoMcpTools(server: McpServer) {
       listProjectsTool.handler,
     ),
   );
+  server.registerTool(
+    createProjectTool.name,
+    createProjectTool.config,
+    instrumentMcpToolHandler(
+      createProjectTool.name,
+      createProjectTool.config.outputSchema,
+      createProjectTool.handler,
+    ),
+  );
   server.registerTool(
     listSavedKeywordsTool.name,
     listSavedKeywordsTool.config,
diff --git a/src/server/mcp/tools/create-project.test.ts b/src/server/mcp/tools/create-project.test.ts
new file mode 100644
index 0000000..b808286
--- /dev/null
+++ b/src/server/mcp/tools/create-project.test.ts
@@ -0,0 +1,103 @@
+import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
+import type { ToolExtra } from "@/server/mcp/context";
+import { beforeEach, describe, expect, it, vi } from "vitest";
+import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";
+
+const mocks = vi.hoisted(() => ({
+  createProject: vi.fn(),
+}));
+
+vi.mock("@/server/features/projects/services/ProjectService", () => ({
+  ProjectService: { createProject: mocks.createProject },
+}));
+
+const authContext = {
+  userId: "user_123",
+  userEmail: "alice@example.com",
+  organizationId: "org_123",
+  clientId: "client_123",
+  scopes: ["mcp"],
+  audience: "https://open-seo.test/mcp",
+  subject: "user_123",
+  baseUrl: "https://open-seo.test",
+};
+
+const toolExtra: ToolExtra = {
+  signal: new AbortController().signal,
+  requestId: 1,
+  sendNotification: vi.fn(),
+  sendRequest: vi.fn(),
+  authInfo: {
+    token: "token",
+    clientId: "client_123",
+    scopes: ["mcp"],
+    resource: new URL("https://open-seo.test/mcp"),
+    extra: { [MCP_AUTH_CONTEXT_PROP]: authContext },
+  } satisfies AuthInfo,
+};
+
+describe("create_project MCP tool", () => {
+  beforeEach(() => {
+    vi.resetModules();
+    mocks.createProject.mockReset();
+  });
+
+  it("creates the project in the caller's organization and returns its link", async () => {
+    mocks.createProject.mockResolvedValue({
+      id: "proj_1",
+      name: "Acme",
+      domain: "acme.com",
+      locationCode: 2704,
+      languageCode: "vi",
+      createdAt: "2026-01-01",
+    });
+    // Dynamic import: vi.resetModules + mocks need a fresh module per test.
+    const { createProjectTool } = await import("./create-project");
+
+    const result = await createProjectTool.handler(
+      { name: "Acme", domain: "https://www.Acme.com/", locationCode: 2704 },
+      toolExtra,
+    );
+
+    expect(mocks.createProject).toHaveBeenCalledWith("org_123", {
+      name: "Acme",
+      domain: "https://www.Acme.com/",
+      locationCode: 2704,
+    });
+    expect(result.structuredContent?.project).toEqual({
+      id: "proj_1",
+      name: "Acme",
+      domain: "acme.com",
+      locationCode: 2704,
+      languageCode: "vi",
+      url: "https://open-seo.test/p/proj_1",
+    });
+    const first = result.content[0];
+    if (first?.type !== "text") throw new Error("expected text content");
+    const text = first.text;
+    expect(text).toContain("proj_1");
+    expect(text).toContain("Acme");
+    expect(text).toContain("acme.com");
+    expect(text).toContain("2704/vi");
+  });
+
+  it("rejects a language without a location before creating", async () => {
+    const { createProjectTool } = await import("./create-project");
+
+    await expect(
+      createProjectTool.handler({ name: "Acme", languageCode: "en" }, toolExtra),
+    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
+    expect(mocks.createProject).not.toHaveBeenCalled();
+  });
+
+  it("is annotated as a non-read-only, non-destructive, closed-world tool", async () => {
+    const { createProjectTool } = await import("./create-project");
+
+    expect(createProjectTool.config.annotations).toEqual({
+      readOnlyHint: false,
+      destructiveHint: false,
+      openWorldHint: false,
+    });
+    expect(createProjectTool.config.description).toContain("list_projects");
+  });
+});
diff --git a/src/server/mcp/tools/create-project.ts b/src/server/mcp/tools/create-project.ts
new file mode 100644
index 0000000..5607b0f
--- /dev/null
+++ b/src/server/mcp/tools/create-project.ts
@@ -0,0 +1,109 @@
+import { z } from "zod";
+import { ProjectService } from "@/server/features/projects/services/ProjectService";
+import {
+  requireMcpToolAuthContext,
+  type ToolExtra,
+} from "@/server/mcp/context";
+import { mcpResponse } from "@/server/mcp/formatters";
+import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
+import { languageCodeSchema, locationCodeSchema } from "@/server/mcp/schemas";
+import { buildDashboardUrl } from "@/server/mcp/urls";
+import { AppError } from "@/server/lib/errors";
+import { createProjectSchema } from "@/types/schemas/projects";
+
+const inputSchema = {
+  name: z
+    .string()
+    .trim()
+    .min(1)
+    .max(120)
+    .describe("Required. Project name (1-120 characters)."),
+  domain: z
+    .string()
+    .max(255)
+    .optional()
+    .describe(
+      "Optional root domain the project is about, host only (e.g. 'acme.com'). Normalized the same way as in the dashboard.",
+    ),
+  locationCode: locationCodeSchema
+    .optional()
+    .describe(
+      "Optional DataForSEO location code for the project's default market. Omit to use the organization's default market. See dataforseo.com/help-center/locations.",
+    ),
+  languageCode: languageCodeSchema
+    .optional()
+    .describe(
+      "Optional language code for the project's default market. Requires locationCode. When only locationCode is given, the language is resolved from the location.",
+    ),
+} as const;
+
+type Args = z.infer<z.ZodObject<typeof inputSchema>>;
+
+export const createProjectTool = {
+  name: "create_project",
+  config: {
+    title: "Create project",
+    description:
+      "Creates a project in the user's organization. Call `list_projects` first to avoid creating duplicates. Uses no credits — does not call DataForSEO. Returns {id, name, domain, locationCode, languageCode, url}; pass the `id` value as `projectId` to other OpenSEO tools. `locationCode`/`languageCode` set the project's default market; `languageCode` requires `locationCode`.",
+    inputSchema,
+    outputSchema: {
+      project: z
+        .object({
+          id: z.string(),
+          name: z.string(),
+          domain: z.string().nullable().optional(),
+          locationCode: z.number(),
+          languageCode: z.string(),
+          url: z.string(),
+        })
+        .passthrough(),
+      ...optionalMetaOutputSchema,
+    },
+    annotations: {
+      readOnlyHint: false,
+      destructiveHint: false,
+      openWorldHint: false,
+    },
+  },
+  handler: async (args: Args, extra: ToolExtra) => {
+    const { baseUrl, ...auth } = requireMcpToolAuthContext(extra);
+
+    // Same schema the dashboard uses, so the "language requires a location"
+    // rule and domain trimming can't drift between the two entry points.
+    const parsed = createProjectSchema.safeParse(args);
+    if (!parsed.success) {
+      throw new AppError(
+        "VALIDATION_ERROR",
+        parsed.error.issues.map((issue) => issue.message).join("; "),
+      );
+    }
+
+    const created = await ProjectService.createProject(
+      auth.organizationId,
+      parsed.data,
+    );
+    const project = {
+      id: created.id,
+      name: created.name,
+      domain: created.domain,
+      locationCode: created.locationCode,
+      languageCode: created.languageCode,
+      url: buildDashboardUrl(baseUrl, `/p/${created.id}`),
+    };
+
+    return mcpResponse({
+      text: [
+        `Created project ${project.id}: ${project.name}`,
+        ...(project.domain ? [`Domain: ${project.domain}`] : []),
+        `Market: ${project.locationCode}/${project.languageCode}`,
+        `Pass "${project.id}" as projectId to other OpenSEO tools.`,
+      ].join("\n"),
+      meta: {
+        organizationId: auth.organizationId,
+        projectId: project.id,
+        url: project.url,
+      },
+      structuredContent: { project },
+    });
+  },
+};

```
