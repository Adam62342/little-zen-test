# Little Zen

Arc's Little Arc for Zen Browser on macOS.

- Links opened from other apps (Mail, Slack, Terminal, Messages…) open in a compact floating window with a minimal bar: back / forward, a host pill (click to copy the link), and "Open in Zen".
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

Open the Browser Console with **Cmd+Shift+J**.

**1. Is the script loading?** After a restart you should see:

```
[Little Zen] script loaded in normal window
[Little Zen] external link hook installed
```

If you see nothing, Sine isn't running the script. Re-check the two Sine settings above, the install path, and that `scripts` in `theme.json` points at `little-zen.uc.js`.

**2. Is the hook working?** Paste this into the console:

```js
Services.wm.getMostRecentWindow("navigator:browser").browserDOMWindow.openURI(
  Services.io.newURI("https://example.com"), null,
  Ci.nsIBrowserDOMWindow.OPEN_NEWTAB, Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
  Services.scriptSecurityManager.getSystemPrincipal()
);
```

A little window should open. If it does, the mod works and the only open question is step 3.

**3. Does a real external link reach the hook?** Click a link in another app and watch the console for a line like `[Little Zen] openURI https://… where: 3 flags: 1 external: true`.

- Line appears, but no little window: look for a red error right after it.
- No line at all: the link isn't coming through `openURI` (for example Zen was fully quit, or the link was handled by another path). Tell me what's logged and I'll adapt the hook.

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
