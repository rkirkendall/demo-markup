import type { Anchor, Annotation, Clip, Project } from './types';
import { KIND_META } from './types';

export const uid = () => Math.random().toString(36).slice(2, 10);
const EPS = 1e-4;

export const clipLength = (c: Clip) => c.sourceOut - c.sourceIn;

/** Timeline start of each clip, in order. */
export function clipStarts(clips: Clip[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const c of clips) {
    out.push(t);
    t += clipLength(c);
  }
  return out;
}

export const totalDuration = (clips: Clip[]) => clips.reduce((s, c) => s + clipLength(c), 0);

/**
 * Find the clip at a timeline time. At a boundary, 'start' bias picks the later clip
 * and 'end' bias picks the earlier one.
 */
export function clipAt(clips: Clip[], time: number, bias: 'start' | 'end' = 'start') {
  const starts = clipStarts(clips);
  for (let i = 0; i < clips.length; i++) {
    const s = starts[i];
    const e = s + clipLength(clips[i]);
    const inside = bias === 'start' ? time >= s - EPS && time < e - EPS : time > s + EPS && time <= e + EPS;
    if (inside) return { clip: clips[i], index: i, start: s };
  }
  if (!clips.length) return null;
  // Clamp to the ends of the timeline.
  if (time <= 0) return { clip: clips[0], index: 0, start: 0 };
  const last = clips.length - 1;
  return { clip: clips[last], index: last, start: starts[last] };
}

export function toAnchor(clips: Clip[], time: number, bias: 'start' | 'end'): Anchor | null {
  const hit = clipAt(clips, time, bias);
  if (!hit) return null;
  const t = hit.clip.sourceIn + Math.min(Math.max(time - hit.start, 0), clipLength(hit.clip));
  return { clipId: hit.clip.id, t };
}

/** Timeline time of an anchor, or null if its clip is gone. */
export function anchorTime(clips: Clip[], a: Anchor): number | null {
  const starts = clipStarts(clips);
  const i = clips.findIndex((c) => c.id === a.clipId);
  if (i < 0) return null;
  const c = clips[i];
  return starts[i] + Math.min(Math.max(a.t - c.sourceIn, 0), clipLength(c));
}

/** Timeline span of an annotation. Start is always <= end. */
export function annotationSpan(clips: Clip[], a: Annotation): { start: number; end: number } | null {
  const s = anchorTime(clips, a.start);
  if (s == null) return null;
  if (!a.end) return { start: s, end: s };
  const e = anchorTime(clips, a.end);
  if (e == null) return { start: s, end: s };
  return { start: Math.min(s, e), end: Math.max(s, e) };
}

/** Split the clip under `time` in two. Anchors past the split move to the new clip. */
export function splitAt(p: Project, time: number): Project {
  const hit = clipAt(p.clips, time, 'start');
  if (!hit) return p;
  const local = time - hit.start;
  if (local < 0.05 || clipLength(hit.clip) - local < 0.05) return p; // too close to an edge
  const cut = hit.clip.sourceIn + local;
  const left: Clip = { ...hit.clip, sourceOut: cut };
  const right: Clip = { ...hit.clip, id: uid(), sourceIn: cut };
  const clips = [...p.clips];
  clips.splice(hit.index, 1, left, right);
  const move = (a: Anchor, isEnd: boolean): Anchor =>
    a.clipId === left.id && (isEnd ? a.t > cut + EPS : a.t >= cut - EPS) ? { ...a, clipId: right.id } : a;
  const annotations = p.annotations.map((a) => ({
    ...a,
    start: move(a.start, false),
    end: a.end ? move(a.end, true) : null,
  }));
  return { clips, annotations };
}

/** Remove a clip and any annotation pinned to it. */
export function removeClip(p: Project, clipId: string): Project {
  return {
    clips: p.clips.filter((c) => c.id !== clipId),
    annotations: p.annotations.filter((a) => a.start.clipId !== clipId && a.end?.clipId !== clipId),
  };
}

export function fmtTime(t: number, withFrames = false): string {
  if (!isFinite(t)) t = 0;
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const base = `${sign}${m}:${String(s).padStart(2, '0')}`;
  if (!withFrames) return base;
  const cs = Math.floor((t % 1) * 100);
  return `${base}.${String(cs).padStart(2, '0')}`;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Map a timeline range to the pieces of source footage it covers. */
export function sourcePieces(clips: Clip[], start: number, end: number, mediaDir: string) {
  const starts = clipStarts(clips);
  const out = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const s = Math.max(start, starts[i]);
    const e = Math.min(end, starts[i] + clipLength(c));
    if (e - s <= EPS) continue;
    out.push({
      clipId: c.id,
      file: c.file,
      path: joinPath(mediaDir, c.file),
      sourceStart: r3(c.sourceIn + s - starts[i]),
      sourceEnd: r3(c.sourceIn + e - starts[i]),
      timelineStart: r3(s),
      timelineEnd: r3(e),
    });
  }
  return out;
}

