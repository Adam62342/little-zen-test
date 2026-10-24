// ==UserScript==
// @name           Dia Swipe
// @description    Dia-style swipe back/forward bubble; hold to open a history list
// @include        main
// ==/UserScript==

(function () {
  "use strict";
  if (window.DiaSwipe) return;

  // ---- Tuning -------------------------------------------------------------
  // Firefox's swipe tracker reports `delta` as a fraction of a page width.
  // It commits navigation at 0.25, so that's where the bubble "arms".
  const ARM_AT = 0.25;
  const HOLD_DELAY_MS = 380; // how long you must sit still to open the list
  const STILL_EPS = 0.02; // movement smaller than this counts as "holding"
  const MAX_ROWS = 50;
  const BUBBLE = 50; // keep in sync with .dia-swipe-bubble size in CSS
  const ROW_H = 46; // keep in sync with .dia-swipe-row height in CSS
  const LIST_PAD = 7;
  const MAX_LIST_H = 430;

  const BACK = "Browser:BackOrBackDuplicate";
  const FORWARD = "Browser:ForwardOrForwardDuplicate";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PREF = "mod.diaswipe.";

  const boolPref = (name, def) => {
    try {
      return Services.prefs.getBoolPref(PREF + name, def);
    } catch (e) {
      return def;
    }
  };

  // ---- Haptics ------------------------------------------------------------
  // macOS: call NSHapticFeedbackManager through js-ctypes, since Gecko doesn't
  // expose trackpad haptics to chrome JS. Pattern 2 = "level change".
  // Only fires on a Force Touch trackpad with fingers down.
  const HAPTIC_STRONG = 2;

  // Built lazily on first use so a ctypes problem can't affect startup.
  let haptic = null;
  function loadHaptic() {
    if (Services.appinfo.OS !== "Darwin") return () => {};
    try {
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
      const id = ctypes.voidptr_t;
      const getClass = objc.declare("objc_getClass", ctypes.default_abi, id, ctypes.char.ptr);
      const sel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
      const send = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id);
      const sendPerform = objc.declare(
        "objc_msgSend",
        ctypes.default_abi,
        ctypes.void_t,
        id,
        id,
        ctypes.long,
        ctypes.unsigned_long
      );
      const cls = getClass("NSHapticFeedbackManager");
      if (cls.isNull()) return () => {};
      const performer = send(cls, sel("defaultPerformer"));
      const perform = sel("performFeedbackPattern:performanceTime:");
      // performanceTime 1 = NSHapticFeedbackPerformanceTimeNow
      return pattern => sendPerform(performer, perform, pattern, 1);
    } catch (e) {
      console.warn("Dia Swipe: haptics unavailable", e);
      return () => {};
    }
  }

  const buzz = pattern => {
    if (!boolPref("haptics", true)) return;
    try {
      haptic ??= loadHaptic();
      haptic(pattern);
    } catch (e) {
      console.warn("Dia Swipe: haptic call failed, disabling", e);
      haptic = () => {};
    }
  };

  // ---- DOM helpers --------------------------------------------------------
  function h(tag, attrs = {}, ...children) {
    const ns = ["svg", "path"].includes(tag) ? SVG_NS : HTML_NS;
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  const arrowIcon = () =>
    h(
      "svg",
      { viewBox: "0 0 24 24", width: "26", height: "26", class: "dia-swipe-arrow" },
      h("path", {
        d: "M14.5 5.5 8 12l6.5 6.5",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );

  // ---- History ------------------------------------------------------------
  function historyEntries(dir) {
    const step = dir === "back" ? -1 : 1;
    const out = [];
    const sh = gBrowser.selectedBrowser.browsingContext?.sessionHistory;
    if (sh) {
      for (let i = sh.index + step; i >= 0 && i < sh.count && out.length < MAX_ROWS; i += step) {
        const e = sh.getEntryAtIndex(i);
        const url = e.URI?.spec ?? "";
        out.push({ index: i, title: e.title || url, url });
      }
      return out;
    }
    // Fallback when session history lives in the content process.
    try {
      const state = JSON.parse(SessionStore.getTabState(gBrowser.selectedTab));
      const cur = state.index - 1;
      for (let i = cur + step; i >= 0 && i < state.entries.length && out.length < MAX_ROWS; i += step) {
        const e = state.entries[i];
        out.push({ index: i, title: e.title || e.url, url: e.url });
      }
    } catch (e) {}
    return out;
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return "";
    }
  }

  // ---- State ----------------------------------------------------------------
  // `s` is the current swipe, and stays alive while its list is open.
  let s = null;
  let suppressUntil = 0;
  let gestureOutside = false; // current swipe started outside the web page

  // Only swipes over the web page count; the sidebar and toolbars are left to
  // Zen (e.g. its workspace-switching swipe).
  function overContent(e) {
    const panels = document.getElementById("tabbrowser-tabpanels") || gBrowser.tabpanels;
    if (!panels) return true;
    const t = e.target;
    if (t?.nodeType === Node.ELEMENT_NODE && t !== document.documentElement) {
      return panels.contains(t);
    }
    const r = panels.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  function fresh() {
    return {
      root: null,
      bubble: null,
      list: null,
      highlight: null,
      height: 0,
      dir: null, // "back" | "forward" | null
      side: null, // "left" | "right"
      mag: 0,
      armed: false,
      open: false, // history list is showing
      stillAt: 0,
      holdTimer: 0,
      entries: [],
      rows: [],
      sel: -1,
      committed: false,
    };
  }

  function directionFor(event, delta) {
    if (!delta) return null;
    const ltr = gHistorySwipeAnimation.isLTR;
    const swipeDir = (delta < 0) === ltr ? "right" : "left";
    const cmd = gGestureSupport._getCommand(event, ["swipe", swipeDir]);
    const nav = gBrowser.webNavigation;
    if (cmd === BACK && nav.canGoBack) return "back";
    if (cmd === FORWARD && nav.canGoForward && boolPref("forward", true)) return "forward";
    return null;
  }

  // ---- Bubble ---------------------------------------------------------------
  // The overlay is a fixed-position box laid exactly over the visible page,
  // so it doesn't depend on how Zen lays out the browser container.
  function mount() {
    const rect = gBrowser.selectedBrowser.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    s.list = h("div", { class: "dia-swipe-list" });
    s.bubble = h("div", { class: "dia-swipe-bubble", tabindex: "-1" }, arrowIcon(), s.list);
    s.root = h("div", { class: "dia-swipe" }, s.bubble);
    Object.assign(s.root.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    s.height = rect.height;
    s.bubble.style.top = `${rect.height / 2 - BUBBLE / 2}px`;
    (document.body || document.documentElement).appendChild(s.root);
    return true;
  }

  function setSide(dir) {
    const ltr = gHistorySwipeAnimation.isLTR;
    s.side = (dir === "back") === ltr ? "left" : "right";
    s.root.setAttribute("side", s.side);
    s.root.setAttribute("nav", dir);
  }

  function setProgress(p) {
    // Slide in from just off the edge, growing as it comes.
    const x = -66 + p * 92;
    const scale = 0.55 + p * 0.45;
    const signed = s.side === "right" ? -x : x;
    s.bubble.style.transform = `translateX(${signed}px) scale(${scale})`;
    s.bubble.style.opacity = String(Math.min(1, p * 1.6));
  }

  // ---- Hold: the bubble morphs into the history list ------------------------
  function scheduleHold() {
    clearTimeout(s.holdTimer);
    if (!boolPref("hold_list", true)) return;
    s.holdTimer = setTimeout(openList, HOLD_DELAY_MS);
  }

  function openList() {
    if (!s || !s.armed || s.open) return;
    s.entries = historyEntries(s.dir);
    if (!s.entries.length) return;

    s.list.replaceChildren();
    s.highlight = h("div", { class: "dia-swipe-highlight" });
    s.list.appendChild(s.highlight);
    s.rows = s.entries.map((entry, i) => {
      const icon = h("img", { class: "dia-swipe-favicon", src: "page-icon:" + entry.url, alt: "" });
      icon.addEventListener("error", () => icon.setAttribute("broken", "true"));
      const row = h(
        "div",
        { class: "dia-swipe-row" },
        icon,
        h(
          "div",
          { class: "dia-swipe-text" },
          h("div", { class: "dia-swipe-title" }, entry.title),
          h("div", { class: "dia-swipe-host" }, hostOf(entry.url))
        )
      );
      row.addEventListener("mousemove", () => select(i));
      row.addEventListener("click", () => go(i));
      s.list.appendChild(row);
      return row;
    });

    // Size the card and keep it on screen; it grows down from the bubble.
    const listH = Math.min(s.rows.length * ROW_H + LIST_PAD * 2, MAX_LIST_H, s.height - 32);
    const bubbleTop = s.height / 2 - BUBBLE / 2;
    const top = Math.max(16, Math.min(bubbleTop, s.height - 16 - listH));
    s.bubble.style.setProperty("--list-h", `${listH}px`);
    s.bubble.style.top = `${top}px`;

    setProgress(1);
    s.open = true;
    s.root.setAttribute("holding", "true");
    buzz(HAPTIC_STRONG);
    select(0);

    // Take keyboard focus for the arrow keys. Anything that moves focus away
    // (clicking the page, another tab, another app) closes the list.
    s.bubble.addEventListener("keydown", onKey);
    s.bubble.addEventListener("blur", () => close());
    s.bubble.focus({ preventScroll: true });
  }

  function select(i) {
    if (i === s.sel || !s.rows[i]) return;
    if (s.rows[s.sel]) s.rows[s.sel].removeAttribute("selected");
    s.sel = i;
    s.rows[i].setAttribute("selected", "true");
    // The highlight glides between rows instead of jumping.
    s.highlight.style.transform = `translateY(${LIST_PAD + i * ROW_H}px)`;
    scrollToRow(i);
  }

  function scrollToRow(i) {
    const list = s.list;
    const rowTop = LIST_PAD + i * ROW_H;
    const view = list.clientHeight;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop - LIST_PAD;
    else if (rowTop + ROW_H > list.scrollTop + view) list.scrollTop = rowTop + ROW_H + LIST_PAD - view;
  }

  function onKey(e) {
    if (!s || !s.open) return;
    const last = s.rows.length - 1;
    const keys = {
      ArrowDown: () => select(Math.min(last, s.sel + 1)),
      ArrowUp: () => select(Math.max(0, s.sel - 1)),
      Home: () => select(0),
      End: () => select(last),
      PageDown: () => select(Math.min(last, s.sel + 5)),
      PageUp: () => select(Math.max(0, s.sel - 5)),
      Enter: () => go(s.sel),
      Escape: () => close(),
    };
    e.preventDefault();
    e.stopPropagation();
    // Any other key counts as interacting with the page: just close.
    (keys[e.key] || close)();
  }

  function go(i) {
    const entry = s?.entries[i];
    if (!entry) return;
    gBrowser.selectedBrowser.gotoIndex(entry.index);
    commit();
    close(120);
  }

  // ---- Lifecycle ------------------------------------------------------------
  function close(delay = 0) {
    const g = s;
    if (!g) return;
    s = null;
    clearTimeout(g.holdTimer);
    if (!g.root) return;
    setTimeout(() => {
      g.root.setAttribute("leaving", "true");
      setTimeout(() => g.root.remove(), 260);
    }, delay);
    // Hand focus back to the page if the list still had it.
    if (g.open && document.activeElement === g.bubble) gBrowser.selectedBrowser.focus();
  }

  function commit() {
    if (!s || !s.root || s.committed) return;
    s.committed = true;
    s.root.setAttribute("committed", "true");
  }

  function begin() {
    close();
    s = fresh();
  }

  function update(e) {
    if (!s) s = fresh();
    if (gestureOutside) return;
    if (s.open) return; // the list is up; the swipe no longer matters

    const mag = Math.abs(e.delta);
    s.mag = mag;
    const dir = directionFor(e, e.delta);
    if (dir !== s.dir) {
      s.dir = dir;
      s.armed = false;
      clearTimeout(s.holdTimer);
      if (dir) {
        if (!s.root && !mount()) return;
        s.root.removeAttribute("armed");
        setSide(dir);
      }
    }
    if (!s.root) return;
    if (!dir) {
      setProgress(0);
      return;
    }

    setProgress(Math.min(mag / ARM_AT, 1));

    const armed = mag >= ARM_AT;
    if (armed !== s.armed) {
      s.armed = armed;
      s.root.toggleAttribute("armed", armed);
      if (armed) {
        buzz(HAPTIC_STRONG);
        s.stillAt = mag;
        scheduleHold();
      } else {
        clearTimeout(s.holdTimer);
      }
    } else if (armed && Math.abs(mag - s.stillAt) > STILL_EPS) {
      s.stillAt = mag;
      scheduleHold();
    }
  }

  function end() {
    if (!s) return;
    if (s.open) {
      // Fingers lifted with the list up: keep it open for clicks/keys.
      suppressUntil = performance.now() + 800;
      return;
    }
    // Leave a moment for a late MozSwipeGesture to mark the swipe committed.
    close(s.committed ? 120 : 60);
  }

  function onSwipeCommitted(e) {
    if (gestureOutside) return; // Firefox's own Back is blocked separately
    if ((s && s.open) || performance.now() < suppressUntil) {
      // The list is open: don't let Firefox go back on lift-off.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    commit();
  }

  // Never let an error here get in the way of Firefox's own swipe handling.
  function handleEvent(e) {
    try {
      dispatch(e);
    } catch (err) {
      console.error("Dia Swipe:", err);
      close();
    }
  }

  function dispatch(e) {
    switch (e.type) {
      case "MozSwipeGestureMayStart":
        gestureOutside = !overContent(e);
        break;
      case "MozSwipeGestureStart":
        gestureOutside = !overContent(e);
        begin();
        break;
      case "MozSwipeGestureUpdate":
        update(e);
        break;
      case "MozSwipeGestureEnd":
        end();
        break;
      case "MozSwipeGesture":
        onSwipeCommitted(e);
        break;
      case "TabSelect":
      case "resize":
        if (s?.open) close();
        break;
    }
  }

  const EVENTS = [
    "MozSwipeGestureMayStart",
    "MozSwipeGestureStart",
    "MozSwipeGestureUpdate",
    "MozSwipeGestureEnd",
    "MozSwipeGesture",
  ];

  // Stop Firefox's own swipe-to-go-back for swipes that started outside the
  // page. Patching this one method, rather than swallowing the swipe events,
  // leaves those events intact for Zen's sidebar gestures.
  let origProcessSwipe = null; // captured in init(), once the browser is ready
  function patchedProcessSwipe(aEvent, aDir) {
    if (gestureOutside) return;
    return origProcessSwipe.call(this, aEvent, aDir);
  }

  function init() {
    // Window capture runs before Firefox's own handler on gBrowser.tabbox.
    for (const type of EVENTS) window.addEventListener(type, handleEvent, true);
    window.addEventListener("resize", handleEvent);
    gBrowser.tabContainer.addEventListener("TabSelect", handleEvent);
    origProcessSwipe = gGestureSupport.processSwipeEvent;
    gGestureSupport.processSwipeEvent = patchedProcessSwipe;
    window.DiaSwipe = {
      buzz,
      uninit() {
        for (const type of EVENTS) window.removeEventListener(type, handleEvent, true);
        window.removeEventListener("resize", handleEvent);
        gBrowser.tabContainer.removeEventListener("TabSelect", handleEvent);
        gGestureSupport.processSwipeEvent = origProcessSwipe;
        close();
        delete window.DiaSwipe;
      },
    };
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const obs = subject => {
      if (subject !== window) return;
      Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
      init();
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
