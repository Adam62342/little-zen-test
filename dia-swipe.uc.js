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
  const ROW_STEP = 0.06; // swipe distance per row while scrubbing (~33px)
  const CANCEL_BELOW = 0.1; // drag back near the edge to cancel
  const EDGE_AT = 0.94; // pushing this far auto-scrolls down the list
  const EDGE_REPEAT_MS = 170;
  const RELEASE_SPEED = 2.0; // page-widths/sec; faster = lift-off animation
  const MAX_ROWS = 50;

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
  // Gecko only exposes haptics to chrome JS through nsIHapticFeedback, which
  // isn't registered on every platform. If it's missing this is a no-op.
  const haptic = (() => {
    try {
      const cid = "@mozilla.org/widget/hapticfeedback;1";
      if (cid in Cc && Ci.nsIHapticFeedback) {
        const svc = Cc[cid].getService(Ci.nsIHapticFeedback);
        return long =>
          svc.performSimpleAction(
            long ? Ci.nsIHapticFeedback.LongPress : Ci.nsIHapticFeedback.ShortPress
          );
      }
    } catch (e) {}
    return () => {};
  })();
  const buzz = long => {
    if (boolPref("haptics", true)) {
      try {
        haptic(long);
      } catch (e) {}
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
      circle: null,
      list: null,
      dir: null, // "back" | "forward" | null
      side: null, // "left" | "right"
      mag: 0,
      armed: false,
      holding: false,
      stillAt: 0,
      holdTimer: 0,
      edgeTimer: 0,
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

  function mount() {
    const stack =
      gBrowser.selectedBrowser.closest(".browserStack") ||
      gBrowser.getPanel().querySelector(".browserStack");
    if (!stack) return false;
    s.circle = h("div", { class: "dia-swipe-circle" }, arrowIcon());
    s.list = h("div", { class: "dia-swipe-list" });
    s.root = h("div", { class: "dia-swipe" }, s.circle, s.list);
    stack.appendChild(s.root);
    return true;
  }

  function setSide(dir) {
    const ltr = gHistorySwipeAnimation.isLTR;
    s.side = (dir === "back") === ltr ? "left" : "right";
    s.root.setAttribute("side", s.side);
    s.root.setAttribute("dir", dir);
  }

  function setProgress(p) {
    // Slide in from just off the edge, growing as it comes.
    const x = -60 + p * 84;
    const scale = 0.55 + p * 0.45;
    const signed = s.side === "right" ? -x : x;
    s.circle.style.transform = `translate(${signed}px, -50%) scale(${scale})`;
    s.circle.style.opacity = String(Math.min(1, p * 1.6));
  }

  // ---- Hold-to-scrub list ---------------------------------------------------
  function scheduleHold() {
    clearTimeout(s.holdTimer);
    if (!boolPref("hold_list", true)) return;
    s.holdTimer = setTimeout(enterHold, HOLD_DELAY_MS);
  }

  function enterHold() {
    if (!s || !s.armed || s.holding) return;
    s.entries = historyEntries(s.dir);
    if (!s.entries.length) return;
    s.holding = true;
    s.anchor = s.mag;
    s.base = 0;
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
    s.root.setAttribute("holding", "true");
    buzz(true);
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
    if (!silent) buzz(false);
  }

  function recomputeSelection() {
    if (s.mag < CANCEL_BELOW) {
      select(-1);
      return;
    }
    const raw = s.base + Math.floor((s.mag - s.anchor) / ROW_STEP + 0.5);
    select(Math.max(0, Math.min(s.rows.length - 1, raw)));
  }

  function updateEdgeScroll() {
    const atEdge = s.mag >= EDGE_AT;
    if (atEdge && !s.edgeTimer) {
      s.edgeTimer = setInterval(() => {
        if (!s || !s.holding) return;
        if (s.sel >= s.rows.length - 1) return;
        s.base++;
        recomputeSelection();
      }, EDGE_REPEAT_MS);
    } else if (!atEdge && s.edgeTimer) {
      clearInterval(s.edgeTimer);
      s.edgeTimer = 0;
    }
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
    const mag = Math.abs(e.delta);
    s.mag = mag;

    if (s.holding) {
      recomputeSelection();
      updateEdgeScroll();
      s.samples.push({ t: performance.now(), mag, sel: s.sel });
      if (s.samples.length > 30) s.samples.shift();
      return;
    }

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
        buzz(false);
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

  function handleEvent(e) {
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
