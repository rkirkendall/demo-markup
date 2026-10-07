import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { Annotation, Clip, Selection } from './types';
import { KIND_META } from './types';
import { annotationSpan, clipAt, clipLength, clipStarts, fmtTime, totalDuration } from './model';
import type { ThumbStrip } from './thumbs';
import type { Hover } from './HoverFrame';

const PAD = 16;
const RULER_H = 26;
const CLIP_H = 66;
const LANE_H = 26;
const MIN_LANES = 3;
const MIN_PPS = 1;
const MAX_PPS = 800;

export interface TimelineHandle {
  zoomBy(factor: number): void;
  fit(): void;
}

interface Props {
  ref?: Ref<TimelineHandle>;
  clips: Clip[];
  annotations: Annotation[];
  pxPerSec: number;
  setPxPerSec(pps: number): void;
  playhead: number;
  playing: boolean;
  selection: Selection | null;
  setSelection(s: Selection | null): void;
  onSeek(t: number): void;
  selectedAnnId: string | null;
  onSelectAnn(id: string | null): void;
  onMoveAnnEdge(id: string, which: 'start' | 'end' | 'point', time: number, done: boolean): void;
  selectedClipId: string | null;
  onSelectClip(id: string | null): void;
  onReorder(clipId: string, toIndex: number): void;
  onDropFiles(files: File[], atIndex: number): void;
  onDropMedia(name: string, atIndex: number): void;
  thumbs: Map<string, ThumbStrip>;
  onHover(h: Hover | null): void;
}

