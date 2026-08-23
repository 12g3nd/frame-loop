# Frame Loop

A Chrome (Manifest V3) extension that loops any HTML5 video between two **frame-accurate** points (not just the whole clip). Built to work where most loopers don't, including players that hide the `<video>` inside a shadow DOM that ordinary extensions can't reach.

## Install (unpacked)

1. Unzip this folder somewhere permanent.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `frame-loop` folder.
5. Open a page with a video. A small **Frame Loop** panel appears in the bottom-right corner.

Works in any Chromium browser (Chrome, Edge, Brave, Arc, Opera).

## Using it

The panel automatically controls whichever video you last **played**. To grab a different one, click **Use largest**.

- **Set A / Set B** — mark the start and end of the loop at the current frame. Both snap to exact frame boundaries.
- **-1 / +1 (arrow icons)** next to A or B — nudge that point one frame earlier/later.
- **Seek (arrow icon)** — jump the video to A or B.
- **Loop A–B** — start/stop looping the marked segment.
- **Timeline** — the amber marker is A, teal is B, the highlighted span is the loop. Click anywhere on it to seek.
- **fps** — the frame rate is auto-detected while the video plays. If detection is off, type the real value (24, 25, 30, 60, or exact ones like 29.97) and it switches to manual. Click **auto** to go back.
- Drag the header to move the panel. **Minimize / Close** buttons are at the top right (a small round button in the corner brings it back, or use the toolbar popup).

### Keyboard shortcuts

| Key | Action                 |
| --- | ---------------------- |
| `[` | Set A at current frame |
| `]` | Set B at current frame |
| `\` | Toggle loop            |
| `,` | Step back one frame    |
| `.` | Step forward one frame |

Shortcuts are ignored while you're typing in a text field.

## Known limitations

- **Streamed video may hiccup on loop.** On DASH/HLS players (like Twitter and many others), jumping back to A can trigger a brief buffer fetch. Short loops that sit fully inside the buffered range are smooth; long jumps may stutter. This is a property of streamed media, not the loop logic.
- **Very early players.** If a site attaches its shadow root before `inject.js` runs (rare) or ships a server-rendered *declarative* shadow root, the video may be unreachable. Reloading the page once usually fixes it.
- **Cross-origin iframes** (e.g. an embedded YouTube inside another site) can't be reached — browsers forbid it. Native first-party videos are fine.
- **Audio on some sites** is a separate stream the player syncs itself; after a loop jump it may realign a beat late. Video frames are exact.
- **YouTube** already binds `,` / `.` for frame stepping, so those keys may act twice there. The panel itself still works. Frame Loop's focus is general HTML5 video.

## Files

- `manifest.json` — MV3 config, registers both content scripts.
- `inject.js` — MAIN-world shadow-DOM opener (document-start).
- `content.js` — video discovery, fps detection, loop engine, control panel.
- `popup.html` / `popup.js` — toolbar popup (show/hide, global fps, help).
- `icons/` — extension icons.
