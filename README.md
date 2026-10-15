# Little Zen

Arc's Little Arc for Zen Browser on macOS.

- Links opened from other apps (Mail, Slack, Terminal, Messages…) open in a compact floating window that has only a top bar: traffic lights, an address field (shows the host; click to edit the full URL), and an "Open in main window" button. No sidebar, no tab strip.
- Swipe back with no history left: the window slides slightly right and shrinks as you swipe, a close hint appears on the left, and releasing past the threshold closes it. Releasing early glides it back.
- `Cmd+[` with no history closes it the same way.
- Links that try to open a new tab (`target=_blank`) are moved into your main window.

## Layout

```
little-zen/
├── theme.json          # Sine manifest (declares the script + style)
├── chrome.css
├── preferences.json
└── little-zen.uc.js    # must be listed under "scripts" in theme.json
```

## Install (Sine)

1. Push this folder to a GitHub repo (files at the repo root) and replace `YOUR-USERNAME` in `theme.json`.
2. Zen → Settings → **Sine Mods** → Sine settings:
   - enable installing **unpublished / unofficial** mods
   - enable the **unsafe JS** option (this mod contains JavaScript; without it Sine silently skips the script)
3. Install the mod by its repo name (`your-username/little-zen`).
4. Restart Zen. After the first install, also run `about:support` → **Clear startup cache**, then restart again.

macOS must have System Settings → Trackpad → More Gestures → **Swipe between pages** turned on.

## Step-by-step diagnosis

Open the Browser Console with **Cmd+Shift+J** and paste each snippet.

**1. Is the script loaded, and is the hook in place?**

```js
(() => {
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  return {
    scriptLoaded: !!w.__littleZen,
    version: w.__littleZen?.version,
    hookInstalled: !!w.browserDOMWindow?.__lz,
    prefExternalLinks: Services.prefs.getBoolPref("mod.littlezen.external_links", null),
  };
})()
```

| Result | Meaning |
| --- | --- |
| `scriptLoaded: false` | Sine isn't running the script. See "If the script isn't loading" below. |
| `scriptLoaded: true`, `hookInstalled: false` | Script ran but couldn't patch `openURI`. Look for `[Little Zen]` lines in the console. |
| both `true`, `prefExternalLinks: false` | The checkbox pref is off. Run `Services.prefs.setBoolPref("mod.littlezen.external_links", true)`. |
| both `true` and pref `true`/`null` | Hook is live. Go to step 2. |

**2. Fire a fake external link:**

```js
Services.wm.getMostRecentWindow("navigator:browser").browserDOMWindow.openURI(
  Services.io.newURI("https://example.com"), null,
  Ci.nsIBrowserDOMWindow.OPEN_NEWTAB, Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
  Services.scriptSecurityManager.getSystemPrincipal()
);
```

The console should log `[Little Zen] openURI … external: true` followed by either `opening in Little Zen window` or the reason it fell back.

**3. Click a real link in another app** and watch for the same `openURI` log line. If nothing is logged, the link isn't arriving through `openURI`.

### If the script isn't loading

First rule out Sine by loading the script directly into your current window (use your real path):

```js
Services.scriptloader.loadSubScript(
  "file:///Users/YOU/path/to/little-zen/little-zen.uc.js",
  Services.wm.getMostRecentWindow("navigator:browser")
);
```

Then run step 2. A little window opening (it will look like plain Zen, because the CSS isn't active) proves the logic works and the problem is Sine loading the mod. Check:

- Sine → unpublished/unofficial mod installs enabled, and the **unsafe JS** option enabled.
- The installed mod's `theme.json` has the `scripts` block (an older copy installed earlier won't).
- Remove and reinstall the mod, then `about:support` → **Clear startup cache**, then restart.

## Window sync (why a link can also show up in your main window)

Zen mirrors tabs between windows by default ("Window Sync"). A normal second window therefore shows your sidebar and any tab opened in it appears everywhere. Little Zen opens a tabless, popup-style window to stay out of that. After a link opens, the console logs:

```
[Little Zen] little window tab count: 1 | toolbar.visible: false | body children: …
```

- `tab count: 1` and `toolbar.visible: false`: the window is separate from sync, as intended.
- `tab count` > 1: Zen is still mirroring tabs into it. Run this and send me the output, so I can target Zen's own "blank window" mechanism instead:

```js
(() => {
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  return {
    globals: Object.keys(w).filter(k => /zen.*(sync|blank|window)/i.test(k)),
    menuItems: [...w.document.querySelectorAll("[id*=blank i],[command*=blank i],[data-l10n-id*=blank i]")]
      .map(e => e.id || e.getAttribute("command") || e.getAttribute("data-l10n-id")),
  };
})()
```

If the little window shows part of Zen's UI, the `body children:` list in that log line tells me which elements to hide.

## Other symptoms

| Symptom | Likely cause / fix |
| --- | --- |
| Little window shows Zen's sidebar or toolbar | Zen renamed an element. Inspect it in the Browser Toolbox and add its ID to the hide list at the top of `chrome.css`. |
| Swipe does nothing | Check `widget.disable-swipe-tracker` is `false` in `about:config`. |
| Swipe feels reversed | RTL locale. Change `DIRECTION_LEFT` to `DIRECTION_RIGHT` in `setupSwipe()`. |
| Edges look flat while swiping | Adjust `--lz-backdrop` in `chrome.css`. |

## Known limitations

- A link that launches Zen from fully quit (no windows) opens a normal window; there's no existing browser to hook.
- Closed little windows can show up in "Recently closed windows".
