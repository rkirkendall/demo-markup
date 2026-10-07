import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationKind, Clip, MediaFile, Project, Selection } from './types';
import { KIND_META } from './types';
import {
  agentPrompt,
  annotationSpan,
  buildSpec,
  clipAt,
  clipStarts,
  fmtTime,
  removeClip,
  splitAt,
  toAnchor,
  totalDuration,
  uid,
} from './model';
import { Timeline } from './Timeline';
import type { TimelineHandle } from './Timeline';
import { Sidebar } from './Sidebar';
import { useThumbs } from './thumbs';

const EMPTY: Project = { clips: [], annotations: [] };
const KIND_ORDER: AnnotationKind[] = ['label', 'cut', 'speed', 'narration', 'instruction'];
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;

function probeDuration(file: string) {
  return new Promise<number | null>((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = '/media/' + encodeURIComponent(file);
    v.onloadedmetadata = () => resolve(isFinite(v.duration) ? v.duration : null);
    v.onerror = () => resolve(null);
  });
}

export function App() {
  // ---------- project state + undo ----------
  const [project, setProjectState] = useState<Project>(EMPTY);
  const projRef = useRef(project);
  const hist = useRef({ past: [] as Project[], future: [] as Project[], key: '', at: 0 });

  const commit = useCallback((fn: (p: Project) => Project, coalesceKey = '') => {
    const prev = projRef.current;
    const next = fn(prev);
    if (next === prev) return;
    const h = hist.current;
    const now = Date.now();
    if (!(coalesceKey && h.key === coalesceKey && now - h.at < 1500)) {
      h.past.push(prev);
      if (h.past.length > 300) h.past.shift();
    }
    h.key = coalesceKey;
    h.at = now;
    h.future = [];
    projRef.current = next;
    setProjectState(next);
  }, []);

  const undo = () => {
    const h = hist.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(projRef.current);
    h.key = '';
    projRef.current = prev;
    setProjectState(prev);
  };
  const redo = () => {
    const h = hist.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(projRef.current);
    h.key = '';
    projRef.current = next;
    setProjectState(next);
  };

  // ---------- UI state ----------
  const [info, setInfo] = useState({ dir: '', specPath: '' });
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(20);
  const [tab, setTab] = useState<'notes' | 'media'>('notes');
  const [focusToken, setFocusToken] = useState(0);
  const [previewEdits, setPreviewEdits] = useState(false);
  const [loop, setLoop] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const timelineRef = useRef<TimelineHandle>(null);
  const toastTimer = useRef(0);

  const flash = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };

  const { clips, annotations } = project;
  const duration = totalDuration(clips);
  const thumbs = useThumbs(clips.map((c) => c.file));

  // ---------- load + autosave ----------
  const refreshMedia = useCallback(async () => {
    const r = await fetch('/api/media');
    setMedia(await r.json());
  }, []);

  useEffect(() => {
    (async () => {
      const i = await (await fetch('/api/info')).json();
      setInfo(i);
      await refreshMedia();
      const r = await fetch('/api/project');
      if (r.ok) {
        const spec = await r.json();
        if (spec?.editor?.clips) {
          projRef.current = spec.editor;
          setProjectState(spec.editor);
          setTimeout(() => timelineRef.current?.fit(), 50);
        }
      }
      setLoaded(true);
    })().catch((e) => flash('Could not load: ' + e));
  }, [refreshMedia]);

  useEffect(() => {
    if (!loaded || !info.dir) return;
    setSaveState('saving');
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/project', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildSpec(project, info.dir), null, 2),
        });
        setSaveState(r.ok ? 'saved' : 'error');
      } catch {
        setSaveState('error');
      }
    }, 500);
    return () => clearTimeout(t);
  }, [project, loaded, info.dir]);

  // ---------- player ----------
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playhead, setPlayheadState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const pl = useRef({
    file: '',
    clipId: '',
    loading: false,
    stopAt: null as number | null,
    loopStart: 0,
    raf: 0,
    token: 0,
    playing: false,
    playhead: 0,
    previewEdits: false,
    loop: false,
  });
  pl.current.previewEdits = previewEdits;
  pl.current.loop = loop;

  const setPlayhead = (t: number) => {
    pl.current.playhead = t;
    setPlayheadState(t);
  };

  const loadAt = async (t: number) => {
    const v = videoRef.current;
    const cs = projRef.current.clips;
    const hit = clipAt(cs, t, 'start');
    if (!v || !hit) return false;
    const P = pl.current;
    P.clipId = hit.clip.id;
    const srcT = hit.clip.sourceIn + Math.max(0, t - hit.start);
    if (P.file !== hit.clip.file) {
      P.file = hit.clip.file;
      P.loading = true;
      v.src = '/media/' + encodeURIComponent(hit.clip.file);
      const ok = await new Promise<boolean>((resolve) => {
        v.onloadedmetadata = () => resolve(true);
        v.onerror = () => resolve(false);
      });
      P.loading = false;
      if (!ok) {
        setVideoError(`This browser can't play ${hit.clip.file}. Try Chrome, or convert it to H.264 MP4.`);
        return false;
      }
      setVideoError(null);
    }
    v.currentTime = srcT;
    return true;
  };

  const stopLoop = () => cancelAnimationFrame(pl.current.raf);

  const pause = () => {
    const P = pl.current;
    P.playing = false;
    P.token++;
    setPlaying(false);
    stopLoop();
    videoRef.current?.pause();
  };

  const seek = async (t: number, play = pl.current.playing) => {
    const cs = projRef.current.clips;
    if (!cs.length) return;
    t = Math.min(Math.max(t, 0), totalDuration(cs));
    setPlayhead(t);
    const token = ++pl.current.token;
    const ok = await loadAt(t);
    if (!ok || token !== pl.current.token) return;
    if (play) {
      try {
        await videoRef.current!.play();
      } catch {
        /* interrupted by another seek */
      }
    }
  };

  const tick = () => {
    const P = pl.current;
    const v = videoRef.current;
    if (!P.playing || !v) return;
    P.raf = requestAnimationFrame(tick);
    if (P.loading || v.seeking) return;
    const { clips: cs, annotations: anns } = projRef.current;
    const i = cs.findIndex((c) => c.id === P.clipId);
    if (i < 0) return pause();
    const c = cs[i];
    const starts = clipStarts(cs);
    const tl = starts[i] + (v.currentTime - c.sourceIn);

    let rate = 1;
    if (P.previewEdits) {
      for (const a of anns) {
        if (!a.end || (a.kind !== 'cut' && a.kind !== 'speed')) continue;
        const s = annotationSpan(cs, a);
        if (!s || tl < s.start || tl >= s.end - 0.03) continue;
        if (a.kind === 'cut') {
          if (s.end >= totalDuration(cs) - 0.03) {
            pause();
            setPlayhead(s.start);
            return;
          }
          void seek(s.end, true);
          return;
        }
        if (a.targetDuration) rate = Math.min(16, Math.max(0.0625, (s.end - s.start) / a.targetDuration));
      }
    }
    if (v.playbackRate !== rate) v.playbackRate = rate;

    if (P.stopAt != null && tl >= P.stopAt - 0.01) {
      if (P.loop) {
        void seek(P.loopStart, true);
      } else {
        pause();
        setPlayhead(P.stopAt);
      }
      return;
    }
    if (v.currentTime >= c.sourceOut - 0.03 || v.ended) {
      if (i + 1 < cs.length) {
        void seek(starts[i + 1], true);
      } else {
        pause();
        setPlayhead(totalDuration(cs));
      }
      return;
    }
    setPlayhead(tl);
  };

  const play = (range?: Selection | null) => {
    const P = pl.current;
    if (!projRef.current.clips.length) return;
    let from = P.playhead;
    if (range && range.end > range.start) {
      P.stopAt = range.end;
      P.loopStart = range.start;
      from = range.start;
    } else {
      P.stopAt = null;
      if (from >= totalDuration(projRef.current.clips) - 0.05) from = 0;
    }
    P.playing = true;
    setPlaying(true);
    stopLoop();
    void seek(from, true).then(() => {
      if (P.playing) {
        stopLoop();
        P.raf = requestAnimationFrame(tick);
      }
    });
  };

  const togglePlay = () => (pl.current.playing ? pause() : play());

  // Refresh the frame when the clip list changes while paused.
  useEffect(() => {
    if (!pl.current.playing) {
      if (clips.length) void seek(Math.min(pl.current.playhead, duration), false);
      else {
        pl.current.file = '';
        videoRef.current?.removeAttribute('src');
        setPlayhead(0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  // ---------- clip operations ----------
  const addClips = async (names: string[], atIndex?: number) => {
    const wasEmpty = projRef.current.clips.length === 0;
    const added: Clip[] = [];
    for (const name of names) {
      const d = await probeDuration(name);
      if (d == null) {
        flash(`Can't read ${name} in this browser. Try an H.264 MP4.`);
        continue;
      }
      added.push({ id: uid(), file: name, sourceIn: 0, sourceOut: d, sourceDuration: d });
    }
    if (!added.length) return;
    commit((p) => {
      const cs = [...p.clips];
      cs.splice(atIndex ?? cs.length, 0, ...added);
      return { ...p, clips: cs };
    });
    if (wasEmpty) setTimeout(() => timelineRef.current?.fit(), 50);
  };

  const importFiles = async (files: File[], atIndex?: number) => {
    const names: string[] = [];
    for (const f of files) {
      if (!VIDEO_RE.test(f.name)) {
        flash(`${f.name} is not a supported video file.`);
        continue;
      }
      setBusy(`Copying ${f.name} into the project folder…`);
      try {
        const r = await fetch('/api/import?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        if (!r.ok) throw new Error((await r.json()).error);
        names.push(f.name);
      } catch (e) {
        flash(`Could not add ${f.name}: ${e}`);
      }
    }
    setBusy(null);
    await refreshMedia();
    await addClips(names, atIndex);
  };

  const reorder = (clipId: string, toIndex: number) =>
    commit((p) => {
      const from = p.clips.findIndex((c) => c.id === clipId);
      if (from < 0) return p;
      const cs = [...p.clips];
      const [c] = cs.splice(from, 1);
      const to = from < toIndex ? toIndex - 1 : toIndex;
      if (to === from) return p;
      cs.splice(to, 0, c);
      return { ...p, clips: cs };
    });

  const split = () => {
    const sel = selection && selection.end - selection.start > 0.05 ? selection : null;
    commit((p) => (sel ? splitAt(splitAt(p, sel.end), sel.start) : splitAt(p, playhead)));
    flash(sel ? 'Split the clip at both ends of the selection' : 'Split the clip at the playhead');
  };

  // ---------- annotation operations ----------
  const createAnnotation = (kind: AnnotationKind) => {
    const meta = KIND_META[kind];
    const sel = selection && selection.end - selection.start > 0.05 ? selection : null;
    if (!clips.length) return flash('Add a video first.');
    if (meta.needsRange && !sel) return flash(`Select a range on the timeline first, then ${meta.verb.toLowerCase()} it.`);
    const start = toAnchor(clips, sel ? sel.start : playhead, 'start');
    const end = sel ? toAnchor(clips, sel.end, 'end') : null;
    if (!start) return;
    const len = sel ? sel.end - sel.start : 0;
    const a: Annotation = {
      id: uid(),
      kind,
      start,
      end,
      title: '',
      text: '',
      targetDuration: kind === 'speed' ? Math.max(1, Math.round(len / 3)) : undefined,
    };
    commit((p) => ({ ...p, annotations: [...p.annotations, a] }));
    setSelectedAnnId(a.id);
    setSelectedClipId(null);
    setTab('notes');
    setFocusToken((n) => n + 1);
  };

  const changeAnn = (id: string, patch: Partial<Annotation>, key?: string) =>
    commit((p) => ({ ...p, annotations: p.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)) }), key);

  const deleteAnn = (id: string) => {
    commit((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== id) }));
    if (selectedAnnId === id) setSelectedAnnId(null);
  };

  const selectAnn = (id: string | null) => {
    setSelectedAnnId(id);
    if (!id) return;
    setSelectedClipId(null);
    setTab('notes');
    const a = projRef.current.annotations.find((x) => x.id === id);
    const span = a && annotationSpan(projRef.current.clips, a);
    if (!a || !span) return;
    setSelection(a.end ? span : null);
    if (!pl.current.playing) void seek(span.start, false);
  };

  const moveAnnEdge = (id: string, which: 'start' | 'end' | 'point', time: number, done: boolean) => {
    const cs = projRef.current.clips;
    commit(
      (p) => ({
        ...p,
        annotations: p.annotations.map((a) => {
          if (a.id !== id) return a;
          if (which === 'end') return { ...a, end: toAnchor(cs, time, 'end') ?? a.end };
          return { ...a, start: toAnchor(cs, time, 'start') ?? a.start };
        }),
      }),
      'edge' + id,
    );
    if (done) {
      const a = projRef.current.annotations.find((x) => x.id === id);
      const span = a && annotationSpan(cs, a);
      if (a?.end && span) setSelection(span);
      if (span && !pl.current.playing) void seek(which === 'end' ? span.end : span.start, false);
    }
  };

  const setAnnToSelection = (id: string) => {
    if (!selection) return;
    changeAnn(id, { start: toAnchor(clips, selection.start, 'start')!, end: toAnchor(clips, selection.end, 'end')! });
  };

  const playAnn = (id: string) => {
    const a = annotations.find((x) => x.id === id);
    const span = a && annotationSpan(clips, a);
    if (!span) return;
    play(a!.end ? span : { start: Math.max(0, span.start - 2), end: Math.min(duration, span.start + 3) });
  };

  const deleteSelected = () => {
    if (selectedAnnId) deleteAnn(selectedAnnId);
    else if (selectedClipId) {
      commit((p) => removeClip(p, selectedClipId));
      setSelectedClipId(null);
    }
  };

  // ---------- export ----------
  const saveNow = async () => {
    const r = await fetch('/api/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSpec(projRef.current, info.dir), null, 2),
    });
    setSaveState(r.ok ? 'saved' : 'error');
    return r.ok;
  };

  const copyPrompt = async () => {
    await saveNow();
    await navigator.clipboard.writeText(agentPrompt(info.specPath));
    flash('Copied a prompt for your AI agent. Paste it into Claude Code or Codex.');
  };

  const downloadSpec = () => {
    const blob = new Blob([JSON.stringify(buildSpec(projRef.current, info.dir), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'demo-markup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---------- keyboard ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement;
    if (tgt?.closest?.('input, textarea, select, [contenteditable]')) {
      if (e.key === 'Escape') tgt.blur();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod) return;
    const step = e.shiftKey ? 1 : 1 / 30;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        return togglePlay();
      case 'Enter':
        e.preventDefault();
        return selection ? play(selection) : togglePlay();
      case 'ArrowLeft':
        e.preventDefault();
        return void seek(playhead - step, false);
      case 'ArrowRight':
        e.preventDefault();
        return void seek(playhead + step, false);
      case 'Home':
        return void seek(0, false);
      case 'End':
        return void seek(duration, false);
      case 'Escape':
        setSelection(null);
        setSelectedAnnId(null);
        setSelectedClipId(null);
        return;
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        return deleteSelected();
      case '=':
      case '+':
        return timelineRef.current?.zoomBy(1.5);
      case '-':
      case '_':
        return timelineRef.current?.zoomBy(1 / 1.5);
      case '\\':
        return timelineRef.current?.fit();
      case '?':
        return setShowHelp((s) => !s);
    }
    if (k === 'i') {
      const end = selection && selection.end > playhead ? selection.end : playhead;
      return setSelection({ start: playhead, end });
    }
    if (k === 'o') {
      const start = selection && selection.start < playhead ? selection.start : playhead;
      return setSelection({ start, end: playhead });
    }
    if (k === 's') return split();
    const kind = KIND_ORDER.find((x) => KIND_META[x].key.toLowerCase() === k);
    if (kind) {
      e.preventDefault();
      createAnnotation(kind);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---------- render ----------
  const hasSel = !!selection && selection.end - selection.start > 0.05;
  const curClip = clipAt(clips, playhead, 'start');
  const activeHere = annotations
    .map((a) => ({ a, span: annotationSpan(clips, a) }))
    .filter(({ a, span }) =>
      span ? (a.end ? playhead >= span.start && playhead < span.end : Math.abs(playhead - span.start) < 0.75) : false,
    );

  const onPageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) void importFiles([...e.dataTransfer.files]);
    const media = e.dataTransfer.getData('application/x-demo-media');
    if (media) void addClips([media]);
  };

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onPageDrop}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">◧</span> Demo Markup
        </div>
        <div className="save-state" title={info.specPath}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : `Saved to ${info.specPath.split('/').slice(-2).join('/')}`}
        </div>
        <div className="top-actions">
          <button className="ghost" onClick={() => setShowHelp(true)}>
            Shortcuts
          </button>
          <button className="ghost" onClick={downloadSpec} disabled={!clips.length}>
            Download JSON
          </button>
          <button className="primary" onClick={copyPrompt} disabled={!clips.length}>
            Copy prompt for AI
          </button>
        </div>
      </header>

      <main className="top">
        <section className="preview">
          <div className="video-wrap" onClick={togglePlay}>
            <video ref={videoRef} playsInline preload="auto" />
            {!clips.length && (
              <div className="empty">
                <h2>Drop screen recordings here</h2>
                <p>Or add them from the Videos tab. They play straight from your disk.</p>
                {media.length > 0 && (
                  <div className="empty-media">
                    {media.slice(0, 6).map((m) => (
                      <button
                        key={m.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          void addClips([m.name]);
                        }}
                      >
                        + {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {videoError && <div className="video-error">{videoError}</div>}
            {clips.length > 0 && (
              <div className="overlay-tl">
                {curClip && <span className="clip-name">{curClip.clip.file}</span>}
                {previewEdits && <span className="pe-badge">Previewing cuts + speed</span>}
              </div>
            )}
            {activeHere.length > 0 && (
              <div className="overlay-bl">
                {activeHere.map(({ a }) => (
                  <span
                    key={a.id}
                    className="active-chip"
                    style={{ ['--c' as string]: KIND_META[a.kind].color }}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectAnn(a.id);
                    }}
                  >
                    {KIND_META[a.kind].name}: {a.title || a.text || 'untitled'}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
        <Sidebar
          tab={tab}
          setTab={setTab}
          clips={clips}
          annotations={annotations}
          selectedAnnId={selectedAnnId}
          focusToken={focusToken}
          onSelectAnn={selectAnn}
          onChangeAnn={changeAnn}
          onDeleteAnn={deleteAnn}
          onPlayAnn={playAnn}
          onSetAnnToSelection={setAnnToSelection}
          selection={selection}
          media={media}
          mediaDir={info.dir}
          onAddMedia={(n) => void addClips([n])}
          onImportFiles={(f) => void importFiles(f)}
          onRefreshMedia={() => void refreshMedia()}
        />
      </main>

      <section className="bottom">
        <div className="toolbar">
          <div className="group">
            <button className="icon" title="Go to start (Home)" onClick={() => void seek(0, false)}>
              ⏮
            </button>
            <button className="icon play" title="Play / pause (Space)" onClick={togglePlay}>
              {playing ? '❚❚' : '▶'}
            </button>
            <button
              title="Play the selection (Enter)"
              disabled={!hasSel}
              onClick={() => play(selection)}
            >
              ▶ Selection
            </button>
            <label className="toggle" title="Loop the selection">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
            </label>
            <span className="timecode">
              {fmtTime(playhead, true)} <span className="muted">/ {fmtTime(duration, true)}</span>
            </span>
            {hasSel && (
              <span className="sel-info">
                Selected {fmtTime(selection!.start, true)}–{fmtTime(selection!.end, true)}{' '}
                <b>{(selection!.end - selection!.start).toFixed(1)}s</b>
              </span>
            )}
          </div>
          <div className="group actions">
            {KIND_ORDER.map((k) => {
              const m = KIND_META[k];
              const disabled = !clips.length || (m.needsRange && !hasSel);
              return (
                <button
                  key={k}
                  className="action"
                  style={{ ['--c' as string]: m.color }}
                  disabled={disabled}
                  title={
                    (m.needsRange ? `${m.verb} the selected range` : hasSel ? `${m.verb} the selected range` : `${m.verb} at the playhead`) +
                    ` (${m.key})`
                  }
                  onClick={() => createAnnotation(k)}
                >
                  <span className="sw" />
                  {m.verb}
                  <kbd>{m.key}</kbd>
                </button>
              );
            })}
            <button className="action" disabled={!clips.length} onClick={split} title="Split the clip at the playhead, or at both ends of the selection (S)">
              ✂ Split<kbd>S</kbd>
            </button>
          </div>
          <div className="group">
            <label className="toggle" title="Skip cuts and apply speed changes while playing">
              <input type="checkbox" checked={previewEdits} onChange={(e) => setPreviewEdits(e.target.checked)} /> Preview
              edits
            </label>
            <button className="icon" title="Zoom out (-)" onClick={() => timelineRef.current?.zoomBy(1 / 1.5)}>
              −
            </button>
            <button title="Fit the timeline (\)" onClick={() => timelineRef.current?.fit()}>
              Fit
            </button>
            <button className="icon" title="Zoom in (+)" onClick={() => timelineRef.current?.zoomBy(1.5)}>
              +
            </button>
          </div>
        </div>
        <Timeline
          ref={timelineRef}
          clips={clips}
          annotations={annotations}
          pxPerSec={pxPerSec}
          setPxPerSec={setPxPerSec}
          playhead={playhead}
          playing={playing}
          selection={selection}
          setSelection={setSelection}
          onSeek={(t) => void seek(t, false)}
          selectedAnnId={selectedAnnId}
          onSelectAnn={selectAnn}
          onMoveAnnEdge={moveAnnEdge}
          selectedClipId={selectedClipId}
          onSelectClip={setSelectedClipId}
          onReorder={reorder}
          onDropFiles={(f, i) => void importFiles(f, i)}
          onDropMedia={(n, i) => void addClips([n], i)}
          thumbs={thumbs}
        />
      </section>

      {(toast || busy) && <div className="toast">{busy ?? toast}</div>}
      {showHelp && <Help onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function Help({ onClose }: { onClose(): void }) {
  const rows: [string, string][] = [
    ['Space', 'Play / pause'],
    ['Enter', 'Play the selection'],
    ['Drag on timeline', 'Select a range (hold Alt to turn off snapping)'],
    ['I / O', 'Set selection start / end at the playhead'],
    ['← / →', 'Step one frame (Shift: one second)'],
    ['L', 'Label (range or point)'],
    ['X', 'Mark the range to cut'],
    ['R', 'Speed the range up or down to a target length'],
    ['N', 'Narration prompt for the range'],
    ['T', 'Instruction for the AI (range or point)'],
    ['S', 'Split the clip'],
    ['Delete', 'Delete the selected annotation or clip'],
    ['+ / − / \\', 'Zoom in / out / fit (or pinch, or Ctrl + scroll)'],
    ['⌘Z / ⇧⌘Z', 'Undo / redo'],
    ['Esc', 'Clear the selection'],
  ];
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        <table>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Drag a clip by its title bar to reorder it. Drop video files anywhere to add them.
        </p>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
