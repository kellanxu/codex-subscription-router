const codexMuxComposerRoutes = new WeakMap();
const codexMuxComposerPanels = new WeakMap();
const codexMuxPendingDocumentRoutes = new WeakMap();
const codexMuxDocumentDraftRoutes = new WeakMap();
const codexMuxDocumentLocations = new WeakMap();
let codexMuxRoutingAccountsPromise = null;

const CODEX_MUX_LOCAL_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_MUX_NEW_TASK_PATHS = new Set([
  "/",
  "/hotkey-window",
  "/hotkey-window/new-thread",
  "/extension/panel/new",
]);

function codexMuxCloneRoute(route) {
  return {
    mode: route.mode,
    accountId: route.accountId || null,
    visibleAccountId: route.visibleAccountId || route.accountId || null,
  };
}

function codexMuxLocation(documentRef = document) {
  const tracked = codexMuxDocumentLocations.get(documentRef);
  if (tracked) return tracked;
  const pathname = documentRef.defaultView?.location?.pathname || "";
  const local = pathname.match(/^\/local\/([^/]+)(?:\/|$)/i);
  if (local) {
    let threadId = local[1];
    try {
      threadId = decodeURIComponent(threadId);
    } catch {}
    return CODEX_MUX_LOCAL_THREAD_ID.test(threadId)
      ? { kind: "local-thread", threadId }
      : { kind: "client-local-thread", threadId };
  }
  const remote = pathname.match(/^\/remote\/([^/]+)(?:\/|$)/i);
  if (remote) return { kind: "remote-thread", threadId: remote[1] };
  if (CODEX_MUX_NEW_TASK_PATHS.has(pathname)) return { kind: "new-task" };
  return { kind: "other" };
}

function codexMuxTrackNativeRoute(route, documentRef = document) {
  let next;
  switch (route?.routeKind) {
    case "home":
    case "new-thread-panel":
      next = { kind: "new-task" };
      break;
    case "client-local-thread":
      next = { kind: "client-local-thread", threadId: route.clientThreadId };
      break;
    case "local-thread":
      next = { kind: "local-thread", threadId: route.conversationId };
      break;
    case "remote-thread":
      next = { kind: "remote-thread", threadId: route.taskId };
      break;
    default:
      next = { kind: "other" };
  }
  const previous = codexMuxDocumentLocations.get(documentRef);
  codexMuxDocumentLocations.set(documentRef, next);
  if (
    !previous ||
    previous.kind !== next.kind ||
    previous.threadId !== next.threadId
  ) {
    setTimeout(() => codexMuxScanNewTaskComposers(documentRef), 0);
  }
  return route;
}

function codexMuxIsNewTaskLocation(documentRef = document) {
  const kind = codexMuxLocation(documentRef).kind;
  return kind === "new-task" || kind === "client-local-thread";
}

function codexMuxRoutingAccounts() {
  if (codexMuxRoutingAccountsPromise) return codexMuxRoutingAccountsPromise;
  codexMuxRoutingAccountsPromise = codexMuxRequest("/accounts")
    .then((result) =>
      (result.accounts || []).filter(
        (account) => account.connected && account.enabled,
      ),
    )
    .catch((error) => {
      codexMuxRoutingAccountsPromise = null;
      throw error;
    });
  return codexMuxRoutingAccountsPromise;
}

function codexMuxDefaultComposerRoute(accounts) {
  const preferred =
    accounts.find((account) => account.preferred) ||
    accounts.find((account) => account.planType === "pro") ||
    accounts.find((account) => account.controller) ||
    accounts[0] ||
    null;
  return {
    mode: "preferred",
    accountId: null,
    visibleAccountId: preferred?.id || null,
  };
}

function codexMuxSetComposerRoute(composer, route) {
  const next = codexMuxCloneRoute(route);
  codexMuxComposerRoutes.set(composer, next);
  const documentRef = composer.ownerDocument;
  if (documentRef && codexMuxIsNewTaskLocation(documentRef)) {
    codexMuxDocumentDraftRoutes.set(documentRef, codexMuxCloneRoute(next));
  }
  composer.dataset.codexMuxRouteMode = next.mode;
  if (next.accountId) composer.dataset.codexMuxRouteAccountId = next.accountId;
  else delete composer.dataset.codexMuxRouteAccountId;
  return next;
}

