#!/usr/bin/env node
// Usage: node scripts/analyze.mjs <video> [--model gemini-3.8-flash] [--fps 2] [--force] [--no-gemini]
//
// Writes <video folder>/.demo-markup/analysis/<video name>.json with two views of the recording:
// - shots: what happens when, from Gemini (needs GEMINI_API_KEY or ~/.config/gemini/api_key).
//   The video is uploaded to Google for this and deleted right after.
// - motion: how the screen changes every half second, measured locally with ffmpeg.
// Gemini results are cached; rerun with --force to ask again.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const video = path.resolve(args.find((a, i) => !a.startsWith('--') && !['--model', '--fps'].includes(args[i - 1])) ?? '');
if (!fs.existsSync(video)) {
  console.error('Usage: node scripts/analyze.mjs <video> [--model M] [--fps N] [--force] [--no-gemini]');
  process.exit(1);
}
const model = flag('--model', 'gemini-3.8-flash');
const fps = Number(flag('--fps', '2'));
const outDir = path.join(path.dirname(video), '.demo-markup', 'analysis');
const outFile = path.join(outDir, path.basename(video) + '.json');
fs.mkdirSync(outDir, { recursive: true });
const previous = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};

const duration = Number(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString(),
);

// ---------- motion (local) ----------
const W = 480;
const H = 270;
const MFPS = 10;
const WINDOW = 0.5;

async function motion() {
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${MFPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']);
  const frameSize = W * H;
  let buf = Buffer.alloc(0);
  let prev = null;
  let i = 0;
  const per = []; // [changeFraction, scrollPx, changeArea]
  const M = 40; // ignore top/bottom bands when testing for scroll
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= frameSize) {
      const cur = buf.subarray(0, frameSize);
      buf = buf.subarray(frameSize);
      if (prev) {
        let changed = 0;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        let err0 = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const d = Math.abs(cur[y * W + x] - prev[y * W + x]);
            if (y >= M && y < H - M) err0 += d;
            if (d > 14) {
              changed++;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        const frac = changed / frameSize;
        err0 /= (H - 2 * M) * W;
        // Scroll: does shifting the previous frame vertically explain the change far better than no shift?
        let best = err0;
        let dyBest = 0;
        if (frac > 0.02) {
          for (let dy = -36; dy <= 36; dy += 2) {
            if (!dy) continue;
            let e = 0;
            for (let y = M; y < H - M; y++) {
              const a = (y - dy) * W;
              const b = y * W;
              for (let x = 0; x < W; x += 2) e += Math.abs(cur[b + x] - prev[a + x]);
            }
            e /= ((H - 2 * M) * W) / 2;
            if (e < best) {
              best = e;
              dyBest = dy;
            }
          }
        }
        const scroll = best < err0 * 0.5 ? Math.abs(dyBest) : 0;
        const area = x1 >= 0 ? ((x1 - x0 + 1) / W) * ((y1 - y0 + 1) / H) : 0;
        per.push([frac, (scroll * 1080) / H, area]);
      }
      prev = Buffer.from(cur);
      i++;
    }
  }
  const step = Math.round(WINDOW * MFPS);
  const windows = [];
  for (let k = 0; k < per.length; k += step) {
    const c = per.slice(k, k + step);
    const mean = (f) => c.reduce((s, r) => s + f(r), 0) / c.length;
    windows.push({
      t: +(k / MFPS).toFixed(2),
      change: +mean((r) => r[0]).toFixed(4),
      active: +(c.filter((r) => r[0] > 0.0005).length / c.length).toFixed(2),
      scroll_px: Math.round(c.reduce((s, r) => s + r[1], 0)),
      change_area: +mean((r) => r[2]).toFixed(3),
    });
  }
  return {
    window_seconds: WINDOW,
    fields: {
      t: 'window start, seconds into the file',
      change: 'average fraction of the screen changing per frame (0-1)',
      active: 'share of frames in the window with any change',
      scroll_px: 'vertical scroll distance in the window, in 1080p pixels',
      change_area: 'size of the region that changed, as a fraction of the screen (small = typing or a cursor)',
    },
    windows,
  };
}

