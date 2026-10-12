# Pair 37 (open-seo-8a728563)

Which patch would you merge? Answer in answers.md as `37: A`, `37: B`, or `37: =` if you cannot tell.

## Issue

Public MCP OAuth clients lose their session at first token refresh

MCP clients that register through dynamic client registration (`/api/auth/oauth2/register`) as public clients, with `token_endpoint_auth_method` set to `"none"` or omitted, currently fail when their access token expires. Codex is one example. It discards the client secret it receives at registration. The token endpoint treats the stored client as confidential, so the refresh grant fails with `invalid_client: missing client_secret`. The user then has to re-authenticate.

The cause is that the registration shim rewrites every public or omitted auth method to `client_secret_post`, so the stored client is confidential. It does this because Perplexity rejects a registration response that has no `client_secret`.

Expected behavior:
- `normalizeClientRegistrationRequest(request: Request)` registers clients as public. An explicit `"none"` stays `"none"`. An omitted `token_endpoint_auth_method` becomes `"none"`. Other auth methods and all other metadata fields pass through unchanged.
- A new `withCompatibilityClientSecret(response: Response): Promise<Response>` post-processes the registration response. It applies only to a successful (201) response whose `token_endpoint_auth_method` is `"none"` and which has no `client_secret`. For those responses it returns a body that:
  - reports `token_endpoint_auth_method: "client_secret_post"`;
  - includes a placeholder `client_secret`, a 32-character lowercase hex string;
  - sets `client_secret_expires_at: 0`;
  - sets `client_secret_issued_at` equal to `client_id_issued_at`;
  - keeps all other fields, such as `client_id`.
- Confidential registrations and error responses (non-201) are returned untouched, as the same `Response` object.
- The stored client stays public, so the token endpoint does not require the placeholder secret. Clients that send it and clients that never store it can both authenticate and refresh.

The Perplexity registration flow must keep working.

## Patch A