function codexMuxInitialComposerRoute(composer, accounts) {
  const documentRef = composer.ownerDocument;
  const draft = documentRef
    ? codexMuxDocumentDraftRoutes.get(documentRef)
    : null;
  return draft
    ? codexMuxCloneRoute(draft)
    : codexMuxDefaultComposerRoute(accounts);
}

function codexMuxComposerForRequest(documentRef = document) {
  const activeComposer = documentRef.activeElement?.closest?.(
    '[data-codex-mux-composer="true"]',
  );
  if (activeComposer) return activeComposer;
  const visible = [...documentRef.querySelectorAll(
    '[data-codex-mux-composer="true"]',
  )].filter((composer) => composer.getClientRects?.().length !== 0);
  return visible.length === 1 ? visible[0] : null;
}

function codexMuxArmComposerRoute(documentRef, composer) {
  const route = composer ? codexMuxComposerRoutes.get(composer) : null;
  if (!route) return false;
  codexMuxPendingDocumentRoutes.set(documentRef, {
    route: { ...route },
    expiresAt: Date.now() + 10_000,
  });
  return true;
}

function codexMuxPendingRoute(documentRef, consume) {
  const pending = codexMuxPendingDocumentRoutes.get(documentRef);
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    codexMuxPendingDocumentRoutes.delete(documentRef);
    return null;
  }
  if (consume) codexMuxPendingDocumentRoutes.delete(documentRef);
  return pending.route;
}

function codexMuxRouteForRequest(documentRef, consumePending = false) {
  const pending = codexMuxPendingRoute(documentRef, consumePending);
  if (pending) return pending;
  const composer = codexMuxComposerForRequest(documentRef);
  return composer ? codexMuxComposerRoutes.get(composer) || null : null;
}

function codexMuxCaptureComposerSubmission(event) {
  const target = event.target;
  if (!target?.closest) return;
  if (event.type === "click") {
    const button = target.closest("button");
    const label = button?.getAttribute?.("aria-label") || "";
    if (
      !button ||
      (button.getAttribute("type") !== "submit" &&
        label !== "Send" &&
        label !== "发送")
    ) {
      return;
    }
  }
  const documentRef = target.ownerDocument || event.currentTarget;
  const composer =
    target.closest('[data-codex-mux-composer="true"]') ||
    codexMuxComposerForRequest(documentRef);
  if (composer && documentRef) codexMuxArmComposerRoute(documentRef, composer);
}

// Called at the app-server request boundary. Routing state comes from the
// active composer's WeakMap entry, never from a renderer-global account ID.
function codexMuxScopeNewTaskRequest(method, params, documentRef = document) {
  if (method !== "thread/start") return params;
  const route = codexMuxRouteForRequest(documentRef, true);
  if (!route) return params;
  return {
    ...(params || {}),
    codexMuxRouting: {
      mode: route.mode,
      ...(route.mode === "manual_locked" && route.accountId
        ? { accountId: route.accountId }
        : {}),
    },
  };
}

function codexMuxShouldDiscardPrewarmedThread(documentRef = document) {
  const route = codexMuxRouteForRequest(documentRef, false);
  return route?.mode === "manual_locked" && Boolean(route.accountId);
}

function codexMuxScopeRequest(method, params) {
  return codexMuxScopePluginRequest(
    method,
    codexMuxScopeNewTaskRequest(method, params),
  );
}

function codexMuxComposerCandidates(documentRef = document) {
  const editors = documentRef.querySelectorAll(
    'textarea[placeholder],[contenteditable="true"]',
  );
  const candidates = [];
  const seen = new Set();
  for (const editor of editors) {
    const composer =
      editor.closest("form") ||
      editor.closest('[data-thread-find-composer="true"]') ||
      editor.parentElement;
    if (!composer || seen.has(composer)) continue;
    seen.add(composer);
    candidates.push(composer);
  }
  return candidates;
}

