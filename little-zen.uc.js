// Little Zen — Arc-style "Little Arc" for Zen Browser.
// Runs in every browser window's chrome scope (window, document, gBrowser,
// Services, Ci, Cc, ChromeUtils are available).

(() => {
  "use strict";

  if (window.__littleZen) return;
  window.__littleZen = { version: "1.1.0" };

  const HTML = "http://www.w3.org/1999/xhtml";
  const PREFIX = "little-zen-";
  const PREF = {
    external: "mod.littlezen.external_links",
    swipe: "mod.littlezen.swipe_to_close",
    width: "mod.littlezen.width",
    height: "mod.littlezen.height",
  };

  const root = document.documentElement;
  const log = (...args) => console.log("[Little Zen]", ...args);

  // ---------------------------------------------------------------- helpers
  const getBool = (name, fallback) => {
    try { return Services.prefs.getBoolPref(name, fallback); } catch { return fallback; }
  };
  const getNum = (name, fallback) => {
    let v;
    try { v = Number(Services.prefs.getStringPref(name, "")); } catch { /* not a string pref */ }
    if (!v) { try { v = Services.prefs.getIntPref(name, 0); } catch { v = 0; } }
    return Number.isFinite(v) && v >= 320 ? v : fallback;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
  );
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );

  const isLittleWindow = w => {
    try { return w.document.documentElement.hasAttribute("littlezen"); } catch { return false; }
  };

  // The opener leaves a note on its own window object; the new window finds it.
  // (window.name is not reliable for chrome windows.)
  function claimLittle() {
    try { if (window.name && window.name.startsWith(PREFIX)) return true; } catch { /* ignore */ }

    let spec = null;
    try {
      const a0 = window.arguments && window.arguments[0];
      spec = typeof a0 === "string" ? a0 : (a0 && a0.data) || null;
    } catch { /* ignore */ }

    const candidates = [];
    try { if (window.opener) candidates.push(window.opener); } catch { /* ignore */ }
    try {
      for (const w of Services.wm.getEnumerator(null)) if (w !== window) candidates.push(w);
    } catch { /* ignore */ }

    for (const w of candidates) {
      let pending;
      try { pending = w.__littleZenPending; } catch { continue; }
      if (!Array.isArray(pending)) continue;
      const i = pending.findIndex(p => Date.now() - p.time < 10000 && (!spec || p.spec === spec));
      if (i !== -1) {
        pending.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  const isLittle = claimLittle();
  log("script loaded in", isLittle ? "LITTLE window" : "normal window");

  // Mark the window immediately so the full Zen UI never flashes.
  if (isLittle) {
    root.setAttribute("littlezen", "");
    root.setAttribute("lz-entering", "");
    setTimeout(() => root.removeAttribute("lz-entering"), 600);
  }

  function findMainWindow() {
    return BrowserWindowTracker.orderedWindows.find(
      w => !w.closed && w !== window && !isLittleWindow(w) && !PrivateBrowsingUtils.isWindowPrivate(w)
    ) || null;
  }

  // ------------------------------------------------- opening a little window
  function openLittle(spec) {
    // Already inside a little window: just navigate it.
    if (isLittle) {
      openTrustedLinkIn(spec, "current");
      window.focus();
      return;
    }

    const W = getNum(PREF.width, 1000);
    const H = getNum(PREF.height, 700);
    const s = window.screen;
    const left = Math.round((s.availLeft || 0) + (s.availWidth - W) / 2);
    const top = Math.round((s.availTop || 0) + (s.availHeight - H) / 3);

    const token = PREFIX + Date.now();
    (window.__littleZenPending ||= []).push({ token, spec, time: Date.now() });

    // Deliberately NOT "all": this produces a tabless, popup-style browser
    // window, which Zen keeps out of its tab/window sync.
    const features = [
      "chrome", "dialog=no", "titlebar", "close", "resizable", "minimizable", "scrollbars",
      `width=${W}`, `height=${H}`, `left=${left}`, `top=${top}`,
    ].join(",");

    const chromeURL = AppConstants.BROWSER_CHROME_URL || "chrome://browser/content/browser.xhtml";
    const win = window.openDialog(chromeURL, token, features, spec);
    win?.focus();
    log("opened little window", token, spec);
  }

  // Intercept links handed to us by other apps (Mail, Slack, Terminal, ...).
  // Firefox's BrowserDOMWindow methods are read-only, so instead of patching
  // them we swap in a delegate that forwards everything to the original and
  // only intercepts openURI.
  function hookExternalLinks(attempt = 0) {
    const original = window.browserDOMWindow;
    if (!original) {
      if (attempt < 20) setTimeout(() => hookExternalLinks(attempt + 1), 500);
      else log("window.browserDOMWindow never appeared; external links NOT hooked");
      return;
    }
    if (original.__lz) {
      log("hook already present");
      return;
    }

    const delegate = {
      QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),
      __lz: true,
    };
    const seen = new Set(["constructor", "QueryInterface", "__lz"]);
    for (let o = original; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const key of Reflect.ownKeys(o)) {
        if (typeof key !== "string" || seen.has(key)) continue;
        seen.add(key);
        const desc = Object.getOwnPropertyDescriptor(o, key);
        if (!desc) continue;
        if (typeof desc.value === "function") {
          delegate[key] = (...args) => original[key](...args);
        } else if (desc.get || desc.set) {
          Object.defineProperty(delegate, key, {
            enumerable: true,
            get: () => original[key],
            set: v => { original[key] = v; },
          });
        }
      }
    }

    delegate.openURI = function (uri, ...rest) {
      try {
        const [, where, flags] = rest;
        const external = !!(flags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL);
        log("openURI", uri?.spec, "where:", where, "flags:", flags, "external:", external);

        if (uri && external && (uri.schemeIs("http") || uri.schemeIs("https"))) {
          const top = BrowserWindowTracker.getTopWindow({ allowPopups: true });
          const api = top && !top.closed ? top.__littleZen : null;
          if (!api?.open) {
            log("no Little Zen API on the frontmost window; falling back");
          } else if (!api.enabled()) {
            log("external links disabled by pref; falling back");
          } else if (PrivateBrowsingUtils.isWindowPrivate(top)) {
            log("private window; falling back");
          } else {
            log("opening in Little Zen window:", uri.spec);
            api.open(uri.spec);
            return null;
          }
        }
      } catch (e) {
        console.error("[Little Zen] external link hook failed:", e, e?.stack);
      }
      return original.openURI(uri, ...rest);
    };
    delegate.openURI.__lz = true;

    window.browserDOMWindow = delegate;
    log("external link hook installed");
  }

  // ------------------------------------------------------------ little window
  let closing = false;

  async function closeAnimated() {
    if (closing) return;
    closing = true;
    root.removeAttribute("lz-swiping");
    root.setAttribute("lz-closing", "");
    await wait(280);
    window.close();
    // If something vetoed the close (e.g. beforeunload), recover gracefully.
    await wait(500);
    if (!window.closed) {
      closing = false;
      root.removeAttribute("lz-closing");
      settle();
    }
  }

  function openInMainWindow() {
    const spec = gBrowser.currentURI.spec;
    const main = findMainWindow();
    if (main) {
      main.openTrustedLinkIn(spec, "tab", { inBackground: false });
      main.focus();
    } else {
      window.openDialog("chrome://browser/content/browser.xhtml", "_blank", "chrome,all,dialog=no", spec);
    }
    closeAnimated();
  }

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElementNS(HTML, tag);
    for (const [k, v] of Object.entries(props)) n.setAttribute(k, v);
    n.append(...kids);
    return n;
  };

  function navigate(text) {
    try {
      gBrowser.fixupAndLoadURIString(text, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch {
      openTrustedLinkIn(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text, "current");
    }
  }

  function buildBar() {
    const lock = el("span", { id: "lz-lock" });
    const host = el("span", { id: "lz-host" });
    const input = el("input", {
      id: "lz-input", type: "text", spellcheck: "false", autocomplete: "off",
    });
    const pill = el("div", { id: "lz-pill", title: "Click to edit address" }, lock, host, input);
    const open = el("div", { id: "lz-open", class: "lz-btn", role: "button", title: "Open in main window" });
    const bar = el("div", { id: "lz-bar" },
      el("div", { id: "lz-traffic" }), pill, open, el("div", { id: "lz-progress" }));

    document.body.prepend(bar);
    root.appendChild(el("div", { id: "lz-hint" }));

    open.addEventListener("click", openInMainWindow);

    const stopEdit = () => pill.removeAttribute("editing");
    pill.addEventListener("click", () => {
      if (pill.hasAttribute("editing")) return;
      pill.setAttribute("editing", "");
      input.value = gBrowser.currentURI.spec;
      input.focus();
      input.select();
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim();
        stopEdit();
        if (text) navigate(text);
        gBrowser.selectedBrowser.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        stopEdit();
        gBrowser.selectedBrowser.focus();
      }
    });
    input.addEventListener("blur", stopEdit);

    const refresh = loc => {
      const uri = loc || gBrowser.currentURI;
      let text = uri.spec, secure = false;
      try {
        if (uri.schemeIs("http") || uri.schemeIs("https")) {
          text = uri.host.replace(/^www\./, "");
          secure = uri.schemeIs("https");
        }
      } catch { /* keep spec */ }
      host.textContent = text === "about:blank" ? "Loading…" : text;
      pill.toggleAttribute("secure", secure);
    };

    const noop = () => {};
    const L = Ci.nsIWebProgressListener;
    gBrowser.addProgressListener({
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange(wp, req, loc) {
        if (!wp.isTopLevel) return;
        refresh(loc);
      },
      onStateChange(wp, req, flags) {
        if (!wp.isTopLevel || !(flags & L.STATE_IS_NETWORK)) return;
        if (flags & L.STATE_START) bar.setAttribute("loading", "");
        else if (flags & L.STATE_STOP) bar.removeAttribute("loading");
      },
      onProgressChange: noop,
      onProgressChange64: noop,
      onStatusChange: noop,
      onSecurityChange: noop,
      onContentBlockingEvent: noop,
    });

    refresh();
  }

  // On a popup-style window macOS may draw a native titlebar; then we don't
  // need to leave room for the traffic lights inside our bar.
  function watchTitlebar() {
    const check = () =>
      root.toggleAttribute("lz-native-titlebar", window.outerHeight - window.innerHeight > 12);
    check();
    setTimeout(check, 400);
    window.addEventListener("resize", check);
  }

  // Belt and braces: inline !important beats Zen re-showing things on hover.
  function hideZenChrome() {
    for (const id of [
      "navigator-toolbox", "zen-appcontent-navbar-container", "zen-sidebar-splitter",
      "zen-sidebar-web-panel", "sidebar-main", "sidebar-box",
    ]) {
      document.getElementById(id)?.style.setProperty("display", "none", "important");
    }
  }

  // ------------------------------------------------ swipe-to-close animation
  const ease = x => 1 - (1 - x) * (1 - x);

  function beginDrag() {
    root.removeAttribute("lz-settling");
    root.setAttribute("lz-swiping", "");
  }
  function drag(p) {
    // The native swipe commits at roughly 25% travel; reach full visual
    // effect a bit past that so the motion stays subtle but readable.
    const visual = ease(Math.min(1, p / 0.45));
    root.style.setProperty("--lz-p", visual.toFixed(4));
    root.toggleAttribute("lz-armed", p >= 0.25);
  }
  function settle() {
    root.setAttribute("lz-settling", "");
    root.removeAttribute("lz-armed");
    root.style.setProperty("--lz-p", "0");
    setTimeout(() => {
      root.removeAttribute("lz-settling");
      root.removeAttribute("lz-swiping");
    }, 480);
  }

  function setupSwipe() {
    let s = null;

    window.addEventListener("MozSwipeGestureMayStart", e => {
      s = null;
      if (closing || !getBool(PREF.swipe, true) || gBrowser.canGoBack) return; // native back handles it
      if (e.direction !== e.DIRECTION_LEFT) return;
      e.allowedDirections |= e.direction; // opt in to the gesture even with no history
      s = { committed: false };
    }, true);

    window.addEventListener("MozSwipeGestureStart", e => {
      if (!s) return;
      e.stopImmediatePropagation();
      beginDrag();
    }, true);

    window.addEventListener("MozSwipeGestureUpdate", e => {
      if (!s) return;
      e.stopImmediatePropagation();
      drag(Math.min(1, Math.abs(e.delta)));
    }, true);

    window.addEventListener("MozSwipeGesture", e => {
      if (!s) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.direction === e.DIRECTION_LEFT) {
        s.committed = true;
        root.setAttribute("lz-settling", "");
        root.style.setProperty("--lz-p", "1");
        closeAnimated();
      }
    }, true);

    window.addEventListener("MozSwipeGestureEnd", e => {
      if (!s) return;
      e.stopImmediatePropagation();
      const current = s;
      // Small grace period in case End is delivered just before the commit.
      setTimeout(() => {
        if (!current.committed && !closing) settle();
        if (s === current) s = null;
      }, 60);
    }, true);
  }

  // Cmd+[ with nothing to go back to closes the window too.
  function setupKeys() {
    window.addEventListener("keydown", e => {
      if (
        e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey &&
        e.code === "BracketLeft" && !gBrowser.canGoBack
      ) {
        e.preventDefault();
        e.stopPropagation();
        closeAnimated();
      }
    }, true);
  }

  // The tab strip is hidden, so a stray second tab (target=_blank) would be
  // invisible. Send tabs the user just opened (selected ones) to the main
  // window. Tabs mirrored in by Zen's window sync are not selected, so they
  // are left alone.
  function setupTabGuard() {
    setTimeout(() => {
      gBrowser.tabContainer.addEventListener("TabOpen", e => {
        const tab = e.target;
        setTimeout(() => {
          if (!tab.selected || gBrowser.tabs.length < 2) return;
          const main = findMainWindow();
          if (!main) return;
          try {
            main.gBrowser.adoptTab(tab, { selectTab: true });
            main.focus();
          } catch (err) {
            console.error("[Little Zen] could not move tab", err);
          }
        }, 50);
      });
    }, 1500);
  }

  function initLittle() {
    buildBar();
    hideZenChrome();
    watchTitlebar();
    setupSwipe();
    setupKeys();
    setupTabGuard();

    // Diagnostics: if Zen's window sync still mirrors tabs in here, this shows it.
    setTimeout(() => {
      log("little window tab count:", gBrowser.tabs.length,
          "| toolbar.visible:", window.toolbar?.visible,
          "| body children:", [...document.body.children].map(c => c.id || c.localName).join(", "));
    }, 1500);
  }

  // ------------------------------------------------------------------ start
  const start = () => {
    window.__littleZen.open = openLittle;
    window.__littleZen.enabled = () => getBool(PREF.external, true);
    try { hookExternalLinks(); } catch (e) { console.error("[Little Zen] hook failed:", e, e?.stack); }
    if (isLittle) {
      try { initLittle(); } catch (e) { console.error("[Little Zen] init failed:", e, e?.stack); }
    }
  };

  if (window.gBrowserInit?.delayedStartupFinished) {
    start();
  } else {
    const observer = {
      observe(subject, topic) {
        if (subject !== window) return;
        Services.obs.removeObserver(observer, topic);
        start();
      },
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
})();
