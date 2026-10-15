# Little Zen

Arc's Little Arc for Zen Browser on macOS.

- Links opened from other apps (Mail, Slack, Terminal, Messages…) open in a compact floating window with a minimal bar: back / forward, a host pill (click to copy the link), and "Open in Zen".
- Swipe back with no history left: the window slides slightly right and shrinks as you swipe, a close hint appears on the left, and releasing past the threshold closes it. Releasing early glides it back.
- `Cmd+[` with no history closes it the same way.
- Links that try to open a new tab (`target=_blank`) are moved into your main window.

## Install

1. Put this folder in a GitHub repo and update the URLs in `theme.json`.
2. In Zen: Settings → Sine → install a mod from the repo URL.
3. Make sure Sine's JavaScript support is enabled. Scripts from the mod's `js/` folder run in each browser window.
4. Restart Zen.

macOS must have System Settings → Trackpad → More Gestures → **Swipe between pages** turned on.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Links still open in the main window | JS isn't loading, or Zen changed `openURI`. Open the Browser Console (Cmd+Shift+J) and look for `[Little Zen]`. |
| Little window shows Zen's sidebar or toolbar | Zen renamed an element. Inspect it in the Browser Toolbox and add its ID to the hide list at the top of `chrome.css`. |
| Swipe does nothing | Check `widget.disable-swipe-tracker` is `false` in `about:config`. |
| Swipe feels reversed | You're in an RTL locale. Change `DIRECTION_LEFT` to `DIRECTION_RIGHT` in `setupSwipe()`. |
| Edges look flat/transparent while swiping | Adjust `--lz-backdrop` in `chrome.css`. |

## Known limitations

- A link that launches Zen from fully quit (no windows at all) opens a normal window; there's no existing browser to hook.
- Closed little windows can show up in "Recently closed windows".
