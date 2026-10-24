# Dia Swipe

Dia-style trackpad navigation for Zen, packaged as a Sine mod.

- **Swipe back or forward** with two fingers: a white bubble with an arrow slides in from the edge and grows as you swipe.
- **Arm point**: when the swipe passes the point where lifting your fingers would navigate, the arrow darkens and pops, with a haptic tick if your build supports it.
- **Hold**: keep your fingers still on the trackpad for about 0.4s after the arrow arms, and the bubble itself grows into a list of the pages in that tab's history.
- **Scrub**: without lifting, swipe back toward the screen edge to move down the list (about 16px per row) and swipe further out to move up. Holding at either end auto-scrolls.
- **Release** to jump straight to the highlighted page. Scrub two rows above the top entry before lifting to cancel.

## Install

1. Copy the `dia-swipe` folder into your profile at `chrome/sine-mods/dia-swipe`, or push it to a GitHub repo and add that repo in Settings → Sine.
2. Restart Zen. If nothing changes, clear the startup cache from `about:support` and restart again.

Make sure `browser.gesture.swipe.left` / `.right` are still set to the default back/forward commands.

## Tuning

The constants at the top of `dia-swipe.uc.js` control the feel: `HOLD_DELAY_MS`, `ROW_STEP`, `CANCEL_STEPS`, `RELEASE_SPEED`.

## Notes

- Firefox's swipe tracker only reports horizontal movement during a swipe, so the list is scrubbed by sliding sideways, not up and down.
- Haptics call macOS's `NSHapticFeedbackManager` through js-ctypes. They need a Force Touch trackpad and "Force Click and haptic feedback" turned on in System Settings → Trackpad.