type Drag =
  | { mode: 'scrub' }
  | { mode: 'select'; x0: number; t0: number; moved: boolean; clipId: string | null }
  | { mode: 'selEdge'; other: number }
  | { mode: 'ann'; id: string; which: 'start' | 'end' | 'point' };

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function Timeline(props: Props) {
  const {
    clips,
    annotations,
    pxPerSec: pps,
    setPxPerSec,
    playhead,
    playing,
    selection,
    setSelection,
    onSeek,
    selectedAnnId,
    onSelectAnn,
    onMoveAnnEdge,
    selectedClipId,
    onSelectClip,
    onReorder,
    onDropFiles,
    onDropMedia,
    thumbs,
    onHover,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const [view, setView] = useState({ left: 0, width: 1000 });
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const setHover = (h: Hover | null) => {
    setHoverTime(h?.time ?? null);
    onHover(h);
  };

  const duration = totalDuration(clips);
  const starts = useMemo(() => clipStarts(clips), [clips]);
  const X = (t: number) => PAD + t * pps;
  const contentWidth = Math.max(X(duration) + 240, view.width);

  const timeFromEvent = (e: { clientX: number }) => {
    const rect = contentRef.current!.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - rect.left - PAD) / pps, 0), duration);
  };

  // ---- zoom ----
  const zoomAround = (newPps: number, anchorTime: number, anchorClientX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    newPps = Math.min(Math.max(newPps, MIN_PPS), MAX_PPS);
    const offsetInView = anchorClientX - el.getBoundingClientRect().left;
    pendingScroll.current = PAD + anchorTime * newPps - offsetInView;
    setPxPerSec(newPps);
  };

  const fit = () => {
    const el = scrollRef.current;
    if (!el || duration <= 0) return;
    pendingScroll.current = 0;
    setPxPerSec(Math.min(Math.max((el.clientWidth - PAD * 2 - 24) / duration, MIN_PPS), MAX_PPS));
  };

  useImperativeHandle(props.ref, () => ({
    zoomBy(factor: number) {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const phX = rect.left + X(playhead) - el.scrollLeft;
      const anchorX = phX >= rect.left && phX <= rect.right ? phX : rect.left + rect.width / 2;
      const anchorT = (el.scrollLeft + anchorX - rect.left - PAD) / pps;
      zoomAround(pps * factor, anchorT, anchorX);
    },
    fit,
  }));

  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
      setView((v) => ({ ...v, left: scrollRef.current!.scrollLeft }));
    }
  }, [pps]);

  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const t = (el.scrollLeft + e.clientX - el.getBoundingClientRect().left - PAD) / pps;
        zoomAround(pps * Math.exp(-e.deltaY * 0.01), t, e.clientX);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollHeight <= el.clientHeight + 1) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    ro.observe(el);
    return () => {
      el.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  });

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = X(playhead);
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) {
      el.scrollLeft = x - 40;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing]);

  // ---- snapping ----
  const snapPoints = useMemo(() => {
    const pts = [0, duration, ...starts];
    for (const a of annotations) {
      const s = annotationSpan(clips, a);
      if (s) pts.push(s.start, s.end);
    }
    return pts;
  }, [clips, annotations, starts, duration]);

  const snap = (t: number, e: { altKey: boolean }) => {
    if (e.altKey) return t;
    let best = t;
    let bestD = 8 / pps;
    for (const p of [...snapPoints, playhead]) {
      const d = Math.abs(p - t);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };

  // ---- pointer handling ----
  const begin = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = d;
    contentRef.current!.setPointerCapture(e.pointerId);
  };

  // Show the hovered frame in the preview pane while over the clip track (not while dragging).
  const updateHover = (e: React.PointerEvent) => {
    const rect = contentRef.current!.getBoundingClientRect();
    const trackTop = rect.top + RULER_H + 6; // .tl-track has a 6px top margin
    const t = (e.clientX - rect.left - PAD) / pps;
    const inTrack = e.clientY >= trackTop && e.clientY <= trackTop + CLIP_H;
    const i = inTrack ? starts.findIndex((s, k) => t >= s && t < s + clipLength(clips[k])) : -1;
    if (i < 0) {
      if (hoverTime != null) setHover(null);
      return;
    }
    setHover({ file: clips[i].file, sourceTime: clips[i].sourceIn + t - starts[i], time: t });
  };

  // While dragging an edge, show the frame at that edge. An end edge shows the last frame inside the range.
  const showEdge = (t: number, isEnd: boolean) => {
    const hit = clipAt(clips, t, isEnd ? 'end' : 'start');
    if (!hit) return;
    const local = Math.min(Math.max(t - hit.start, 0), clipLength(hit.clip));
    const sourceTime = Math.max(hit.clip.sourceIn, hit.clip.sourceIn + local - (isEnd ? 0.001 : 0));
    setHover({ file: hit.clip.file, sourceTime, time: t });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      if (e.pointerType === 'mouse') updateHover(e);
      return;
    }
    const t = timeFromEvent(e);
    if (d.mode === 'scrub') {
      if (hoverTime != null) setHover(null);
      onSeek(t);
    } else if (d.mode === 'select') {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
      d.moved = true;
      const s = snap(t, e);
      setSelection({ start: Math.min(d.t0, s), end: Math.max(d.t0, s) });
      showEdge(s, s > d.t0);
    } else if (d.mode === 'selEdge') {
      const s = snap(t, e);
      setSelection({ start: Math.min(d.other, s), end: Math.max(d.other, s) });
      showEdge(s, s > d.other);
    } else if (d.mode === 'ann') {
      const s = snap(t, e);
      onMoveAnnEdge(d.id, d.which, s, false);
      showEdge(s, d.which === 'end');
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (hoverTime != null) setHover(null);
    if (d.mode === 'select' && !d.moved) {
      setSelection(null);
      onSelectAnn(null);
      onSelectClip(d.clipId);
      onSeek(d.t0);
    } else if (d.mode === 'select') {
      onSelectAnn(null);
      onSelectClip(null);
    } else if (d.mode === 'ann') {
      onMoveAnnEdge(d.id, d.which, snap(timeFromEvent(e), e), true);
    }
  };

  const startSelect = (e: React.PointerEvent, clipId: string | null = null) => {
    if (e.button !== 0) return;
    const t0 = snap(timeFromEvent(e), e);
    begin(e, { mode: 'select', x0: e.clientX, t0, moved: false, clipId });
  };

  // ---- drag and drop (clips, media, files) ----
  const indexAt = (t: number) => {
    for (let i = 0; i < clips.length; i++) if (t < starts[i] + clipLength(clips[i]) / 2) return i;
    return clips.length;
  };
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes('Files') && !types.includes('application/x-demo-clip') && !types.includes('application/x-demo-media'))
      return;
    e.preventDefault();
    const rect = contentRef.current!.getBoundingClientRect();
    setDropIndex(indexAt((e.clientX - rect.left - PAD) / pps));
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = contentRef.current!.getBoundingClientRect();
    const idx = indexAt((e.clientX - rect.left - PAD) / pps);
    setDropIndex(null);
    const clipId = e.dataTransfer.getData('application/x-demo-clip');
    const media = e.dataTransfer.getData('application/x-demo-media');
    if (clipId) onReorder(clipId, idx);
    else if (media) onDropMedia(media, idx);
    else if (e.dataTransfer.files.length) onDropFiles([...e.dataTransfer.files], idx);
  };

  // ---- annotation lanes ----
  const laid = useMemo(() => {
    const items = annotations
      .map((a) => ({ a, span: annotationSpan(clips, a) }))
      .filter((x): x is { a: Annotation; span: { start: number; end: number } } => !!x.span)
      .sort((x, y) => x.span.start - y.span.start);
    const laneEnds: number[] = [];
    return items.map((it) => {
      const isPoint = !it.a.end;
      const labelPx = isPoint ? 22 + Math.min((it.a.title || KIND_META[it.a.kind].name).length * 6.5, 150) : 0;
      const startPx = X(it.span.start) - (isPoint ? 7 : 0);
      const endPx = Math.max(X(it.span.end), startPx + (isPoint ? labelPx : 6)) + 2;
      let lane = laneEnds.findIndex((end) => end <= startPx);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = endPx;
      return { ...it, lane, isPoint };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, clips, pps]);
  const laneCount = Math.max(MIN_LANES, ...laid.map((l) => l.lane + 1));
  const contentHeight = RULER_H + CLIP_H + 8 + laneCount * LANE_H + 12;

  // ---- ruler ----
  const step = TICK_STEPS.find((s) => s * pps >= 70) ?? 600;
  const minor = step / (step >= 1 && Number.isInteger(step / 5) ? 5 : 2);
  const ticks: { t: number; major: boolean }[] = [];
  const vStart = Math.max(0, (view.left - PAD) / pps - step);
  const vEnd = (view.left + view.width) / pps + step;
  for (let t = Math.floor(vStart / minor) * minor; t <= vEnd; t += minor) {
    const r = Math.round(t / minor) * minor;
    ticks.push({ t: r, major: Math.abs(r / step - Math.round(r / step)) < 1e-6 });
  }

  const cutSpans = laid.filter((l) => l.a.kind === 'cut' && !l.isPoint);
  const speedSpans = laid.filter((l) => l.a.kind === 'speed' && !l.isPoint);

  return (
    <div
      className="tl-scroll"
      ref={scrollRef}
      onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}
    >
      <div
        className="tl-content"
        ref={contentRef}
        style={{ width: contentWidth, height: contentHeight }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => hoverTime != null && setHover(null)}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerDown={(e) => startSelect(e)}
        onDragOver={onDragOver}
        onDragLeave={() => setDropIndex(null)}
        onDrop={onDrop}
      >
        {/* Ruler */}
        <div
          className="tl-ruler"
          style={{ height: RULER_H }}
          onPointerDown={(e) => {
            begin(e, { mode: 'scrub' });
            onSeek(timeFromEvent(e));
          }}
        >
          {ticks.map(({ t, major }) => (
            <div key={t.toFixed(3)} className={major ? 'tick major' : 'tick'} style={{ left: X(t) }}>
              {major && <span>{step < 1 ? fmtTime(t, true) : fmtTime(t)}</span>}
            </div>
          ))}
        </div>

        {/* Clip track */}
        <div className="tl-track" style={{ top: RULER_H, height: CLIP_H }}>
          {clips.map((c, i) => {
            const left = X(starts[i]);
            const width = clipLength(c) * pps;
            const strip = thumbs.get(c.file);
            const thumbW = strip ? 48 * strip.aspect : 85;
            const slots = [];
            if (strip && strip.urls.length) {
              const first = Math.max(0, Math.floor((view.left - left) / thumbW));
              const last = Math.min(Math.ceil(width / thumbW), Math.ceil((view.left + view.width - left) / thumbW));
              for (let k = first; k < last; k++) {
                const srcT = c.sourceIn + (k * thumbW) / pps;
                const idx = Math.min(strip.urls.length - 1, Math.floor(srcT / strip.interval));
                slots.push(
                  <img key={k} src={strip.urls[idx]} style={{ left: k * thumbW, width: thumbW }} alt="" draggable={false} />,
                );
              }
            }
            return (
              <div
                key={c.id}
                className={'tl-clip' + (c.id === selectedClipId ? ' selected' : '')}
                style={{ left, width }}
                onPointerDown={(e) => startSelect(e, c.id)}
              >
                <div className="tl-film">{slots}</div>
                <div
                  className="tl-clip-head"
                  draggable
                  title="Drag to reorder"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onSelectClip(c.id)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-demo-clip', c.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  <span className="grip">⋮⋮</span>
                  <span className="name">{c.file}</span>
                  <span className="len">{fmtTime(clipLength(c))}</span>
                </div>
              </div>
            );
          })}
          {cutSpans.map(({ a, span }) => (
            <div
              key={'cut' + a.id}
              className="tl-cut-overlay"
              style={{ left: X(span.start), width: (span.end - span.start) * pps }}
            />
          ))}
          {speedSpans.map(({ a, span }) =>
            a.targetDuration ? (
              <div key={'spd' + a.id} className="tl-speed-badge" style={{ left: X(span.start) + 4 }}>
                {((span.end - span.start) / a.targetDuration).toFixed(1)}×
              </div>
            ) : null,
          )}
          {!clips.length && <div className="tl-empty">Drop screen recordings here</div>}
        </div>

        {/* Annotation lanes */}
        <div className="tl-lanes" style={{ top: RULER_H + CLIP_H + 8, height: laneCount * LANE_H }}>
          {Array.from({ length: laneCount }, (_, i) => (
            <div key={i} className="tl-lane-bg" style={{ top: i * LANE_H, height: LANE_H }} />
          ))}
          {laid.map(({ a, span, lane, isPoint }) => {
            const meta = KIND_META[a.kind];
            const selected = a.id === selectedAnnId;
            const title = a.title || meta.name;
            const select = (e: React.PointerEvent) => {
              e.stopPropagation();
              onSelectAnn(a.id);
            };
            if (isPoint) {
              return (
                <div
                  key={a.id}
                  className={'tl-pin' + (selected ? ' selected' : '')}
                  style={{ left: X(span.start) - 7, top: lane * LANE_H + 3, ['--c' as string]: meta.color }}
                  onPointerDown={(e) => {
                    select(e);
                    begin(e, { mode: 'ann', id: a.id, which: 'point' });
                  }}
                  title={a.text || title}
                >
                  <span className="diamond" />
                  <span className="pin-label">{title}</span>
                </div>
              );
            }
            return (
              <div
                key={a.id}
                className={'tl-ann' + (selected ? ' selected' : '')}
                style={{
                  left: X(span.start),
                  width: Math.max(4, (span.end - span.start) * pps),
                  top: lane * LANE_H + 3,
                  ['--c' as string]: meta.color,
                }}
                onPointerDown={select}
                title={a.text || title}
              >
                <span className="ann-label">{title}</span>
                {selected && (
                  <>
                    <span
                      className="edge l"
                      onPointerDown={(e) => begin(e, { mode: 'ann', id: a.id, which: 'start' })}
                    />
                    <span
                      className="edge r"
                      onPointerDown={(e) => begin(e, { mode: 'ann', id: a.id, which: 'end' })}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Point annotation guides, drawn through the clip track */}
        {laid
          .filter((l) => l.isPoint)
          .map(({ a, span }) => (
            <div
              key={'g' + a.id}
              className="tl-guide"
              style={{ left: X(span.start), top: RULER_H, height: CLIP_H + 8, ['--c' as string]: KIND_META[a.kind].color }}
            />
          ))}

        {/* Range selection */}
        {selection && selection.end > selection.start && (
          <div
            className="tl-selection"
            style={{ left: X(selection.start), width: (selection.end - selection.start) * pps, top: 0, height: contentHeight }}
          >
            <span
              className="sel-edge l"
              onPointerDown={(e) => begin(e, { mode: 'selEdge', other: selection.end })}
            />
            <span
              className="sel-edge r"
              onPointerDown={(e) => begin(e, { mode: 'selEdge', other: selection.start })}
            />
          </div>
        )}

        {dropIndex != null && (
          <div
            className="tl-drop-marker"
            style={{
              left: X(dropIndex < clips.length ? starts[dropIndex] : duration) - 2,
              top: RULER_H,
              height: CLIP_H,
            }}
          />
        )}

        {hoverTime != null && (
          <div className="tl-hover-line" style={{ left: X(hoverTime), top: RULER_H, height: CLIP_H }} />
        )}

        {/* Playhead */}
        <div className="tl-playhead" style={{ left: X(playhead), height: contentHeight }}>
          <div
            className="head"
            onPointerDown={(e) => {
              begin(e, { mode: 'scrub' });
            }}
          />
        </div>
      </div>
    </div>
  );
}
