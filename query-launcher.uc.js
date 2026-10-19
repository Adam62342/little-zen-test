// ==UserScript==
// @name           Query Launcher
// @description    Pin a custom destination (AI, another browser, any URL) directly under your urlbar query
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==
(() => {
  "use strict";

  const ID = "query-launcher";
  const PREF = "mod." + ID + ".";
  const DT = "querylauncher"; // dynamic urlbar result type name

  const DEFAULTS = {
    label: "Ask AI",
    url: "https://www.perplexity.ai/search?q=%s",
    openin: "tab",     // tab | current | window | external
    app: "",           // external app name (macOS), e.g. "Google Chrome"
    iconmode: "favicon", // favicon | symbol
    symbol: "✦",  // ✦ — paste an SF Symbol glyph here for symbol mode
    minlen: "1",
    index: "1",        // row position: 1 = directly below your typed query
  };

  // ---------- preferences (Sine stores them as mod.<id>.<key>) ----------
  const P = Services.prefs;
  const pref = (k, d) => {
    try {
      const key = PREF + k, t = P.getPrefType(key);
      if (t === P.PREF_STRING) return P.getStringPref(key);
      if (t === P.PREF_INT) return String(P.getIntPref(key));
      if (t === P.PREF_BOOL) return String(P.getBoolPref(key));
    } catch (e) {}
    return d;
  };

  // ---------- destination ----------
  const buildUrl = (tpl, q) => {
    const e = encodeURIComponent(q);
    if (/%s/.test(tpl)) return tpl.replace(/%s/g, e);
    if (/\{query\}/.test(tpl)) return tpl.replace(/\{query\}/g, e);
    return tpl + (tpl.includes("?") ? "&" : "?") + "q=" + e; // no placeholder → append ?q=
  };
  const hostOf = (tpl) => { try { return new URL(tpl.replace(/%s|\{query\}/g, "")).hostname; } catch (e) { return ""; } };
  const faviconFor = (tpl) => { const h = hostOf(tpl); return h ? "https://www.google.com/s2/favicons?sz=64&domain=" + h : ""; };

  // launch an external app with the URL (macOS `open -a App URL`); returns false if not possible
  function launchExternal(app, url) {
    try {
      if (Services.appinfo.OS !== "Darwin" || !app) return false; // only macOS, and only with a named app
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath("/usr/bin/open");
      const p = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      p.init(f);
      const args = ["-a", app, url];
      p.runAsync(args, args.length);
      return true;
    } catch (e) { console.warn("[query-launcher] external launch failed", e); return false; }
  }

  function go(q) {
    const tpl = pref("url", DEFAULTS.url);
    if (!tpl) return;
    const url = buildUrl(tpl, q);
    const where = pref("openin", DEFAULTS.openin);
    if (where === "external" && launchExternal(pref("app", ""), url)) return; // else fall through to a tab
    try {
      openTrustedLinkIn(url, where === "current" ? "current" : where === "window" ? "window" : "tab");
    } catch (e) {
      try { gBrowser.selectedTab = gBrowser.addTrustedTab(url); } catch (e2) {}
    }
  }

  // ---------- styling (injected per window) ----------
  const CSS = `
.urlbarView-row[dynamicType="${DT}"] .urlbarView-row-inner { display: flex; align-items: center; gap: 8px; }
.altdest-iconbox {
  width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  background-size: cover; background-position: center; border-radius: 3px;
  font: 14px/1 -apple-system, "SF Pro Text", "SF Pro", system-ui, sans-serif;
}
.altdest-label { font-weight: 600; flex: none; }
.altdest-query { opacity: 0.55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.altdest-hint { margin-inline-start: auto; opacity: 0.5; font-size: 11px; flex: none; }
`;
  function injectCSS(doc) {
    if (!doc || doc.getElementById("altdest-style")) return;
    const s = doc.createElement("style");
    s.id = "altdest-style";
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // ---------- the pinned result row ----------
  const TEMPLATE = {
    attributes: { selectable: true }, // keyboard-selectable (arrow down, then Enter)
    children: [
      { name: "iconbox", tag: "span", classList: ["altdest-iconbox"] }, // favicon as bg-image, or glyph as text
      { name: "label", tag: "span", classList: ["altdest-label"] },
      { name: "query", tag: "span", classList: ["altdest-query"] },
      { name: "hint", tag: "span", classList: ["altdest-hint"] },
    ],
  };

  let UrlbarUtils, UrlbarProvider, UrlbarResult, UrlbarProvidersManager;
  function loadModules() {
    const u = ChromeUtils.importESModule("resource:///modules/UrlbarUtils.sys.mjs");
    const m = ChromeUtils.importESModule("resource:///modules/UrlbarProvidersManager.sys.mjs");
    UrlbarUtils = u.UrlbarUtils;
    UrlbarProvider = u.UrlbarProvider || m.UrlbarProvider;
    UrlbarResult = ChromeUtils.importESModule("resource:///modules/UrlbarResult.sys.mjs").UrlbarResult;
    UrlbarProvidersManager = m.UrlbarProvidersManager;
    return !!(UrlbarUtils && UrlbarProvider && UrlbarResult && UrlbarProvidersManager);
  }

  // defined in a factory so the class body only evaluates after the base class is loaded
  function makeProvider() {
    return new (class extends UrlbarProvider {
      get name() { return "QueryLauncher"; }
      get type() { return UrlbarUtils.PROVIDER_TYPE.PROFILE; }
      getPriority() { return 0; }

      isActive(context) {
        const q = (context.searchString || "").trim();
        const min = Math.max(1, parseInt(pref("minlen", DEFAULTS.minlen), 10) || 1);
        return q.length >= min && !!pref("url", DEFAULTS.url);
      }

      startQuery(context, add) {
        const q = (context.searchString || "").trim();
        if (!q) return;
        const result = new UrlbarResult(
          UrlbarUtils.RESULT_TYPE.DYNAMIC,
          UrlbarUtils.RESULT_SOURCE.OTHER_LOCAL,
          {
            dynamicType: DT,
            query: q,
            label: pref("label", DEFAULTS.label),
            iconmode: pref("iconmode", DEFAULTS.iconmode),
            symbol: pref("symbol", DEFAULTS.symbol),
            icon: faviconFor(pref("url", DEFAULTS.url)),
          }
        );
        let idx = parseInt(pref("index", DEFAULTS.index), 10);
        result.suggestedIndex = idx >= 0 ? idx : 1; // 1 = right under your typed query
        add(this, result);
      }

      getViewTemplate() { return TEMPLATE; }

      getViewUpdate(result) {
        const p = result.payload;
        const fav = p.iconmode !== "symbol";
        return {
          iconbox: {
            textContent: fav ? "" : (p.symbol || DEFAULTS.symbol),
            attributes: { style: fav ? `background-image:url("${p.icon}")` : "" },
          },
          label: { textContent: p.label || DEFAULTS.label },
          query: { textContent: p.query ? "“" + p.query + "”" : "" },
          hint: { textContent: "↵ send" },
        };
      }

      // fires when the row is chosen (Enter on it, or click) — signature varies by Firefox version,
      // so just find the details object (the one carrying .result) among the arguments
      onEngagement(...args) {
        try {
          let details = null;
          for (const a of args) if (a && typeof a === "object" && a.result) { details = a; break; }
          const result = details && details.result;
          if (!result || result.providerName !== this.name) return;
          const q = result.payload && result.payload.query;
          console.log("[query-launcher] engagement →", q);
          if (q) go(q);
          try { gURLBar.view.close(); } catch (e) {}
          try { gURLBar.blur(); } catch (e) {}
        } catch (e) { console.warn("[query-launcher] engagement error", e); }
      }
    })();
  }

  // register the provider once per process (ES modules are process-wide singletons, so the flag on
  // UrlbarProvidersManager persists across windows); inject the CSS once per window
  function register() {
    if (UrlbarProvidersManager.__queryLauncher) return;
    try { UrlbarResult.addDynamicResultType(DT); } catch (e) {}
    // the view template must be registered on the UrlbarView class, or dynamic rows render as a
    // generic fallback (magnifying glass) and don't use our layout. Reach the class via the live view.
    try {
      const UrlbarView = gURLBar?.view?.constructor;
      if (UrlbarView?.addDynamicViewTemplate) UrlbarView.addDynamicViewTemplate(DT, TEMPLATE);
    } catch (e) { console.warn("[query-launcher] view template registration failed", e); }
    UrlbarProvidersManager.registerProvider(makeProvider());
    UrlbarProvidersManager.__queryLauncher = true;
  }

  function init(tries) {
    try {
      if (!loadModules()) throw new Error("urlbar modules not ready");
      if (!gURLBar || !gURLBar.view || !gURLBar.view.constructor) throw new Error("urlbar view not ready");
      register();
      injectCSS(document);
      console.log("[query-launcher] loaded v1.0.1");
    } catch (e) {
      if ((tries || 0) < 15) setTimeout(() => init((tries || 0) + 1), 800);
      else console.warn("[query-launcher] init failed", e);
    }
  }
  init(0);
})();
