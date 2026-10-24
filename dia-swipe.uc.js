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

  // Scrubbing works like a trackpad cursor: slow movement is precise, faster
  // movement covers more rows. Speeds are in page-widths per second.
  const ROW_STEP = 0.035; // swipe distance per row at slow speed (~19px)
  const ACCEL_FROM = 0.15; // below this speed there's no acceleration
  const ACCEL = 2.5; // extra gain per unit of speed above ACCEL_FROM
  const ACCEL_MAX = 3; // gain tops out at 1 + ACCEL_MAX
  const HYSTERESIS = 0.08; // extra fraction of a row to cross before switching
  const CANCEL_STEPS = 2; // rows to scrub above the top entry to cancel

  // Resting near either end of the swipe range keeps scrolling, faster the
  // deeper you push.
  const LOW_EDGE = 0.06; // near the screen edge: scroll down the list
  const HIGH_EDGE = 0.92; // far end of the swipe: scroll up the list
  const EDGE_DWELL_MS = 150;
  const EDGE_RATE_MIN = 5; // rows/sec at the start of the edge zone
  const EDGE_RATE_MAX = 16; // rows/sec at the very end

  const RELEASE_SPEED = 2.0; // faster than this is the lift-off snap; ignored
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
      edgeRaf: 0,
      edgeDwell: 0,
      edgeDir: 0,
      edgeT: 0,
      pos: 0, // continuous scrub position, in rows
      slot: 0, // row the highlight sits on (may be negative = cancel zone)
      lastMag: 0,
      lastT: 0,
      listH: 0,
      highlight: null,
      entries: [],
      rows: [],
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
    s.holdTimer = setTimeout(enterHold, HOLD_DELAY_MS);
  }

  function enterHold() {
    if (!s || !s.armed || s.holding) return;
    s.entries = historyEntries(s.dir);
    if (!s.entries.length) return;

    s.list.replaceChildren();
    s.highlight = h("div", { class: "dia-swipe-highlight" });
    s.list.appendChild(s.highlight);
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
    const bubbleTop = stackH / 2 - BUBBLE / 2;
    const top = Math.max(16, Math.min(bubbleTop, stackH - 16 - listH));
    s.listH = listH;
    s.bubble.style.setProperty("--list-h", `${listH}px`);
    s.bubble.style.top = `${top}px`;

    setProgress(1);
    s.holding = true;
    s.pos = 0;
    s.slot = 0;
    s.lastMag = s.mag;
    s.lastT = performance.now();
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
      // The highlight glides between rows instead of jumping.
      s.highlight.style.transform = `translateY(${LIST_PAD + i * ROW_H}px)`;
    }
    if (!silent) buzz(HAPTIC_TICK);
  }

  // Keep the scrub position comfortably inside the visible part of the list.
  // Driven by the continuous position, so the list moves with your fingers.
  // Uses known row geometry because the card is still growing at first.
  function followScroll() {
    const list = s.list;
    const view = s.listH;
    const center = LIST_PAD + (Math.max(0, s.pos) + 0.5) * ROW_H;
    const margin = Math.min(ROW_H * 1.5, view / 2 - ROW_H / 2);
    const max = Math.max(0, LIST_PAD * 2 + s.rows.length * ROW_H - view);
    let target = list.scrollTop;
    if (center - margin < target) target = center - margin;
    else if (center + margin > target + view) target = center + margin - view;
    list.scrollTop = Math.max(0, Math.min(target, max));
  }

  // Swiping back toward the screen edge moves down the list; swiping further
  // out moves up. Scrubbing past the top entry cancels.
  function movePos(rows) {
    const lo = -CANCEL_STEPS;
    const hi = s.rows.length - 1;
    // Clamping the position itself means reversing responds immediately.
    s.pos = Math.max(lo, Math.min(hi, s.pos + rows));
    // Only change rows once clearly past the midpoint, so a finger resting on
    // a boundary doesn't flicker between two rows.
    if (Math.abs(s.pos - s.slot) > 0.5 + HYSTERESIS) {
      s.slot = Math.max(lo, Math.min(hi, Math.round(s.pos)));
    }
    select(s.slot < 0 ? (s.slot <= lo ? -1 : 0) : s.slot);
    followScroll();
    pushSample();
  }

  function onHoldMove(mag) {
    const now = performance.now();
    const dm = mag - s.lastMag;
    const dt = Math.max(4, now - s.lastT) / 1000;
    s.lastMag = mag;
    s.lastT = now;
    s.mag = mag;
    updateEdgeScroll();

    const speed = Math.abs(dm) / dt;
    if (speed > RELEASE_SPEED) return; // the lift-off snap, not your fingers
    const gain = 1 + Math.min(ACCEL_MAX, Math.max(0, speed - ACCEL_FROM) * ACCEL);
    movePos((-dm / ROW_STEP) * gain);
  }

  // Continuous auto-scroll while resting at either end of the swipe range.
  function updateEdgeScroll() {
    const dirn = s.mag <= LOW_EDGE ? 1 : s.mag >= HIGH_EDGE ? -1 : 0;
    if (dirn === s.edgeDir) return;
    stopEdgeScroll();
    s.edgeDir = dirn;
    if (!dirn) return;
    const g = s;
    g.edgeDwell = setTimeout(() => {
      g.edgeT = performance.now();
      const tick = now => {
        if (s !== g || !g.holding || !g.edgeDir) return;
        const dt = Math.min(0.05, (now - g.edgeT) / 1000);
        g.edgeT = now;
        const depth =
          g.edgeDir > 0
            ? (LOW_EDGE - g.mag) / LOW_EDGE
            : (g.mag - HIGH_EDGE) / (1 - HIGH_EDGE);
        const rate = EDGE_RATE_MIN + Math.max(0, Math.min(1, depth)) * (EDGE_RATE_MAX - EDGE_RATE_MIN);
        movePos(g.edgeDir * rate * dt);
        g.edgeRaf = requestAnimationFrame(tick);
      };
      g.edgeRaf = requestAnimationFrame(tick);
    }, EDGE_DWELL_MS);
  }

  function stopEdgeScroll() {
    clearTimeout(s.edgeDwell);
    cancelAnimationFrame(s.edgeRaf);
    s.edgeDwell = 0;
    s.edgeRaf = 0;
    s.edgeDir = 0;
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
    stopEdgeScroll();
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
    clearTimeout(g.edgeDwell);
    cancelAnimationFrame(g.edgeRaf);
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
      onHoldMove(Math.max(0, e.delta * s.sign));
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