function codexMuxStatusBadgeText(snapshot) {
  if (!snapshot || snapshot.state === "unknown") return "Plugins unknown";
  const connected = (snapshot.plugins || []).filter(
    (plugin) => plugin.state === "connected",
  );
  const blocked = (snapshot.plugins || []).filter(
    (plugin) => plugin.state !== "connected",
  );
  if (blocked.some((plugin) => plugin.state === "conflict")) {
    return "Plugin conflict";
  }
  if (connected.length === 0) return "No plugin access";
  const names = connected.slice(0, 2).map((plugin) => plugin.label);
  return `${names.join(", ")}${connected.length > 2 ? ` +${connected.length - 2}` : ""}`;
}

function codexMuxRenderComposerPanel(composer, accounts, panel) {
  const documentRef = composer.ownerDocument || document;
  const route =
    codexMuxComposerRoutes.get(composer) ||
    codexMuxSetComposerRoute(
      composer,
      codexMuxInitialComposerRoute(composer, accounts),
    );
  const statuses = panel.__codexMuxStatuses || new Map();
  panel.replaceChildren();

  const label = documentRef.createElement("span");
  label.className = "shrink-0 text-[11px] text-token-text-tertiary";
  label.textContent = "New task owner";
  panel.append(label);

  const choices = accounts.map((account) => ({
      id: account.id,
      label: account.controller
        ? "Primary"
        : account.planLabel || account.label,
      mode: "manual_locked",
      accountId: account.id,
      account,
    }));
  for (const choice of choices) {
    const active = route.visibleAccountId === choice.accountId;
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = [
      "rounded-lg border px-2 py-1 text-[11px] transition-colors",
      active
        ? "border-token-border-default bg-token-foreground/10 text-token-text-primary"
        : "border-token-border-light text-token-text-secondary hover:bg-token-foreground/5",
    ].join(" ");
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.dataset.codexMuxRouteChoice = choice.id;
    button.textContent = choice.label;
    button.title =
      route.mode === "preferred" && active
        ? "Preferred default; click to manually lock this composer"
        : `Manually lock this composer to ${choice.account.label}`;
    button.addEventListener("click", () => {
      codexMuxSetComposerRoute(composer, {
        mode: choice.mode,
        accountId: choice.accountId,
        visibleAccountId: choice.accountId,
      });
      codexMuxRenderComposerPanel(composer, accounts, panel);
    });
    panel.append(button);

    if (choice.account) {
      const badge = documentRef.createElement("span");
      const snapshot = statuses.get(choice.accountId);
      badge.className =
        "-ml-1 rounded-full bg-token-foreground/5 px-1.5 py-0.5 text-[10px] text-token-text-tertiary";
      badge.textContent = codexMuxStatusBadgeText(snapshot);
      badge.title = snapshot
        ? "Connection only; matching workspace, page, and channel access are not confirmed."
        : "Hover or focus the owner picker to refresh account-scoped plugin status.";
      badge.dataset.codexMuxPluginBadge = choice.accountId;
      panel.append(badge);
    }
  }
  if (route.mode === "manual_locked") {
    const locked = documentRef.createElement("span");
    locked.className = "text-[10px] text-token-text-tertiary";
    locked.textContent = "Locked for this request";
    panel.append(locked);
  }
}

function codexMuxResetComposerPanel(composer) {
  codexMuxComposerPanels.get(composer)?.remove();
  codexMuxComposerPanels.delete(composer);
  codexMuxComposerRoutes.delete(composer);
  delete composer.dataset.codexMuxComposer;
  delete composer.dataset.codexMuxRouteMode;
  delete composer.dataset.codexMuxRouteAccountId;
}

function codexMuxCreateComposerPanel(composer, view) {
  const documentRef = composer.ownerDocument || document;
  const panel = documentRef.createElement("div");
  panel.dataset.codexMuxRoutingPicker = "true";
  panel.dataset.codexMuxRoutingView = view;
  panel.className =
    "flex flex-wrap items-center gap-1.5 border-b border-token-border-light px-3 py-1.5";
  codexMuxComposerPanels.set(composer, panel);
  composer.insertBefore(panel, composer.firstChild);
  return panel;
}

