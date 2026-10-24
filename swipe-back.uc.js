// ==UserScript==
// @name        Swipe Back
// @description Dia-style back gesture with hold-to-reveal history
// @include     main
// ==/UserScript==
(() => {
  if (window.__zenSwipeBack) return;
  window.__zenSwipeBack = true;

  const ARM_AT = 0.3;      // swipe progress (0..1) where the bubble "snaps" and haptics fire
  const HOLD_MS = 420;     // armed + held this long => open history list
  const ROW_STEP = 40;     // vertical scroll px per row while list is open
  const MAX_ROWS = 12;

  const HTML = "http://www.w3.org/1999/xhtml";
  const SVG = "http://www.w3.org/2000/svg";
  const h = (tag, cls, parent) => {
    const e = document.createElementNS(HTML, tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  };

  // Stop Firefox's built-in swipe animation from fighting ours.
  try { Services.prefs.setCharPref("browser.gesture.swipe.left", ""); } catch (e) {}

  // ---- UI ----
  const root = h("div", "zsb-root");
  const bubble = h("div", "zsb-bubble", root);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M19 12H5M11 6l-6 6 6 6");
  svg.appendChild(path);
  bubble.appendChild(svg);
  const list = h("div", "zsb-list", root);
  document.documentElement.appendChild(root);

  // ---- state ----
  let active = false, armed = false, listOpen = false;
  let holdTimer = null, entries = [], selected = 0, wheelAcc = 0;

  const browser = () => gBrowser.selectedBrowser;
  const history = () => browser().browsingContext?.sessionHistory;
  const canGoBack = () => { try { return browser().canGoBack; } catch (e) { return false; } };

  function haptic() {
    // Best effort: no stable haptic API is exposed to Firefox chrome code on desktop,
    // so this is a no-op on most builds. The bubble's scale "pop" is the fallback cue.
    try {
      const fb = Cc["@mozilla.org/widget/hapticfeedback;1"].getService(Ci.nsIHapticFeedback);
      fb.performSimpleAction(Ci.nsIHapticFeedback.ShortPress);
    } catch (e) {}
  }

  function place() {
    const r = document.getElementById("tabbrowser-tabpanels")?.getBoundingClientRect();
    if (!r) return;
    root.style.setProperty("--zsb-left", r.left + "px");
    root.style.setProperty("--zsb-top", r.top + r.height / 2 + "px");
  }

  function render(p) {
    const t = Math.min(p / ARM_AT, 1);
    const x = -48 + t * 72 + Math.max(0, p - ARM_AT) * 36;
    root.style.setProperty("--zsb-x", x + "px");
  }

  function buildList() {
    const sh = history();
    entries = [];
    if (!sh) return;
    for (let i = sh.index - 1; i >= 0 && entries.length < MAX_ROWS; i--) {
      const e = sh.getEntryAtIndex(i);
      let host = "";
      try { host = e.URI.host || e.URI.spec; } catch (err) { host = e.URI?.spec || ""; }
      entries.push({ index: i, title: e.title || host, host });
    }
    list.replaceChildren();
    entries.forEach((en, n) => {
      const row = h("div", "zsb-row", list);
      h("div", "zsb-title", row).textContent = en.title;
      h("div", "zsb-host", row).textContent = en.host;
      if (n === 0) row.setAttribute("selected", "");
    });
    selected = 0;
    wheelAcc = 0;
  }

  function select(n) {
    n = Math.max(0, Math.min(entries.length - 1, n));
    if (n === selected) return;
    selected = n;
    [...list.children].forEach((row, i) => row.toggleAttribute("selected", i === n));
    list.children[n]?.scrollIntoView?.({ block: "nearest" });
  }

  function openList() {
    if (!armed || listOpen) return;
    buildList();
    if (entries.length < 2) return; // nothing worth choosing between
    listOpen = true;
    root.setAttribute("listopen", "");
    haptic();
  }

  function reset() {
    clearTimeout(holdTimer);
    active = armed = listOpen = false;
    root.removeAttribute("active");
    root.removeAttribute("armed");
    root.removeAttribute("listopen");
    root.style.setProperty("--zsb-x", "-48px");
  }

  // ---- gesture events (macOS, and Windows precision touchpads) ----
  window.addEventListener("MozSwipeGestureMayStart", (e) => {
    if (e.direction === e.DIRECTION_LEFT && canGoBack()) {
      e.allowedDirections |= e.DIRECTION_LEFT;
    }
  }, true);

  window.addEventListener("MozSwipeGestureStart", (e) => {
    if (e.direction !== e.DIRECTION_LEFT || !canGoBack()) return;
    reset();
    place();
    active = true;
    root.setAttribute("active", "");
    render(0);
  }, true);

  window.addEventListener("MozSwipeGestureUpdate", (e) => {
    if (!active) return;
    const p = Math.min(Math.abs(e.delta), 1);
    render(p);
    if (!armed && p >= ARM_AT) {
      armed = true;
      root.setAttribute("armed", "");
      haptic();
      holdTimer = setTimeout(openList, HOLD_MS);
    } else if (armed && !listOpen && p < ARM_AT * 0.6) {
      armed = false;               // user pulled back: cancel
      root.removeAttribute("armed");
      clearTimeout(holdTimer);
    }
  }, true);

  window.addEventListener("MozSwipeGestureEnd", () => {
    if (!active) return;
    const go = armed, target = listOpen ? entries[selected]?.index : null;
    reset();
    if (!go) return;
    if (target != null) browser().gotoIndex(target);
    else browser().goBack();
  }, true);

  // Swallow the final swipe event so Firefox doesn't also navigate.
  window.addEventListener("MozSwipeGesture", (e) => {
    if (e.direction === e.DIRECTION_LEFT) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---- scroll through the list while still holding ----
  window.addEventListener("wheel", (e) => {
    if (!listOpen) return;
    e.preventDefault();
    e.stopPropagation();
    wheelAcc += e.deltaY;
    const steps = Math.trunc(wheelAcc / ROW_STEP);
    if (steps) {
      wheelAcc -= steps * ROW_STEP;
      select(selected + steps);   // scrolling down = further back
    }
  }, { capture: true, passive: false });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && active) reset();
  }, true);
})();
