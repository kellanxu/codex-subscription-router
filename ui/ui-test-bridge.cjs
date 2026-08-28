"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, Menu } = require("electron");

const HOST = "127.0.0.1";
const PORT = 48124;
const diagnostics = [];

function recordDiagnostic(kind, details) {
  diagnostics.push({ kind, ...details });
  if (diagnostics.length > 100) diagnostics.shift();
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function mainWindow() {
  const windows = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && window.getBounds().width >= 700,
  );
  return windows.find((window) => window.isVisible()) ?? windows[0];
}

function acceptanceWindows() {
  return BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed() && window.getBounds().width >= 700)
    .sort((left, right) => left.id - right.id);
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

async function phase12RoutingState(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel=document.querySelector('[data-codex-mux-routing-picker="true"]');
    const composer=panel?.closest('[data-codex-mux-composer="true"]')??null;
    const threadOwner=panel?.querySelector('[data-codex-mux-thread-owner]')??null;
    return {
      href:location.href,
      bodyText:(document.body?.innerText??'').trim().slice(0,240),
      editorCount:document.querySelectorAll('textarea[placeholder],[contenteditable="true"]').length,
      hasComposer:Boolean(composer),
      view:panel?.dataset.codexMuxRoutingView??null,
      threadId:panel?.dataset.codexMuxThreadId??null,
      threadOwnerId:panel?.dataset.codexMuxThreadAccountId??null,
      threadOwnerLabel:threadOwner?.textContent?.trim()??null,
      mode:composer?.dataset.codexMuxRouteMode??null,
      choices:panel?[...panel.querySelectorAll('button[data-codex-mux-route-choice]')]
        .map(button=>({label:button.textContent?.trim()??'',pressed:button.getAttribute('aria-pressed')})):[],
      badges:panel?[...panel.querySelectorAll('[data-codex-mux-plugin-badge]')]
        .map(badge=>({text:badge.textContent?.trim()??'',title:badge.getAttribute('title')??''})):[],
      locked:Boolean(panel&&panel.textContent?.includes('Locked for this request')),
    };
  })()`);
}

async function phase12ClickRoute(window, label) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const label=${JSON.stringify(label)};
    const target=[...document.querySelectorAll('button[data-codex-mux-route-choice]')]
      .find(button=>button.textContent?.trim()===label);
    if(!target)return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Could not select Phase 1 route ${label}`);
  await waitFor(
    async () => {
      const state = await phase12RoutingState(window);
      return state.choices.some(
        (choice) => choice.label === label && choice.pressed === "true",
      );
    },
    5_000,
    `Phase 1 route ${label} did not remain selected`,
  );
}

async function phase12StartNewTask(window) {
  window.show();
  window.focus();
  const marker = `phase12-${Date.now()}-${Math.random()}`;
  const reset = await window.webContents.executeJavaScript(`(() => {
    const marker=${JSON.stringify(marker)};
    const panel=document.querySelector('[data-codex-mux-routing-picker="true"]');
    const composer=panel?.closest('[data-codex-mux-composer="true"]');
    if(composer)composer.dataset.codexMuxAcceptanceComposer=marker;
    const target=document.querySelector(
      'button[aria-label="New chat"],button[aria-label="新对话"]',
    );
    if(!target)return false;
    target.click();
    return true;
  })()`);
  if (!reset) throw new Error("Could not return a Phase 1 window to a new task");
  await waitFor(
    () => window.webContents.executeJavaScript(`(() => {
      const marker=${JSON.stringify(marker)};
      const panel=document.querySelector('[data-codex-mux-routing-picker="true"]');
      const composer=panel?.closest('[data-codex-mux-composer="true"]');
      return Boolean(composer&&composer.dataset.codexMuxAcceptanceComposer!==marker);
    })()`),
    15_000,
    "Phase 1 window did not create a fresh new-task owner picker",
  );
}

