import { serve, file } from "bun";
import { spawn } from "bun";
import postgres from "postgres";
import { randomUUID } from "crypto";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { createHash, randomBytes } from "crypto";
import { homedir } from "os";
import { runMigrations } from "./db/migrate.js";

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "postgres://openworld:openworld@localhost:5432/openworld";
const SESSIONS_DIR = join(import.meta.dir, "sessions");
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

// Claude OAuth constants
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTH_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_MANUAL_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";

let pendingOAuth = null;

// ── Database ────────────────────────────────────────────────
const sql = postgres(DATABASE_URL, { max: 10 });

// ── Helpers ─────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function refreshClaudeToken() {
  try {
    let credentials = {};
    try { credentials = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")); } catch { return; }
    const oauth = credentials.claudeAiOauth;
    if (!oauth?.refreshToken || !oauth?.expiresAt) return;
    const expiresAt = new Date(oauth.expiresAt).getTime();
    if (Date.now() < expiresAt - 10 * 60 * 1000) return;
    console.log("[auth] Claude token expiring soon, refreshing...");
    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: CLAUDE_CLIENT_ID }),
    });
    if (!res.ok) { console.error("[auth] Token refresh failed:", res.status, await res.text()); return; }
    const tokens = await res.json();
    credentials.claudeAiOauth = {
      ...oauth,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? oauth.refreshToken,
      expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
    };
    await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
    console.log("[auth] Claude token refreshed successfully");
  } catch (err) { console.error("[auth] Token refresh error:", err); }
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
};

// ── Active Claude processes per session ─────────────────────
const activeProcesses = new Map();

// ── Run migrations on startup ───────────────────────────────
await runMigrations(sql);

