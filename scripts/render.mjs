#!/usr/bin/env node
// Renders a Demo Markup project into a video.
//
// Usage: node scripts/render.mjs <demo-markup.json> [options]
//   --out <file>          output path (default: <project folder>/<name>-draft.mp4, or -final.mp4 with --final)
//   --include-suggested   also apply suggestions that have not been accepted yet (for drafts)
//   --final               full quality (default is a faster draft encode at 1280 px wide)
//   --allow-tts           allow generating narration audio that is not cached yet (costs ElevenLabs credits)
//   --no-narration        render without narration audio
//   --blend               blend frames in sped-up sections so the cursor moves smoothly instead of jumping
//   --dry                 print the plan without rendering
//
// Reads the `editor` section of the project. Annotations it applies:
//   cut                           remove the range
//   speed + targetDuration        retime the range to last targetDuration seconds
//   narration + text              voice-over (ElevenLabs), placed at the range start (+ audioOffset seconds);
//                                 with matchAudio the range is retimed to the audio's length
//   instruction + effect          "freeze": show the freezeFrame source frame over the range
//                                 "fade-to-black": fade over fadeDuration seconds (default 1) and stay black;
//                                 only at the end of the video
// Narration audio is cached in <project folder>/.demo-markup/tts/, keyed by voice, model, and text.
// Settings: ~/.config/demo-markup/config.json {"tts": {"voiceId": "...", "model": "eleven_multilingual_v2"}}
// Key: ELEVENLABS_API_KEY or ~/.config/elevenlabs/api_key.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);
const projectPath = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? '');
if (!fs.existsSync(projectPath)) {
  console.error('Usage: node scripts/render.mjs <demo-markup.json> [--out f] [--include-suggested] [--final] [--allow-tts] [--no-narration] [--blend] [--dry]');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
const folder = path.dirname(projectPath);
const mediaDir = fs.existsSync(path.join(folder, spec.editor.clips[0]?.file ?? '')) ? folder : spec.mediaDir;
const final = has('--final');
const out = path.resolve(opt('--out', path.join(folder, `${path.basename(folder)}-${final ? 'final' : 'draft'}.mp4`)));
const log = (...a) => console.error(...a);
const EPS = 1e-6;

// ---------- timeline ----------
const clips = spec.editor.clips;
const clipLen = (c) => c.sourceOut - c.sourceIn;
const starts = [];
clips.reduce((t, c) => (starts.push(t), t + clipLen(c)), 0);
const duration = clips.reduce((t, c) => t + clipLen(c), 0);
const anchorTime = (a) => {
  const i = clips.findIndex((c) => c.id === a?.clipId);
  if (i < 0) return null;
  return starts[i] + Math.min(Math.max(a.t - clips[i].sourceIn, 0), clipLen(clips[i]));
};
const anns = spec.editor.annotations
  .filter((a) => has('--include-suggested') || !a.suggested)
  .map((a) => {
    const s = anchorTime(a.start);
    const e = a.end ? anchorTime(a.end) : s;
    return s == null || e == null ? null : { ...a, s: Math.min(s, e), e: Math.max(s, e) };
  })
  .filter(Boolean)
  .sort((x, y) => x.s - y.s);

// ---------- narration audio ----------
const config = (() => {
  const p = path.join(os.homedir(), '.config', 'demo-markup', 'config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
})();
const voiceId = opt('--voice', config.tts?.voiceId);
const ttsModel = config.tts?.model ?? 'eleven_multilingual_v2';
const ttsDir = path.join(folder, '.demo-markup', 'tts');
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
// With --no-narration the audio is left out, but audio-matched ranges keep their timing (cached or estimated length).
const silent = has('--no-narration');
const narrations = anns.filter((a) => a.kind === 'narration' && a.text?.trim());
if (narrations.length && !voiceId && !silent) {
  log('No narration voice set. Add {"tts": {"voiceId": "<ElevenLabs voice id>"}} to ~/.config/demo-markup/config.json, pass --voice <id>, or use --no-narration.');
  process.exit(1);
}
for (const a of narrations) {
  const hash = crypto.createHash('sha1').update(`elevenlabs|${voiceId ?? ''}|${ttsModel}|${a.text.trim()}`).digest('hex').slice(0, 16);
  a.audioFile = path.join(ttsDir, `${hash}.mp3`);
  a.cached = fs.existsSync(a.audioFile);
  a.audio = a.cached ? probe(a.audioFile) : a.text.trim().split(/\s+/).length / 2.6; // estimate until generated
}
const missing = silent ? [] : narrations.filter((a) => !a.cached);
const missingChars = missing.reduce((n, a) => n + a.text.trim().length, 0);
if (missing.length && has('--allow-tts') && !has('--dry')) {
  const key = process.env.ELEVENLABS_API_KEY?.trim() ?? (() => {
    const p = path.join(os.homedir(), '.config', 'elevenlabs', 'api_key');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
  })();
  if (!key) {
    log('No ElevenLabs key: set ELEVENLABS_API_KEY or save it to ~/.config/elevenlabs/api_key.');
    process.exit(1);
  }
  fs.mkdirSync(ttsDir, { recursive: true });
  let credits = 0;
  for (const a of missing) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: a.text.trim(), model_id: ttsModel }),
    });
    if (!r.ok) {
      log(`ElevenLabs HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      process.exit(1);
    }
    credits += Number(r.headers.get('character-cost') ?? 0);
    fs.writeFileSync(a.audioFile, Buffer.from(await r.arrayBuffer()));
    a.cached = true;
    a.audio = probe(a.audioFile);
  }
  log(`Generated ${missing.length} narration clip(s): ${missingChars} characters, ${credits} ElevenLabs credits.`);
} else if (missing.length && !has('--dry')) {
  log(`${missing.length} narration clip(s) are not generated yet (${missingChars} characters of ElevenLabs credits).`);
  log('Rerun with --allow-tts to generate them, or --no-narration for a silent render.');
  process.exit(2);
}

// ---------- retimed ranges ----------
const ranges = [];
for (const a of anns) {
  if (a.e - a.s < EPS) continue;
  if (a.kind === 'cut') ranges.push({ s: a.s, e: a.e, speed: 0, why: 'cut', a });
  else if (a.kind === 'speed' && a.targetDuration > 0) ranges.push({ s: a.s, e: a.e, speed: (a.e - a.s) / a.targetDuration, why: 'speed', a });
  else if (a.kind === 'narration' && a.matchAudio && a.audio)
    ranges.push({ s: a.s, e: a.e, speed: (a.e - a.s) / ((a.audioOffset ?? 0) + a.audio), why: 'narration', a });
}
const overlaps = [];
for (let i = 1; i < ranges.length; i++)
  if (ranges[i].s < ranges[i - 1].e - 1e-3) overlaps.push(`${ranges[i - 1].why} ${fmt(ranges[i - 1].s)}-${fmt(ranges[i - 1].e)} overlaps ${ranges[i].why} ${fmt(ranges[i].s)}-${fmt(ranges[i].e)}`);
if (overlaps.length) {
  log('Cannot render: cuts, speed changes, and audio-matched narrations overlap:\n  ' + overlaps.join('\n  '));
  process.exit(1);
}
const bounds = [...new Set([0, duration, ...ranges.flatMap((r) => [r.s, r.e])].map((x) => +x.toFixed(4)))].sort((a, b) => a - b);
const segs = [];
for (let i = 0; i + 1 < bounds.length; i++) {
  const s = bounds[i];
  const e = bounds[i + 1];
  if (e - s < 1e-3) continue;
  const r = ranges.find((r) => r.s <= s + 1e-3 && e <= r.e + 1e-3);
  segs.push({ s, e, speed: r ? r.speed : 1 });
}
const outTime = (t) => {
  let o = 0;
  for (const g of segs) {
    if (t <= g.e + EPS) return o + (g.speed ? (Math.max(t, g.s) - g.s) / g.speed : 0);
    o += g.speed ? (g.e - g.s) / g.speed : 0;
  }
  return o;
};
const total = outTime(duration);

// Split segments at clip boundaries so each piece reads from one file.
const pieces = [];
for (const g of segs) {
  if (!g.speed) continue;
  for (let i = 0; i < clips.length; i++) {
    const cs = starts[i];
    const ce = cs + clipLen(clips[i]);
    const s = Math.max(g.s, cs);
    const e = Math.min(g.e, ce);
    if (e - s < 1e-3) continue;
    pieces.push({ clip: clips[i], src: clips[i].sourceIn + (s - cs), len: e - s, speed: g.speed });
  }
}

// ---------- effects ----------
const warnings = [];
const freezes = anns.filter((a) => a.kind === 'instruction' && a.effect === 'freeze');
const fades = anns.filter((a) => a.kind === 'instruction' && a.effect === 'fade-to-black');
for (const a of anns.filter((a) => a.kind === 'instruction' && !['freeze', 'fade-to-black'].includes(a.effect)))
  warnings.push(`Instruction at ${fmt(a.s)} is not applied by the renderer: "${(a.text || a.title || '').slice(0, 80)}"`);
for (const a of fades) if (Math.abs(a.e - duration) > 0.25) warnings.push(`Fade to black at ${fmt(a.s)} is not at the end of the video; it will stay black after.`);
for (const a of narrations) {
  const room = outTime(a.e) - outTime(a.s) - (a.audioOffset ?? 0);
  if (!a.matchAudio && a.audio > room + 0.05) warnings.push(`Narration at ${fmt(a.s)} runs ${(a.audio - room).toFixed(1)} s past its range.`);
}

// ---------- plan ----------
function fmt(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}
log(`Project: ${projectPath}`);
log(`Timeline ${fmt(duration)} -> output ${fmt(total)}${has('--include-suggested') ? ' (including suggestions)' : ''}`);
for (const g of segs)
  log(`  ${fmt(g.s).padStart(7)}-${fmt(g.e).padEnd(7)} ${g.speed ? `${g.speed.toFixed(2)}x`.padStart(7) : '    cut'}  -> ${fmt(outTime(g.s))}-${fmt(outTime(g.e))}`);
for (const a of narrations)
  log(`  narration at ${fmt(outTime(a.s) + (a.audioOffset ?? 0))}, ${a.audio.toFixed(1)} s${a.cached ? '' : ' (estimated, not generated)'}${a.matchAudio ? ', range matched to audio' : ''}: "${a.text.trim().slice(0, 50)}${a.text.trim().length > 50 ? '…' : ''}"`);
for (const a of freezes) log(`  freeze frame ${fmt(outTime(a.s))}-${fmt(outTime(a.e))}`);
for (const a of fades) log(`  fade to black from ${fmt(outTime(a.s))}`);
for (const w of warnings) log(`  ! ${w}`);
if (has('--dry')) {
  if (missing.length) log(`Not generated yet: ${missing.length} narration clip(s), ${missingChars} characters.`);
  process.exit(0);
}

// ---------- render ----------
const info = (f) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', f]).toString())
    .streams[0];
const first = info(path.join(mediaDir, clips[0].file));
const maxW = final ? 1920 : 1280;
const W = Math.min(maxW, first.width) & ~1;
const H = Math.round((W * first.height) / first.width / 2) * 2;
const FPS = final ? 30 : 30;
const srcFps = {};
const inputs = [];
const f = [];
pieces.forEach((p, i) => {
  const file = path.join(mediaDir, p.clip.file);
  if (!(file in srcFps)) {
    const [n, d] = info(file).r_frame_rate.split('/').map(Number);
    srcFps[file] = n / (d || 1);
  }
  inputs.push('-ss', p.src.toFixed(3), '-t', p.len.toFixed(3), '-i', file);
  const blend = has('--blend') && p.speed > 1.5 ? Math.min(16, Math.round((p.speed * srcFps[file]) / FPS)) : 0;
  f.push(
    `[${i}:v]${blend > 1 ? `tmix=frames=${blend},` : ''}setpts=(PTS-STARTPTS)/${p.speed.toFixed(6)},fps=${FPS},` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`,
  );
});
let v = `${pieces.map((_, i) => `[v${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0`;
let next = pieces.length;
freezes.forEach((a, j) => {
  const fa = a.freezeFrame ?? a.start;
  const ci = clips.findIndex((c) => c.id === fa.clipId);
  if (ci < 0) return warnings.push('Freeze frame points at a missing clip.');
  inputs.push('-ss', String(fa.t), '-i', path.join(mediaDir, clips[ci].file));
  f.push(`[${next}:v]trim=end_frame=1,loop=-1:1,setpts=N/${FPS}/TB,fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[fz${j}]`);
  f.push(`${v}[pre${j}]`);
  v = `[pre${j}][fz${j}]overlay=shortest=1:enable='between(t,${outTime(a.s).toFixed(3)},${outTime(a.e).toFixed(3)})'`;
  next++;
});
for (const a of fades) v += `,fade=t=out:st=${outTime(a.s).toFixed(3)}:d=${(a.fadeDuration ?? 1).toFixed(3)}`;
f.push(`${v},trim=end=${total.toFixed(3)}[v]`);
const mix = [];
for (const a of silent ? [] : narrations) {
  inputs.push('-i', a.audioFile);
  const ms = Math.round((outTime(a.s) + (a.audioOffset ?? 0)) * 1000);
  f.push(`[${next}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[a${mix.length}]`);
  mix.push(`[a${mix.length}]`);
  next++;
}
if (mix.length) f.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest,apad,atrim=end=${total.toFixed(3)}[a]`);
else f.push(`anullsrc=r=48000:cl=stereo,atrim=end=${total.toFixed(3)}[a]`);

const enc = final ? ['-preset', 'medium', '-crf', '18'] : ['-preset', 'veryfast', '-crf', '23'];
const cmd = ['-y', '-hide_banner', '-loglevel', 'error', '-stats', ...inputs, '-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', ...enc, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
log(`Rendering ${pieces.length} piece(s) at ${W}x${H}…`);
const r = spawnSync('ffmpeg', cmd, { stdio: ['ignore', 'inherit', 'inherit'] });
if (r.status !== 0) process.exit(r.status ?? 1);
log(`Done: ${fmt(probe(out))}`);
console.log(out);
