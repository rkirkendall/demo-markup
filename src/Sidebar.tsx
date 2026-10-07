import { useEffect, useRef } from 'react';
import type { Annotation, AnnotationKind, Clip, MediaFile, Selection } from './types';
import { KIND_META } from './types';
import { annotationSpan, fmtTime } from './model';

interface Props {
  tab: 'notes' | 'media';
  setTab(t: 'notes' | 'media'): void;
  clips: Clip[];
  annotations: Annotation[];
  selectedAnnId: string | null;
  focusToken: number;
  onSelectAnn(id: string): void;
  onChangeAnn(id: string, patch: Partial<Annotation>, coalesceKey?: string): void;
  onDeleteAnn(id: string): void;
  onAcceptAll(): void;
  onRejectAll(): void;
  onPlayAnn(id: string): void;
  onSetAnnToSelection(id: string): void;
  selection: Selection | null;
  media: MediaFile[];
  mediaDir: string;
  onAddMedia(name: string): void;
  onImportFiles(files: File[]): void;
  onRefreshMedia(): void;
}

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={p.tab === 'notes' ? 'active' : ''} onClick={() => p.setTab('notes')}>
          Annotations <span className="count">{p.annotations.length}</span>
        </button>
        <button className={p.tab === 'media' ? 'active' : ''} onClick={() => p.setTab('media')}>
          Videos <span className="count">{p.media.length}</span>
        </button>
      </div>
      {p.tab === 'notes' ? <Notes {...p} /> : <Media {...p} />}
    </aside>
  );
}

