# Query Launcher (Sine mod)

A userChrome.js mod for Zen / Firefox, loaded via Sine. As you type in the address bar, it pins one
extra result **directly under your query** — press **↓ then Enter** (or click it) to send whatever you
typed to a destination you choose: an AI, any URL, or another browser.

## What it does

- Watches the address bar. The moment you start typing, a pinned row appears just below your typed
  query, above the normal suggestions.
- Selecting it (arrow down + Enter, or a click) takes your text to the destination you configured.
- The destination is a URL template with your query substituted in, so it works with any search or AI
  site. Examples:
  - Perplexity — `https://www.perplexity.ai/search?q=%s`
  - Google — `https://www.google.com/search?q=%s`
  - ChatGPT — `https://chatgpt.com/?q=%s`
  - Claude — `https://claude.ai/new?q=%s`
  - YouTube — `https://www.youtube.com/results?search_query=%s`

  Use `%s` (or `{query}`) where your text should go. If you leave out the placeholder, your text is
  appended as `?q=...`.
- Open it where you like: a new tab, the current tab, a new window, or **an external app** (macOS) —
  so you can bounce the query straight into another browser.

## Settings

In Sine → this mod → preferences:

- **Row label** — the text shown next to the icon (e.g. "Ask AI").
- **Destination URL** — the template above.
- **Open the destination in** — new tab · current tab · new window · external app (macOS).
- **External app name** — when "external app" is chosen, the macOS app to open, e.g. `Google Chrome`,
  `Safari`, `Arc`. (Launches via `open -a "<app>" <url>`.)
- **Row icon** — a website favicon, or an SF Symbol / glyph.
- **Icon glyph** — used in glyph mode. Paste an **SF Symbol** here (open the **SF Symbols** app,
  right-click a symbol → **Copy**, paste it in), or use any emoji / character.
- **Minimum characters** — only show the row once you've typed at least this many characters.
- **Row position** — `1` puts it directly below your typed query.

## Notes & limitations

- **SF Symbols** render using your Mac's system font. Most common symbols show up; a few niche ones
  may not render if the glyph isn't in the installed `SF Pro` font. A favicon or an emoji is a safe
  fallback. In glyph mode the icon inherits the address-bar text color, so it adapts to light/dark.
- **External app** launching is macOS-only. On other systems that option falls back to opening a tab.
  Leaving the app name empty also falls back to a tab (otherwise it would just reopen in Zen).
- The favicon is fetched from Google's favicon service (`google.com/s2/favicons`) based on the
  destination's domain — a small network request when the row is shown.
- Files: `query-launcher.uc.js` (all logic), `theme.json`, `preferences.json`, `chrome.css`.

## How it works (for the curious)

It registers a Urlbar **provider** that contributes a single **dynamic result** with
`suggestedIndex = 1`, so the muxer pins it just under the heuristic (your typed query). The row is
rendered from a small view template; selecting it triggers the provider's engagement handler, which
builds the final URL and opens it (or launches the external app).