function codexMuxThreadOwnerLabel(account) {
  if (!account) return "Task owner unavailable";
  if (account.controller) return "Primary";
  return account.planLabel || account.label || "Subscription";
}

function codexMuxRenderThreadOwnerPanel(panel, account, routing) {
  const documentRef = panel.ownerDocument || document;
  panel.replaceChildren();

  const label = documentRef.createElement("span");
  label.className = "shrink-0 text-[11px] text-token-text-tertiary";
  label.textContent = "Task owner";
  panel.append(label);

  const owner = documentRef.createElement("span");
  owner.className =
    "rounded-lg border border-token-border-default bg-token-foreground/10 px-2 py-1 text-[11px] text-token-text-primary";
  owner.textContent = codexMuxThreadOwnerLabel(account);
  owner.title = account?.planLabel
    ? `${account.label} · ${account.planLabel}`
    : account?.label || owner.textContent;
  owner.dataset.codexMuxThreadOwner = account?.id || "";
  panel.dataset.codexMuxThreadAccountId = account?.id || "";
  panel.append(owner);

  const locked = documentRef.createElement("span");
  locked.className = "text-[10px] text-token-text-tertiary";
  locked.textContent = routing?.mode === "manual_locked"
    ? "Manually locked to this task"
    : "Sticky for this task";
  panel.append(locked);
}

async function codexMuxEnhanceThreadComposer(
  composer,
  threadId,
  request = codexMuxRequest,
) {
  const view = `thread:${threadId}`;
  const existingPanel = codexMuxComposerPanels.get(composer);
  if (existingPanel?.dataset.codexMuxRoutingView === view) {
    if (!existingPanel.isConnected && composer.isConnected) {
      composer.insertBefore(existingPanel, composer.firstChild);
    }
    return;
  }
  if (existingPanel) codexMuxResetComposerPanel(composer);
  const panel = codexMuxCreateComposerPanel(composer, view);
  panel.dataset.codexMuxThreadId = threadId;
  const loading = (composer.ownerDocument || document).createElement("span");
  loading.className = "text-[11px] text-token-text-tertiary";
  loading.textContent = "Loading task owner…";
  panel.append(loading);
  try {
    const result = await request(
      `/thread-account?threadId=${encodeURIComponent(threadId)}`,
    );
    if (
      composer.isConnected &&
      codexMuxComposerPanels.get(composer) === panel &&
      panel.dataset.codexMuxThreadId === threadId
    ) {
      codexMuxRenderThreadOwnerPanel(
        panel,
        result.account || null,
        result.routing || null,
      );
    }
  } catch {
    if (
      composer.isConnected &&
      codexMuxComposerPanels.get(composer) === panel
    ) {
      codexMuxRenderThreadOwnerPanel(panel, null, null);
    }
  }
}

async function codexMuxRefreshComposerPluginStatuses(
  composer,
  accounts,
  panel,
  refresh,
) {
  if (panel.__codexMuxRefreshStarted && refresh) return;
  if (refresh) panel.__codexMuxRefreshStarted = true;
  try {
    const snapshots = await Promise.all(
      accounts.map((account) =>
        codexMuxRequest(
          `/plugin-status?accountId=${encodeURIComponent(account.id)}&refresh=${refresh ? "true" : "false"}`,
        ).catch(() => ({ accountId: account.id, state: "unknown", plugins: [] })),
      ),
    );
    panel.__codexMuxStatuses = new Map(
      snapshots.map((snapshot) => [snapshot.accountId, snapshot]),
    );
    const isCurrentPanel =
      composer.isConnected &&
      codexMuxComposerPanels.get(composer) === panel &&
      panel.dataset.codexMuxRoutingView === "new-task";
    if (isCurrentPanel) {
      codexMuxRenderComposerPanel(composer, accounts, panel);
    }
    if (
      isCurrentPanel &&
      refresh &&
      !panel.__codexMuxBackgroundRetryScheduled &&
      snapshots.some((snapshot) => snapshot.state === "unknown" && !snapshot.cached)
    ) {
      panel.__codexMuxBackgroundRetryScheduled = true;
      setTimeout(() => {
        if (
          !composer.isConnected ||
          codexMuxComposerPanels.get(composer) !== panel ||
          panel.dataset.codexMuxRoutingView !== "new-task"
        ) {
          return;
        }
        panel.__codexMuxRefreshStarted = false;
        codexMuxRefreshComposerPluginStatuses(composer, accounts, panel, true);
      }, 10_000);
    }
  } finally {
    if (!panel.__codexMuxBackgroundRetryScheduled) {
      panel.__codexMuxRefreshStarted = false;
    }
  }
}

