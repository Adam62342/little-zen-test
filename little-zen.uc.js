// ==UserScript==
// @name            Little Zen
// @description     Arc-style "Little Arc" for Zen: external links open in a small
//                  floating macOS-style window, with swipe-back-to-close.
// @include         chrome://browser/content/browser.xhtml
// ==/UserScript==
//
// How it works, at a glance:
//   1. We wrap this window's `browserDOMWindow.openURI`. When the OS hands Zen a
//      link from another app, that call arrives with the OPEN_EXTERNAL flag. We
//      intercept it and ask Zen to open a brand-new window instead.
//   2. A global observer notices that new window finishing startup and "tags" it
//      as a little window: shrinks + centers it, strips the chrome, adds a small
//      toolbar, and wires up the swipe-to-close gesture.
//   3. On macOS, Firefox/Zen tracks the two-finger history swipe continuously and
//      emits MozSwipeGesture* events. When the little window can't go back any
//      further, we take over those events and animate the whole native window
//      sliding right + shrinking, then close it.

(function () {
  "use strict";

  const BROWSER_URL = "chrome://browser/content/browser.xhtml";
  const ATTR = "littlezen";

  const PREF = {
    enabled: "littlezen.enabled",
    swipe: "littlezen.swipe-to-close",
    escape: "littlezen.escape-to-close",
    dim: "littlezen.dim-inactive",
    backDir: "littlezen.back-direction",
    width: "littlezen.width",
    height: "littlezen.height",
    threshold: "littlezen.swipe-threshold",
  };

  // ---- small pref helpers (tolerant of missing prefs / string<->int) ----
  const getBool = (k, d) => {
    try { return Services.prefs.getBoolPref(k, d); } catch (_) { return d; }
  };
  const getStr = (k, d) => {
    try { return Services.prefs.getStringPref(k, d); } catch (_) { return d; }
  };
  const getNum = (k, d) => {
    try {
      const v = parseFloat(Services.prefs.getStringPref(k));
      if (!Number.isNaN(v)) return v;
    } catch (_) {}
    try { return Services.prefs.getIntPref(k); } catch (_) {}
    return d;
  };

  const log = (...a) => { try { console.log("[little-zen]", ...a); } catch (_) {} };
  const warn = (...a) => { try { console.warn("[little-zen]", ...a); } catch (_) {} };

  function isLittle(win) {
    try { return win.document.documentElement.getAttribute(ATTR) === "true"; }
    catch (_) { return false; }
  }
  function isWebURI(uri) {
    try { return uri && (uri.scheme === "http" || uri.scheme === "https"); }
    catch (_) { return false; }
  }
  function winRect(win) {
    return { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight };
  }

  // =====================================================================
  // 1. Intercept links opened from external applications
  // =====================================================================

  // The flags argument tells us whether the open came from another app.
  function isExternalOpenContext(flags) {
    try {
      return (
        (flags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL) !== 0 ||
        (typeof flags === "number" &&
          (flags & Ci.nsIWebNavigation.LOAD_FLAGS_FROM_EXTERNAL) !== 0)
      );
    } catch (_) {
      return false;
    }
  }

  // Open an EMPTY new browser window and stash what it should become. We can't
  // reliably hand the URL to openURI(OPEN_NEWWINDOW) — Zen lands the window on
  // its empty-tab state and the navigation is lost (hence the earlier blank
  // window). Instead we open the window, then load the URL ourselves once its
  // <browser> is ready (see loadIntoLittle), exactly like 12th-devs/little-zen.
  function openLittleWindow(url, principal) {
    let win = null;
    try {
      if (typeof window.OpenBrowserWindow === "function") {
        win = window.OpenBrowserWindow({});
      }
    } catch (e) {
      warn("OpenBrowserWindow failed, trying openDialog", e);
    }
    if (!win) {
      try {
        win = window.openDialog(BROWSER_URL, "_blank", "chrome,all,dialog=no");
      } catch (e) {
        warn("openDialog failed", e);
      }
    }
    if (win) {
      // Expando survives until the window's startup observer picks it up.
      win.__littleZenInit = { url, principal };
    }
    return win;
  }

  // `window.browserDOMWindow` is exposed across an XPCOM boundary, so you can't
  // reassign a method on it (that throws NS_ERROR_XPC_CANT_MODIFY_PROP_ON_WN).
  // The reliable fix — proven by 12th-devs/little-zen — is to REPLACE the whole
  // object with a plain JS wrapper that inherits from the original via __proto__
  // and overrides only the open methods, plus QueryInterface so XPConnect still
  // accepts it as an nsIBrowserDOMWindow.
  function hookBrowserDOMWindow() {
    if (window.__littleZenDOMWindowPatched) return;
    const original = window.browserDOMWindow;
    if (!original) {
      warn("no browserDOMWindow yet; skipping external-link hook");
      return;
    }

    const wrapper = {
      __proto__: original,

      openURI(aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aCsp) {
        try {
          if (getBool(PREF.enabled, true) && isExternalOpenContext(aFlags) && isWebURI(aURI)) {
            openLittleWindow(aURI.spec, aTriggeringPrincipal);
            return null;
          }
        } catch (e) {
          warn("openURI hook failed, falling back to default", e);
        }
        return original.openURI.call(original, aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aCsp);
      },

      openURIInFrame(aURI, aParams, aWhere, aFlags, aName) {
        try {
          if (getBool(PREF.enabled, true) && isExternalOpenContext(aFlags) && isWebURI(aURI)) {
            openLittleWindow(aURI.spec, aParams?.triggeringPrincipal);
            return null;
          }
        } catch (e) {
          warn("openURIInFrame hook failed, falling back to default", e);
        }
        return original.openURIInFrame
          ? original.openURIInFrame.call(original, aURI, aParams, aWhere, aFlags, aName)
          : null;
      },

      QueryInterface(iid) {
        if (iid.equals(Ci.nsIBrowserDOMWindow) || iid.equals(Ci.nsISupports)) {
          return this;
        }
        if (typeof original.QueryInterface === "function") {
          return original.QueryInterface(iid);
        }
        throw Components.Exception("", Components.results.NS_ERROR_NO_INTERFACE);
      },
    };

    window._littleZenOriginalBrowserDOMWindow = original;
    window.browserDOMWindow = wrapper;
    window.__littleZenDOMWindowPatched = true;
    log("external-link interception installed");
  }

  // Keep little windows out of "most recent window" lookups, so external links
  // and other chrome always route from a normal window.
  function patchBrowserWindowTracker() {
    try {
      const { BrowserWindowTracker } = ChromeUtils.importESModule(
        "resource:///modules/BrowserWindowTracker.sys.mjs"
      );
      if (BrowserWindowTracker.__littleZenPatched) return;
      const origGetTop = BrowserWindowTracker.getTopWindow.bind(BrowserWindowTracker);
      BrowserWindowTracker.getTopWindow = function (options = {}) {
        const top = origGetTop(options);
        if (!top || !isLittle(top)) return top;
        for (const w of BrowserWindowTracker.orderedWindows) {
          if (w !== top && !isLittle(w) && !w.closed) return w;
        }
        return top;
      };
      BrowserWindowTracker.__littleZenPatched = true;
    } catch (e) {
      warn("getTopWindow patch failed", e);
    }
  }

  // =====================================================================
  // 2. Tag + shape the newly-opened window
  // =====================================================================
  const windowObserver = {
    observe(subject, topic) {
      if (topic !== "browser-delayed-startup-finished") return;
      const win = subject;
      try {
        if (!win || win === window || !win.__littleZenInit) return;
        const { url, principal } = win.__littleZenInit;
        delete win.__littleZenInit;
        makeLittle(win);
        loadIntoLittle(win, url, principal);
      } catch (e) {
        warn("failed to shape little window", e);
      }
    },
  };

  function makeLittle(win) {
    const de = win.document.documentElement;
    de.setAttribute(ATTR, "true");

    const w = Math.max(360, Math.round(getNum(PREF.width, 480)));
    const h = Math.max(400, Math.round(getNum(PREF.height, 640)));
    try {
      const availW = win.screen.availWidth;
      const availH = win.screen.availHeight;
      const x = Math.round((availW - w) / 2);
      const y = Math.round((availH - h) / 3); // sit a little above dead-center
      win.resizeTo(w, h);
      win.moveTo(Math.max(0, x), Math.max(0, y));
    } catch (e) {
      warn("could not size/position little window", e);
    }

    positionLittleWindowNavbar(win);
    injectChrome(win);
    installSwipeToClose(win);
    installKeyAndFocus(win);
    log("little window ready");
  }

  // Relocate the nav/URL bar above the page content and pull back/forward/reload
  // in front of it, so once CSS hides the vertical-tab sidebar the little window
  // still has a usable top toolbar. Mirrors 12th-devs/little-zen. Sets a marker
  // attribute so the stylesheet knows the relocation succeeded.
  function positionLittleWindowNavbar(win) {
    const d = win.document;
    let moved = false;
    try {
      const navBar = d.getElementById("nav-bar");
      const navContainer = d.getElementById("zen-appcontent-navbar-container");
      if (navBar && navContainer) {
        if (navBar.parentElement !== navContainer) navContainer.appendChild(navBar);
        moved = true;
      }
      const target = d.getElementById("nav-bar-customization-target");
      const urlbar = d.getElementById("urlbar-container");
      if (target && urlbar && urlbar.parentElement === target) {
        for (const id of ["back-button", "forward-button", "stop-reload-button"]) {
          const item = d.getElementById(id);
          if (item) target.insertBefore(item, urlbar);
        }
      }
    } catch (e) {
      warn("navbar reposition failed", e);
    }
    try { d.documentElement.toggleAttribute("littlezen-navbar-moved", moved); } catch (_) {}
  }

  // Load the external URL once the fresh window has a <browser> to load into.
  function loadIntoLittle(win, url, principal) {
    if (!url) return;
    const tp = principal || Services.scriptSecurityManager.getSystemPrincipal();
    const loadFlags =
      Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP ??
      Ci.nsIWebNavigation.LOAD_FLAGS_NONE;

    const attempt = (n) => {
      if (win.closed) return;
      const browser = win.gBrowser && win.gBrowser.selectedBrowser;
      if (!browser || !browser.browsingContext) {
        if (n < 40) win.setTimeout(() => attempt(n + 1), 50);
        else warn("gave up waiting for little window browser");
        return;
      }
      try {
        browser.browsingContext.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: tp,
          loadFlags,
        });
        log("loaded into little window", url);
      } catch (e) {
        warn("load into little window failed", e);
      }
    };
    attempt(0);
  }

  // =====================================================================
  // Injected toolbar: "Open in Zen" (promote) + close
  // =====================================================================
  function injectChrome(win) {
    const doc = win.document;
    if (doc.getElementById("littlezen-bar")) return;

    const bar = doc.createXULElement("hbox");
    bar.id = "littlezen-bar";
    bar.setAttribute("align", "center");

    const promote = doc.createXULElement("toolbarbutton");
    promote.id = "littlezen-promote";
    promote.classList.add("littlezen-btn");
    promote.setAttribute("label", "Open in Zen");
    promote.setAttribute("tooltiptext", "Move this page into your main Zen window");
    const doPromote = (e) => { e && e.stopPropagation(); promoteToMain(win); };
    promote.addEventListener("command", doPromote);
    promote.addEventListener("click", doPromote);

    const close = doc.createXULElement("toolbarbutton");
    close.id = "littlezen-close";
    close.classList.add("littlezen-btn");
    close.setAttribute("label", "✕");
    close.setAttribute("tooltiptext", "Close this little window (Esc)");
    const doClose = (e) => { e && e.stopPropagation(); animateClose(win, winRect(win)); };
    close.addEventListener("command", doClose);
    close.addEventListener("click", doClose);

    bar.appendChild(promote);
    bar.appendChild(close);
    doc.documentElement.appendChild(bar);
  }

  function promoteToMain(win) {
    try {
      const { BrowserWindowTracker } = ChromeUtils.importESModule(
        "resource:///modules/BrowserWindowTracker.sys.mjs"
      );
      let target = null;
      for (const w of BrowserWindowTracker.orderedWindows) {
        if (w !== win && !isLittle(w) && w.gBrowser) { target = w; break; }
      }
      if (!target) {
        // Nothing to promote into — just turn this into a normal window.
        win.document.documentElement.removeAttribute(ATTR);
        try { win.resizeTo(1100, 760); } catch (_) {}
        return;
      }
      const tab = win.gBrowser.selectedTab;
      target.gBrowser.adoptTab(tab, {
        tabIndex: target.gBrowser.tabs.length,
        selectTab: true,
      });
      try { target.focus(); } catch (_) {}
      // The little window held a single tab; adopting it empties the window.
      try { win.close(); } catch (_) {}
    } catch (e) {
      warn("promote to main failed", e);
    }
  }

  // =====================================================================
  // 3. Swipe-back-to-close + native window animation
  // =====================================================================
  function installSwipeToClose(win) {
    if (!getBool(PREF.swipe, true)) return;

    let active = false;      // true once we've claimed the current swipe
    let startRect = null;
    let rafId = 0;
    let latestFrac = 0;

    const backIsRight = getStr(PREF.backDir, "right") !== "left";

    const canGoBack = () => {
      try { return !!win.gBrowser.selectedBrowser.canGoBack; } catch (_) { return false; }
    };
    const dirIsBack = (e) => {
      try {
        return backIsRight
          ? e.direction === e.DIRECTION_RIGHT
          : e.direction === e.DIRECTION_LEFT;
      } catch (_) { return false; }
    };

    // Follow-the-finger: nudge the real window right + a touch smaller.
    const applyFrac = (frac) => {
      if (!startRect) return;
      const f = Math.max(0, Math.min(1, frac));
      const shrink = 0.12 * f;
      const w = Math.round(startRect.w * (1 - shrink));
      const h = Math.round(startRect.h * (1 - shrink));
      const slide = Math.round(startRect.w * 0.18 * f);
      const x = startRect.x + slide + Math.round((startRect.w - w) / 2);
      const y = startRect.y + Math.round((startRect.h - h) / 2);
      try {
        win.resizeTo(w, h);
        win.moveTo(x, y);
        win.document.documentElement.style.opacity = String(1 - 0.25 * f);
      } catch (_) {}
    };
    const scheduleFrame = () => {
      if (rafId) return;
      rafId = win.requestAnimationFrame(() => { rafId = 0; applyFrac(latestFrac); });
    };

    const onStart = (e) => {
      active = false;
      if (!isLittle(win)) return;
      if (canGoBack()) return;          // let real "back" navigation happen
      if (!dirIsBack(e)) return;        // only the back direction dismisses
      try {
        // Tell the OS this direction is navigable so we keep getting updates
        // instead of a hard rubber-band stop.
        e.allowedDirections |= backIsRight ? e.DIRECTION_RIGHT : e.DIRECTION_LEFT;
      } catch (_) {}
      active = true;
      startRect = winRect(win);
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    const onUpdate = (e) => {
      if (!active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      latestFrac = Math.abs(e.delta || 0);
      scheduleFrame();
    };

    const finish = (commit) => {
      active = false;
      if (!startRect) return;
      const r = startRect;
      startRect = null;
      if (commit) animateClose(win, r);
      else animateSnapBack(win, r);
    };

    const onEnd = (e) => {
      if (!active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const threshold = getNum(PREF.threshold, 0.25);
      finish(Math.abs(e.delta || 0) >= threshold);
    };

    // Fired when the OS recognizes a complete swipe (some builds skip Update).
    const onSwipe = (e) => {
      if (active) {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(true);
        return;
      }
      if (!isLittle(win) || canGoBack() || !dirIsBack(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      animateClose(win, winRect(win));
    };

    win.addEventListener("MozSwipeGestureStart", onStart, true);
    win.addEventListener("MozSwipeGestureUpdate", onUpdate, true);
    win.addEventListener("MozSwipeGestureEnd", onEnd, true);
    win.addEventListener("MozSwipeGesture", onSwipe, true);
  }

  function installKeyAndFocus(win) {
    if (getBool(PREF.escape, true)) {
      win.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Escape" && isLittle(win)) {
            animateClose(win, winRect(win));
          }
        },
        true
      );
    }
    if (getBool(PREF.dim, true)) {
      const de = win.document.documentElement;
      win.addEventListener("deactivate", () => {
        try { de.setAttribute("littlezen-inactive", "true"); } catch (_) {}
      });
      win.addEventListener("activate", () => {
        try { de.removeAttribute("littlezen-inactive"); } catch (_) {}
      });
    }
  }

  // ---- shared native-window geometry tween ----
  function animateGeom(win, from, to, dur, done) {
    let start = 0;
    const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
    const frame = (now) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / dur);
      const e = easeOutCubic(p);
      const w = Math.round(from.w + (to.w - from.w) * e);
      const h = Math.round(from.h + (to.h - from.h) * e);
      const x = Math.round(from.x + (to.x - from.x) * e);
      const y = Math.round(from.y + (to.y - from.y) * e);
      const o = from.o + (to.o - from.o) * e;
      try {
        win.resizeTo(w, h);
        win.moveTo(x, y);
        win.document.documentElement.style.opacity = String(o);
      } catch (_) {}
      if (p < 1) win.requestAnimationFrame(frame);
      else if (done) done();
    };
    win.requestAnimationFrame(frame);
  }

  function animateClose(win, r) {
    const curOpacity = parseFloat(win.document.documentElement.style.opacity || "1");
    const from = { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight, o: curOpacity };
    const to = {
      w: Math.round(r.w * 0.72),
      h: Math.round(r.h * 0.72),
      x: r.x + Math.round(r.w * 0.42), // slide clearly to the right
      y: r.y + Math.round(r.h * 0.14),
      o: 0,
    };
    animateGeom(win, from, to, 220, () => { try { win.close(); } catch (_) {} });
  }

  function animateSnapBack(win, r) {
    const curOpacity = parseFloat(win.document.documentElement.style.opacity || "1");
    const from = { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight, o: curOpacity };
    animateGeom(win, from, { x: r.x, y: r.y, w: r.w, h: r.h, o: 1 }, 180);
  }

  // =====================================================================
  // Boot
  // =====================================================================
  function init() {
    try { hookBrowserDOMWindow(); } catch (e) { warn("init hook failed", e); }
    try { patchBrowserWindowTracker(); } catch (e) { warn("init tracker patch failed", e); }
    Services.obs.addObserver(windowObserver, "browser-delayed-startup-finished");
    window.addEventListener(
      "unload",
      () => {
        try { Services.obs.removeObserver(windowObserver, "browser-delayed-startup-finished"); }
        catch (_) {}
      },
      { once: true }
    );
  }

  if (typeof gBrowserInit !== "undefined" && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const startupObserver = {
      observe(subject, topic) {
        if (subject === window && topic === "browser-delayed-startup-finished") {
          Services.obs.removeObserver(startupObserver, topic);
          init();
        }
      },
    };
    Services.obs.addObserver(startupObserver, "browser-delayed-startup-finished");
  }
})();
