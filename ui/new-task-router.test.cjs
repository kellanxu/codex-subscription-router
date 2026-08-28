"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  codexMuxArmComposerRoute,
  codexMuxCaptureComposerSubmission,
  codexMuxComposerPanels,
  codexMuxDefaultComposerRoute,
  codexMuxDocumentDraftRoutes,
  codexMuxDocumentLocations,
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
} = require("./new-task-router.js");

function documentFor(composer) {
  return {
    activeElement: {
      closest(selector) {
        assert.equal(selector, '[data-codex-mux-composer="true"]');
        return composer;
      },
    },
    querySelectorAll() {
      return [composer];
    },
  };
}

function composer() {
  return { dataset: {}, getClientRects: () => [{}] };
}

function documentAt(pathname, selectedComposer = null) {
  return {
    activeElement: selectedComposer
      ? {
          closest() {
            return selectedComposer;
          },
        }
      : null,
    defaultView: { location: { pathname } },
    querySelectorAll() {
      return selectedComposer ? [selectedComposer] : [];
    },
  };
}

function domElement(documentRef) {
  return {
    ownerDocument: documentRef,
    dataset: {},
    children: [],
    isConnected: true,
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    remove() {
      this.isConnected = false;
    },
  };
}

function domComposer(documentRef) {
  const value = domElement(documentRef);
  value.firstChild = null;
  value.insertBefore = (child) => {
    child.isConnected = true;
    value.children.unshift(child);
  };
  return value;
}

test("default new-task route prefers the connected Pro 20x account", () => {
  const route = codexMuxDefaultComposerRoute([
    { id: "primary", controller: true, planType: "prolite" },
    { id: "pro20", controller: false, planType: "pro" },
  ]);
  assert.deepEqual(route, {
    mode: "preferred",
    accountId: null,
    visibleAccountId: "pro20",
  });
});

test("route detection distinguishes new, local, remote, and unrelated pages", () => {
  const threadId = "262f715d-ff74-48c8-b056-e71edf896c3c";
  assert.deepEqual(codexMuxLocation(documentAt("/")), { kind: "new-task" });
  assert.deepEqual(codexMuxLocation(documentAt("/hotkey-window/new-thread")), {
    kind: "new-task",
  });
  assert.deepEqual(codexMuxLocation(documentAt(`/local/${threadId}`)), {
    kind: "local-thread",
    threadId,
  });
  assert.deepEqual(
    codexMuxLocation(documentAt("/local/client-new-thread%3Atemporary")),
    { kind: "client-local-thread", threadId: "client-new-thread:temporary" },
  );
  assert.deepEqual(codexMuxLocation(documentAt("/remote/cloud-task")), {
    kind: "remote-thread",
    threadId: "cloud-task",
  });
  assert.equal(codexMuxIsNewTaskLocation(documentAt("/settings")), false);
});

test("native route state overrides Electron's fixed index.html location", () => {
  const documentRef = documentAt("/index.html");
  assert.deepEqual(codexMuxLocation(documentRef), { kind: "other" });
  codexMuxTrackNativeRoute(
    { routeKind: "home", pathname: "/" },
    documentRef,
  );
  assert.deepEqual(codexMuxLocation(documentRef), { kind: "new-task" });
  codexMuxTrackNativeRoute(
    {
      routeKind: "local-thread",
      conversationId: "262f715d-ff74-48c8-b056-e71edf896c3c",
    },
    documentRef,
  );
  assert.deepEqual(codexMuxLocation(documentRef), {
    kind: "local-thread",
    threadId: "262f715d-ff74-48c8-b056-e71edf896c3c",
  });
  assert.equal(codexMuxDocumentLocations.has(documentRef), true);
});