async function codexMuxEnhanceComposer(composer) {
  const existingPanel = codexMuxComposerPanels.get(composer);
  if (existingPanel?.dataset.codexMuxRoutingView === "new-task") {
    if (!existingPanel.isConnected && composer.isConnected) {
      composer.insertBefore(existingPanel, composer.firstChild);
    }
    return;
  }
  if (existingPanel) codexMuxResetComposerPanel(composer);
  composer.dataset.codexMuxComposer = "true";
  const panel = codexMuxCreateComposerPanel(composer, "new-task");
  try {
    const accounts = await codexMuxRoutingAccounts();
    if (
      !composer.isConnected ||
      codexMuxComposerPanels.get(composer) !== panel
    ) {
      return;
    }
    codexMuxSetComposerRoute(
      composer,
      codexMuxInitialComposerRoute(composer, accounts),
    );
    codexMuxRenderComposerPanel(composer, accounts, panel);
    panel.addEventListener(
      "pointerenter",
      () => codexMuxRefreshComposerPluginStatuses(composer, accounts, panel, true),
      { once: true },
    );
    panel.addEventListener(
      "focusin",
      () => codexMuxRefreshComposerPluginStatuses(composer, accounts, panel, true),
      { once: true },
    );
    codexMuxRefreshComposerPluginStatuses(composer, accounts, panel, false);
  } catch {
    panel.textContent = "Subscription routing unavailable";
  }
}

function codexMuxScanNewTaskComposers(documentRef = document) {
  const location = codexMuxLocation(documentRef);
  const isNewTask =
    location.kind === "new-task" || location.kind === "client-local-thread";
  if (!isNewTask) {
    codexMuxDocumentDraftRoutes.delete(documentRef);
    codexMuxPendingDocumentRoutes.delete(documentRef);
  }
  for (const composer of codexMuxComposerCandidates(documentRef)) {
    if (isNewTask) {
      codexMuxEnhanceComposer(composer);
      continue;
    }
    if (location.kind === "local-thread") {
      codexMuxEnhanceThreadComposer(composer, location.threadId);
      continue;
    }
    codexMuxResetComposerPanel(composer);
  }
}

function codexMuxInstallNewTaskRoutingPicker(documentRef = document) {
  if (!documentRef?.documentElement || typeof MutationObserver === "undefined") return;
  documentRef.addEventListener("click", codexMuxCaptureComposerSubmission, true);
  documentRef.addEventListener("submit", codexMuxCaptureComposerSubmission, true);
  const scan = () => codexMuxScanNewTaskComposers(documentRef);
  const observer = new MutationObserver(scan);
  observer.observe(documentRef.documentElement, { childList: true, subtree: true });
  scan();
  setInterval(scan, 1_000);
}

if (typeof document !== "undefined") {
  codexMuxInstallNewTaskRoutingPicker(document);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    codexMuxComposerRoutes,
    codexMuxComposerPanels,
    codexMuxPendingDocumentRoutes,
    codexMuxDocumentDraftRoutes,
    codexMuxDocumentLocations,
    codexMuxArmComposerRoute,
    codexMuxCaptureComposerSubmission,
    codexMuxDefaultComposerRoute,
    codexMuxEnhanceThreadComposer,
    codexMuxInitialComposerRoute,
    codexMuxIsNewTaskLocation,
    codexMuxLocation,
    codexMuxScanNewTaskComposers,
    codexMuxSetComposerRoute,
    codexMuxScopeNewTaskRequest,
    codexMuxShouldDiscardPrewarmedThread,
    codexMuxStatusBadgeText,
    codexMuxThreadOwnerLabel,
    codexMuxTrackNativeRoute,
  };
}
