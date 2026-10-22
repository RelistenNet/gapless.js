export interface DemoTrack {
  url: string;
  title: string;
}

// Grateful Dead — Barton Hall, Cornell University, 1977-05-08.
// Web Audio needs CORS to decode these. audio.relisten.net only allows
// specific origins, so in dev they go through the proxy in vite.config.ts.
const ORIGIN = import.meta.env.DEV ? '/relisten-audio' : 'https://audio.relisten.net';
const BASE = `${ORIGIN}/archive.org//download/gd1977-05-08.148737.SBD.Betty.Anon.Noel.t-flac2448/`;

const track = (file: string, title: string): DemoTrack => ({ url: BASE + file, title });

export const SET_ONE: DemoTrack[] = [
  track('gd77-05-08.s1t01.mp3', 'New Minglewood Blues'),
  track('gd77-05-08.s1t02.mp3', 'Loser'),
  track('gd77-05-08.s1t03.mp3', 'El Paso'),
  track('gd77-05-08.s1t04.mp3', 'They Love Each Other'),
  track('gd77-05-08.s1t05.mp3', 'Jack Straw'),
  track('gd77-05-08.s1t06.mp3', 'Deal'),
  track('gd77-05-08.s1t07.mp3', 'Lazy Lightning'),
  track('gd77-05-08.s1t08.mp3', 'Supplication'),
  track('gd77-05-08.s1t09.mp3', 'Brown Eyed Women'),
  track('gd77-05-08.s1t10.mp3', 'Mama Tried'),
  track('gd77-05-08.s1t11.mp3', 'Row Jimmy'),
];

export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–:––';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
