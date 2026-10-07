import { useEffect, useRef, useState } from 'react';
import { fmtTime } from './model';
import type { ThumbStrip } from './thumbs';

export interface Hover {
  file: string;
  /** Seconds into the source file. */
  sourceTime: number;
  /** Timeline time. */
  time: number;
}

/**
 * Covers the preview pane with the frame under the mouse while hovering the clip track.
 * Shows the nearest cached thumbnail right away, then the exact frame once its own video has seeked to it.
 * The main player is left alone, so the playhead frame comes back when the hover ends.
 */
export function HoverFrame({ file, sourceTime, time, strip }: Hover & { strip: ThumbStrip | undefined }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seeking = useRef(false);
  const target = useRef(sourceTime);
  const requested = useRef(-1);
  // True once the video has drawn a frame for this file; until then the cached thumbnail shows.
  const [ready, setReady] = useState(false);

  target.current = sourceTime;

  // Seek to the latest hovered time. While a seek is in flight, only the newest target is kept.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) return;
    if (!seeking.current) seekTo(v, sourceTime);
  }, [sourceTime, file]);

  function seekTo(v: HTMLVideoElement, t: number) {
    seeking.current = true;
    requested.current = t;
    v.currentTime = t;
  }

  const onSeeked = () => {
    if (requested.current !== target.current) {
      seekTo(videoRef.current!, target.current);
    } else {
      seeking.current = false;
      setReady(true);
    }
  };

  const onLoaded = () => seekTo(videoRef.current!, target.current);

  useEffect(() => {
    seeking.current = false;
    setReady(false);
  }, [file]);

  const thumb = strip?.urls.length
    ? strip.urls[Math.min(strip.urls.length - 1, Math.floor(sourceTime / strip.interval))]
    : undefined;

  return (
    <div className="hover-frame">
      {thumb && <img src={thumb} alt="" />}
      <video
        ref={videoRef}
        src={'/media/' + encodeURIComponent(file)}
        muted
        preload="auto"
        playsInline
        onLoadedData={onLoaded}
        onSeeked={onSeeked}
        style={{ opacity: ready ? 1 : 0 }}
      />
      <span className="hover-time">{fmtTime(time, true)}</span>
    </div>
  );
}