const joinPath = (dir: string, f: string) => (dir.endsWith('/') ? dir + f : `${dir}/${f}`);

export const SPEC_FORMAT = 'demo-markup/v1';

const AGENT_BRIEF = [
  'This file is an edit spec for a demo video, written by a person in the Demo Markup editor.',
  'Your job: produce the final video by applying every annotation, using tools like ffmpeg.',
  "Build the base video by joining `timeline.clips` in order. Each clip is the range [sourceIn, sourceOut] (seconds) of the file at `path`.",
  'All annotation times are given twice: on the timeline (seconds from the start of the joined video) and as `sources` (the exact file and source seconds).',
  'Annotation types:',
  '- cut: remove this range from the output.',
  '- speed: retime this range so it lasts exactly `targetDuration` seconds (`speedFactor` = original / target).',
  '- narration: write and generate voice-over for this range, following `instruction`. Do not let audio spill past the range end, unless `adjustSpeedToAudio` is true: then speed up or slow down this range so it lasts exactly as long as the generated audio.',
  '- label: a name for this part of the video. Use it as context for other instructions.',
  '- instruction: free-form direction. A point (`isPoint: true`) applies at that moment; a range applies to that span.',
  'Apply cuts and speed changes last-to-first, or recompute times, so earlier edits do not shift later ones.',
  'If an instruction needs an API key or a choice the spec does not give, ask the person instead of guessing.',
  'Write the result next to the source files unless told otherwise.',
].join('\n');

export function buildSpec(p: Project, mediaDir: string) {
  const starts = clipStarts(p.clips);
  const duration = totalDuration(p.clips);
  const annotations = p.annotations
    .map((a) => ({ a, span: annotationSpan(p.clips, a) }))
    .filter((x): x is { a: Annotation; span: { start: number; end: number } } => !!x.span)
    .sort((x, y) => x.span.start - y.span.start)
    .map(({ a, span }) => {
      const isPoint = !a.end;
      const length = span.end - span.start;
      const base: Record<string, unknown> = {
        id: a.id,
        type: a.kind,
        title: a.title || KIND_META[a.kind].name,
        instruction: a.text,
        isPoint,
        timelineStart: r3(span.start),
        timelineEnd: r3(span.end),
        duration: r3(length),
      };
      if (a.kind === 'speed' && a.targetDuration) {
        base.targetDuration = r3(a.targetDuration);
        base.speedFactor = r3(length / a.targetDuration);
      }
      if (a.kind === 'narration') base.adjustSpeedToAudio = !!a.matchAudio;
      if (isPoint) {
        const hit = clipAt(p.clips, span.start, 'start');
        if (hit) {
          base.sources = [
            {
              clipId: hit.clip.id,
              file: hit.clip.file,
              path: joinPath(mediaDir, hit.clip.file),
              sourceTime: r3(hit.clip.sourceIn + span.start - hit.start),
              timelineTime: r3(span.start),
            },
          ];
        }
      } else {
        base.sources = sourcePieces(p.clips, span.start, span.end, mediaDir);
      }
      return base;
    });

  return {
    format: SPEC_FORMAT,
    savedAt: new Date().toISOString(),
    agentBrief: AGENT_BRIEF,
    mediaDir,
    timeline: {
      duration: r3(duration),
      clips: p.clips.map((c, i) => ({
        id: c.id,
        order: i + 1,
        file: c.file,
        path: joinPath(mediaDir, c.file),
        sourceIn: r3(c.sourceIn),
        sourceOut: r3(c.sourceOut),
        timelineStart: r3(starts[i]),
        timelineEnd: r3(starts[i] + clipLength(c)),
      })),
    },
    annotations,
    // Raw editor state, used to reopen the project. Agents can ignore this.
    editor: p,
  };
}

export function agentPrompt(specPath: string) {
  return `Read the edit spec at ${specPath} and produce the demo video it describes. Follow "agentBrief" in that file. Apply every annotation in order. Tell me before you use any paid API, and ask if anything is unclear.`;
}
