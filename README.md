# Demo Markup

Mark up your screen recordings, then let an AI agent (Claude Code, Codex, or any other) do the editing.

Demo Markup is not a full video editor. It is a markup tool. You line up your recordings on a timeline, select parts of it, and say what should happen there: cut this, speed this up to 4 seconds, narrate this, put an intro graphic here. The tool saves your notes as a JSON edit spec next to your videos. Then you hand that spec to your agent, and it does the real work with ffmpeg, ElevenLabs, or whatever it needs.

Everything runs on your machine. Videos play straight from your disk and are never uploaded anywhere.

## Run it

Requires Node 20 or newer.

```bash
npm install
npm start -- ~/Movies/my-demo
```

Then open http://localhost:5173.

The folder you pass is your project folder. The editor lists the videos in it, and saves the edit spec there as `demo-markup.json`. If you leave the folder out, it uses `./media`. Videos you drop into the browser are copied into the project folder, so the agent can find them by path.

Use `--port 3000` to pick a different port.

## How to use it

1. **Add videos.** Drop screen recordings anywhere on the page, or use the Videos tab. Drag a clip by its title bar to reorder it.
2. **Select a part.** Drag across the timeline. Press Enter to play just that part. Pinch, Ctrl + scroll, or `+` / `-` to zoom.
3. **Mark it up.** With a range selected, pick an action:
   - **Label** (`L`): name the part, e.g. "Hook: the dashboard reveal".
   - **Cut** (`X`): remove it.
   - **Speed** (`R`): fit it into a target number of seconds.
   - **Narrate** (`N`): describe the voice-over for this range.
   - **Instruct** (`T`): any other direction for the AI.
   - **Split** (`S`): break the clip in two at the playhead (or at both ends of the selection).

   Click a single moment instead of dragging to add a point **Instruction** or **Label**, like "Show a fancy intro graphic here, then transition in."
4. **Hand it off.** Click **Copy prompt for AI** and paste it into Claude Code or Codex. The prompt points the agent at `demo-markup.json`.

Turn on **Preview edits** to watch a rough cut: cut ranges are skipped and speed ranges play faster.

Press `?` for all keyboard shortcuts.

## The edit spec

`demo-markup.json` is written for an agent to read. It contains:

- `agentBrief`: plain-language rules for applying the spec.
- `timeline.clips`: the clips in order, each with an absolute `path` and the `sourceIn` / `sourceOut` seconds to use.
- `annotations`: sorted by time. Each one has a `type` (`label`, `cut`, `speed`, `narration`, `instruction`), a `title`, the person's `instruction` text, the timeline times, and `sources`: the exact file and source seconds it covers. Speed annotations also carry `targetDuration` and `speedFactor`.
- `editor`: the raw editor state, used to reopen the project. Agents can ignore it.

Annotations are pinned to the footage, not to the timeline. If you reorder or split clips later, your notes stay on the right frames.

## Browser support

Chrome, Edge, Arc, and Safari work. Most screen recordings (H.264 `.mov` or `.mp4`) play fine. Some HEVC or ProRes files may not play in Chrome. Convert those to H.264 MP4 first, or use Safari.

## Develop

```bash
npm run typecheck
```

The app is React + Vite. `server/mediaServer.ts` is a small Vite plugin that serves videos from the project folder and reads and writes the spec. `src/model.ts` holds the timeline math and the spec builder.
