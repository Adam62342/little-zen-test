// ==UserScript==
// @name           Glance Sites
// @description    On chosen websites, links open in Zen Glance instead of a new tab.
// @include        main
// ==/UserScript==

(() => {
  const PREF_PREFIX = "mod.glance_sites.";
  const PREF_LIST = PREF_PREFIX + "list";
  const PREF_MODE = PREF_PREFIX + "mode";
  const DEBUG = false; // set to true to log to the Browser Console (Ctrl+Shift+J)
  const log = (...a) => DEBUG && console.log("[Glance Sites]", ...a);

  const MSG_READY = "GlanceSites:Ready";
  const MSG_CONFIG = "GlanceSites:Config";
  const MSG_OPEN = "GlanceSites:Open";

  // ---------------------------------------------------------------------------
  // Content side: runs inside every web page's process as a frame script.
  // ---------------------------------------------------------------------------
  const frameScript = `(${function (cfg) {
    if (globalThis.__glanceSitesInstalled) return;
    globalThis.__glanceSitesInstalled = true;

    let config = { hosts: [], mode: "newtab" };
    addMessageListener(cfg.config, (m) => { config = m.data; });

    const siteEnabled = () => {
      if (!config.hosts.length) return false;
      let host;
      try { host = content.location.hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return false; }
      return !!host && config.hosts.some((h) => host === h || host.endsWith("." + h));
    };

    const findLink = (e) => {
      for (const node of e.composedPath ? e.composedPath() : [e.target]) {
        if (node && node.localName === "a" && node.href) return node;
      }
      return null;
    };

    const opensNewTab = (e, link) => {
      if (e.type === "auxclick" || e.ctrlKey || e.metaKey) return true;
      const t = (link.getAttribute("target") || "").toLowerCase();
      if (!t || t === "_self" || t === "_top" || t === "_parent") return false;
      try { if (content.frames[t]) return false; } catch (err) {}
      return true;
    };

    const handle = (e) => {
      if (e.altKey || e.shiftKey) return; // Alt = Zen's own Glance shortcut, Shift = new window
      if (e.type === "auxclick" ? e.button !== 1 : e.button !== 0) return;

      const link = findLink(e);
      if (!link || !/^https?:$/i.test(link.protocol) || link.hasAttribute("download")) return;
      if (link.hash && link.href.split("#")[0] === content.location.href.split("#")[0]) return; // same-page anchor
      if (!siteEnabled()) return;
      if (config.mode !== "all" && !opensNewTab(e, link)) return;

      e.preventDefault();
      e.stopPropagation();
      const r = link.getBoundingClientRect();
      sendAsyncMessage(cfg.open, {
        url: link.href,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      });
    };

    addEventListener("click", handle, true);
    addEventListener("auxclick", handle, true);

    // Ask the browser side for the current settings.
    sendAsyncMessage(cfg.ready);
  }})(${JSON.stringify({ ready: MSG_READY, config: MSG_CONFIG, open: MSG_OPEN })});`;

  const frameScriptURL = "data:application/javascript;charset=UTF-8," + encodeURIComponent(frameScript);

  // ---------------------------------------------------------------------------
  // Chrome side: settings + opening Glance.
  // ---------------------------------------------------------------------------
  const readPref = (name, fallback) => {
    try {
      switch (Services.prefs.getPrefType(name)) {
        case Services.prefs.PREF_STRING: return Services.prefs.getStringPref(name);
        case Services.prefs.PREF_INT: return String(Services.prefs.getIntPref(name));
      }
    } catch (e) {}
    return fallback;
  };

  const parseHosts = (raw) =>
    raw.split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/^\*\./, "")
        .replace(/^www\./, "")
        .replace(/[\/?#:].*$/, ""))
      .filter(Boolean);

  const getConfig = () => ({
    hosts: parseHosts(readPref(PREF_LIST, "")),
    mode: readPref(PREF_MODE, "newtab") === "all" ? "all" : "newtab",
  });

  const broadcastConfig = () => {
    const cfg = getConfig();
    log("config", cfg);
    window.messageManager.broadcastAsyncMessage(MSG_CONFIG, cfg);
  };

  // Hand the request to Zen's own Glance actor (same message Alt+click uses);
  // fall back to the manager, then to a normal new tab so a link never just dies.
  const openGlance = (browser, data) => {
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("ZenGlance");
      if (actor?.receiveMessage) {
        actor.receiveMessage({ name: "ZenGlance:OpenGlance", data });
        log("opened via ZenGlance actor", data.url);
        return;
      }
    } catch (e) { log("actor route failed:", e); }
    try {
      if (typeof gZenGlanceManager !== "undefined") {
        gZenGlanceManager.openGlance(data, null, gBrowser.getTabForBrowser(browser));
        log("opened via gZenGlanceManager", data.url);
        return;
      }
    } catch (e) { console.error("[Glance Sites] openGlance failed", e); }
    console.error("[Glance Sites] couldn't open Glance, opening a normal tab");
    openTrustedLinkIn(data.url, "tab");
  };

  const onMessage = (msg) => {
    if (msg.name === MSG_READY) {
      msg.target.messageManager.sendAsyncMessage(MSG_CONFIG, getConfig());
      return;
    }
    const { url, rect } = msg.data;
    openGlance(msg.target, { url, clientX: rect.x, clientY: rect.y, width: rect.width, height: rect.height });
  };

  const prefObserver = { observe: broadcastConfig };

  window.messageManager.addMessageListener(MSG_READY, onMessage);
  window.messageManager.addMessageListener(MSG_OPEN, onMessage);
  Services.prefs.addObserver(PREF_PREFIX, prefObserver);
  window.messageManager.loadFrameScript(frameScriptURL, true);
  log("loaded");

  window.addEventListener("unload", () => {
    window.messageManager.removeMessageListener(MSG_READY, onMessage);
    window.messageManager.removeMessageListener(MSG_OPEN, onMessage);
    Services.prefs.removeObserver(PREF_PREFIX, prefObserver);
  }, { once: true });
})();
