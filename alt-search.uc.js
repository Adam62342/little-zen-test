// ==UserScript==
// @name            Alt Search
// @description     Pins "send this query elsewhere" rows (AI, other browser, any URL) under the URL bar's top result
// @version         1.0.0
// ==/UserScript==

(() => {
  "use strict";

  const PREF_ENABLED = "mod.altsearch.enabled";
  const PREF_MIN_WORDS = "mod.altsearch.min_words";
  const PREF_ENTRIES = "mod.altsearch.entries";
  const DEFAULT_ENTRIES = JSON.stringify([
    { name: "ChatGPT", url: "https://chatgpt.com/?q={query}", icon: "favicon" },
  ]);
  const PROVIDER_NAME = "SineAltSearch";

  const { UrlbarProvider, UrlbarUtils } = ChromeUtils.importESModule(
    "resource:///modules/UrlbarUtils.sys.mjs"
  );
  const { UrlbarResult } = ChromeUtils.importESModule(
    "resource:///modules/UrlbarResult.sys.mjs"
  );
  const { UrlbarProvidersManager } = ChromeUtils.importESModule(
    "resource:///modules/UrlbarProvidersManager.sys.mjs"
  );

  // ---------- config ----------
  function getEntries() {
    try {
      const raw = Services.prefs.getStringPref(PREF_ENTRIES, DEFAULT_ENTRIES);
      const list = JSON.parse(raw);
      return (Array.isArray(list) ? list : []).filter(
        e => e && e.name && typeof e.url === "string" && e.url.includes("{query}")
      );
    } catch (ex) {
      console.error("[AltSearch] Invalid JSON in " + PREF_ENTRIES, ex);
      return [];
    }
  }

  function glyphIcon(glyph) {
    // Paste a glyph copied from the SF Symbols app (Edit > Copy Glyph).
    // Needs the SF Pro font installed for it to render.
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' id='sine-alt'>" +
      "<text x='8' y='13' text-anchor='middle' font-size='13' " +
      "font-family='SF Pro, SF Pro Text, SF Pro Display, -apple-system, sans-serif' " +
      "fill='context-fill #8f8f9d'>" + glyph + "</text></svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function iconFor(entry) {
    const icon = (entry.icon ?? "favicon").trim();
    if (!icon || icon.toLowerCase() === "favicon") {
      try {
        return "page-icon:" + new URL(entry.url.replace("{query}", "")).origin;
      } catch {
        return "";
      }
    }
    if (/^(https?|data|chrome|moz-icon|page-icon):/i.test(icon)) return icon;
    return glyphIcon(icon);
  }

  function looksLikeUrl(s) {
    return !/\s/.test(s) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /\.[a-z]{2,}(\/|:|$)/i.test(s));
  }

  // ---------- shared state (one per process, many windows) ----------
  const shared = (UrlbarProvidersManager.__sineAlt ??= { entriesByUrl: new Map() });

  function makeResult(payload) {
    const type = UrlbarUtils.RESULT_TYPE.URL;
    const source = UrlbarUtils.RESULT_SOURCE.OTHER_LOCAL;
    if (UrlbarResult.length === 1) return new UrlbarResult({ type, source, payload });
    return new UrlbarResult(type, source, payload);
  }

  class AltSearchProvider extends UrlbarProvider {
    get name() { return PROVIDER_NAME; }
    get type() { return UrlbarUtils.PROVIDER_TYPE.PROFILE; }
    getPriority() { return 0; }

    isActive(ctx) {
      if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) return false;
      if (ctx.restrictSource || ctx.isPrivate === undefined && false) return false;
      const q = (ctx.searchString || "").trim();
      if (!q || looksLikeUrl(q)) return false;
      const minWords = parseInt(Services.prefs.getStringPref(PREF_MIN_WORDS, "1"), 10) || 1;
      return q.split(/\s+/).length >= minWords;
    }

    async startQuery(ctx, addCallback) {
      const q = ctx.searchString.trim();
      for (const entry of getEntries()) {
        const url = entry.url.replace("{query}", encodeURIComponent(q));
        shared.entriesByUrl.set(url, entry);
        let host = "";
        try { host = new URL(url).host; } catch {}
        const payload = {
          url,
          title: `${entry.name} \u2014 ${q}`,
          displayUrl: entry.app ? `Open in ${entry.app}` : host,
        };
        const icon = iconFor(entry);
        if (icon) payload.icon = icon;
        try {
          addCallback(this, makeResult(payload));
        } catch (ex) {
          console.error("[AltSearch] could not add result", ex);
        }
      }
    }

    cancelQuery() {}
  }

  // ---------- register provider + pin via muxer (once per process) ----------
  if (!shared.registered) {
    shared.registered = true;
    UrlbarProvidersManager.registerProvider(new AltSearchProvider());

    let muxer = UrlbarProvidersManager.muxers?.get?.("UnifiedComplete");
    if (!muxer) {
      try {
        const mod = ChromeUtils.importESModule("resource:///modules/UrlbarMuxerStandard.sys.mjs");
        const m = mod.UrlbarMuxerStandard ?? mod.UrlbarMuxerUnifiedComplete;
        muxer = typeof m === "function" ? m.prototype : m;
      } catch (ex) {
        console.error("[AltSearch] muxer not found; rows will not be pinned", ex);
      }
    }
    if (muxer && !muxer.__sineAltPatched) {
      const origSort = muxer.sort;
      muxer.sort = function (context, unsorted, ...rest) {
        const mine = [], others = [];
        for (const r of unsorted) (r.providerName === PROVIDER_NAME ? mine : others).push(r);
        const ret = origSort.call(this, context, others, ...rest);
        if (mine.length && Array.isArray(context.results)) {
          for (const r of mine) {
            try { r.group ??= UrlbarUtils.RESULT_GROUP.GENERAL_PARENT; } catch {}
          }
          // index 0 = the typed query's heuristic row; we go right below it.
          const at = context.results[0]?.heuristic ? 1 : 0;
          context.results.splice(at, 0, ...mine);
        }
        return ret;
      };
      muxer.__sineAltPatched = true;
    }
  }

  // ---------- per-window: handle Enter / click on our rows ----------
  function openExternal(app, url) {
    const exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    exe.initWithPath("/usr/bin/open"); // macOS
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(exe);
    const args = ["-a", app, url];
    proc.runw(false, args, args.length);
  }

  if (typeof gURLBar !== "undefined" && !gURLBar.__sineAltPatched) {
    const origPick = gURLBar.pickResult.bind(gURLBar);
    gURLBar.pickResult = function (result, event, ...rest) {
      if (result?.providerName !== PROVIDER_NAME) return origPick(result, event, ...rest);
      const url = result.payload.url;
      const entry = shared.entriesByUrl.get(url);
      gURLBar.view.close();
      try { gURLBar.handleRevert(); } catch {}
      if (entry?.app) {
        try { openExternal(entry.app, url); }
        catch (ex) { console.error("[AltSearch] failed to open " + entry.app, ex); }
      } else {
        const newTab = event && (event.metaKey || event.ctrlKey || event.button === 1);
        openTrustedLinkIn(url, newTab ? "tab" : "current");
      }
      return undefined;
    };
    gURLBar.__sineAltPatched = true;
  }
})();
