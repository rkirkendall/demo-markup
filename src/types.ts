export type AnnotationKind = 'label' | 'cut' | 'speed' | 'narration' | 'instruction';

/** One segment on the timeline. Several clips can point at the same file (after a split). */
export interface Clip {
  id: string;
  /** File name inside the media folder. */
  file: string;
  /** Seconds into the source file where this clip starts. */
  sourceIn: number;
  /** Seconds into the source file where this clip ends. */
  sourceOut: number;
  /** Full length of the source file, in seconds. */
  sourceDuration: number;
}

/**
 * A position pinned to a moment of source footage, not to the timeline.
 * This keeps annotations attached to the right footage when clips move or split.
 */
export interface Anchor {
  clipId: string;
  /** Seconds into the clip's source file. */
  t: number;
}

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  start: Anchor;
  /** Null for a point annotation. */
  end: Anchor | null;
  /** Short name shown on the timeline. */
  title: string;
  /** The instruction for the AI agent. */
  text: string;
  /** For 'speed': how long the range should last after the edit, in seconds. */
  targetDuration?: number;
  /** For 'narration': retime the range so it lasts as long as the generated audio. */
  matchAudio?: boolean;
}

export interface Project {
  clips: Clip[];
  annotations: Annotation[];
}

export interface MediaFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export interface Selection {
  start: number;
  end: number;
}

export const KIND_META: Record<
  AnnotationKind,
  { name: string; verb: string; color: string; needsRange: boolean; key: string; placeholder: string }
> = {
  label: {
    name: 'Label',
    verb: 'Label',
    color: '#7c8cff',
    needsRange: false,
    key: 'L',
    placeholder: 'What is this part? e.g. "Hook: the fancy dashboard reveal"',
  },
  cut: {
    name: 'Cut',
    verb: 'Cut',
    color: '#ff5d5d',
    needsRange: true,
    key: 'X',
    placeholder: 'Optional: why cut, or how to transition across the gap',
  },
  speed: {
    name: 'Speed',
    verb: 'Speed',
    color: '#f5b83d',
    needsRange: true,
    key: 'R',
    placeholder: 'Optional: e.g. "Ease in and out of the speed-up"',
  },
  narration: {
    name: 'Narration',
    verb: 'Narrate',
    color: '#3ec7a0',
    needsRange: true,
    key: 'N',
    placeholder: 'What should the narration say here?',
  },
  instruction: {
    name: 'Instruction',
    verb: 'Instruct',
    color: '#c77dff',
    needsRange: false,
    key: 'T',
    placeholder: 'Tell the AI what to do here. e.g. "Create a fancy intro graphic, then transition into this."',
  },
};