test("manual draft owner survives a composer remount in the same new task", () => {
  const first = composer();
  const documentRef = documentAt("/", first);
  first.ownerDocument = documentRef;
  codexMuxSetComposerRoute(first, {
    mode: "manual_locked",
    accountId: "primary",
  });

  const replacement = composer();
  replacement.ownerDocument = documentRef;
  assert.deepEqual(
    codexMuxInitialComposerRoute(replacement, [
      { id: "primary", controller: true, planType: "prolite" },
      { id: "pro20", controller: false, planType: "pro" },
    ]),
    {
      mode: "manual_locked",
      accountId: "primary",
      visibleAccountId: "primary",
    },
  );
  assert.equal(
    codexMuxDocumentDraftRoutes.get(documentRef).accountId,
    "primary",
  );
});

test("entering an existing task clears the completed draft selection", () => {
  const documentRef = documentAt("/");
  codexMuxDocumentDraftRoutes.set(documentRef, {
    mode: "manual_locked",
    accountId: "primary",
    visibleAccountId: "primary",
  });
  documentRef.defaultView.location.pathname =
    "/local/262f715d-ff74-48c8-b056-e71edf896c3c";
  codexMuxScanNewTaskComposers(documentRef);
  assert.equal(codexMuxDocumentDraftRoutes.has(documentRef), false);
});

test("remote and non-task routes remove stale owner controls", () => {
  const documentRef = documentAt("/index.html");
  const selected = domComposer(documentRef);
  const editor = {
    closest() {
      return selected;
    },
  };
  documentRef.querySelectorAll = () => [editor];
  selected.dataset.codexMuxComposer = "true";
  selected.dataset.codexMuxRouteMode = "manual_locked";
  const panel = domElement(documentRef);
  codexMuxComposerPanels.set(selected, panel);
  codexMuxDocumentDraftRoutes.set(documentRef, {
    mode: "manual_locked",
    accountId: "primary",
    visibleAccountId: "primary",
  });
  codexMuxDocumentLocations.set(documentRef, {
    kind: "remote-thread",
    threadId: "remote-task",
  });

  codexMuxScanNewTaskComposers(documentRef);

  assert.equal(codexMuxComposerPanels.has(selected), false);
  assert.equal(codexMuxDocumentDraftRoutes.has(documentRef), false);
  assert.equal(panel.isConnected, false);
  assert.equal(selected.dataset.codexMuxComposer, undefined);
});

test("manual routing is isolated per composer and per request", () => {
  const first = composer();
  const second = composer();
  codexMuxSetComposerRoute(first, {
    mode: "manual_locked",
    accountId: "primary",
  });
  codexMuxSetComposerRoute(second, {
    mode: "manual_locked",
    accountId: "pro20",
  });

  const firstParams = codexMuxScopeNewTaskRequest(
    "thread/start",
    { cwd: "/first" },
    documentFor(first),
  );
  const secondParams = codexMuxScopeNewTaskRequest(
    "thread/start",
    { cwd: "/second" },
    documentFor(second),
  );
  assert.equal(firstParams.codexMuxRouting.accountId, "primary");
  assert.equal(secondParams.codexMuxRouting.accountId, "pro20");
  assert.equal(firstParams.cwd, "/first");
  assert.equal(secondParams.cwd, "/second");
});

test("captured submissions are isolated per document and consumed once", () => {
  const first = composer();
  const second = composer();
  const firstDocument = documentFor(first);
  const secondDocument = documentFor(second);
  codexMuxSetComposerRoute(first, {
    mode: "manual_locked",
    accountId: "primary",
  });
  codexMuxSetComposerRoute(second, {
    mode: "manual_locked",
    accountId: "pro20",
  });

  assert.equal(codexMuxArmComposerRoute(firstDocument, first), true);
  assert.equal(codexMuxArmComposerRoute(secondDocument, second), true);
  assert.equal(
    codexMuxScopeNewTaskRequest("thread/start", {}, firstDocument)
      .codexMuxRouting.accountId,
    "primary",
  );
  assert.equal(
    codexMuxScopeNewTaskRequest("thread/start", {}, secondDocument)
      .codexMuxRouting.accountId,
    "pro20",
  );

  // A consumed pending route falls back only to this document's composer.
  assert.equal(
    codexMuxScopeNewTaskRequest("thread/start", {}, firstDocument)
      .codexMuxRouting.accountId,
    "primary",
  );
});

