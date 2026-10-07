import { useEffect, useState } from 'react';

export interface ThumbStrip {
  /** Seconds between thumbnails. */
  interval: number;
  /** Width / height of each frame. */
  aspect: number;
  urls: string[];
}

const cache = new Map<string, ThumbStrip>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let queue: Promise<void> = Promise.resolve();

const THUMB_H = 48;
const MAX_THUMBS = 150;

function seek(v: HTMLVideoElement, t: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      resolve();
    };
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

async function generate(file: string) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = '/media/' + encodeURIComponent(file);
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error('cannot load ' + file));
  });
  const dur = v.duration || 1;
  const interval = Math.max(1, dur / MAX_THUMBS);
  const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
  const canvas = document.createElement('canvas');
  canvas.height = THUMB_H * 2;
  canvas.width = Math.round(THUMB_H * 2 * aspect);
  const ctx = canvas.getContext('2d')!;
  const strip: ThumbStrip = { interval, aspect, urls: [] };
  cache.set(file, strip);
  for (let t = 0; t < dur; t += interval) {
    await seek(v, Math.min(t + 0.05, dur - 0.05));
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    strip.urls.push(canvas.toDataURL('image/jpeg', 0.6));
    // Publish progress every few frames so the strip fills in as it loads.
    if (strip.urls.length % 8 === 1) {
      cache.set(file, { ...strip, urls: [...strip.urls] });
      listeners.forEach((l) => l());
    }
  }
  cache.set(file, { ...strip, urls: [...strip.urls] });
  listeners.forEach((l) => l());
  v.removeAttribute('src');
  v.load();
}

/** Lazily builds a thumbnail strip for every file. Files are processed one at a time. */
export function useThumbs(files: string[]) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const key = [...new Set(files)].sort().join('|');
  useEffect(() => {
    for (const f of new Set(files)) {
      if (cache.has(f) || pending.has(f)) continue;
      pending.add(f);
      queue = queue.then(() => generate(f).catch(() => {})).finally(() => pending.delete(f));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return cache;
}
