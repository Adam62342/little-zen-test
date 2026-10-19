# Alt Search

Type in the URL bar → a pinned row sits right under your query. Arrow down, Enter → the query is sent to your chosen destination.

Each destination is an object in the `mod.altsearch.entries` JSON list:

```json
[
  {"name": "ChatGPT",    "url": "https://chatgpt.com/?q={query}",          "icon": "favicon"},
  {"name": "Perplexity", "url": "https://www.perplexity.ai/search?q={query}", "icon": "<paste SF glyph>"},
  {"name": "Claude in Arc", "url": "https://claude.ai/new?q={query}", "app": "Arc", "icon": "favicon"}
]
```

- `{query}` is replaced with the URL-encoded text.
- `icon`: `"favicon"`, a glyph copied from the SF Symbols app (Edit → Copy Glyph; needs the SF Pro font installed), or an image URL.
- `app` (optional, macOS): open in that browser instead (`open -a <app> <url>`).
- Cmd/Ctrl+Enter opens in a new tab.

Manual install (no Sine UI): fx-autoconfig → copy `alt-search.uc.js` to `chrome/JS/`, `chrome.css` into `chrome/userChrome.css`, edit prefs in about:config, clear startup cache, restart.