```diff
diff --git a/src/server/mcp/oauth-provider.ts b/src/server/mcp/oauth-provider.ts
index 5026c58..afcf607 100644
--- a/src/server/mcp/oauth-provider.ts
+++ b/src/server/mcp/oauth-provider.ts
@@ -20,7 +20,10 @@ import {
   MCP_ROUTE,
   withWorkersOAuthMcpScopes,
 } from "@/server/mcp/context";
-import { normalizeClientRegistrationRequest } from "@/server/mcp/oauth-registration";
+import {
+  normalizeClientRegistrationRequest,
+  withCompatibilityClientSecret,
+} from "@/server/mcp/oauth-registration";
 import { getPublicOrigin } from "@/server/mcp/public-origin";
 import { handleAuthenticatedOpenSeoMcpRequest } from "@/server/mcp/transport";
 import { resolveHostedContext } from "@/middleware/ensure-user/hosted";
@@ -445,11 +448,13 @@ export function createOpenSeoOAuthProvider(appFetch: AppFetch) {
       const url = new URL(request.url);
 
       if (url.pathname === OAUTH_REGISTER_PATH) {
-        // Cloudflare's provider can reject public DCR clients, but Perplexity
-        // does not appear to retry as confidential and instead expects a
-        // client_secret. Normalize before handing the request to Cloudflare so
-        // it still owns client creation, secret hashing, and token storage.
-        request = await normalizeClientRegistrationRequest(request);
+        // Register DCR clients as public so refresh works without a stored
+        // secret, then add a placeholder client_secret to the response for
+        // Perplexity, which rejects registration responses without one.
+        const registration = await normalizeClientRegistrationRequest(request);
+        return withCompatibilityClientSecret(
+          await provider.fetch(registration, env, ctx),
+        );
       }
 
       return provider.fetch(request, env, ctx);
diff --git a/src/server/mcp/oauth-registration.test.ts b/src/server/mcp/oauth-registration.test.ts
index 97b5426..7240836 100644
--- a/src/server/mcp/oauth-registration.test.ts
+++ b/src/server/mcp/oauth-registration.test.ts
@@ -1,8 +1,11 @@
 import { describe, expect, it } from "vitest";
-import { normalizeClientRegistrationRequest } from "@/server/mcp/oauth-registration";
+import {
+  normalizeClientRegistrationRequest,
+  withCompatibilityClientSecret,
+} from "@/server/mcp/oauth-registration";
 
 describe("normalizeClientRegistrationRequest", () => {
-  it("converts public dynamic registration requests to confidential clients", async () => {
+  it("keeps explicit public registrations public", async () => {
     const request = new Request(
       "https://app.openseo.so/api/auth/oauth2/register",
       {
@@ -19,11 +22,11 @@ describe("normalizeClientRegistrationRequest", () => {
     const normalized = await normalizeClientRegistrationRequest(request);
 
     await expect(normalized.json()).resolves.toMatchObject({
-      token_endpoint_auth_method: "client_secret_post",
+      token_endpoint_auth_method: "none",
     });
   });
 
-  it("defaults omitted token auth methods to confidential clients", async () => {
+  it("defaults omitted token auth methods to public clients", async () => {
     const request = new Request(
       "https://app.openseo.so/api/auth/oauth2/register",
       {
@@ -39,7 +42,7 @@ describe("normalizeClientRegistrationRequest", () => {
     const normalized = await normalizeClientRegistrationRequest(request);
 
     await expect(normalized.json()).resolves.toMatchObject({
-      token_endpoint_auth_method: "client_secret_post",
+      token_endpoint_auth_method: "none",
     });
   });
 
@@ -86,3 +89,57 @@ describe("normalizeClientRegistrationRequest", () => {
     );
   });
 });
+
+describe("withCompatibilityClientSecret", () => {
+  const publicRegistration = {
+    client_id: "client-1",
+    client_id_issued_at: 1700000000,
+    redirect_uris: ["https://www.perplexity.ai/api/mcp/oauth/callback"],
+    token_endpoint_auth_method: "none",
+  };
+
+  it("adds a placeholder secret to public registration responses", async () => {
+    const response = new Response(JSON.stringify(publicRegistration), {
+      status: 201,
+      headers: { "Content-Type": "application/json" },
+    });
+
+    const result = await withCompatibilityClientSecret(response);
+    const body = (await result.json()) as Record<string, unknown>;
+
+    expect(result.status).toBe(201);
+    expect(body).toMatchObject({
+      client_id: "client-1",
+      token_endpoint_auth_method: "client_secret_post",
+      client_secret_expires_at: 0,
+      client_secret_issued_at: 1700000000,
+    });
+    expect(body.client_secret).toMatch(/^[0-9a-f]{32}$/);
+  });
+
+  it("returns confidential registrations untouched", async () => {
+    const response = new Response(
+      JSON.stringify({
+        ...publicRegistration,
+        token_endpoint_auth_method: "client_secret_post",
+        client_secret: "real-secret",
+      }),
+      { status: 201 },
+    );
+
+    await expect(withCompatibilityClientSecret(response)).resolves.toBe(
+      response,
+    );
+  });
+
+  it("returns error responses untouched", async () => {
+    const response = new Response(
+      JSON.stringify({ error: "invalid_client_metadata" }),
+      { status: 400 },
+    );
+
+    await expect(withCompatibilityClientSecret(response)).resolves.toBe(
+      response,
+    );
+  });
+});
diff --git a/src/server/mcp/oauth-registration.ts b/src/server/mcp/oauth-registration.ts
index 427dfe8..1cd9922 100644
--- a/src/server/mcp/oauth-registration.ts
+++ b/src/server/mcp/oauth-registration.ts
@@ -1,4 +1,5 @@
-const CONFIDENTIAL_CLIENT_AUTH_METHOD = "client_secret_post";
+const PUBLIC_CLIENT_AUTH_METHOD = "none";
+const COMPATIBILITY_AUTH_METHOD = "client_secret_post";
 const MAX_CLIENT_REGISTRATION_BODY_BYTES = 1024 * 1024;
 
 export async function normalizeClientRegistrationRequest(request: Request) {
@@ -38,14 +39,10 @@ export async function normalizeClientRegistrationRequest(request: Request) {
     ...clientMetadata,
   } as Record<string, unknown>;
 
-  if (
-    metadata.token_endpoint_auth_method === undefined ||
-    metadata.token_endpoint_auth_method === "none"
-  ) {
-    // Perplexity registers as a public client but then rejects DCR responses
-    // without a client_secret. Use client_secret_post because its validator
-    // accepts that method but rejects client_secret_basic.
-    metadata.token_endpoint_auth_method = CONFIDENTIAL_CLIENT_AUTH_METHOD;
+  if (metadata.token_endpoint_auth_method === undefined) {
+    // Register as a public client so refresh works for clients that discard
+    // the registration response's client_secret (e.g. Codex).
+    metadata.token_endpoint_auth_method = PUBLIC_CLIENT_AUTH_METHOD;
   }
 
   const headers = new Headers(request.headers);
@@ -58,3 +55,60 @@ export async function normalizeClientRegistrationRequest(request: Request) {
     body: JSON.stringify(metadata),
   });
 }
+
+/**
+ * Perplexity rejects a registration response with no client_secret. For public
+ * registrations, report a throwaway placeholder secret. It is never stored, so
+ * the token endpoint (public client) does not require it. client_secret_post is
+ * used because Perplexity's validator accepts it but rejects client_secret_basic.
+ */
+export async function withCompatibilityClientSecret(
+  response: Response,
+): Promise<Response> {
+  if (response.status !== 201) {
+    return response;
+  }
+
+  let body: unknown;
+  try {
+    body = await response.clone().json();
+  } catch {
+    return response;
+  }
+
+  if (!body || typeof body !== "object" || Array.isArray(body)) {
+    return response;
+  }
+
+  const registration = body as Record<string, unknown>;
+  if (
+    registration.token_endpoint_auth_method !== PUBLIC_CLIENT_AUTH_METHOD ||
+    registration.client_secret !== undefined
+  ) {
+    return response;
+  }
+
+  const secretBytes = crypto.getRandomValues(new Uint8Array(16));
+  const clientSecret = Array.from(secretBytes, (byte) =>
+    byte.toString(16).padStart(2, "0"),
+  ).join("");
+
+  const headers = new Headers(response.headers);
+  headers.set("Content-Type", "application/json");
+  headers.delete("Content-Length");
+
+  return new Response(
+    JSON.stringify({
+      ...registration,
+      token_endpoint_auth_method: COMPATIBILITY_AUTH_METHOD,
+      client_secret: clientSecret,
+      client_secret_expires_at: 0,
+      client_secret_issued_at: registration.client_id_issued_at,
+    }),
+    {
+      status: response.status,
+      statusText: response.statusText,
+      headers,
+    },
+  );
+}

```

