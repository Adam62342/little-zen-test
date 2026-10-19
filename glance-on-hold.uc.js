// ==UserScript==
// @name           Glance on Hold
// @description    Click and hold a link to open it in Zen Glance.
// @include        main
// ==/UserScript==

(() => {
  const PREF_DELAY = "mod.glance_hold.delay";
  const DEFAULT_DELAY = 700;
  const MOVE_TOLERANCE = 8; // px the cursor may drift before the hold is cancelled
  const DEBUG = true; // logs to the Browser Console (Ctrl+Shift+J); set to false once it works
  const log = (...a) => DEBUG && console.log("[Glance on Hold]", ...a);
  log("script loaded");

  const MSG_DOWN = "GlanceHold:Down";
  const MSG_CANCEL = "GlanceHold:Cancel";
  const MSG_FIRED = "GlanceHold:Fired";

  // ---------------------------------------------------------------------------
  // Content side: runs inside every web page's process as a frame script.
  // ---------------------------------------------------------------------------
  const frameScript = `(${function (cfg) {
    if (globalThis.__glanceHoldInstalled) return;
    globalThis.__glanceHoldInstalled = true;

    let startX = 0, startY = 0, holding = false, swallowClick = false;

    const findLink = (e) => {
      for (const node of e.composedPath ? e.composedPath() : [e.target]) {
        if (node && node.localName === "a" && node.href) return node;
      }
      return null;
    };

    const cancel = () => {
      if (!holding) return;
      holding = false;
      sendAsyncMessage(cfg.cancel);
    };

    addEventListener("mousedown", (e) => {
      swallowClick = false;
      if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const link = findLink(e);
      if (!link || !/^(https?|file):/i.test(link.href)) return;

      startX = e.clientX;
      startY = e.clientY;
      holding = true;
      const r = link.getBoundingClientRect();
      sendAsyncMessage(cfg.down, {
        url: link.href,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      });
    }, true);

    addEventListener("mousemove", (e) => {
      if (holding && Math.hypot(e.clientX - startX, e.clientY - startY) > cfg.tolerance) cancel();
    }, true);

    for (const type of ["mouseup", "dragstart", "contextmenu", "blur"]) {
      addEventListener(type, cancel, true);
    }

    // If Glance fired, eat the click that follows the mouse release so the page doesn't navigate.
    addMessageListener(cfg.fired, () => { swallowClick = true; holding = false; });

    addEventListener("click", (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }})(${JSON.stringify({
    down: MSG_DOWN, cancel: MSG_CANCEL, fired: MSG_FIRED, tolerance: MOVE_TOLERANCE,
  })});`;

  const frameScriptURL = "data:application/javascript;charset=UTF-8," + encodeURIComponent(frameScript);

  // ---------------------------------------------------------------------------
  // Chrome side: owns the timer and talks to Zen's Glance manager.
  // ---------------------------------------------------------------------------
  const getDelay = () => {
    try {
      switch (Services.prefs.getPrefType(PREF_DELAY)) {
        case Services.prefs.PREF_STRING: return parseInt(Services.prefs.getStringPref(PREF_DELAY), 10) || DEFAULT_DELAY;
        case Services.prefs.PREF_INT: return Services.prefs.getIntPref(PREF_DELAY);
      }
    } catch (e) {}
    return DEFAULT_DELAY;
  };

  let timer = null;
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const onMessage = (msg) => {
    if (msg.name === MSG_CANCEL) return clearTimer();

    // MSG_DOWN
    if (msg.target !== gBrowser.selectedBrowser) return;
    clearTimer();
    const { url, rect } = msg.data;
    const browser = msg.target;
    log("mouse down on link", url, "- waiting", getDelay(), "ms");

    timer = setTimeout(() => {
      timer = null;
      log("hold complete, opening Glance for", url);
      if (openGlance(browser, { url, clientX: rect.x, clientY: rect.y, width: rect.width, height: rect.height })) {
        browser.messageManager.sendAsyncMessage(MSG_FIRED);
      }
    }, getDelay());
  };

  // Preferred: hand the request to Zen's own Glance actor, exactly as Alt+click does,
  // so Zen applies its own coordinate handling. Fallback: call the manager directly.
  const openGlance = (browser, data) => {
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("ZenGlance");
      if (actor?.receiveMessage) {
        actor.receiveMessage({ name: "ZenGlance:OpenGlance", data });
        log("opened via ZenGlance actor");
        return true;
      }
    } catch (e) {
      log("actor route failed:", e);
    }
    try {
      if (typeof gZenGlanceManager !== "undefined") {
        gZenGlanceManager.openGlance(data, null, gBrowser.getTabForBrowser(browser));
        log("opened via gZenGlanceManager");
        return true;
      }
    } catch (e) {
      console.error("[Glance on Hold] gZenGlanceManager.openGlance failed", e);
    }
    console.error("[Glance on Hold] no way to open Glance found");
    return false;
  };

  window.messageManager.addMessageListener(MSG_DOWN, onMessage);
  window.messageManager.addMessageListener(MSG_CANCEL, onMessage);
  window.messageManager.loadFrameScript(frameScriptURL, true);

  window.addEventListener("unload", () => {
    clearTimer();
    window.messageManager.removeMessageListener(MSG_DOWN, onMessage);
    window.messageManager.removeMessageListener(MSG_CANCEL, onMessage);
  }, { once: true });
})();
