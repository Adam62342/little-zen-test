# Little Zen

Arc's **Little Arc**, rebuilt for Zen Browser via [Sine](https://github.com/CosmoCreeper/Sine). Click a link in Slack, Mail, Notes, a terminal — anything outside Zen — and it opens in a small, floating macOS-style window instead of hijacking your main window. Read it, follow a couple of links, then either keep it (**Open in Zen** promotes the page to your main window) or flick it away with a two-finger back-swipe.

Built for macOS first: rounded floating window, focus dimming, draggable header, and a trackpad dismiss gesture that slides the whole window right and shrinks it as it closes.

## Features

- **External links → little window.** Any `http(s)` link opened from another app lands in a compact, centered, chrome-light window.
- **Swipe-back-to-close.** When the little window is on its first page (nothing to go back to), a two-finger back-swipe dismisses it. The real OS window slides right and scales down ~30% following your fingers, then closes. Swipe past the first page? Normal history-back, untouched.
- **Open in Zen.** One click moves the current page into your main Zen window (`adoptTab`, so history comes with it) and closes the little window.
- **macOS niceties.** Rounded corners, soft shadow, dim-on-blur, drag the header to move, `Esc` to close.
- **No effect on normal windows.** `Cmd+N`, new tabs, and in-browser links behave exactly as before — only OS-external opens are rerouted.

## Install

### Via Sine (recommended)
1. Install Sine: https://github.com/CosmoCreeper/Sine
2. Push this `little-zen/` folder to a GitHub repo.
3. Zen → **Settings → Sine → "add your own locally from a GitHub repo"** → paste your repo URL.
4. Restart Zen. If the mod doesn't appear, clear the startup cache from `about:support` → *Clear startup cache*.

### Manual (drop-in)
1. `about:profiles` → your active profile → **Open root directory**.
2. Copy the whole `little-zen/` folder into `chrome/sine-mods/`.
3. Restart Zen (clear startup cache if needed).

## Settings

Zen → **Settings → Sine → Little Zen**:

| Setting | Default | What it does |
| --- | --- | --- |
| Enable Little Zen | on | Master switch for rerouting external links. |
| Swipe back to close | on | Two-finger back-swipe dismisses when there's no page to go back to. |
| Escape to close | on | `Esc` closes the little window. |
| Dim when inactive | on | Fades the window slightly when it loses focus. |
| Back direction | right | Which swipe direction counts as "back" (macOS default = right). |
| Width / Height | 480 / 640 | Little window size in px. |
| Swipe threshold | 0.25 | How far to swipe (0.1 easy → 0.5 deliberate) before it closes. |

Changes apply to the **next** little window you open.

## How it works

- `little-zen.uc.js` wraps this window's `browserDOMWindow.openURI`. OS-external opens arrive with the `nsIBrowserDOMWindow.OPEN_EXTERNAL` flag; we catch those and ask Zen for a new window.
- A `browser-delayed-startup-finished` observer tags that new window (`:root[littlezen="true"]`), resizes/centers it, injects the toolbar, and wires the gesture.
- The dismiss gesture hooks the `MozSwipeGesture*` events Firefox/Zen already fire for the macOS two-finger history swipe. When `canGoBack` is false, we claim the gesture, animate the native window via `moveTo`/`resizeTo`, and `close()` past the threshold.
- `style.css` scopes all styling under `:root[littlezen="true"]`, so normal windows are never affected.

## Known limitations

- **Cold start.** If Zen isn't already running when you open an external link, the OS opens the first window directly and it won't be a little window. Once Zen is running, every external link is little. (Matches how Little Arc effectively behaves.)
- **Zen version drift.** The chrome-stripping selectors in `style.css` target current Zen IDs. After a big Zen/Firefox update a stray toolbar strip may appear — inspect with the Browser Toolbox (`Cmd+Opt+Shift+I`) and add the offending ID to the "hide chrome" block.
- **Gesture availability.** Swipe-to-close relies on macOS trackpad swipe events (Firefox 111+ swipe tracking). If your build routes swipes differently, use the **✕** button or `Esc` — those always work.
- Tested against the Sine mod format as of Zen 1.21.x (Firefox 152). `.uc.js` runs with full chrome privileges, so review before installing — as you should with any userChrome script.

## Files

```
little-zen/
├── theme.json          # Sine metadata (declares the script + stylesheet)
├── preferences.json    # Settings UI shown in Sine
├── little-zen.uc.js    # The logic: intercept, shape, gesture, animate
├── style.css           # macOS-style little-window chrome
└── README.md
```