function Notes(p: Props) {
  const sel = p.annotations.find((a) => a.id === p.selectedAnnId) ?? null;
  const items = p.annotations
    .map((a) => ({ a, span: annotationSpan(p.clips, a) }))
    .filter((x) => x.span)
    .sort((x, y) => x.span!.start - y.span!.start);

  const suggested = p.annotations.filter((a) => a.suggested).length;

  return (
    <div className="notes">
      {suggested > 0 && (
        <div className="suggest-bar">
          <span>
            {suggested} suggestion{suggested === 1 ? '' : 's'} to review
          </span>
          <button className="ghost" onClick={p.onRejectAll}>
            Reject all
          </button>
          <button className="primary" onClick={p.onAcceptAll}>
            Accept all
          </button>
        </div>
      )}
      {sel ? (
        <Inspector key={sel.id} ann={sel} {...p} />
      ) : (
        <div className="hint">
          <p>
            <b>Drag across the timeline</b> to select a range, then pick an action in the toolbar.
          </p>
          <p>
            Or <b>click a moment</b> and add an instruction or label at that point.
          </p>
        </div>
      )}
      <div className="ann-list">
        {items.map(({ a, span }) => {
          const meta = KIND_META[a.kind];
          return (
            <button
              key={a.id}
              className={'ann-item' + (a.id === p.selectedAnnId ? ' selected' : '') + (a.suggested ? ' suggested' : '')}
              onClick={() => p.onSelectAnn(a.id)}
            >
              <span className="dot" style={{ background: meta.color }} />
              <span className="kind">{a.suggested ? 'Suggested' : meta.name}</span>
              <span className="title">{a.title || a.text || <i>untitled</i>}</span>
              <span className="time">
                {fmtTime(span!.start)}
                {a.end ? `–${fmtTime(span!.end)}` : ''}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Inspector({ ann, ...p }: Props & { ann: Annotation }) {
  const meta = KIND_META[ann.kind];
  const span = annotationSpan(p.clips, ann)!;
  const length = span.end - span.start;
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (p.focusToken) textRef.current?.focus();
  }, [p.focusToken]);

  const kinds = (Object.keys(KIND_META) as AnnotationKind[]).filter((k) => ann.end || !KIND_META[k].needsRange);

  return (
    <div className="inspector" style={{ ['--c' as string]: meta.color }}>
      {(ann.suggested || ann.reason) && (
        <div className={'reason' + (ann.suggested ? ' pending' : '')}>
          {ann.suggested && <b>Suggested {meta.name.toLowerCase()}. </b>}
          {ann.reason}
          {ann.suggested && (
            <div className="reason-actions">
              <button className="ghost" onClick={() => p.onDeleteAnn(ann.id)}>
                Reject
              </button>
              <button className="primary" onClick={() => p.onChangeAnn(ann.id, { suggested: false })}>
                Accept
              </button>
            </div>
          )}
        </div>
      )}
      <div className="kind-row">
        {kinds.map((k) => (
          <button
            key={k}
            className={'kind-chip' + (k === ann.kind ? ' active' : '')}
            style={{ ['--c' as string]: KIND_META[k].color }}
            onClick={() =>
              p.onChangeAnn(ann.id, {
                kind: k,
                targetDuration: k === 'speed' && !ann.targetDuration ? Math.max(1, Math.round(length / 3)) : ann.targetDuration,
              })
            }
          >
            {KIND_META[k].name}
          </button>
        ))}
      </div>
      <div className="span-row">
        <span>
          {ann.end ? (
            <>
              {fmtTime(span.start, true)} – {fmtTime(span.end, true)} <span className="muted">({length.toFixed(1)}s)</span>
            </>
          ) : (
            <>At {fmtTime(span.start, true)}</>
          )}
        </span>
        <span className="span-actions">
          <button className="ghost" onClick={() => p.onPlayAnn(ann.id)} title="Play this part">
            ▶ Play
          </button>
          {p.selection && p.selection.end > p.selection.start && (
            <button className="ghost" onClick={() => p.onSetAnnToSelection(ann.id)} title="Move to the current selection">
              Use selection
            </button>
          )}
        </span>
      </div>
      {ann.kind !== 'narration' && (
        <label className="field">
          <span>Title</span>
          <input
            value={ann.title}
            placeholder={meta.name}
            onChange={(e) => p.onChangeAnn(ann.id, { title: e.target.value }, 'title' + ann.id)}
          />
        </label>
      )}
      {ann.kind === 'speed' && (
        <div className="field speed">
          <span>Fit into</span>
          <div className="speed-row">
            <input
              type="number"
              min={0.1}
              step={0.5}
              value={ann.targetDuration ?? ''}
              onChange={(e) =>
                p.onChangeAnn(ann.id, { targetDuration: Math.max(0.1, Number(e.target.value) || 0.1) }, 'td' + ann.id)
              }
            />
            <span className="muted">
              seconds · from {length.toFixed(1)}s
              {ann.targetDuration ? ` · ${(length / ann.targetDuration).toFixed(2)}× speed` : ''}
            </span>
          </div>
        </div>
      )}
      <label className="field">
        <span>{ann.kind === 'narration' ? 'Narration prompt' : 'Instructions for the AI'}</span>
        <textarea
          ref={textRef}
          value={ann.text}
          rows={ann.kind === 'narration' || ann.kind === 'instruction' ? 6 : 3}
          placeholder={meta.placeholder}
          onChange={(e) => p.onChangeAnn(ann.id, { text: e.target.value }, 'text' + ann.id)}
        />
      </label>
      {ann.kind === 'narration' && (
        <label className="toggle check">
          <input
            type="checkbox"
            checked={!!ann.matchAudio}
            onChange={(e) => p.onChangeAnn(ann.id, { matchAudio: e.target.checked })}
          />
          Adjust segment speed to match audio duration
        </label>
      )}
      <div className="inspector-foot">
        <button className="danger ghost" onClick={() => p.onDeleteAnn(ann.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

function Media(p: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const used = new Set(p.clips.map((c) => c.file));
  return (
    <div className="media">
      <div className="media-dir" title={p.mediaDir}>
        Folder: <code>{p.mediaDir}</code>
      </div>
      <div className="media-actions">
        <button onClick={() => inputRef.current?.click()}>Add videos…</button>
        <button className="ghost" onClick={p.onRefreshMedia}>
          Refresh
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,.mov,.mkv"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) p.onImportFiles([...e.target.files]);
            e.target.value = '';
          }}
        />
      </div>
      <p className="muted small">
        Videos you add are copied into this folder so the AI agent can find them. Drag a video onto the timeline to place it.
      </p>
      <div className="media-list">
        {p.media.map((m) => (
          <div
            key={m.name}
            className="media-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-demo-media', m.name);
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <div className="media-name">
              {m.name}
              {used.has(m.name) && <span className="badge">in timeline</span>}
            </div>
            <div className="muted small">{(m.size / 1e6).toFixed(1)} MB</div>
            <button className="ghost" onClick={() => p.onAddMedia(m.name)}>
              + Add
            </button>
          </div>
        ))}
        {!p.media.length && <p className="muted">No videos in this folder yet.</p>}
      </div>
    </div>
  );
}
