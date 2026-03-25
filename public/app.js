// ── State ────────────────────────────────────────────────
let currentSessionId = null;
let sessions = [];
let isGenerating = false;
let pendingFiles = []; // files attached before sending

// ── DOM refs ─────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const landing = $("#landing");
const workspace = $("#workspace");
const promptInput = $("#prompt-input");
const followupInput = $("#followup-input");
const messagesEl = $("#messages");
const sessionList = $("#session-list");
const sceneFrame = $("#scene-frame");
const emptyState = $("#empty-state");
const loadingOverlay = $("#loading-overlay");
const loadingText = $("#loading-text");
const loadingLog = $("#loading-log");
const authModal = $("#auth-modal");
const landingAuthStatus = $("#landing-auth-status");
const landingAuthDot = $("#landing-auth-dot");
const landingAuthText = $("#landing-auth-text");

// ── Init ─────────────────────────────────────────────────
async function init() {
  await loadSessions();
  checkAuth();
  setupEvents();
  loadPublicSessions();

  // Load session from URL param
  const params = new URLSearchParams(window.location.search);
  const sessionParam = params.get("session");
  if (sessionParam) {
    loadSession(sessionParam);
  }
}

// Handle browser back/forward
window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  const sessionParam = params.get("session");
  if (sessionParam) {
    loadSession(sessionParam);
  } else {
    showLanding();
  }
});

// ── Auth ─────────────────────────────────────────────────
async function checkAuth() {
  try {
    const res = await fetch("/api/claude-auth/status");
    const data = await res.json();
    if (data.loggedIn || data.account) {
      setLandingAuth(true, data.account || "Claude");
    } else {
      setLandingAuth(false);
      showAuthModal();
    }
  } catch {
    setLandingAuth(false);
    showAuthModal();
  }
}

function setLandingAuth(connected, account) {
  const cls = connected ? "connected" : "disconnected";
  const text = connected ? `Connected to ${account}` : "Claude not connected - click to connect";
  landingAuthDot.className = `auth-dot ${cls}`;
  landingAuthText.textContent = text;
  // Also update sidebar
  const sidebarDot = $("#sidebar-auth-dot");
  const sidebarText = $("#sidebar-auth-text");
  if (sidebarDot) sidebarDot.className = `auth-dot ${cls}`;
  if (sidebarText) sidebarText.textContent = text;
}

function showAuthModal() {
  authModal.classList.remove("hidden");
  $("#auth-status-text").textContent = "Connect your Claude account to start building.";
  $("#auth-login-section").classList.remove("hidden");
  $("#auth-code-section").classList.add("hidden");
  $("#auth-logged-in").classList.add("hidden");
}

function hideAuthModal() {
  authModal.classList.add("hidden");
  checkAuth();
}

async function startLogin() {
  const res = await fetch("/api/claude-auth/login", { method: "POST" });
  const data = await res.json();
  if (data.url) {
    window.open(data.url, "_blank", "width=600,height=700");
    $("#auth-login-section").classList.add("hidden");
    $("#auth-code-section").classList.remove("hidden");
  } else {
    alert(data.error || "Failed to start login");
  }
}

async function submitAuthCode() {
  const code = $("#auth-code-input").value;
  if (!code.trim()) return;
  const res = await fetch("/api/claude-auth/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (data.ok) {
    $("#auth-code-section").classList.add("hidden");
    $("#auth-logged-in").classList.remove("hidden");
    setLandingAuth(true, "Claude");
    setTimeout(() => hideAuthModal(), 500);
  } else {
    alert(data.error || "Failed to authenticate");
  }
}

async function logout() {
  await fetch("/api/claude-auth/logout", { method: "POST" });
  setLandingAuth(false);
  showAuthModal();
}

// ── Sessions ─────────────────────────────────────────────
async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
    renderSessionList();
  } catch {}
}

function renderSessionList() {
  const html = sessions
    .map(
      (s) => `
    <div class="session-item ${s.id === currentSessionId ? "active" : ""}" data-id="${s.id}">
      <span>${escapeHtml(s.title)}</span>
      <button class="delete-btn" data-id="${s.id}" title="Delete">&times;</button>
    </div>
  `
    )
    .join("");
  sessionList.innerHTML = html;
  // Also update drawer
  renderDrawerSessions();
}

