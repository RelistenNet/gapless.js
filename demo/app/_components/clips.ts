import type { DemoTrack } from './tracks';

// Two halves of one continuous 10-second stretch of Scarlet Begonias
// (Cornell 1977-05-08, 2:22–2:32), cut at an exact sample with no fade.
// The music runs straight through the cut, so any gap is audible.
// Regenerate with ffmpeg from the 48 kHz source:
//   atrim=start_sample=6816000:end_sample=7056000 (part 1)
//   atrim=start_sample=7056000:end_sample=7296000 (part 2)
export const CLIP_SECONDS = 5;

export const CLIPS: DemoTrack[] = [
  { url: '/clips/part-1.wav', title: 'part-1.wav' },
  { url: '/clips/part-2.wav', title: 'part-2.wav' },
];

/** Normalized peak amplitude, 64 buckets per clip. */
export const PEAKS: number[][] = [
  [
    0.54, 0.44, 0.52, 0.35, 0.76, 0.6, 0.27, 0.61, 0.32, 0.65, 0.34, 0.55, 0.77, 0.34, 0.28, 0.25,
    0.28, 0.38, 0.3, 0.52, 0.39, 0.7, 0.48, 0.27, 0.26, 0.23, 0.6, 0.44, 0.28, 0.27, 0.2, 0.71,
    0.28, 0.22, 0.25, 0.21, 0.59, 0.21, 0.53, 0.65, 0.3, 0.35, 0.29, 0.73, 0.34, 0.44, 0.45, 0.47,
    0.55, 0.26, 0.38, 0.31, 0.41, 0.35, 0.31, 0.32, 0.28, 0.18, 0.24, 0.44, 1.0, 0.61, 0.34, 0.32,
  ],
  [
    0.37, 0.56, 0.35, 0.32, 0.33, 0.44, 0.44, 0.21, 0.34, 0.28, 0.46, 0.51, 0.36, 0.32, 0.17, 0.66,
    0.59, 0.35, 0.35, 0.24, 0.47, 0.19, 0.14, 0.19, 0.25, 0.69, 0.26, 0.21, 0.22, 0.18, 0.43, 0.31,
    0.26, 0.23, 0.52, 0.66, 0.31, 0.23, 0.18, 0.41, 0.31, 0.15, 0.23, 0.14, 0.76, 0.73, 0.32, 0.36,
    0.2, 0.36, 0.27, 0.62, 0.48, 0.43, 0.63, 0.33, 0.47, 0.35, 0.38, 0.57, 0.31, 0.56, 0.36, 0.47,
  ],
];