async function completeIsolatedOnboarding(window) {
  await waitFor(
    () => window.webContents.executeJavaScript(`(() =>
      Boolean(document.querySelector('[data-codex-mux-routing-picker="true"]'))||
      Boolean((document.body?.innerText??'').trim())
    )()`),
    60_000,
    "Isolated renderer did not leave its blank loading state",
  );
  const steps = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await phase12RoutingState(window);
    if (state.hasComposer) {
      recordDiagnostic("phase12-onboarding", { steps, completed: true });
      return;
    }
    const result = await window.webContents.executeJavaScript(`(() => {
      const visible=element=>{const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0&&!element.closest('[inert],[aria-hidden="true"]')};
      const advance=[...document.querySelectorAll('button')].filter(visible).find(button=>{
        const text=button.textContent?.trim()??'';
        return !button.disabled&&/^(继续|下一步|开始|完成|跳过|前往 ChatGPT|Continue|Next|Get started|Done|Skip|Go to ChatGPT)$/i.test(text);
      });
      if(advance){const text=advance.textContent?.trim()??'';advance.click();return {clicked:text};}
      const leaves=[...document.querySelectorAll('button,[role="button"],[role="radio"],label')]
        .filter(visible);
      const option=leaves.find(element=>['Other','其他'].includes(element.textContent?.trim()))
        ??leaves.find(element=>element.getAttribute('role')==='radio')
        ??leaves.find(element=>{
          const text=element.textContent?.trim()??'';
          return text&&text.length<80&&!/继续|下一步|开始|完成|跳过|前往 ChatGPT|Continue|Next|Get started|Done|Skip|Go to ChatGPT/i.test(text);
        });
      if(option){const text=option.textContent?.trim()??'';option.click();return {clicked:text};}
      return {clicked:null,body:(document.body?.innerText??'').trim().slice(0,160)};
    })()`);
    steps.push(result.clicked ?? result.body ?? "no-action");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Isolated onboarding did not reach the composer: ${JSON.stringify(steps)}`);
}

function findNewWindowMenuItem() {
  const root = Menu.getApplicationMenu();
  const visit = (menu) => {
    for (const item of menu?.items ?? []) {
      if (/^(New Window|新建窗口)$/.test(item.label ?? "")) return item;
      const nested = visit(item.submenu);
      if (nested) return nested;
    }
    return null;
  };
  return visit(root);
}

async function clickProfileMenu(window) {
  window.show();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = await window.webContents.executeJavaScript(`(() => {
      const target=document.querySelector(
        'button[aria-label="Open profile menu"],button[aria-label="打开个人资料菜单"]',
      );
      if(!target)return null;
      const rect=target.getBoundingClientRect();
      return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
    })()`);
    if (!point) return false;
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const opened = await window.webContents.executeJavaScript(`(() =>
      (document.body?.innerText??'').includes('Usage remaining')
    )()`);
    if (opened) return true;
  }
  return false;
}

async function submitRoutingProbe(window, step, startNewChat, waitForCompletion = true) {
  const runId = (process.env.CODEX_MUX_ACCEPTANCE_RUN_ID ?? "").trim();
  const expected = `ROUTER_E2E_STEP_${step}${runId ? `_${runId}` : ""}_OK`;
  const prompt = `Router ${runId || "acceptance"} E2E step ${step}. Reply with ${expected} only.`;
  if (startNewChat) {
    const started = await window.webContents.executeJavaScript(`(() => {
      const target=document.querySelector(
        'button[aria-label="New chat"],button[aria-label="新对话"]',
      );
      if(!target)return false;
      target.click();
      return true;
    })()`);
    if (!started) throw new Error("Could not start the routing test chat");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const filled = await window.webContents.executeJavaScript(`(() => {
    const prompt=${JSON.stringify(prompt)};
    const composer=document.querySelector('textarea[placeholder]')??document.querySelector('[contenteditable="true"]');
    if(!composer)return false;
    composer.focus();
    if(composer instanceof HTMLTextAreaElement){
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(composer,prompt);
    }else{
      composer.textContent=prompt;
    }
    composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
    return true;
  })()`);
  if (!filled) throw new Error("Could not fill the routing test composer");
  const submitted = await waitFor(
    () => window.webContents.executeJavaScript(`(() => {
      const target=[...document.querySelectorAll('button')].find(button=>{
        const label=button.getAttribute('aria-label');
        return (label==='Send'||label==='发送')&&!button.disabled;
      });
      if(!target)return false;
      target.click();
      return true;
    })()`),
    10_000,
    "Routing test send button did not become ready",
  );
  if (!submitted) throw new Error("Could not submit the routing test turn");
  if (!waitForCompletion) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return;
  }
  const completed = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const expected=${JSON.stringify(expected)};
    const visible=()=>[...document.querySelectorAll('body *')].some(element=>
      element.children.length===0&&element.textContent?.trim()===expected
    );
    if(visible()){resolve(true);return;}
    const observer=new MutationObserver(()=>{if(visible()){observer.disconnect();resolve(true);}});
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
    setTimeout(()=>{observer.disconnect();resolve(false);},240000);
  })`);
  if (!completed) throw new Error(`Routing test step ${step} did not complete`);
}