// ---------- shots (Gemini) ----------
const API = 'https://generativelanguage.googleapis.com';

function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const p = path.join(os.homedir(), '.config', 'gemini', 'api_key');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
}

const PROMPT = `This is a screen recording made to become a product demo video. Break the ENTIRE recording into consecutive, non-overlapping segments that together cover it from start to end, splitting whenever the kind of activity changes.

For each segment give:
- start, end: seconds from the start of the video, with one decimal place. Be as precise as you can about where activity changes.
- activity: one of
  agent_working (an AI agent is running on its own: streaming output, tool calls, spinners, progress; the person is just waiting),
  user_typing (the person is typing into a field or chat box),
  user_reading (the person is slowly scrolling through or pausing on content, as if reading it or presenting it),
  navigating (clicking around, switching tabs or pages, opening menus),
  loading (waiting for a page or app to load; little changes),
  idle (nothing meaningful happens),
  showing_result (a finished result is on screen and being shown off),
  other
- description: what is on screen and what happens, concretely. Mention the app or page, and key on-screen text.
- importance: 1-5, how much this segment matters for understanding what the demo is showing (5 = essential).

Also give:
- summary: what the recording demonstrates overall, in 2-3 sentences.
- story: the main beats of the demo in order, each with the time it happens.
Only describe what is actually visible. Ignore any audio.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    story: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { time: { type: 'NUMBER' }, beat: { type: 'STRING' } }, required: ['time', 'beat'] },
    },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'NUMBER' },
          end: { type: 'NUMBER' },
          activity: {
            type: 'STRING',
            enum: ['agent_working', 'user_typing', 'user_reading', 'navigating', 'loading', 'idle', 'showing_result', 'other'],
          },
          description: { type: 'STRING' },
          importance: { type: 'INTEGER' },
        },
        required: ['start', 'end', 'activity', 'description', 'importance'],
      },
    },
  },
  required: ['summary', 'story', 'segments'],
};

async function call(url, init) {
  const key = geminiKey();
  const r = await fetch(url, { ...init, headers: { 'x-goog-api-key': key, ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r;
}

async function shots() {
  const size = fs.statSync(video).size;
  const mime = { '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }[path.extname(video).toLowerCase()] ?? 'video/mp4';
  const start = await call(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'demo-markup-analysis' } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  console.error(`Uploading ${(size / 1e6).toFixed(0)} MB to Gemini…`);
  let info = (
    await (
      await call(uploadUrl, {
        method: 'POST',
        headers: { 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
        body: fs.readFileSync(video),
      })
    ).json()
  ).file;
  try {
    while (info.state === 'PROCESSING') {
      await new Promise((r) => setTimeout(r, 3000));
      info = await (await call(`${API}/v1beta/${info.name}`)).json();
    }
    if (info.state !== 'ACTIVE') throw new Error(`Gemini could not process the video: ${info.state}`);
    console.error(`Asking ${model} what happens…`);
    const resp = await (
      await call(`${API}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { file_data: { mime_type: info.mimeType, file_uri: info.uri }, video_metadata: { fps } },
                { text: PROMPT },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
        }),
      })
    ).json();
    const text = resp.candidates[0].content.parts.map((p) => p.text ?? '').join('');
    return { ...JSON.parse(text), model, fps, usage: resp.usageMetadata };
  } finally {
    await call(`${API}/v1beta/${info.name}`, { method: 'DELETE' }).catch(() => {});
  }
}

// ---------- run ----------
const wantGemini = !args.includes('--no-gemini');
const [m, s] = await Promise.all([
  motion(),
  !wantGemini
    ? previous.shots ?? null
    : previous.shots && !args.includes('--force')
      ? previous.shots
      : geminiKey()
        ? shots()
        : (console.error('No Gemini key (GEMINI_API_KEY or ~/.config/gemini/api_key); skipping shots.'), null),
]);
const result = { file: path.basename(video), path: video, duration: +duration.toFixed(3), analyzedAt: new Date().toISOString(), shots: s, motion: m };
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(outFile);