test("a send button outside the marked form binds the focused composer", () => {
  const selected = composer();
  const documentRef = documentFor(selected);
  codexMuxSetComposerRoute(selected, {
    mode: "manual_locked",
    accountId: "primary",
  });
  const button = {
    getAttribute(name) {
      return name === "aria-label" ? "Send" : null;
    },
  };
  const target = {
    ownerDocument: documentRef,
    closest(selector) {
      return selector === "button" ? button : null;
    },
  };
  codexMuxCaptureComposerSubmission({ type: "click", target });
  assert.equal(
    codexMuxScopeNewTaskRequest("thread/start", {}, documentRef)
      .codexMuxRouting.accountId,
    "primary",
  );
});

test("unrelated requests never receive the private routing field", () => {
  const selected = composer();
  codexMuxSetComposerRoute(selected, {
    mode: "manual_locked",
    accountId: "primary",
  });
  const params = { threadId: "existing" };
  assert.equal(
    codexMuxScopeNewTaskRequest("turn/start", params, documentFor(selected)),
    params,
  );
});

test("manual routing invalidates an account-agnostic prewarmed thread", () => {
  const selected = composer();
  codexMuxSetComposerRoute(selected, {
    mode: "manual_locked",
    accountId: "primary",
  });
  assert.equal(
    codexMuxShouldDiscardPrewarmedThread(documentFor(selected)),
    true,
  );

  codexMuxSetComposerRoute(selected, { mode: "preferred", accountId: null });
  assert.equal(
    codexMuxShouldDiscardPrewarmedThread(documentFor(selected)),
    false,
  );
});

test("plugin badges distinguish cold, connected, and conflict states", () => {
  assert.equal(codexMuxStatusBadgeText(null), "Plugins unknown");
  assert.equal(
    codexMuxStatusBadgeText({
      state: "connected",
      plugins: [{ state: "connected", label: "Notion" }],
    }),
    "Notion",
  );
  assert.equal(
    codexMuxStatusBadgeText({
      state: "conflict",
      plugins: [{ state: "conflict", label: "Slack" }],
    }),
    "Plugin conflict",
  );
});

test("existing tasks use the persisted owner label instead of the new-task default", () => {
  assert.equal(
    codexMuxThreadOwnerLabel({
      id: "primary",
      controller: true,
      label: "Prime",
      planLabel: "Pro Lite",
    }),
    "Primary",
  );
  assert.equal(
    codexMuxThreadOwnerLabel({
      id: "pro20",
      controller: false,
      label: "Subscription 2",
      planLabel: "Pro 20x",
    }),
    "Pro 20x",
  );
});

test("a late owner response cannot overwrite the task selected after it", async () => {
  const documentRef = documentAt(
    "/local/11111111-1111-4111-8111-111111111111",
  );
  documentRef.createElement = () => domElement(documentRef);
  const selected = domComposer(documentRef);
  let resolveFirst;
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const request = (path) => {
    if (path.includes("11111111-1111-4111-8111-111111111111")) {
      return firstResponse;
    }
    return Promise.resolve({
      account: {
        id: "pro20",
        controller: false,
        label: "Subscription 2",
        planLabel: "Pro 20x",
      },
      routing: { mode: "manual_locked" },
    });
  };

  const first = codexMuxEnhanceThreadComposer(
    selected,
    "11111111-1111-4111-8111-111111111111",
    request,
  );
  const second = codexMuxEnhanceThreadComposer(
    selected,
    "22222222-2222-4222-8222-222222222222",
    request,
  );
  await second;
  resolveFirst({
    account: {
      id: "primary",
      controller: true,
      label: "Prime",
      planLabel: "Pro Lite",
    },
    routing: { mode: "manual_locked" },
  });
  await first;

  const panel = codexMuxComposerPanels.get(selected);
  assert.equal(
    panel.dataset.codexMuxThreadId,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(panel.dataset.codexMuxThreadAccountId, "pro20");
  assert.equal(panel.children[1].textContent, "Pro 20x");
});