async function runAction(
  window,
  action,
  delayMs,
  targetThreadId = null,
  targetThreadTitle = null,
) {
  window.show();
  window.focus();
  if (action === "phase12-onboarding") {
    await completeIsolatedOnboarding(window);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (action === "phase12-open-second-window") {
    const before = new Set(acceptanceWindows().map((candidate) => candidate.id));
    const item = findNewWindowMenuItem();
    if (!item || typeof item.click !== "function") {
      throw new Error("Could not find the native New Window menu item");
    }
    item.click(undefined, window.webContents, undefined);
    await waitFor(
      () => acceptanceWindows().find((candidate) => !before.has(candidate.id)),
      15_000,
      "Native New Window command did not create a second window",
    );
    return;
  }
  if (action === "phase12-dual-select") {
    const windows = acceptanceWindows();
    if (windows.length < 2) throw new Error("Phase 1 dual-window test needs two windows");
    await phase12ClickRoute(windows[0], "Primary");
    await phase12ClickRoute(windows[1], "Pro 20x");
    const first = await phase12RoutingState(windows[0]);
    const second = await phase12RoutingState(windows[1]);
    if (first.mode !== "manual_locked" || second.mode !== "manual_locked") {
      throw new Error("Dual-window manual_locked state was not isolated");
    }
    if (!first.locked || !second.locked) {
      throw new Error("Dual-window manual lock indicator is missing");
    }
    return;
  }
  if (action === "phase12-recover-windows") {
    const windows = acceptanceWindows();
    const errorFlags = await Promise.all(
      windows.map((candidate) => candidate.webContents.executeJavaScript(`(() =>
        (document.body?.innerText??'').includes('Oops, an error has occurred')
      )()`)),
    );
    const failed = windows.filter((_candidate, index) => errorFlags[index]);
    if (failed.length === 0) {
      throw new Error("No recoverable Phase 1 window error page was present");
    }
    for (const candidate of failed) candidate.close();
    const item = findNewWindowMenuItem();
    if (!item || typeof item.click !== "function") {
      throw new Error("Could not recreate the failed native New Window");
    }
    item.click(undefined, acceptanceWindows()[0]?.webContents, undefined);
    await waitFor(
      () => acceptanceWindows().length >= 2,
      15_000,
      "Recreated native New Window did not appear",
    );
    return;
  }
  if (action === "phase12-refresh-badges") {
    const windows = acceptanceWindows();
    await Promise.all(windows.map((candidate) => candidate.webContents.executeJavaScript(`(() => {
      const panel=document.querySelector('[data-codex-mux-routing-picker="true"]');
      if(!panel)return false;
      panel.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}));
      return true;
    })()`)));
    await new Promise((resolve) => setTimeout(resolve, 12_500));
    const states = await Promise.all(windows.map(phase12RoutingState));
    if (states.some((state) => state.badges.length < 2)) {
      throw new Error("Plugin status badges are missing for a connected account");
    }
    if (states.some((state) => state.badges.some((badge) => !badge.title.includes("workspace, page, and channel access are not confirmed")))) {
      throw new Error("Plugin badge scope disclaimer is missing");
    }
    return;
  }
  if (action === "phase12-reset-second-new-task") {
    const windows = acceptanceWindows();
    if (windows.length < 2) throw new Error("Phase 1 reset needs two windows");
    await phase12StartNewTask(windows[0]);
    await phase12StartNewTask(windows[1]);
    return;
  }
  if (action === "phase12-open-thread") {
    if (!/^[0-9a-f-]{36}$/i.test(targetThreadId ?? "")) {
      throw new Error("Phase 1 thread navigation needs a UUID threadId");
    }
    if (
      typeof targetThreadTitle !== "string" ||
      targetThreadTitle.length < 8 ||
      targetThreadTitle.length > 100
    ) {
      throw new Error("Phase 1 thread navigation needs a bounded unique title");
    }
    const targetWindow = acceptanceWindows()[0] ?? window;
    targetWindow.show();
    targetWindow.focus();
    const point = await waitFor(
      () => targetWindow.webContents.executeJavaScript(`(() => {
        const title=${JSON.stringify(targetThreadTitle)};
        const target=[...document.querySelectorAll('body *')].find(element=>{
          if(element.children.length>0||!element.textContent?.includes(title))return false;
          const rect=element.getBoundingClientRect();
          return rect.width>0&&rect.height>0&&rect.left>=0&&rect.right<=460;
        });
        if(!target)return null;
        const rect=target.getBoundingClientRect();
        return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
      })()`),
      15_000,
      `Could not open Phase 1 thread ${targetThreadId}`,
    );
    targetWindow.webContents.sendInputEvent({
      type: "mouseDown",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    targetWindow.webContents.sendInputEvent({
      type: "mouseUp",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(
      async () => {
        const state = await phase12RoutingState(targetWindow);
        return state.threadId === targetThreadId && Boolean(state.threadOwnerId);
      },
      20_000,
      `Phase 1 thread ${targetThreadId} did not render its persisted owner`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (
    action === "phase12-submit-default" ||
    action === "phase12-submit-primary" ||
    action === "phase12-submit-pro"
  ) {
    const windows = acceptanceWindows();
    if (windows.length < 2) throw new Error("Phase 1 routing submission needs two windows");
    const index = action === "phase12-submit-default" ? 1 : 0;
    const step =
      action === "phase12-submit-default"
        ? 10
        : action === "phase12-submit-primary"
          ? 11
          : 12;
    const target = windows[index];
    target.show();
    target.focus();
    if (action === "phase12-submit-primary") {
      await phase12StartNewTask(target);
      await phase12ClickRoute(target, "Primary");
    } else if (action === "phase12-submit-pro") {
      await phase12StartNewTask(target);
      await phase12ClickRoute(target, "Pro 20x");
    }
    await submitRoutingProbe(target, step, false, false);
    await waitFor(
      async () => {
        const state = await phase12RoutingState(target);
        return (
          state.view?.startsWith("thread:") &&
          Boolean(state.threadId) &&
          Boolean(state.threadOwnerId) &&
          state.choices.length === 0
        );
      },
      30_000,
      `Phase 1 routing submission ${step} did not settle on its real thread`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (action === "profile-toggle") {
    const toggled = await window.webContents.executeJavaScript(`(() => { const target=[...document.querySelectorAll('button[aria-label]')].find(element=>{const label=element.getAttribute('aria-label')||'';return label==='Show combined profile stats'||(label.startsWith('Show ')&&label.endsWith(' profile stats'))}); if(!target)return false; target.click(); return true; })()`);
    if (!toggled) throw new Error("Could not toggle a subscription profile");
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 1_500)));
    return;
  }
  if (action === "routing-first" || action === "routing-second") {
    await submitRoutingProbe(window, action === "routing-first" ? 1 : 2, action === "routing-first");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (action === "plugins-select-second") {
    const selected = await window.webContents.executeJavaScript(`(() => {
      const accountButtons=[...document.querySelectorAll('button[aria-pressed]')]
        .filter(button=>button.textContent?.includes('Subscription'));
      const target=accountButtons.find(button=>button.textContent?.includes('Subscription 2'))??accountButtons[0];
      if(!target)return false;
      target.click();
      return true;
    })()`);
    if (!selected) throw new Error("Could not select a secondary plugin subscription");
    await new Promise((resolve) => setTimeout(resolve, 750));
    const selectionState = await window.webContents.executeJavaScript(`(() => {
      const target=[...document.querySelectorAll('button[aria-pressed]')]
        .find(button=>button.textContent?.includes('Subscription 2'));
      return {accountId:globalThis.__codexMuxPluginAccountId??null,pressed:target?.getAttribute('aria-pressed')??null};
    })()`);
    if (selectionState.accountId === "primary" || selectionState.pressed !== "true") {
      throw new Error(`Secondary plugin subscription did not remain selected: ${JSON.stringify(selectionState)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 1_500)));
    return;
  }
  if (action === "usage-select-second") {
    const selected = await window.webContents.executeJavaScript(`(() => {
      const target=[...document.querySelectorAll('button[aria-pressed]')]
        .find(button=>button.textContent?.includes('Subscription 2'));
      if(!target)return false;
      target.click();
      return true;
    })()`);
    if (!selected) throw new Error("Could not select a secondary reset subscription");
    const selectionState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const read=()=>{const target=[...document.querySelectorAll('button[aria-pressed]')]
        .find(button=>button.textContent?.includes('Subscription 2'));
        return {accountId:globalThis.__codexMuxResetAccountId??null,pressed:target?.getAttribute('aria-pressed')??null};};
      const deadline=Date.now()+4000;
      const poll=()=>{const state=read();if(state.accountId&&state.accountId!=="primary"&&state.pressed==="true")resolve(state);else if(Date.now()>=deadline)resolve(state);else setTimeout(poll,100);};
      poll();
    })`);
    if (!selectionState.accountId || selectionState.accountId === "primary" || selectionState.pressed !== "true") {
      throw new Error(`Secondary reset subscription did not remain selected: ${JSON.stringify(selectionState)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 1_500)));
    return;
  }
  const settingsSections = {
    "settings-profile": ["Profile", "个人资料"],
    "settings-plugins": ["Plugins", "插件"],
    "settings-appshots": ["Appshots", "应用截图"],
    "settings-computer-use": ["Computer use", "计算机控制"],
  };
  if (Object.hasOwn(settingsSections, action)) {
    const sectionLabels = settingsSections[action];
    const alreadyInSettings = await window.webContents.executeJavaScript(`(() =>
      ['Back to app','返回应用'].some(label=>document.body?.innerText?.includes(label))
    )()`);
    if (!alreadyInSettings) {
      const settingsPoint = `(() => { const expected=['Settings','设置']; const labels=[...document.querySelectorAll('body *')].filter(element=>expected.includes(element.textContent?.trim())); const label=labels.sort((a,b)=>a.children.length-b.children.length)[0]; const target=label?.closest('button,a,[role="menuitem"],[role="button"]')??label; if(!target)return null; const rect=target.getBoundingClientRect(); return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}; })()`;
      let point = await window.webContents.executeJavaScript(settingsPoint);
      if (!point) {
        if (!(await clickProfileMenu(window))) {
          throw new Error("Could not find the profile-menu button");
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
        point = await window.webContents.executeJavaScript(settingsPoint);
      }
      if (!point) throw new Error("Could not open Settings");
      window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
      window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    const settingsWindow = mainWindow() ?? window;
    const sectionPoint = await settingsWindow.webContents.executeJavaScript(`(() => { const labels=${JSON.stringify(sectionLabels)}; const target=[...document.querySelectorAll('body *')].find(element=>element.children.length===0&&labels.includes(element.textContent?.trim())); if(!target)return null; const rect=target.getBoundingClientRect(); return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}; })()`);
    if (!sectionPoint) throw new Error(`Could not open Settings > ${sectionLabels[0]}`);
    settingsWindow.webContents.sendInputEvent({ type: "mouseDown", x: sectionPoint.x, y: sectionPoint.y, button: "left", clickCount: 1 });
    settingsWindow.webContents.sendInputEvent({ type: "mouseUp", x: sectionPoint.x, y: sectionPoint.y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 1_500)));
    return;
  }
  if (action === "appshots-open") {
    const plusPoint = await window.webContents.executeJavaScript(`(() => {
      const buttons=[...document.querySelectorAll('button')];
      const target=buttons.find(button=>{
        const label=(button.getAttribute('aria-label')??'').toLowerCase();
        const rect=button.getBoundingClientRect();
        return rect.width>0&&rect.height>0&&(label.includes('attach')||label.includes('add'))&&rect.bottom>innerHeight-180;
      });
      if(!target)return null;
      const rect=target.getBoundingClientRect();
      return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
    })()`);
    if (!plusPoint) throw new Error("Could not find the composer attachment button");
    window.webContents.sendInputEvent({ type: "mouseDown", x: plusPoint.x, y: plusPoint.y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: plusPoint.x, y: plusPoint.y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    let opened = await window.webContents.executeJavaScript(`(() => {
      const target=[...document.querySelectorAll('button,[role="menuitem"]')]
        .find(element=>/appshot/i.test(element.textContent??''));
      if(!target)return false;
      target.click();
      return true;
    })()`);
    if (!opened) {
      const scrolled = await window.webContents.executeJavaScript(`(() => {
        const candidates=[...document.querySelectorAll('body *')]
          .filter(element=>element.scrollHeight>element.clientHeight+20&&element.clientHeight>150)
          .sort((left,right)=>(right.scrollHeight-right.clientHeight)-(left.scrollHeight-left.clientHeight));
        const target=candidates[0];
        if(!target)return false;
        target.scrollTop=target.scrollHeight;
        target.dispatchEvent(new Event('scroll',{bubbles:true}));
        return true;
      })()`);
      if (scrolled) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        opened = await window.webContents.executeJavaScript(`(() => {
          const target=[...document.querySelectorAll('button,[role="menuitem"]')]
            .find(element=>/appshot/i.test(element.textContent??''));
          if(!target)return false;
          target.click();
          return true;
        })()`);
      }
    }
    if (!opened) throw new Error("Could not find Appshots in the attachment menu");
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 2_000)));
    return;
  }
  if (action === "appshots-hotkey") {
    for (let index = 0; index < 2; index += 1) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Meta" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Meta" });
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 3_000)));
    return;
  }
  if (action === "appshots-settings-trigger") {
    const triggered = await window.webContents.executeJavaScript(`(() => {
      const label=[...document.querySelectorAll('body *')]
        .find(element=>element.children.length===0&&element.textContent?.trim()==='Take an appshot to show ChatGPT your frontmost window');
      const target=label?.closest('button,[role="button"]')??label;
      if(!target)return false;
      target.click();
      return true;
    })()`);
    if (!triggered) throw new Error("Could not trigger an Appshot from Settings");
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 4_000)));
    return;
  }
  if (action === "computer-use-details") {
    const opened = await window.webContents.executeJavaScript(`(() => {
      const label=[...document.querySelectorAll('body *')]
        .find(element=>element.children.length===0&&/^Worked for \d+s/.test(element.textContent?.trim()??''));
      const target=label?.closest('button,[role="button"]')??label;
      if(!target)return false;
      target.click();
      return true;
    })()`);
    if (!opened) throw new Error("Could not expand the Computer Use details");
    await new Promise((resolve) => setTimeout(resolve, Math.max(delayMs, 1_500)));
    return;
  }
  if (action === "usage" || action === "usage-confirm" || action === "usage-confirm-final") {
    const usageVisible = await window.webContents.executeJavaScript(`(() =>
      [...document.querySelectorAll('h1,h2,[role="dialog"]')]
        .some(element => element.textContent?.includes('Usage limit resets'))
    )()`);
    if (!usageVisible) {
      if (!(await clickProfileMenu(window))) {
        throw new Error("Could not find the profile-menu button");
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      const opened = await window.webContents.executeJavaScript(`(() => { const target=[...document.querySelectorAll('button,[role="menuitem"]')].find(element=>element.textContent?.includes('Usage remaining')); if(!target)return false; target.click(); return true; })()`);
      if (!opened) throw new Error("Could not open the Usage sheet");
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    if (action === "usage-confirm") {
      const confirming = await window.webContents.executeJavaScript(`(() => { const target=[...document.querySelectorAll('button')].find(element=>element.textContent?.trim()==='Use reset'); if(!target)return false; target.click(); return true; })()`);
      if (!confirming) throw new Error("Could not find the Use reset button");
    }
    if (action === "usage-confirm-final") {
      const confirmed = await window.webContents.executeJavaScript(`(() => { const target=[...document.querySelectorAll('button')].find(element=>element.textContent?.trim()==='Confirm'); if(!target)return false; target.click(); return true; })()`);
      if (!confirmed) throw new Error("Could not find the reset confirmation button");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (action === "submit-computer-use") {
    const isSettings = await window.webContents.executeJavaScript(`document.body?.innerText?.includes('Back to app')??false`);
    if (isSettings) {
      const returned = await window.webContents.executeJavaScript(`(() => { const label=[...document.querySelectorAll('body *')].find(element=>element.textContent?.trim()==='Back to app'); const target=label?.closest('button,a,[role="button"]')??label; if(!target)return false; target.click(); return true; })()`);
      if (!returned) throw new Error("Could not leave Settings for the Computer Use test");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      window = mainWindow() ?? window;
    }
    const newChatPoint = await window.webContents.executeJavaScript(`(() => { const target=document.querySelector('button[aria-label="New chat"]'); if(!target)return null; const rect=target.getBoundingClientRect(); return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}; })()`);
    if (newChatPoint) {
      window.webContents.sendInputEvent({ type: "mouseDown", x: newChatPoint.x, y: newChatPoint.y, button: "left", clickCount: 1 });
      window.webContents.sendInputEvent({ type: "mouseUp", x: newChatPoint.x, y: newChatPoint.y, button: "left", clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const filled = await window.webContents.executeJavaScript(`(() => {
      const composer=document.querySelector('textarea[placeholder]')??document.querySelector('[contenteditable="true"]');
      if(!composer)return false;
      composer.focus();
      if(composer instanceof HTMLTextAreaElement){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(composer,${JSON.stringify("Use the Computer controls to open Calculator, then stop.")});}
      else{composer.textContent=${JSON.stringify("Use the Computer controls to open Calculator, then stop.")};}
      composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify("Use the Computer controls to open Calculator, then stop.")}}));
      return true;
    })()`);
    if (!filled) throw new Error("Could not fill the Computer Use test prompt");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const submitted = await window.webContents.executeJavaScript(`(() => { const target=[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='Send'&&!button.disabled); if(!target)return false; target.click(); return true; })()`);
    if (!submitted) throw new Error("Could not submit the Computer Use test prompt");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    const outcome = await window.webContents.executeJavaScript(`(() => { const text=document.body?.innerText??''; return {fellBack:/osascript|native automation interface/i.test(text),text:text.slice(-4000)}; })()`);
    if (outcome.fellBack) throw new Error("Computer Use fell back to osascript");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (action === "submit-quota") {
    const filled = await window.webContents.executeJavaScript(`(() => {
      const composer=document.querySelector('textarea[placeholder]')??document.querySelector('[contenteditable="true"]');
      if(!composer)return false;
      composer.focus();
      if(composer instanceof HTMLTextAreaElement){
        const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
        setter.call(composer,'Quota handling preview');
      }else{
        composer.textContent='Quota handling preview';
      }
      composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Quota handling preview'}));
      return true;
    })()`);
    if (!filled) throw new Error("Could not find the test composer");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const submitted = await window.webContents.executeJavaScript(`(() => {
      const composer=document.querySelector('textarea[placeholder]')??document.querySelector('[contenteditable="true"]');
      if(!composer)return false;
      const target=[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='Send'&&!button.disabled);
      if(!target)return false;
      target.click();
      return true;
    })()`);
    if (!submitted) throw new Error("Could not submit the quota test turn");
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const visibleQuotaError=()=>[...document.querySelectorAll('[role="alert"],body *')].some(element=>element.textContent?.includes('All connected subscriptions are depleted'));
      if(visibleQuotaError()){resolve(true);return;}
      const observer=new MutationObserver(()=>{if(visibleQuotaError()){observer.disconnect();resolve(true);}});
      observer.observe(document.body,{childList:true,subtree:true,characterData:true});
      setTimeout(()=>{observer.disconnect();resolve(false);},15000);
    })`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  const selector = "button,[role='button'],a";
  let script;
  if (action === "profile") {
    if (!(await clickProfileMenu(window))) {
      throw new Error("Could not find the profile-menu button");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  } else if (action === "quota-thread") {
    const openQuotaThread = `(() => { const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})]; const target=candidates.find(element=>element.textContent.trim()==="Quota handling preview"); if(!target)return false; target.click(); return true; })()`;
    if (!(await window.webContents.executeJavaScript(openQuotaThread))) {
      const expanded = await window.webContents.executeJavaScript(`(() => { const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})]; const target=candidates.find(element=>element.textContent.trim()==="Show more"); if(!target)return false; target.click(); return true; })()`);
      if (!expanded) throw new Error("Could not expand the recent chats");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!(await window.webContents.executeJavaScript(openQuotaThread))) {
        throw new Error("Could not find the quota preview thread");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  } else if (action === "first-thread") {
    script = `(() => { const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})]; const target=candidates.find(element=>element.textContent.includes("Codex, we want to modify ChatGPT.app")); if(!target)return false; target.click(); return true; })()`;
  } else {
    script = `(() => { const labels=['Back to app','返回应用']; const label=[...document.querySelectorAll('body *')].find(element=>labels.includes(element.textContent?.trim())); const target=label?.closest('button,a,[role="button"]')??label; if(!target)return false; target.click(); return true; })()`;
  }
  const clicked = await window.webContents.executeJavaScript(script);
  if (!clicked) throw new Error(`Could not perform UI-test action: ${action}`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function capture(
  action,
  delayMs,
  includeDebug,
  targetThreadId = null,
  targetThreadTitle = null,
) {
  let window = mainWindow();
  if (!window) throw new Error("Codex Subscription Router has no main window");
  if (action !== null) {
    await runAction(window, action, delayMs, targetThreadId, targetThreadTitle);
  }
  if (action === "phase12-open-thread" && targetThreadId) {
    const matchingWindows = await Promise.all(
      acceptanceWindows().map(async (candidate) => ({
        candidate,
        state: await phase12RoutingState(candidate),
      })),
    );
    window =
      matchingWindows.find(({ state }) => state.threadId === targetThreadId)
        ?.candidate ?? window;
  } else {
    window = mainWindow() ?? window;
  }
  const image = await window.webContents.capturePage();
  const result = {
    bounds: window.getContentBounds(),
    imageBase64: image.toPNG().toString("base64"),
  };
  if (includeDebug) {
    result.debug = await window.webContents.executeJavaScript(`(() => {
      const composer=document.querySelector('textarea[placeholder]')??document.querySelector('[contenteditable="true"]');
      const describe=element=>{const rect=element.getBoundingClientRect(); return {ariaLabel:element.getAttribute('aria-label'),disabled:element.disabled,text:element.textContent.trim().slice(0,80),type:element.type,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}};
      return {
        readyState: document.readyState,
        href: location.href,
        bodyText: document.body?.innerText?.trim().slice(0,500)??null,
        rootHtml: document.querySelector('#root')?.innerHTML?.slice(0,1_000)??null,
        composer:composer?describe(composer):null,
        buttons:[...document.querySelectorAll('button')].filter(button=>{const rect=button.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.bottom>innerHeight-180}).map(describe),
      };
    })()`);
    result.diagnostics = diagnostics.slice(-50);
    result.phase12 = {
      windowCount: acceptanceWindows().length,
      windows: await Promise.all(
        acceptanceWindows().map(async (candidate) => ({
          windowId: candidate.id,
          ...(await phase12RoutingState(candidate)),
        })),
      ),
    };
  }
  return result;
}

function start() {
  if (process.env.CODEX_MUX_UI_TESTS !== "1") return;
  app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (_consoleEvent, level, message, line, sourceId) => {
      recordDiagnostic("console", { level, message, line, sourceId });
    });
    contents.on("render-process-gone", (_goneEvent, details) => {
      recordDiagnostic("render-process-gone", details);
    });
  });
  const token = fs
    .readFileSync(path.join(os.homedir(), ".codex-mux", "control-token"), "utf8")
    .trim();
  const server = http.createServer(async (request, response) => {
    if (request.headers["x-codex-mux-token"] !== token) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (request.method !== "GET" || url.pathname !== "/v1/test/app-state") {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    const action = url.searchParams.get("action");
    if (
      action !== null &&
      action !== "phase12-onboarding" &&
      action !== "phase12-open-second-window" &&
      action !== "phase12-dual-select" &&
      action !== "phase12-recover-windows" &&
      action !== "phase12-refresh-badges" &&
      action !== "phase12-reset-second-new-task" &&
      action !== "phase12-open-thread" &&
      action !== "phase12-submit-primary" &&
      action !== "phase12-submit-default" &&
      action !== "phase12-submit-pro" &&
      action !== "profile" &&
	  action !== "profile-toggle" &&
	  action !== "settings-profile" &&
	  action !== "settings-plugins" &&
	  action !== "settings-appshots" &&
	  action !== "settings-computer-use" &&
	  action !== "plugins-select-second" &&
	  action !== "usage" &&
	  action !== "usage-confirm" &&
	  action !== "usage-confirm-final" &&
	  action !== "usage-select-second" &&
	  action !== "routing-first" &&
	  action !== "routing-second" &&
	  action !== "appshots-open" &&
	  action !== "appshots-hotkey" &&
	  action !== "appshots-settings-trigger" &&
	  action !== "computer-use-details" &&
	  action !== "submit-computer-use" &&
      action !== "quota-thread" &&
      action !== "first-thread" &&
      action !== "back-to-app" &&
      action !== "submit-quota"
    ) {
      writeJson(response, 400, { error: "unsupported action" });
      return;
    }
    const delayMs = Number(url.searchParams.get("delayMs") ?? 400);
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
      writeJson(response, 400, { error: "delayMs must be between 0 and 5000" });
      return;
    }
    const includeDebug = url.searchParams.get("debug") === "1";
    const targetThreadId = url.searchParams.get("threadId");
    const targetThreadTitle = url.searchParams.get("threadTitle");
    try {
      writeJson(
        response,
        200,
        await capture(
          action,
          delayMs,
          includeDebug,
          targetThreadId,
          targetThreadTitle,
        ),
      );
    } catch (error) {
      writeJson(response, 500, { error: error.message });
    }
  });
  server.listen(PORT, HOST);
}

module.exports = { start };