function renderDrawerSessions() {
  const el = $("#drawer-session-list");
  if (!el) return;
  el.innerHTML = sessions
    .map(
      (s) => `
    <div class="session-item ${s.id === currentSessionId ? "active" : ""}" data-id="${s.id}">
      <span>${escapeHtml(s.title)}</span>
      <button class="delete-btn" data-id="${s.id}" title="Delete">&times;</button>
    </div>
  `
    )
    .join("");
}

function openDrawer() {
  renderDrawerSessions();
  $("#sessions-drawer").classList.add("open");
  $("#drawer-backdrop").classList.remove("hidden");
}

function closeDrawer() {
  $("#sessions-drawer").classList.remove("open");
  $("#drawer-backdrop").classList.add("hidden");
}

async function createSession(title) {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const session = await res.json();
  currentSessionId = session.id;
  sessions.unshift(session);
  renderSessionList();
  return session;
}

async function loadSession(sessionId) {
  currentSessionId = sessionId;
  // Update URL
  const url = new URL(window.location);
  url.searchParams.set("session", sessionId);
  history.pushState(null, "", url);

  // Reset view state
  hideLoading();
  showEmptyState();
  showWorkspace();
  renderSessionList();

  const res = await fetch(`/api/sessions/${sessionId}`);
  const data = await res.json();

  // Render messages
  messagesEl.innerHTML = "";
  for (const msg of data.messages || []) {
    appendMessage(msg.role, msg.content);
  }

  // Check if session is currently generating
  try {
    const statusRes = await fetch(`/api/sessions/${sessionId}/status`);
    const statusData = await statusRes.json();
    if (statusData.generating) {
      showLoading();
      return;
    }
  } catch {}

  // Try to load scene
  const scenePath = `/sessions/${sessionId}/index.html`;
  try {
    const check = await fetch(scenePath, { method: "HEAD" });
    if (check.ok) {
      showScene(scenePath + "?t=" + Date.now());
    } else {
      showEmptyState();
    }
  } catch {
    showEmptyState();
  }
}

async function deleteSession(sessionId) {
  await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  sessions = sessions.filter((s) => s.id !== sessionId);
  if (currentSessionId === sessionId) {
    if (sessions.length > 0) {
      loadSession(sessions[0].id);
    } else {
      showLanding();
    }
  }
  renderSessionList();
}

// ── Chat ─────────────────────────────────────────────────
async function sendMessage(message) {
  if (!message.trim() || isGenerating) return;

  // If no session, create one and clear old messages
  if (!currentSessionId) {
    messagesEl.innerHTML = "";
    showEmptyState();
    await createSession(message.substring(0, 60));
  }

  // Update URL with session
  const url = new URL(window.location);
  url.searchParams.set("session", currentSessionId);
  history.pushState(null, "", url);

  // Switch to workspace view
  showWorkspace();

  // Show user message (include file names if any)
  const fileNames = pendingFiles.map((f) => f.name);
  const displayMsg = fileNames.length
    ? `${message}\n[Attached: ${fileNames.join(", ")}]`
    : message;
  appendMessage("user", displayMsg);

  // Show loading
  showLoading();
  isGenerating = true;

  try {
    // Build form data with files
    const formData = new FormData();
    formData.append("sessionId", currentSessionId);
    formData.append("message", message);
    for (const file of pendingFiles) {
      formData.append("files", file);
    }
    pendingFiles = [];
    clearAttachments();

    const res = await fetch("/api/chat", {
      method: "POST",
      body: formData,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullResponse = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === "status") {
            // status updates handled by typewriter rotation
          } else if (event.type === "text") {
            fullResponse += event.content;
            updateLoadingLog(fullResponse);
          } else if (event.type === "done") {
            const responseText = event.message || fullResponse;
            if (event.sceneReady) {
              showScene(event.scenePath + "?t=" + Date.now());
              appendMessage("assistant", responseText || "Scene created!");
            } else {
              showEmptyState();
              appendMessage("assistant", responseText || "Something went wrong - no scene was generated.");
            }
          } else if (event.type === "error") {
            showEmptyState();
            appendMessage("assistant", "Error: " + event.message);
          }
        } catch {}
      }
    }
  } catch (err) {
    showEmptyState();
    appendMessage("assistant", "Connection error: " + err.message);
  } finally {
    isGenerating = false;
    hideLoading();
    await loadSessions(); // Refresh session list for updated titles
  }
}

// ── UI Helpers ───────────────────────────────────────────
function showWorkspace() {
  landing.classList.add("hidden");
  workspace.classList.remove("hidden");
}

