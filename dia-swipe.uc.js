// ==UserScript==
// @name           Dia Swipe
// @description    Dia-style swipe back/forward bubble with hold-to-scrub history list
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
  const ROW_STEP = 0.03; // swipe distance per row while scrubbing (~16px)
  const CANCEL_STEPS = 2; // rows to scrub above the top entry to cancel
  const LOW_EDGE = 0.04; // near the screen edge: auto-scroll down the list
  const HIGH_EDGE = 0.94; // far end of the swipe: auto-scroll up the list
  const EDGE_REPEAT_MS = 140;
  const RELEASE_SPEED = 2.0; // page-widths/sec; faster = lift-off animation
  const MAX_ROWS = 50;
  const ROW_H = 42; // keep in sync with .dia-swipe-row height in CSS
  const LIST_PAD = 6;
  const MAX_LIST_H = 380;

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
  // expose trackpad haptics to chrome JS. Patterns: 0 generic, 1 alignment,
  // 2 level change. Only fires on a Force Touch trackpad with fingers down.
  const HAPTIC_TICK = 1;
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
      { viewBox: "0 0 24 24", width: "22", height: "22", class: "dia-swipe-arrow" },
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

  // ---- Gesture state ------------------------------------------------------
  let s = null;

  function fresh() {
    return {
      root: null,
      bubble: null,
      list: null,
      height: 0,
      dir: null, // "back" | "forward" | null
      side: null, // "left" | "right"
      sign: 1, // sign of delta for the current direction
      mag: 0,
      armed: false,
      holding: false,
      stillAt: 0,
      holdTimer: 0,
      edgeTimer: 0,
      edgeDir: 0,
      entries: [],
      rows: [],
      anchor: 0,
      base: 0,
      sel: -1,
      samples: [],
      committed: false,
    };
  }
  let suppressUntil = 0;

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

  // The overlay is a fixed-position box laid exactly over the visible page,
  // so it doesn't depend on how Zen lays out the browser container.
  function mount() {
    const rect = gBrowser.selectedBrowser.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    s.list = h("div", { class: "dia-swipe-list" });
    s.bubble = h("div", { class: "dia-swipe-bubble" }, arrowIcon(), s.list);
    s.root = h("div", { class: "dia-swipe" }, s.bubble);
    Object.assign(s.root.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    s.height = rect.height;
    s.bubble.style.top = `${rect.height / 2 - 22}px`;
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
    const x = -60 + p * 84;
    const scale = 0.55 + p * 0.45;
    const signed = s.side === "right" ? -x : x;
    s.bubble.style.transform = `translateX(${signed}px) scale(${scale})`;
    s.bubble.style.opacity = String(Math.min(1, p * 1.6));
  }

  // ---- Hold: the bubble morphs into the history list ------------------------
  function scheduleHold() {
    clearTimeout(s.holdTimer);
    if (!boolPref("hold_list", true)) return;
    s.holdTimer = setTimeout(enterHold, HOLD_DELAY_MS);
  }

  function enterHold() {
    if (!s || !s.armed || s.holding) return;
    s.entries = historyEntries(s.dir);
    if (!s.entries.length) return;

    s.list.replaceChildren();
    s.rows = s.entries.map(entry => {
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
      s.list.appendChild(row);
      return row;
    });

    // Size the card and keep it on screen; it grows down from the bubble.
    const stackH = s.height;
    const listH = Math.min(s.rows.length * ROW_H + LIST_PAD * 2, MAX_LIST_H, stackH - 32);
    const bubbleTop = stackH / 2 - 22;
    const top = Math.max(16, Math.min(bubbleTop, stackH - 16 - listH));
    s.bubble.style.setProperty("--list-h", `${listH}px`);
    s.bubble.style.top = `${top}px`;

    setProgress(1);
    s.holding = true;
    s.anchor = s.mag;
    s.base = 0;
    s.root.setAttribute("holding", "true");
    buzz(HAPTIC_STRONG);
    select(0, true);
  }

  function select(i, silent) {
    if (i === s.sel) return;
    if (s.rows[s.sel]) s.rows[s.sel].removeAttribute("selected");
    s.sel = i;
    s.root.toggleAttribute("cancel", i < 0);
    if (s.rows[i]) {
      s.rows[i].setAttribute("selected", "true");
      s.rows[i].scrollIntoView({ block: "nearest" });
    }
    if (!silent) buzz(HAPTIC_TICK);
  }

  // Swiping back toward the screen edge moves down the list; swiping further
  // out moves up. Scrubbing past the top entry cancels.
  function recomputeSelection() {
    const moved = Math.round((s.anchor - s.mag) / ROW_STEP);
    const raw = Math.max(-CANCEL_STEPS, Math.min(s.rows.length - 1, s.base + moved));
    s.base = raw - moved; // don't let edge auto-scroll run past the ends
    select(raw < 0 ? (raw <= -CANCEL_STEPS ? -1 : 0) : raw);
  }

  function updateEdgeScroll() {
    const dirn = s.mag <= LOW_EDGE ? 1 : s.mag >= HIGH_EDGE ? -1 : 0;
    if (dirn === s.edgeDir) return;
    clearInterval(s.edgeTimer);
    s.edgeTimer = 0;
    s.edgeDir = dirn;
    if (!dirn) return;
    s.edgeTimer = setInterval(() => {
      if (!s || !s.holding) return;
      s.base += dirn;
      recomputeSelection();
      pushSample();
    }, EDGE_REPEAT_MS);
  }

  function pushSample() {
    s.samples.push({ t: performance.now(), mag: s.mag, sel: s.sel });
    if (s.samples.length > 30) s.samples.shift();
  }

  // When fingers lift, the tracker animates delta toward 0 or 1 quickly.
  // Use the selection from just before that burst so the list doesn't jump.
  function settledSelection() {
    const now = performance.now();
    const list = s.samples;
    for (let i = list.length - 1; i > 0; i--) {
      const a = list[i - 1];
      const b = list[i];
      const dt = (b.t - a.t) / 1000;
      const speed = dt > 0 ? Math.abs(b.mag - a.mag) / dt : 0;
      if (speed < RELEASE_SPEED || now - b.t > 450) return b.sel;
    }
    return list.length ? list[0].sel : s.sel;
  }

  function finishHold() {
    const sel = settledSelection();
    s.holding = false;
    clearInterval(s.edgeTimer);
    s.edgeTimer = 0;
    suppressUntil = performance.now() + 800;
    const entry = s.entries[sel];
    if (sel >= 0 && entry) {
      if (s.sel !== sel) select(sel, true);
      gBrowser.selectedBrowser.gotoIndex(entry.index);
      commit();
    }
  }

  // ---- Lifecycle ------------------------------------------------------------
  function teardown(delay = 0) {
    const g = s;
    if (!g) return;
    s = null;
    clearTimeout(g.holdTimer);
    clearInterval(g.edgeTimer);
    if (!g.root) return;
    setTimeout(() => {
      g.root.setAttribute("leaving", "true");
      setTimeout(() => g.root.remove(), 260);
    }, delay);
  }

  function commit() {
    if (!s || !s.root || s.committed) return;
    s.committed = true;
    s.root.setAttribute("committed", "true");
  }

  function begin() {
    teardown();
    s = fresh();
  }

  function update(e) {
    if (!s) s = fresh();

    if (s.holding) {
      // Measure along the original direction only; crossing zero clamps.
      s.mag = Math.max(0, e.delta * s.sign);
      recomputeSelection();
      updateEdgeScroll();
      pushSample();
      return;
    }

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
    s.sign = Math.sign(e.delta);

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
    if (s.holding) finishHold();
    // Leave a moment for a late MozSwipeGesture to mark the swipe committed.
    teardown(s.committed ? 120 : 60);
  }

  function onSwipeCommitted(e) {
    if ((s && s.holding) || performance.now() < suppressUntil) {
      // We navigate to the picked entry ourselves; stop Firefox's plain Back.
      e.preventDefault();
      e.stopPropagation();
      if (s && s.holding) finishHold();
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
      teardown();
    }
  }

  function dispatch(e) {
    switch (e.type) {
      case "MozSwipeGestureStart":
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
    }
  }

  const EVENTS = ["MozSwipeGestureStart", "MozSwipeGestureUpdate", "MozSwipeGestureEnd", "MozSwipeGesture"];

  function init() {
    // Window capture runs before Firefox's own handler on gBrowser.tabbox.
    for (const type of EVENTS) window.addEventListener(type, handleEvent, true);
    window.DiaSwipe = {
      buzz,
      uninit() {
        for (const type of EVENTS) window.removeEventListener(type, handleEvent, true);
        teardown();
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
