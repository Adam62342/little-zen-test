// ==UserScript==
// @name         Page Summary
// @description  Dia-style summary & chat panel for the current page
// @include      main
// ==/UserScript==

(() => {
  const ID = "page-summary";
  const PREF = "mod.page-summary.";
  const NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MSG = "page-summary:text";
  const MARGIN = 8;
  const MAX_CHARS = 24000;
  const SYSTEM =
    "You summarize web pages. Reply in concise markdown bullet points (5-8 bullets, one or two lines each, " +
    "bold only key terms). No preamble or closing remarks. For follow-up questions, answer briefly using the page.";
  const CHIPS = [
    ["Key takeaways", "What are the key takeaways?"],
    ["Explain simply", "Explain this page in simple terms."],
    ["Action items", "List any action items or next steps from this page."],
  ];
  const ICONS = {
    new: "M7 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V9M11.3 2.7l2 2L8 10l-2.7.7L6 8z",
    close: "M4 4l8 8M12 4l-8 8",
    send: "M8 13V3M3.5 7.5L8 3l4.5 4.5",
  };

  window.__pageSummary?.destroy();

  // ---------- prefs ----------
  const pref = (k, d) => {
    try { return Services.prefs.getStringPref(PREF + k, d) || d; } catch { return d; }
  };
  const provider = () => pref("provider", "apple");
  const apiKey = () => pref("apikey", "").trim();
  const baseUrl = () =>
    (provider() === "apple"
      ? pref("applebase", "http://127.0.0.1:11435/v1")
      : pref("baseurl", "https://api.openai.com/v1")
    )
      .trim()
      .replace(/\/+$/, "")
      .replace(/^(https?:\/\/[^/]+)$/, provider() === "apple" ? "$1/v1" : "$1");
  const model = () =>
    pref("model", "") || ({ anthropic: "claude-haiku-5-5", apple: "apple.local" }[provider()] || "gpt-4o-mini");
  const llmReady = () =>
    provider() === "anthropic"
      ? !!apiKey()
      : provider() === "apple" || !!apiKey() || /localhost|127\.0\.0\.1/.test(baseUrl());
  // Apple's on-device model has a ~4k-token context, so long pages are read in chunks
  const chunkSize = () => (provider() === "apple" ? 5500 : MAX_CHARS);

  // ---------- DOM helpers ----------
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElementNS(NS, tag);
    Object.assign(el, props);
    el.append(...kids);
    return el;
  };
  const icon = (name) => {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("class", "ps-svg");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", ICONS[name]);
    s.append(p);
    return s;
  };

  const pageUrl = () => {
    const uri = gBrowser.currentURI;
    return /^https?$/.test(uri.scheme) ? uri.spec : null;
  };

  // ---------- page text ----------
  function extractInContent() {
    const doc = content.document;
    const root = doc.querySelector("article, main, [role=main], #mw-content-text, #content") || doc.body;
    const skip = "nav, footer, aside, header, form, .navbox, .reflist, .references, .toc, #toc, .mw-editsection";
    const parts = [];
    for (const el of root.querySelectorAll("h1,h2,h3,p,li,blockquote")) {
      if (el.closest(skip)) continue;
      const t = el.textContent.replace(/\s+/g, " ").replace(/\[\d+\]/g, "").trim();
      if (t.length > 1) parts.push(t);
    }
    let text = parts.join("\n");
    if (text.length < 200) text = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
    sendAsyncMessage("page-summary:text", { title: doc.title, url: doc.location.href, text });
  }

  async function getPageText(browser) {
    try {
      const mm = browser.messageManager;
      const data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          mm.removeMessageListener(MSG, listener);
          reject(new Error("timeout"));
        }, 4000);
        const listener = (m) => {
          clearTimeout(timer);
          mm.removeMessageListener(MSG, listener);
          resolve(m.data);
        };
        mm.addMessageListener(MSG, listener);
        mm.loadFrameScript(
          "data:application/javascript," + encodeURIComponent(`(${extractInContent.toString()})()`),
          false
        );
      });
      if (data?.text) return data;
    } catch (e) {
      console.warn("[page-summary] frame script failed, trying reader mode", e);
    }
    const { ReaderMode } = ChromeUtils.importESModule("resource://gre/modules/ReaderMode.sys.mjs");
    const art = await ReaderMode.downloadAndParseDocument(browser.currentURI.spec);
    if (!art?.textContent) throw new Error("couldn't read this page");
    return { title: art.title, url: browser.currentURI.spec, text: art.textContent.replace(/\s+/g, " ") };
  }

  // ---------- offline extractive summarizer ----------
  function extractive(text, n = 6) {
    const sents = (text.replace(/\s+/g, " ").match(/[^.!?。！？]+[.!?。！？]+/g) || [])
      .map((s) => s.trim())
      .filter((s) => s.length > 30 && s.length < 400);
    if (sents.length <= n) return sents.map((s) => "- " + s).join("\n");
    const stop = new Set(
      "the and for with that this from which who his her their has have had not but also than then into over after before are was were been its they you your".split(" ")
    );
    const words = (s) => (s.toLowerCase().match(/[\p{L}']{3,}/gu) || []).filter((w) => !stop.has(w));
    const freq = new Map();
    for (const s of sents) for (const w of words(s)) freq.set(w, (freq.get(w) || 0) + 1);
    return sents
      .map((s, i) => {
        const ws = words(s);
        const score = (ws.reduce((a, w) => a + freq.get(w), 0) / Math.sqrt(ws.length || 1)) * (i < sents.length * 0.3 ? 1.15 : 1);
        return { s, i, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .sort((a, b) => a.i - b.i)
      .map((x) => "- " + x.s)
      .join("\n");
  }

  // ---------- networking ----------
  const httpError = (status, body) =>
    `${status} ${String(body).replace(/\s+/g, " ").slice(0, 200)}` +
    (status === 401 || status === 403 ? " (check the API key / access settings of your AI server)" : "");

  // afm-server documents Bearer auth, but its Xcode setup uses x-api-key, so send both
  const authHeaders = () =>
    apiKey()
      ? { authorization: `Bearer ${apiKey()}`, ...(provider() === "apple" ? { "x-api-key": apiKey() } : {}) }
      : {};

  async function* fetchChunks(url, headers, body, signal) {
    const res = await fetch(url, { method: "POST", signal, headers, body });
    if (!res.ok) throw new Error(httpError(res.status, await res.text()));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield dec.decode(value, { stream: true });
    }
  }

  // Raw browser channel: unlike fetch(), it adds no Origin / Sec-Fetch-* headers, which some
  // local servers (like afm-server) may reject with 403.
  async function* channelChunks(url, headers, body, signal) {
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    let ch;
    try {
      ch = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true }).QueryInterface(Ci.nsIHttpChannel);
      const sis = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
      sis.setUTF8Data(body);
      ch.QueryInterface(Ci.nsIUploadChannel2).explicitSetUploadStream(sis, "application/json", -1, "POST", false);
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== "content-type") ch.setRequestHeader(k, v, false);
      }
    } catch (e) {
      e.channelSetup = true;
      throw e;
    }

    const queue = [];
    let wake = null, done = false, failure = null, status = 0, full = "";
    const ping = () => { wake?.(); wake = null; };
    const dec = new TextDecoder();
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest() { try { status = ch.responseStatus; } catch {} },
      onDataAvailable(_req, stream, _offset, count) {
        const bin = NetUtil.readInputStreamToString(stream, count);
        const txt = dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)), { stream: true });
        full += txt;
        if (status < 400) { queue.push(txt); ping(); }
      },
      onStopRequest(_req, code) {
        if (signal.aborted) failure = new DOMException("aborted", "AbortError");
        else if (!Components.isSuccessCode(code) && !status) failure = new TypeError("network error");
        done = true;
        ping();
      },
    };
    signal.addEventListener("abort", () => {
      try { ch.cancel(Components.results.NS_BINDING_ABORTED); } catch {}
    }, { once: true });
    try {
      ch.asyncOpen(listener);
    } catch (e) {
      e.channelSetup = true;
      throw e;
    }

    for (;;) {
      while (queue.length) yield queue.shift();
      if (done) break;
      await new Promise((r) => (wake = r));
    }
    if (failure) throw failure;
    if (status >= 400) throw new Error(httpError(status, full));
  }

  async function* chunks(url, headers, body, signal) {
    if (provider() === "apple") {
      try {
        yield* channelChunks(url, headers, body, signal);
        return;
      } catch (e) {
        if (!e.channelSetup) throw e;
        console.warn("[page-summary] channel transport unavailable, using fetch", e);
      }
    }
    yield* fetchChunks(url, headers, body, signal);
  }

  async function* sseEvents(chunkIter) {
    let buf = "";
    for await (const c of chunkIter) {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try { yield JSON.parse(d); } catch {}
      }
    }
  }

  async function* streamLLM(msgs, signal) {
    const anthropic = provider() === "anthropic";
    const url = anthropic ? "https://api.anthropic.com/v1/messages" : baseUrl() + "/chat/completions";
    const headers = anthropic
      ? {
          "content-type": "application/json",
          "x-api-key": apiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        }
      : { "content-type": "application/json", ...authHeaders() };
    const body = JSON.stringify(
      anthropic
        ? { model: model(), max_tokens: 1024, stream: true, system: SYSTEM, messages: msgs }
        : { model: model(), stream: true, messages: [{ role: "system", content: SYSTEM }, ...msgs] }
    );
    for await (const j of sseEvents(chunks(url, headers, body, signal))) {
      const d = anthropic ? (j.type === "content_block_delta" ? j.delta?.text : "") : j.choices?.[0]?.delta?.content;
      if (d) yield d;
    }
  }

  async function complete(msgs, signal) {
    const headers = { "content-type": "application/json", ...authHeaders() };
    const body = JSON.stringify({
      model: model(),
      stream: false,
      messages: [{ role: "system", content: "You extract key facts tersely." }, ...msgs],
    });
    let text = "";
    for await (const c of chunks(baseUrl() + "/chat/completions", headers, body, signal)) text += c;
    return JSON.parse(text).choices?.[0]?.message?.content || "";
  }

  // ---------- context building (chunked reading for small-context models) ----------
  function chunkText(text, size) {
    const out = [];
    let cur = "";
    for (const line of text.split("\n")) {
      if (cur && cur.length + line.length > size) { out.push(cur); cur = ""; }
      cur += (cur ? "\n" : "") + line.slice(0, size);
    }
    if (cur) out.push(cur);
    return out;
  }

  async function buildContext(page, signal, setStatus) {
    const size = chunkSize();
    if (provider() !== "apple" || page.text.length <= size) return page.text.slice(0, size);
    let parts = chunkText(page.text, size);
    if (parts.length > 8) parts = Array.from({ length: 8 }, (_, i) => parts[Math.floor((i * parts.length) / 8)]);
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      setStatus(`Reading part ${i + 1} of ${parts.length}…`);
      notes.push(
        await complete(
          [{ role: "user", content: "List the key facts in this excerpt as 4-6 terse bullet points:\n\n" + parts[i] }],
          signal
        )
      );
    }
    return notes.join("\n").slice(0, size);
  }

  // ---------- minimal markdown -> DOM ----------
  const inline = (s) =>
    s.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((t) =>
      t.startsWith("**") && t.endsWith("**") && t.length > 4
        ? h("strong", { textContent: t.slice(2, -2) })
        : document.createTextNode(t)
    );

  function renderMd(el, text) {
    el.replaceChildren();
    let ul = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const m = line.match(/^[-*•]\s+(.*)/) || line.match(/^\d+[.)]\s+(.*)/);
      if (m) {
        if (!ul) { ul = h("ul"); el.append(ul); }
        ul.append(h("li", {}, ...inline(m[1])));
      } else if (line) {
        ul = null;
        el.append(h("p", {}, ...inline(line.replace(/^#+\s*/, ""))));
      } else {
        ul = null;
      }
    }
  }

  // ---------- per-tab session ----------
  const sessions = new Map(); // tab -> session
  const offset = { x: 0, y: 0 }; // user drag offset from the default top-right spot

  function makeSession(tab) {
    let panel, logEl, foot, input, sendBtn;
    let page = null, convo = [], ctrl = null, currentUrl = null;
    let busy = false, gen = 0, closed = false;

    const instruction = () => pref("prompt", "Summarize this page into concise bullet points.");

    const request = () => {
      const header = `Title: ${page.title}\nURL: ${page.url}\n\n${page.context}`;
      const lastIsQuestion = convo.at(-1)?.role === "user";
      // afm-server may drop earlier messages, so for Apple Intelligence every follow-up
      // carries the page + prior answers inside a single self-contained message.
      if (provider() === "apple" && lastIsQuestion) {
        const transcript = convo
          .slice(0, -1)
          .slice(-3)
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1200)}`)
          .join("\n");
        return [{
          role: "user",
          content:
            "Answer the question using ONLY the web page below. If the page does not say, answer that it doesn't. " +
            "Be concise.\n\n=== PAGE ===\n" + header +
            (transcript ? `\n\n=== CONVERSATION SO FAR ===\n${transcript}` : "") +
            `\n\n=== QUESTION ===\n${convo.at(-1).content}`,
        }];
      }
      return [{ role: "user", content: `${instruction()}\n\n${header}` }, ...convo.slice(-4)];
    };

    const setBusy = (b) => { busy = b; if (sendBtn) sendBtn.disabled = b; };
    const nearBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
    const scrollDown = (smooth) => logEl?.scrollTo({ top: logEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };

    function position() {
      if (!panel) return;
      const r = gBrowser.selectedBrowser.getBoundingClientRect();
      const w = Math.min(parseInt(pref("width", "440"), 10) || 440, r.width - MARGIN * 2);
      const hgt = Math.min(parseInt(pref("height", "620"), 10) || 620, r.height - MARGIN * 2);
      const baseLeft = r.right - w - MARGIN;
      const baseTop = r.top + MARGIN;
      // apply the user's drag offset, keeping the panel on screen
      const left = Math.min(Math.max(baseLeft + offset.x, 0), window.innerWidth - w);
      const top = Math.min(Math.max(baseTop + offset.y, 0), window.innerHeight - 80);
      offset.x = left - baseLeft;
      offset.y = top - baseTop;
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.right = "auto";
      panel.style.width = `${Math.round(w)}px`;
      panel.style.height = `${Math.round(hgt)}px`;
    }

    function enableDrag(head) {
      head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return;
        e.preventDefault();
        head.setPointerCapture(e.pointerId);
        panel.classList.add("ps-dragging");
        const move = (ev) => { offset.x += ev.movementX; offset.y += ev.movementY; position(); };
        const up = (ev) => {
          head.releasePointerCapture(ev.pointerId);
          panel.classList.remove("ps-dragging");
          head.removeEventListener("pointermove", move);
          head.removeEventListener("pointerup", up);
          head.removeEventListener("pointercancel", up);
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
        head.addEventListener("pointercancel", up);
      });
      // double-click the header to snap back to the corner
      head.addEventListener("dblclick", (e) => {
        if (e.target.closest("button")) return;
        offset.x = offset.y = 0;
        position();
      });
    }

    function submit(text) {
      const q = (text ?? input.value).trim();
      if (!q || busy || !page) return;
      input.value = "";
      autosize();
      ask(q);
    }

    function build() {
      const newBtn = h("button", { className: "ps-icon", title: "New chat (summarize this page)", onclick: () => { const u = pageUrl(); if (u) run(u); } }, icon("new"));
      const closeBtn = h("button", { className: "ps-icon", title: "Close (Esc)", onclick: () => close() }, icon("close"));
      logEl = h("div", { className: "ps-log" });

      input = h("textarea", { className: "ps-input", rows: 1, placeholder: "Ask a question about this page…" });
      input.addEventListener("input", autosize);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); }
      });
      sendBtn = h("button", { className: "ps-send", title: "Send", onclick: () => submit() }, icon("send"));
      const chips = h("div", { className: "ps-chips" }, ...CHIPS.map(([label, q]) =>
        h("button", { className: "ps-chip", textContent: label, onclick: () => submit(q) })
      ));
      foot = h("div", { className: "ps-foot", hidden: true }, h("div", { className: "ps-composer" }, input, h("div", { className: "ps-row" }, chips, sendBtn)));

      const head = h("div", { className: "ps-head", title: "Drag to move · double-click to reset" }, newBtn, closeBtn);
      enableDrag(head);
      panel = h("div", { id: `${ID}-panel` }, head, logEl, foot);
      document.documentElement.append(panel);
      position();
    }

    function pageCard(url) {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const ico = h("div", { className: "ps-card-ico" });
      if (tab.image) ico.append(h("img", { className: "ps-card-fav", src: tab.image }));
      else ico.textContent = (host[0] || "?").toUpperCase();
      const title = h("div", { className: "ps-card-title", textContent: tab.label || url });
      const card = h("div", { className: "ps-msg ps-card" }, ico, h("div", { className: "ps-card-meta" }, title, h("div", { className: "ps-card-domain", textContent: host })));
      card._title = title;
      return card;
    }

    function actionsRow(getText) {
      const mini = (label, fn) => h("button", { className: "ps-mini", textContent: label, onclick: fn });
      return h("div", { className: "ps-actions" },
        mini("Copy", (e) => {
          Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(getText());
          e.target.textContent = "Copied";
          setTimeout(() => (e.target.textContent = "Copy"), 1200);
        }),
        mini("Regenerate", regenerate)
      );
    }

    async function generate() {
      ctrl?.abort();
      ctrl = new AbortController();
      const signal = ctrl.signal;
      const my = ++gen;
      setBusy(true);
      const block = h("div", { className: "ps-msg ps-ai ps-streaming" });
      logEl.append(block);
      scrollDown(true);
      let acc = "";
      try {
        if (!llmReady()) {
          acc = extractive(page.text) || "Couldn't find enough text on this page to summarize.";
          renderMd(block, acc);
          block.append(h("div", { className: "ps-note", textContent: "Offline summary. Add an API key (or use Apple Intelligence) in the mod settings for AI summaries and follow-ups." }));
        } else {
          for await (const d of streamLLM(request(), signal)) {
            const stick = nearBottom();
            acc = acc.length > 20 && d.startsWith(acc) ? d : acc + d; // tolerate cumulative streams
            renderMd(block, acc);
            if (stick) scrollDown(false);
          }
        }
        if (acc) convo.push({ role: "assistant", content: acc });
      } catch (e) {
        if (e.name !== "AbortError") {
          const unreachable = e instanceof TypeError;
          block.append(h("p", {
            className: "ps-error",
            textContent: unreachable
              ? `Couldn't reach the AI server at ${baseUrl()}. Is it running? Showing an offline summary instead.`
              : `Couldn't summarize: ${e.message}`,
          }));
          if (unreachable && !acc && !convo.length) {
            acc = extractive(page.text);
            const fb = h("div");
            renderMd(fb, acc);
            block.append(fb);
          }
        }
      }
      if (closed || my !== gen) return;
      block.classList.remove("ps-streaming");
      if (acc) block.append(actionsRow(() => acc));
      foot.hidden = !llmReady();
      setBusy(false);
      scrollDown(true);
    }

    function regenerate() {
      if (busy) return;
      const blocks = logEl.querySelectorAll(".ps-ai");
      blocks[blocks.length - 1]?.remove();
      if (convo.at(-1)?.role === "assistant") convo.pop();
      generate();
    }

    function ask(q) {
      logEl.append(h("div", { className: "ps-msg ps-user", textContent: q }));
      convo.push({ role: "user", content: q });
      generate();
    }

    async function run(url) {
      ctrl?.abort();
      gen++;
      currentUrl = url;
      if (!panel) build(); else position();
      const card = pageCard(url);
      const status = h("div", { className: "ps-msg ps-status", textContent: "Reading page…" });
      logEl.replaceChildren(card, h("div", { className: "ps-msg ps-user", textContent: "Summarize" }), status);
      foot.hidden = true;
      setBusy(true);
      convo = [];
      page = null;

      try {
        page = await getPageText(tab.linkedBrowser);
      } catch (e) {
        if (closed || currentUrl !== url) return;
        status.replaceWith(h("p", { className: "ps-msg ps-error", textContent: `Couldn't read this page: ${e.message}` }));
        setBusy(false);
        return;
      }
      if (closed || currentUrl !== url) return;
      if (page.title) card._title.textContent = page.title;
      page.text = page.text.slice(0, MAX_CHARS * 2);
      ctrl = new AbortController();
      try {
        page.context = await buildContext(page, ctrl.signal, (t) => { status.textContent = t; });
      } catch (e) {
        if (e.name === "AbortError" || closed) return;
        page.context = page.text.slice(0, chunkSize()); // generate() will surface the real error
      }
      if (closed || currentUrl !== url) return;
      status.remove();
      generate();
    }

    function show() { if (panel) { panel.hidden = false; position(); } }
    function hide() { if (panel) panel.hidden = true; }

    function close(immediate) {
      if (closed) return;
      closed = true;
      gen++;
      ctrl?.abort();
      sessions.delete(tab);
      if (!panel) return;
      const p = panel;
      if (immediate) p.remove();
      else { p.classList.add("ps-out"); setTimeout(() => p.remove(), 180); }
    }

    return { run, show, hide, position, close, get url() { return currentUrl; } };
  }

  // ---------- window-level wiring ----------
  const current = () => sessions.get(gBrowser.selectedTab);

  function toggle() {
    const url = pageUrl();
    const s = current();
    if (s && (!url || url === s.url)) return s.close();
    if (!url) return;
    if (s) return s.run(url);
    const tab = gBrowser.selectedTab;
    const ns = makeSession(tab);
    sessions.set(tab, ns);
    ns.run(url);
  }

  const onKey = (e) => {
    if (e.key === "Escape") current()?.close();
    else if (e.altKey && e.shiftKey && e.code === "KeyP") { e.preventDefault(); toggle(); }
  };
  const onSelect = () => {
    const cur = gBrowser.selectedTab;
    for (const [t, s] of sessions) (t === cur ? s.show() : s.hide());
  };
  const onTabClose = (e) => sessions.get(e.target)?.close(true);
  const onResize = () => current()?.position();

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
  gBrowser.tabContainer.addEventListener("TabClose", onTabClose);

  // toolbar button (created once per session, shared across windows)
  const { CustomizableUI } = ChromeUtils.importESModule("resource:///modules/CustomizableUI.sys.mjs");
  if (!CustomizableUI.getWidget(ID)?.provider) {
    CustomizableUI.createWidget({
      id: ID,
      type: "button",
      label: "Summarize page",
      tooltiptext: "Summarize this page (Alt+Shift+P)",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(e) { e.target.ownerGlobal.__pageSummary?.toggle(); },
    });
  }

  window.__pageSummary = {
    toggle,
    destroy() {
      for (const s of [...sessions.values()]) s.close(true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
      gBrowser.tabContainer.removeEventListener("TabClose", onTabClose);
      delete window.__pageSummary;
    },
  };
  console.log("[page-summary] loaded v1.2");
})();