## Patch B

```diff
diff --git a/src/server/mcp/oauth-provider.ts b/src/server/mcp/oauth-provider.ts
index 5026c58..5b8e93e 100644
--- a/src/server/mcp/oauth-provider.ts
+++ b/src/server/mcp/oauth-provider.ts
@@ -20,7 +20,10 @@ import {
   MCP_ROUTE,
   withWorkersOAuthMcpScopes,
 } from "@/server/mcp/context";
-import { normalizeClientRegistrationRequest } from "@/server/mcp/oauth-registration";
+import {
+  normalizeClientRegistrationRequest,
+  withCompatibilityClientSecret,
+} from "@/server/mcp/oauth-registration";
 import { getPublicOrigin } from "@/server/mcp/public-origin";
 import { handleAuthenticatedOpenSeoMcpRequest } from "@/server/mcp/transport";
 import { resolveHostedContext } from "@/middleware/ensure-user/hosted";
@@ -445,11 +448,13 @@ export function createOpenSeoOAuthProvider(appFetch: AppFetch) {
       const url = new URL(request.url);
 
       if (url.pathname === OAUTH_REGISTER_PATH) {
-        // Cloudflare's provider can reject public DCR clients, but Perplexity
-        // does not appear to retry as confidential and instead expects a
-        // client_secret. Normalize before handing the request to Cloudflare so
-        // it still owns client creation, secret hashing, and token storage.
+        // Register DCR clients as public so refresh works for clients that
+        // discard the secret (e.g. Codex), then add a placeholder client_secret
+        // to the response because Perplexity rejects responses without one.
         request = await normalizeClientRegistrationRequest(request);
+        return withCompatibilityClientSecret(
+          await provider.fetch(request, env, ctx),
+        );
       }
 
       return provider.fetch(request, env, ctx);
diff --git a/src/server/mcp/oauth-registration.test.ts b/src/server/mcp/oauth-registration.test.ts
index 97b5426..37b0544 100644
--- a/src/server/mcp/oauth-registration.test.ts
+++ b/src/server/mcp/oauth-registration.test.ts
@@ -1,8 +1,11 @@
 import { describe, expect, it } from "vitest";
-import { normalizeClientRegistrationRequest } from "@/server/mcp/oauth-registration";
+import {
+  normalizeClientRegistrationRequest,
+  withCompatibilityClientSecret,
+} from "@/server/mcp/oauth-registration";
 
 describe("normalizeClientRegistrationRequest", () => {
-  it("converts public dynamic registration requests to confidential clients", async () => {
+  it("keeps explicit public registrations public", async () => {
     const request = new Request(
       "https://app.openseo.so/api/auth/oauth2/register",
       {
@@ -19,11 +22,11 @@ describe("normalizeClientRegistrationRequest", () => {
     const normalized = await normalizeClientRegistrationRequest(request);
 
     await expect(normalized.json()).resolves.toMatchObject({
-      token_endpoint_auth_method: "client_secret_post",
+      token_endpoint_auth_method: "none",
     });
   });
 
-  it("defaults omitted token auth methods to confidential clients", async () => {
+  it("defaults omitted token auth methods to public clients", async () => {
     const request = new Request(
       "https://app.openseo.so/api/auth/oauth2/register",
       {
@@ -39,7 +42,7 @@ describe("normalizeClientRegistrationRequest", () => {
     const normalized = await normalizeClientRegistrationRequest(request);
 
     await expect(normalized.json()).resolves.toMatchObject({
-      token_endpoint_auth_method: "client_secret_post",
+      token_endpoint_auth_method: "none",
     });
   });
 
@@ -86,3 +89,60 @@ describe("normalizeClientRegistrationRequest", () => {
     );
   });
 });
+
+describe("withCompatibilityClientSecret", () => {
+  const publicRegistration = {
+    client_id: "client-1",
+    client_id_issued_at: 1700000000,
+    token_endpoint_auth_method: "none",
+    redirect_uris: ["https://www.perplexity.ai/api/mcp/oauth/callback"],
+  };
+
+  it("adds a placeholder secret to public registration responses", async () => {
+    const response = new Response(JSON.stringify(publicRegistration), {
+      status: 201,
+      headers: { "Content-Type": "application/json" },
+    });
+
+    const result = await withCompatibilityClientSecret(response);
+    const body = (await result.json()) as { client_secret: string };
+
+    expect(result.status).toBe(201);
+    expect(body).toMatchObject({
+      ...publicRegistration,
+      token_endpoint_auth_method: "client_secret_post",
+      client_secret_expires_at: 0,
+      client_secret_issued_at: 1700000000,
+    });
+    expect(body.client_secret).toMatch(/^[0-9a-f]{32}$/);
+  });
+
+  it("returns confidential registrations untouched", async () => {
+    const response = new Response(
+      JSON.stringify({
+        ...publicRegistration,
+        token_endpoint_auth_method: "client_secret_post",
+        client_secret: "real",
+      }),
+      { status: 201 },
+    );
+
+    await expect(withCompatibilityClientSecret(response)).resolves.toBe(
+      response,
+    );
+  });
+
+  it("returns error responses untouched", async () => {
+    const response = new Response(
+      JSON.stringify({
+        ...publicRegistration,
+        error: "invalid_client_metadata",
+      }),
+      { status: 400 },
+    );
+
+    await expect(withCompatibilityClientSecret(response)).resolves.toBe(
+      response,
+    );
+  });
+});
diff --git a/src/server/mcp/oauth-registration.ts b/src/server/mcp/oauth-registration.ts
index 427dfe8..2517688 100644
--- a/src/server/mcp/oauth-registration.ts
+++ b/src/server/mcp/oauth-registration.ts
@@ -1,4 +1,5 @@
-const CONFIDENTIAL_CLIENT_AUTH_METHOD = "client_secret_post";
+const PUBLIC_CLIENT_AUTH_METHOD = "none";
+const COMPAT_CLIENT_AUTH_METHOD = "client_secret_post";
 const MAX_CLIENT_REGISTRATION_BODY_BYTES = 1024 * 1024;
 
 export async function normalizeClientRegistrationRequest(request: Request) {
@@ -38,14 +39,11 @@ export async function normalizeClientRegistrationRequest(request: Request) {
     ...clientMetadata,
   } as Record<string, unknown>;
 
-  if (
-    metadata.token_endpoint_auth_method === undefined ||
-    metadata.token_endpoint_auth_method === "none"
-  ) {
-    // Perplexity registers as a public client but then rejects DCR responses
-    // without a client_secret. Use client_secret_post because its validator
-    // accepts that method but rejects client_secret_basic.
-    metadata.token_endpoint_auth_method = CONFIDENTIAL_CLIENT_AUTH_METHOD;
+  if (metadata.token_endpoint_auth_method === undefined) {
+    // Register public clients as public so the token endpoint does not demand
+    // a client_secret that clients like Codex discard. See
+    // withCompatibilityClientSecret for Perplexity's response requirement.
+    metadata.token_endpoint_auth_method = PUBLIC_CLIENT_AUTH_METHOD;
   }
 
   const headers = new Headers(request.headers);
@@ -58,3 +56,57 @@ export async function normalizeClientRegistrationRequest(request: Request) {
     body: JSON.stringify(metadata),
   });
 }
+
+function randomHex32() {
+  const bytes = crypto.getRandomValues(new Uint8Array(16));
+  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
+    "",
+  );
+}
+
+/**
+ * Perplexity rejects registration responses without a client_secret, and its
+ * validator accepts client_secret_post but not client_secret_basic. The stored
+ * client stays public, so the placeholder secret is never checked at the token
+ * endpoint: clients that send it and clients that discard it both work.
+ */
+export async function withCompatibilityClientSecret(
+  response: Response,
+): Promise<Response> {
+  if (response.status !== 201) {
+    return response;
+  }
+
+  let body: unknown;
+  try {
+    body = await response.clone().json();
+  } catch {
+    return response;
+  }
+
+  if (!body || typeof body !== "object" || Array.isArray(body)) {
+    return response;
+  }
+
+  const registration = body as Record<string, unknown>;
+  if (
+    registration.token_endpoint_auth_method !== PUBLIC_CLIENT_AUTH_METHOD ||
+    registration.client_secret !== undefined
+  ) {
+    return response;
+  }
+
+  const headers = new Headers(response.headers);
+  headers.delete("Content-Length");
+
+  return new Response(
+    JSON.stringify({
+      ...registration,
+      token_endpoint_auth_method: COMPAT_CLIENT_AUTH_METHOD,
+      client_secret: randomHex32(),
+      client_secret_expires_at: 0,
+      client_secret_issued_at: registration.client_id_issued_at,
+    }),
+    { status: response.status, statusText: response.statusText, headers },
+  );
+}

```