function showLanding() {
  landing.classList.remove("hidden");
  workspace.classList.add("hidden");
  currentSessionId = null;
  promptInput.value = "";
  const url = new URL(window.location);
  url.searchParams.delete("session");
  history.pushState(null, "", url);
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function appendMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showScene(path) {
  sceneFrame.src = path;
  sceneFrame.classList.remove("hidden");
  emptyState.classList.add("hidden");
}

function showEmptyState() {
  sceneFrame.classList.add("hidden");
  sceneFrame.src = "";
  emptyState.classList.remove("hidden");
}

const loadingPhrases = [
  "Thinking...",
  "Imagining your scene...",
  "Generating 3D models...",
  "Building the world...",
  "Crafting geometry...",
  "Painting textures...",
  "Setting up lighting...",
  "Rendering your creation...",
  "Adding final touches...",
  "Almost there...",
];

let loadingInterval = null;
let typewriterTimeout = null;

function showLoading() {
  loadingText.textContent = "";
  loadingLog.textContent = "";
  loadingLog.classList.remove("has-content");
  loadingOverlay.classList.remove("hidden");
  emptyState.classList.add("hidden");
  startPhraseRotation();
}

function hideLoading() {
  loadingOverlay.classList.add("hidden");
  stopPhraseRotation();
}

function startPhraseRotation() {
  stopPhraseRotation();
  let phraseIndex = 0;
  typewritePhrase(loadingPhrases[0]);
  loadingInterval = setInterval(() => {
    phraseIndex = (phraseIndex + 1) % loadingPhrases.length;
    typewritePhrase(loadingPhrases[phraseIndex]);
  }, 4000);
}

function stopPhraseRotation() {
  if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = null; }
  if (typewriterTimeout) { clearTimeout(typewriterTimeout); typewriterTimeout = null; }
}

function typewritePhrase(phrase) {
  if (typewriterTimeout) clearTimeout(typewriterTimeout);
  loadingText.textContent = "";
  let i = 0;
  function type() {
    if (i < phrase.length) {
      loadingText.textContent = phrase.substring(0, i + 1);
      i++;
      typewriterTimeout = setTimeout(type, 35 + Math.random() * 25);
    }
  }
  type();
}

function updateLoadingLog(text) {
  // Show last few lines of Claude's response
  const lines = text.split("\n").slice(-8).join("\n");
  if (lines.trim()) {
    loadingLog.textContent = lines;
    loadingLog.classList.add("has-content");
    loadingLog.scrollTop = loadingLog.scrollHeight;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Attachments ──────────────────────────────────────────
function addFiles(files) {
  for (const file of files) {
    pendingFiles.push(file);
  }
  renderAttachments();
}

function removeFile(index) {
  pendingFiles.splice(index, 1);
  renderAttachments();
}

function clearAttachments() {
  document.querySelectorAll(".attachments").forEach((el) => (el.innerHTML = ""));
}

function renderAttachments() {
  const containers = [$("#attachments-landing"), $("#attachments-sidebar")];
  for (const container of containers) {
    container.innerHTML = pendingFiles
      .map((file, i) => {
        const isImage = file.type.startsWith("image/");
        const name = file.name.length > 20 ? file.name.substring(0, 17) + "..." : file.name;
        const iconHtml = isImage
          ? `<img class="attachment-thumb" src="${URL.createObjectURL(file)}" alt="" />`
          : `<span class="file-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>`;
        return `<div class="attachment-chip">
          ${iconHtml}
          <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(name)}</span>
          <button class="remove-btn" data-index="${i}" title="Remove">&times;</button>
        </div>`;
      })
      .join("");

    // Bind remove buttons
    container.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFile(parseInt(btn.dataset.index));
      });
    });
  }
}

