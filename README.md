# Dia Swipe

Dia-style trackpad navigation for Zen, packaged as a Sine mod.

- **Swipe back or forward** with two fingers: a white bubble with an arrow slides in from the edge and grows as you swipe.
- **Arm point**: when the swipe passes the point where lifting your fingers would navigate, the arrow darkens and pops, with a haptic tick if your build supports it.
- **Hold**: keep your fingers still on the trackpad for about 0.4s after the arrow arms, and a list of the pages in that tab's history opens next to the bubble.
- **Scrub**: without lifting, keep swiping in the same direction to move down the list (about 33px per row). Swipe back toward the edge to move up. Push to the far end to auto-scroll.
- **Release** to jump straight to the highlighted page. Pull nearly all the way back to the edge before lifting to cancel.

## Install

1. Copy the `dia-swipe` folder into your profile at `chrome/sine-mods/dia-swipe`, or push it to a GitHub repo and add that repo in Settings → Sine.
2. Restart Zen. If nothing changes, clear the startup cache from `about:support` and restart again.

Make sure `browser.gesture.swipe.left` / `.right` are still set to the default back/forward commands.

## Tuning

The constants at the top of `dia-swipe.uc.js` control the feel: `HOLD_DELAY_MS`, `ROW_STEP`, `CANCEL_BELOW`, `RELEASE_SPEED`.

## Notes

- Firefox's swipe tracker only reports horizontal movement during a swipe, so the list is scrubbed by sliding sideways, not up and down.
- A mod can only trigger haptics through Gecko's `nsIHapticFeedback` service. Where your build doesn't provide it, the haptic calls do nothing.
