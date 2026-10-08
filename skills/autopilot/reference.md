# Demo Markup reference

## Project file

`demo-markup.json` sits next to the recordings. Only the `editor` section is yours to write; the editor regenerates
the rest when it saves. To save, write the whole file to a temporary path in the same folder, then rename it over
`demo-markup.json`. The editor picks the change up within a second.

A new project:

```json
{
  "format": "demo-markup/v1",
  "mediaDir": "/absolute/path/to/the/folder",
  "editor": {
    "clips": [
      { "id": "clip-install", "file": "Install.mov", "sourceIn": 0, "sourceOut": 184.2, "sourceDuration": 184.2 }
    ],
    "annotations": []
  }
}
```

- `file` is a file name inside the folder. `sourceIn`/`sourceOut` trim the clip, in seconds of that file. Get the
  length with `ffprobe -v error -show_entries format=duration -of csv=p=0 <file>`.
- Clips play in array order. The timeline is the clips joined end to end.

## Annotations

```json
{
  "id": "ap-1a2b3c",
  "kind": "speed",
  "start": { "clipId": "clip-run", "t": 152.5 },
  "end": { "clipId": "clip-run", "t": 886.0 },
  "title": "Agent builds and tests the workflow",
  "text": "",
  "targetDuration": 5,
  "suggested": true,
  "reason": "Long agent run; nothing to read until 'Done' appears. 733.5 s -> 5 s."
}
```

- `start.t` / `end.t` are seconds into the **source file** of that clip, not timeline time. A point annotation has
  `"end": null`. A range may start in one clip and end in another.
- `id`: unique; start yours with `ap-`.
- `suggested: true` and a one-line `reason` on everything you propose. Never change annotations without
  `suggested: true`: the person made or accepted those. Remove your own stale suggestions when you replace them.

| kind | fields | effect when rendered |
|---|---|---|
| `cut` | | removes the range |
| `speed` | `targetDuration` (seconds) | retimes the range to last that long |
| `narration` | `text`, optional `matchAudio`, `audioOffset` | `text` is read word for word, starting `audioOffset` seconds (default 0) after the range starts. With `matchAudio: true` the range is retimed to the audio's length (plus the offset). |
| `label` | `title` | none; names a part of the video |
| `instruction` | `effect`, see below | free-text instructions are not rendered; the renderer lists them |

Effects (`kind: "instruction"`):

- `"effect": "freeze", "freezeFrame": { "clipId": "...", "t": 33.9 }`: shows that source frame over the range while
  narration continues. Use it to hold on, or cut away to, a key screen.
- `"effect": "fade-to-black", "fadeDuration": 1`: fades to black over `fadeDuration` seconds from the range start and
  stays black. Only at the end of the video. For a sign-off over black, cover the last moments with the fade range
  and put a `matchAudio` narration on the same range with `audioOffset` equal to the fade duration.

Rules the renderer enforces: cuts, speed ranges, and `matchAudio` narrations must not overlap one another.
Narration without `matchAudio` may overlap anything, but should fit inside its range (the dry run warns when not).

Pauses in narration: ElevenLabs reads `<break time="0.5s" />` tags in the text as a pause. Use them sparingly, for
example after an opening line.

## Renderer

```
node scripts/render.mjs <demo-markup.json> [options]
  --dry                 print the plan (timeline, length, narration, warnings) without rendering or spending
  --include-suggested   apply suggestions that are not accepted yet (drafts)
  --out <file>          output path
  --final               1920 px, higher quality; default is a faster 1280 px draft
  --allow-tts           generate narration audio that is not cached (costs ElevenLabs credits; prints the cost)
  --no-narration        silent render; audio-matched ranges keep their timing using cached or estimated lengths
  --blend               blend frames in sped-up sections so the cursor moves smoothly
  --voice <id>          ElevenLabs voice for this render (default: ~/.config/demo-markup/config.json)
```

Narration audio is cached in `.demo-markup/tts/`, keyed by voice, model, and text, so unchanged lines are free on
later renders. Exit code 2 means narration needs generating and `--allow-tts` was not given.

## Analysis

`node scripts/analyze.mjs <video> [--force] [--no-gemini] [--model M] [--fps N]` writes
`.demo-markup/analysis/<file>.json`:

- `shots.summary`, `shots.story` (beats with times), `shots.segments` (consecutive sections with `start`, `end`,
  `activity`, `description`, `importance` 1-5). Times are seconds into the file, good to about half a second.
- `motion.windows`: every 0.5 s, `change` (share of the screen changing), `active` (share of frames with any change),
  `scroll_px` (vertical scrolling), `change_area` (size of the changing region; small means typing or the cursor).
