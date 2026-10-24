# Swipe Back

Dia-style back gesture for Zen.

- Two-finger swipe right on the trackpad: a white arrow bubble slides in from the left edge.
- Past the snap point the bubble pops (and fires haptics where the platform allows). Release to go back.
- Keep holding: after a moment a list of earlier pages in this tab opens. Scroll down to move further back, release to jump there.
- Pull the swipe back before releasing (or press Esc) to cancel.

Uses the browser's swipe gesture events (macOS and Windows precision touchpads). Linux touchpads don't emit them.