// ── Server ──────────────────────────────────────────────────
serve({
  port: PORT,
  idleTimeout: 255, // max seconds — Claude generation can take a while
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // ── Static files ──────────────────────────────────────
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(file(join(import.meta.dir, "public", "index.html")));
    }

    // Serve session files (Three.js scenes)
    if (pathname.startsWith("/sessions/")) {
      const filePath = join(import.meta.dir, pathname);
      try {
        const f = file(filePath);
        if (await f.exists()) {
          const ext = extname(filePath);
          return new Response(f, {
            headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" },
          });
        }
      } catch {}
      return new Response("Not found", { status: 404 });
    }

    // Serve public static files
    if (pathname.startsWith("/public/") || pathname.startsWith("/fonts/") || pathname.endsWith(".css") || pathname.endsWith(".js") || pathname.endsWith(".woff2")) {
      const filePath = pathname.startsWith("/public/")
        ? join(import.meta.dir, pathname)
        : join(import.meta.dir, "public", pathname);
      try {
        const f = file(filePath);
        if (await f.exists()) {
          const ext = extname(filePath);
          return new Response(f, {
            headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" },
          });
        }
      } catch {}
    }

    // ── API: Sessions ─────────────────────────────────────

    // List sessions
    if (pathname === "/api/sessions" && req.method === "GET") {
      const sessions = await sql`
        SELECT s.id, s.title, s.created_at, s.updated_at,
          (SELECT content FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message
        FROM sessions s ORDER BY s.updated_at DESC
      `;
      return json(sessions);
    }

    // Create session
    if (pathname === "/api/sessions" && req.method === "POST") {
      const { title } = await req.json();
      const id = randomUUID();
      const sessionDir = join(SESSIONS_DIR, id);
      await mkdir(sessionDir, { recursive: true });
      await sql`INSERT INTO sessions (id, title) VALUES (${id}, ${title || "New Scene"})`;
      return json({ id, title: title || "New Scene" });
    }

    // Get session with messages
    if (pathname.match(/^\/api\/sessions\/[^/]+$/) && req.method === "GET") {
      const sessionId = pathname.split("/").pop();
      const [session] = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
      if (!session) return json({ error: "Session not found" }, 404);
      const messages = await sql`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY created_at`;
      return json({ ...session, messages });
    }

    // Delete session
    if (pathname.match(/^\/api\/sessions\/[^/]+$/) && req.method === "DELETE") {
      const sessionId = pathname.split("/").pop();
      await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
      // Clean up session directory
      try {
        const dir = join(SESSIONS_DIR, sessionId);
        const proc = spawn(["rm", "-rf", dir]);
        await proc.exited;
      } catch {}
      return json({ ok: true });
    }

    // ── API: Chat / Generate ──────────────────────────────

    if (pathname === "/api/chat" && req.method === "POST") {
      // Parse multipart form data
      const formData = await req.formData();
      const sessionId = formData.get("sessionId");
      const message = formData.get("message");
      const files = formData.getAll("files");

      if (!sessionId || !message) return json({ error: "sessionId and message required" }, 400);

      // Verify session exists
      const [session] = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
      if (!session) return json({ error: "Session not found" }, 404);

      const sessionDir = join(SESSIONS_DIR, sessionId);
      await mkdir(sessionDir, { recursive: true });

      // Save uploaded files to session directory
      const uploadedFiles = [];
      for (const f of files) {
        if (f && f.name && f.size > 0) {
          const filePath = join(sessionDir, f.name);
          const buf = Buffer.from(await f.arrayBuffer());
          await writeFile(filePath, buf);
          uploadedFiles.push(f.name);
        }
      }

      // Save user message
      const msgContent = uploadedFiles.length
        ? `${message}\n[Attached: ${uploadedFiles.join(", ")}]`
        : message;
      await sql`INSERT INTO messages (session_id, role, content) VALUES (${sessionId}, 'user', ${msgContent})`;
      await sql`UPDATE sessions SET updated_at = NOW() WHERE id = ${sessionId}`;

      // Update title from first message
      const [msgCount] = await sql`SELECT count(*) as c FROM messages WHERE session_id = ${sessionId} AND role = 'user'`;
      if (parseInt(msgCount.c) === 1) {
        const title = message.substring(0, 60) + (message.length > 60 ? "..." : "");
        await sql`UPDATE sessions SET title = ${title} WHERE id = ${sessionId}`;
      }

      // Get conversation history for context
      const history = await sql`SELECT role, content FROM messages WHERE session_id = ${sessionId} ORDER BY created_at`;

      // Build the prompt for Claude
      const conversationContext = history
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n\n");

      const systemPrompt = `You are a 3D scene/model/game creator. You create Three.js scenes that run in the browser.

IMPORTANT RULES:
- Create a single index.html file in the current directory
- Use Three.js via CDN: https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
- Also include OrbitControls if needed via: https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js
- The scene should fill the entire viewport (100vw x 100vh)
- Make it visually impressive with lighting, shadows, and animation
- Use requestAnimationFrame for smooth animation loops
- The HTML file should be completely self-contained
- Add mouse/touch interaction where appropriate
- If the user asks for a game, include game logic, scoring, and controls
- Background should be a nice gradient or dark color, NOT white

RESPONSE RULES:
- In your text response, ONLY describe what the scene contains and its features
- NEVER mention file names, index.html, directories, or technical implementation details
- NEVER tell the user to "open" any file — the scene loads automatically
- Talk about the scene as if presenting it: "Your scene features...", "The scene includes..."
- Keep responses concise and descriptive

Current working directory: ${sessionDir}
${uploadedFiles.length ? `\nUploaded files in this directory: ${uploadedFiles.join(", ")}\nYou can reference these files in your Three.js scene (e.g., textures, models, reference images).` : ""}

Conversation so far:
${conversationContext}

Create or update the Three.js scene based on the latest user request. Write the files to the current directory.`;

      // Stream response using SSE
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let controllerClosed = false;
          function safeEnqueue(data) {
            if (!controllerClosed) {
              try { controller.enqueue(data); } catch { controllerClosed = true; }
            }
          }
          function safeClose() {
            if (!controllerClosed) {
              try { controller.close(); } catch {}
              controllerClosed = true;
            }
          }
          try {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", message: "Starting Claude..." })}\n\n`));

            await refreshClaudeToken();

            const claudeArgs = [
              "claude",
              "--dangerously-skip-permissions",
              "--output-format", "stream-json",
              "--verbose",
              "-p", systemPrompt,
            ];
            console.log("[claude] Spawning:", claudeArgs.join(" ").substring(0, 200) + "...");
            console.log("[claude] CWD:", sessionDir);

            const proc = spawn(claudeArgs, {
              cwd: sessionDir,
              stdout: "pipe",
              stderr: "pipe",
              env: { ...process.env, HOME: homedir() },
            });

            // Log stderr in real-time
            (async () => {
              const stderrReader = proc.stderr.getReader();
              let stderrBuf = "";
              while (true) {
                const { done, value } = await stderrReader.read();
                if (done) break;
                stderrBuf += new TextDecoder().decode(value);
                const lines = stderrBuf.split("\n");
                stderrBuf = lines.pop() || "";
                for (const line of lines) {
                  if (line.trim()) console.error("[claude stderr]", line);
                }
              }
              if (stderrBuf.trim()) console.error("[claude stderr]", stderrBuf);
            })();

            activeProcesses.set(sessionId, proc);

            let assistantResponse = "";
            let buffer = "";

            const reader = proc.stdout.getReader();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = new TextDecoder().decode(value);
              buffer += chunk;
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const event = JSON.parse(line);
                  console.log("[claude event]", event.type, JSON.stringify(event).substring(0, 300));

                  if (event.type === "assistant" && event.message) {
                    for (const block of event.message.content || []) {
                      if (block.type === "text") {
                        assistantResponse += block.text;
                        safeEnqueue(
                          encoder.encode(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`)
                        );
                      }
                    }
                  } else if (event.type === "content_block_delta") {
                    if (event.delta?.text) {
                      assistantResponse += event.delta.text;
                      safeEnqueue(
                        encoder.encode(`data: ${JSON.stringify({ type: "text", content: event.delta.text })}\n\n`)
                      );
                    }
                  } else if (event.type === "result") {
                    if (event.result) {
                      assistantResponse = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
                    }
                    safeEnqueue(
                      encoder.encode(`data: ${JSON.stringify({ type: "status", message: "Finalizing..." })}\n\n`)
                    );
                  }
                } catch (parseErr) {
                  console.warn("[claude] Non-JSON line:", line.substring(0, 200));
                }
              }
            }

            const exitCode = await proc.exited;
            console.log("[claude] Process exited with code:", exitCode);
            activeProcesses.delete(sessionId);

            // Save assistant response
            console.log("[claude] Response length:", assistantResponse.length);
            if (assistantResponse) {
              await sql`INSERT INTO messages (session_id, role, content) VALUES (${sessionId}, 'assistant', ${assistantResponse.substring(0, 10000)})`;
            }

            // Check if index.html was created
            const indexPath = join(sessionDir, "index.html");
            let sceneReady = false;
            try {
              await stat(indexPath);
              sceneReady = true;
              console.log("[claude] Scene file created:", indexPath);
            } catch {
              console.warn("[claude] No index.html found at:", indexPath);
              // List what files were created
              try {
                const dirFiles = await readdir(sessionDir);
                console.log("[claude] Files in session dir:", dirFiles);
              } catch {}
            }

            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "done",
                  sceneReady,
                  scenePath: `/sessions/${sessionId}/index.html`,
                  message: assistantResponse,
                })}\n\n`
              )
            );
          } catch (err) {
            console.error("[claude] Stream error:", err);
            safeEnqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`)
            );
          } finally {
            activeProcesses.delete(sessionId);
            safeClose();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // ── API: Check if session is generating ────────────────
    if (pathname.match(/^\/api\/sessions\/[^/]+\/status$/) && req.method === "GET") {
      const sessionId = pathname.split("/")[3];
      return json({ generating: activeProcesses.has(sessionId) });
    }

    // ── API: Stop generation ──────────────────────────────
    if (pathname === "/api/stop" && req.method === "POST") {
      const { sessionId } = await req.json();
      const proc = activeProcesses.get(sessionId);
      if (proc) {
        proc.kill();
        activeProcesses.delete(sessionId);
      }
      return json({ ok: true });
    }

    // ── Claude Auth API (OAuth PKCE) ────────────────────────

    if (pathname === "/api/claude-auth/status" && req.method === "GET") {
      try {
        await refreshClaudeToken();
        const raw = await readFile(CREDENTIALS_PATH, "utf8");
        const creds = JSON.parse(raw);
        if (creds.claudeAiOauth?.accessToken) {
          return json({ loggedIn: true, account: "Claude" });
        }
        return json({ loggedIn: false });
      } catch {
        return json({ loggedIn: false });
      }
    }

    if (pathname === "/api/claude-auth/login" && req.method === "POST") {
      try {
        const { verifier, challenge } = generatePKCE();
        const state = randomBytes(32).toString("base64url");
        pendingOAuth = { codeVerifier: verifier, state };
        const ref = pendingOAuth;
        setTimeout(() => { if (pendingOAuth === ref) pendingOAuth = null; }, 10 * 60 * 1000);

        const authUrl = new URL(CLAUDE_AUTH_URL);
        authUrl.searchParams.set("code", "true");
        authUrl.searchParams.set("client_id", CLAUDE_CLIENT_ID);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("redirect_uri", CLAUDE_MANUAL_REDIRECT);
        authUrl.searchParams.set("scope", CLAUDE_SCOPES);
        authUrl.searchParams.set("code_challenge", challenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("state", state);

        return json({ ok: true, url: authUrl.toString() });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    if (pathname === "/api/claude-auth/code" && req.method === "POST") {
      try {
        const { code } = await req.json();
        if (!code?.trim()) return json({ error: "Code is required." }, 400);
        if (!pendingOAuth) return json({ error: "No pending login. Click Connect first." }, 400);

        const authCode = code.trim().split("#")[0];

        const tokenRes = await fetch(CLAUDE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLAUDE_CLIENT_ID,
            code: authCode,
            code_verifier: pendingOAuth.codeVerifier,
            redirect_uri: CLAUDE_MANUAL_REDIRECT,
            state: pendingOAuth.state,
          }),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          console.error("[auth] Token exchange failed:", tokenRes.status, errBody);
          return json({ error: "Token exchange failed. The code may be invalid or expired." }, 400);
        }

        const tokens = await tokenRes.json();
        pendingOAuth = null;

        const credDir = join(homedir(), ".claude");
        await mkdir(credDir, { recursive: true });
        let credentials = {};
        try { credentials = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")); } catch {}
        credentials.claudeAiOauth = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
          scopes: CLAUDE_SCOPES.split(" "),
        };
        await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
        console.log("[auth] OAuth tokens saved to", CREDENTIALS_PATH);

        return json({ ok: true });
      } catch (err) {
        console.error("[auth] Code exchange error:", err);
        return json({ error: err.message }, 500);
      }
    }

    if (pathname === "/api/claude-auth/logout" && req.method === "POST") {
      try {
        let credentials = {};
        try { credentials = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")); } catch {}
        delete credentials.claudeAiOauth;
        await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── Fallback: serve index.html for SPA ────────────────
    return new Response(file(join(import.meta.dir, "public", "index.html")));
  },
});

console.log(`OpenWorld server running on http://localhost:${PORT}`);