// ── Events ───────────────────────────────────────────────
function setupEvents() {
  // Landing prompt
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const msg = promptInput.value.trim();
      promptInput.value = "";
      sendMessage(msg);
    }
  });

  // Submit button on landing
  $("#btn-submit").addEventListener("click", () => {
    const msg = promptInput.value.trim();
    promptInput.value = "";
    sendMessage(msg);
  });

  // Follow-up input
  followupInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const msg = followupInput.value.trim();
      followupInput.value = "";
      sendMessage(msg);
    }
  });

  $("#btn-followup").addEventListener("click", () => {
    const msg = followupInput.value.trim();
    followupInput.value = "";
    sendMessage(msg);
  });

  // File attach - landing
  $("#btn-attach-landing").addEventListener("click", () => $("#file-input-landing").click());
  $("#file-input-landing").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });

  // File attach - sidebar
  $("#btn-attach-sidebar").addEventListener("click", () => $("#file-input-sidebar").click());
  $("#file-input-sidebar").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });

  // New session
  // Home
  $("#btn-home").addEventListener("click", () => showLanding());

  // Mobile sidebar toggle
  $("#btn-toggle-sidebar").addEventListener("click", () => {
    $("#sidebar").classList.toggle("collapsed");
  });

  // Mobile sessions drawer
  $("#btn-menu").addEventListener("click", () => openDrawer());
  $("#btn-close-drawer").addEventListener("click", () => closeDrawer());
  $("#drawer-backdrop").addEventListener("click", () => closeDrawer());

  // Drawer session clicks
  $("#drawer-session-list").addEventListener("click", (e) => {
    const deleteBtn = e.target.closest(".delete-btn");
    if (deleteBtn) {
      e.stopPropagation();
      const id = deleteBtn.dataset.id;
      if (confirm("Delete this session?")) {
        deleteSession(id);
        renderDrawerSessions();
      }
      return;
    }
    const item = e.target.closest(".session-item");
    if (item) {
      loadSession(item.dataset.id);
      closeDrawer();
    }
  });

  $("#btn-new-session").addEventListener("click", () => {
    currentSessionId = null;
    messagesEl.innerHTML = "";
    showEmptyState();
    renderSessionList();
    followupInput.focus();
  });

  // Session list click delegation
  sessionList.addEventListener("click", (e) => {
    const deleteBtn = e.target.closest(".delete-btn");
    if (deleteBtn) {
      e.stopPropagation();
      const id = deleteBtn.dataset.id;
      if (confirm("Delete this session?")) deleteSession(id);
      return;
    }
    const item = e.target.closest(".session-item");
    if (item) {
      loadSession(item.dataset.id);
    }
  });

  // Auth
  $("#sidebar-auth-status").addEventListener("click", () => checkAuthAndShow());
  landingAuthStatus.addEventListener("click", () => checkAuthAndShow());

  // Quick examples
  document.querySelectorAll(".example-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prompt = btn.dataset.prompt;
      promptInput.value = prompt;
      sendMessage(prompt);
    });
  });
  $("#btn-start-login").addEventListener("click", startLogin);
  $("#btn-submit-code").addEventListener("click", submitAuthCode);
  $("#btn-logout").addEventListener("click", logout);
  $("#btn-close-auth").addEventListener("click", hideAuthModal);
  $(".modal-backdrop")?.addEventListener("click", hideAuthModal);

  // Auth code enter key
  $("#auth-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuthCode();
  });
}

async function checkAuthAndShow() {
  authModal.classList.remove("hidden");
  $("#auth-status-text").textContent = "Checking...";
  $("#auth-login-section").classList.add("hidden");
  $("#auth-code-section").classList.add("hidden");
  $("#auth-logged-in").classList.add("hidden");

  try {
    const res = await fetch("/api/claude-auth/status");
    const data = await res.json();
    if (data.loggedIn || data.account) {
      $("#auth-status-text").textContent = `Logged in as ${data.account || "Claude user"}`;
      $("#auth-logged-in").classList.remove("hidden");
      setLandingAuth(true, data.account || "Claude");
      setTimeout(() => hideAuthModal(), 500);
    } else {
      showAuthModal();
      setLandingAuth(false);
    }
  } catch {
    showAuthModal();
    setLandingAuth(false);
  }
}

// ── Public Sessions Gallery ──────────────────────────────
async function loadPublicSessions() {
  try {
    const res = await fetch("/api/sessions/public");
    const publicSessions = await res.json();
    const grid = $("#public-sessions-grid");
    if (!publicSessions.length) {
      $("#public-sessions").style.display = "none";
      return;
    }
    grid.innerHTML = publicSessions
      .map((s) => {
        const date = new Date(s.created_at).toLocaleDateString();
        return `
          <div class="session-card" data-id="${s.id}">
            <iframe class="session-card-preview" src="/sessions/${s.id}/index.html" sandbox="allow-scripts" loading="lazy" tabindex="-1"></iframe>
            <div class="session-card-info">
              <div class="session-card-title">${escapeHtml(s.title)}</div>
              <div class="session-card-date">${date}</div>
            </div>
          </div>`;
      })
      .join("");

    grid.querySelectorAll(".session-card").forEach((card) => {
      card.addEventListener("click", () => loadSession(card.dataset.id));
    });
  } catch {
    $("#public-sessions").style.display = "none";
  }
}

// ── Start ────────────────────────────────────────────────
init();
