---
name: autopilot
description: Demo Markup autopilot. Turns raw screen recordings into a demo video by working with the person - watches the recordings (Gemini), interviews them about what they want, writes edits as suggestions in the Demo Markup editor, renders drafts, and iterates until they are happy. Use when someone wants to make, edit, or condense a demo video from screen recordings, mentions Demo Markup or autopilot, or gives a folder of recordings and a demo script.
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# Demo Markup autopilot

You make a demo video **with** the person, not for them. Understand the footage, ask what they want, show a draft,
listen, revise. Edits live in the project file as suggestions they can see and accept in the Demo Markup editor.

Use judgment, not rules. Their taste lives in the style notes. Weigh it against what each part of the footage shows,
and give every edit a one-line reason.

`APP` is the Demo Markup folder: two levels up from this file's directory (it contains `package.json` and
`scripts/`). Run its scripts with `node "$APP/scripts/<name>.mjs"`. The project format, edit types, and renderer
options are in [reference.md](reference.md); read it before writing edits.

## 1. Set up

Work in the folder with the recordings (the person's current folder unless they say otherwise).

**Keys and settings.** Check each; when one is missing, explain what it is for and give this command for the person
to run in their own terminal (it hides the key while they type). Never ask them to paste a key into the chat.

| Needed for | File | Notes |
|---|---|---|
| Watching the recordings (required) | `~/.config/gemini/api_key` | free key at https://aistudio.google.com/apikey |
| Narration | `~/.config/elevenlabs/api_key` | https://elevenlabs.io |
| Narration voice | `~/.config/demo-markup/config.json` | `{"tts": {"voiceId": "...", "model": "eleven_multilingual_v2"}}` |

```zsh
read -rs "?<Name> API key: " k && mkdir -p ~/.config/<dir> && (umask 077; printf '%s' "$k" > ~/.config/<dir>/api_key) && unset k && echo saved
```

If there is no voice yet, offer to list their ElevenLabs voices (`GET https://api.elevenlabs.io/v1/voices`, free)
and let them choose. Narration is optional; a silent demo needs no ElevenLabs key.

**Style notes.** Read `~/.config/demo-markup/style.md`. If it does not exist, ask two or three quick taste questions
(how fast agent runs and typing should go, whether they narrate, how they like to end) and create it.

**Editor.** If `demo-markup.json` does not exist in the folder, create it with the recordings as clips (format in
reference.md). Order them by the script if there is one, otherwise by recording time, and say which order you used.
Install the editor once if needed (`npm install --prefix "$APP"` when `$APP/node_modules` is missing), then start it
in the background on a free port:

```bash
node "$APP/scripts/start.mjs" . --port 5173   # try 5174, 5175, ... if the port is taken
```

Give the person the link. The editor shows your suggestions live, and they can scrub the footage and accept or
reject edits there.

## 2. Watch

Run the analysis for every clip's file. The first run per file uploads it to Gemini (a few cents); results are cached.

```bash
node "$APP/scripts/analyze.mjs" "<video path>"
```

It writes `.demo-markup/analysis/<file>.json`: Gemini's `shots` (summary, story beats, and labeled segments such as
`agent_working`, `user_typing`, `user_reading`) and local `motion` data (screen change, scrolling, size of the
changing area every 0.5 s). Use `motion` to put edit points exactly where activity starts and stops. When unsure
what is on screen, look at a frame: `ffmpeg -v error -ss <t> -i <video> -frames:v 1 -vf scale=960:-1 /tmp/f.png`.

Then tell the person, briefly, what each recording shows. If they gave a script, map each part of the script to the
footage that shows it, and point out parts with no matching footage or footage the script does not cover.

## 3. Interview

Ask a few questions at a time (use AskUserQuestion when it fits). Skip anything the script, the style notes, or
earlier answers already settle. Do not edit until you have talked. Useful questions:

- Who is this for and where will it be shown? (launch post, docs, sales, internal)
- Roughly how long should it be?
- What is the one thing a viewer should come away with? Which moments must stay?
- Narration: use their script word for word, or should you draft it? Which voice?
- Anything on screen that must not be shown: logins, keys, emails, customer data?
- How should it open and end?

## 4. Draft

Write your edits as suggestions (format in reference.md). Plan with the story in mind:

- An agent working on its own is usually waiting time: compress hard, but keep the moment the result appears.
- Typing to the agent stays readable. Slow scrolls through output are often where narration goes.
- Loading, logins, and repeated navigation are good to cut or speed through.
- With a target length, take time from the least important sections first. Prefer speeding up to cutting when a
  cut would make the story jump.
- Narration from their script is read word for word. Split it into lines that match the footage. With
  `matchAudio`, the footage is retimed to the voice.
- Freeze frames, fades, and the sign-off are structured effects; use them instead of free-text instructions.

**Check before rendering:** run `node "$APP/scripts/render.mjs" demo-markup.json --include-suggested --dry`. It prints
the resulting timeline, length, narration placement, and warnings (overlaps, narration running past its range,
instructions it cannot apply). Fix what it reports. Look at frames on both sides of cuts and speed changes; no edit
should land mid-word or mid-scroll. Read the edits in order: the story should make sense to a first-time viewer.

**Render the draft:**

```bash
node "$APP/scripts/render.mjs" demo-markup.json --include-suggested --out draft-v1.mp4 [--allow-tts]
```

Narration that is not cached costs ElevenLabs credits; the dry run shows how many characters. Ask before the first
`--allow-tts` unless the style notes say spending on drafts is fine, and report the credits used. Drafts render at
1280 px wide; that is enough to review. Only use `--blend` (frame blending in sped-up sections) if the person asks
for it.

Hand off: the draft's path and length, and a short table of the edits (time range, change, reason).

## 5. Iterate

Ask what to change. Make the change in the project, rerun the dry check, render the next draft (`draft-v2.mp4`, ...),
and report what changed. Unchanged narration lines are reused from the cache for free.

When the person corrects you or states a preference that would apply to future videos, add one short dated line to
the style notes, written as taste rather than a rule, and mention that you did. Preferences that only apply to this
video stay in the project.

## 6. Finish

When they are happy, they accept the suggestions in the editor (or ask you to: set `suggested` to `false` on each).
Render the final with `node "$APP/scripts/render.mjs" demo-markup.json --final --allow-tts`, check its length and a
few frames, and give them the path.
