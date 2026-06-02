'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

/* ---------- YouTube IFrame API types ---------- */
declare global {
  interface Window {
    YT: {
      Player: new (el: HTMLElement, opts: object) => YTPlayer;
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
    };
    onYouTubeIframeAPIReady: () => void;
  }
}
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  getCurrentTime(): number;
  destroy(): void;
}

/* ---------- Data types ---------- */
interface Segment {
  index: number;
  original: string;
  translated: string;
  offset: number;    // ms from video start
  duration: number;  // ms
  audio: string | null; // base64 mp3
}

type Phase = 'idle' | 'preparing' | 'ready' | 'playing' | 'error';

const LANGUAGES = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Japanese', 'Korean', 'Chinese (Simplified)', 'Arabic',
  'Hindi', 'Russian', 'Dutch', 'Polish', 'Turkish',
];
const VOICES = ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'];

function extractId(url: string) {
  return url.match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/)?.[1] ?? null;
}

type RawCaption = { text: string; offset: number; duration: number };

function parseTimedEvents(events: Array<{ segs?: Array<{ utf8?: string }>; tStartMs?: number; dDurationMs?: number }>): RawCaption[] {
  return events
    .filter(e => e.segs?.length && typeof e.tStartMs === 'number')
    .map(e => ({
      text: (e.segs ?? []).map(s => s.utf8 ?? '').join('').replace(/\n/g, ' ').trim(),
      offset: e.tStartMs as number,
      duration: e.dDurationMs ?? 3000,
    }))
    .filter(i => i.text.length > 0);
}

// Fetch captions client-side using the browser's residential IP.
// Vercel datacenter IPs are blocked by YouTube; the user's browser is not.
async function fetchCaptionsInBrowser(videoId: string): Promise<RawCaption[] | null> {
  // Strategy A: InnerTube player API (IOS/WEB clients)
  const bodies = [
    { videoId, context: { client: { clientName: 'IOS', clientVersion: '19.09.3', deviceMake: 'Apple', deviceModel: 'iPhone14,3', osName: 'iPhone', osVersion: '17.5.1.21F90', hl: 'en', gl: 'US' } } },
    { videoId, context: { client: { clientName: 'WEB', clientVersion: '2.20240401.00.00', hl: 'en', gl: 'US' } } },
  ];
  for (const body of bodies) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const tracks: Array<{ baseUrl: string; languageCode?: string }> | undefined =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks?.length) continue;
      const track = tracks.find(t => t.languageCode?.startsWith('en')) ?? tracks[0];
      if (!track?.baseUrl) continue;
      const u = new URL(track.baseUrl);
      u.searchParams.set('fmt', 'json3');
      const cr = await fetch(u.toString());
      if (!cr.ok) continue;
      const items = parseTimedEvents((await cr.json()).events ?? []);
      if (items.length > 0) return items;
    } catch { /* CORS or network error — try next */ }
  }

  // Strategy B: unsigned timedtext URL (works for auto-captions on some videos)
  for (const lang of ['en', 'en-US', 'a.en']) {
    try {
      const res = await fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`);
      if (!res.ok) continue;
      const items = parseTimedEvents((await res.json()).events ?? []);
      if (items.length > 0) return items;
    } catch { /* try next */ }
  }

  return null;
}

/* ================================================ */
export default function Home() {
  const [url, setUrl]           = useState('');
  const [language, setLanguage] = useState('Spanish');
  const [voice, setVoice]       = useState('nova');
  const [phase, setPhase]       = useState<Phase>('idle');
  const [videoId, setVideoId]   = useState('');
  const [total, setTotal]       = useState(0);
  const [ready, setReady]       = useState(0);
  const [subtitle, setSubtitle] = useState('');
  const [error, setError]       = useState('');
  const [statusMsg, setStatus]  = useState('');

  const playerRef    = useRef<YTPlayer | null>(null);
  const audioRef     = useRef<HTMLAudioElement | null>(null);
  const segmentsRef  = useRef<Segment[]>([]);
  const curSegRef    = useRef(-1);
  const syncRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef     = useRef<Phase>('idle');
  const abortRef     = useRef<AbortController | null>(null);

  function updatePhase(p: Phase) { phaseRef.current = p; setPhase(p); }

  /* ---- Load YouTube IFrame API once ---- */
  useEffect(() => {
    if (typeof window === 'undefined' || window.YT) return;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }, []);

  /* ---- Transition to ready once enough audio is buffered ---- */
  useEffect(() => {
    if (phaseRef.current === 'preparing' && total > 0 && ready >= Math.min(5, total)) {
      updatePhase('ready');
    }
  }, [ready, total]);

  /* ---- Init YouTube player ---- */
  const initPlayer = useCallback((vid: string) => {
    playerRef.current?.destroy();
    const mount = () => {
      const el = document.getElementById('yt-mount');
      if (!el) return;
      playerRef.current = new window.YT.Player(el as HTMLElement, {
        videoId: vid,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => playerRef.current?.mute(),
          onStateChange: (e: { data: number }) => {
            if (e.data === 1) startSync();  // PLAYING
            else stopSync();
          },
        },
      });
    };
    if (window.YT?.Player) mount();
    else window.onYouTubeIframeAPIReady = mount;
  }, []);

  /* ---- Sync loop: every 100ms, play correct TTS segment ---- */
  function startSync() {
    if (syncRef.current) return;
    syncRef.current = setInterval(() => {
      if (!playerRef.current) return;
      const ms   = playerRef.current.getCurrentTime() * 1000;
      const segs = segmentsRef.current;
      const idx  = segs.findIndex(s => ms >= s.offset && ms < s.offset + s.duration);

      if (idx !== curSegRef.current) {
        curSegRef.current = idx;
        if (idx >= 0) {
          setSubtitle(segs[idx].translated);
          const a = audioRef.current;
          if (a && segs[idx].audio) {
            a.pause();
            a.src = `data:audio/mpeg;base64,${segs[idx].audio}`;
            a.play().catch(() => {});
          }
        } else {
          setSubtitle('');
          audioRef.current?.pause();
        }
      }
    }, 100);
  }

  function stopSync() {
    if (syncRef.current) { clearInterval(syncRef.current); syncRef.current = null; }
  }

  /* ---- Main: load video + start processing ---- */
  async function handleLoad(e: React.FormEvent) {
    e.preventDefault();
    const vid = extractId(url);
    if (!vid) { setError('Invalid YouTube URL.'); return; }

    // Abort any running stream
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    // Reset state
    setError('');
    setSubtitle('');
    setTotal(0);
    setReady(0);
    segmentsRef.current = [];
    curSegRef.current = -1;
    stopSync();

    setVideoId(vid);
    updatePhase('preparing');
    setStatus('Fetching captions…');

    // Init YouTube player
    requestAnimationFrame(() => setTimeout(() => initPlayer(vid), 300));

        // Fetch captions via edge function (Cloudflare IPs, not blocked by YouTube)
    let browserCaptions: RawCaption[] | null = null;
    try {
      const cr = await fetch(`/api/captions?videoId=${vid}`);
      if (cr.ok) {
        const cd = await cr.json() as { items?: RawCaption[] | null; debug?: string };
        if (cd.items?.length) {
          browserCaptions = cd.items;
          setStatus(`Got ${browserCaptions.length} caption segments — translating…`);
        } else {
          // Edge route returned no captions — fall back to browser-direct fetch
          browserCaptions = await fetchCaptionsInBrowser(vid);
          if (browserCaptions) setStatus(`Got ${browserCaptions.length} caption segments — translating…`);
        }
      }
    } catch { /* server will fall back */ }

    // Stream processing
    let res: Response;
    try {
      res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: vid, language, voice, captions: browserCaptions }),
        signal: abortRef.current.signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError('Network error — could not reach the server.');
      updatePhase('error');
      return;
    }

    if (!res.body) { setError('Empty server response.'); updatePhase('error'); return; }

    const reader  = res.body.getReader();
    const dec     = new TextDecoder();
    let buf       = '';
    const acc: Segment[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const d = JSON.parse(part.slice(6));

          if (d.type === 'status') {
            setStatus(d.message);
          }

          if (d.type === 'total') {
            setTotal(d.count);
            for (let i = 0; i < d.count; i++)
              acc.push({ index: i, original: '', translated: '', offset: 0, duration: 0, audio: null });
            setStatus(`Translating ${d.count} segments…`);
          }

          if (d.type === 'segment') {
            acc[d.index] = { ...acc[d.index], ...d };
          }

          if (d.type === 'audio') {
            acc[d.index] = { ...acc[d.index], audio: d.audio };
            const r = acc.filter(s => s.audio !== null).length;
            setReady(r);
            segmentsRef.current = [...acc];
            setStatus(`Generating audio… ${r} / ${acc.length}`);
          }

          if (d.type === 'done') {
            segmentsRef.current = [...acc];
            updatePhase('ready');
            setStatus('Ready!');
          }

          if (d.type === 'error') {
            setError(d.message);
            updatePhase('error');
            return;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError('Stream interrupted.');
        updatePhase('error');
      }
    }
  }

  function handlePlay() {
    playerRef.current?.mute();
    playerRef.current?.playVideo();
    updatePhase('playing');
    curSegRef.current = -1;
    setSubtitle('');
  }

  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;

  return (
    <main className="min-h-screen bg-[#080808] text-white flex flex-col items-center px-4 py-12">
      <audio ref={audioRef} className="hidden" />

      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-indigo-600 mb-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight mb-1">YouTube Translator</h1>
          <p className="text-zinc-500 text-sm">Watch any YouTube video in your language</p>
        </div>

        {/* Form */}
        <form onSubmit={handleLoad} className="space-y-3 mb-6">
          <div className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              required
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm outline-none focus:border-indigo-500 transition-colors placeholder-zinc-600"
            />
            <button
              type="submit"
              disabled={phase === 'preparing'}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:cursor-not-allowed rounded-xl px-5 py-3 text-sm font-medium transition-colors shrink-0"
            >
              {phase === 'preparing' ? '…' : 'Load'}
            </button>
          </div>

          <div className="flex gap-3">
            <select value={language} onChange={e => setLanguage(e.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm outline-none focus:border-indigo-500 transition-colors">
              {LANGUAGES.map(l => <option key={l}>{l}</option>)}
            </select>
            <select value={voice} onChange={e => setVoice(e.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm outline-none focus:border-indigo-500 transition-colors">
              {VOICES.map(v => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
            </select>
          </div>
        </form>

        {/* Error */}
        {error && (
          <div className="bg-red-950/60 border border-red-800 rounded-xl p-4 text-sm text-red-300 mb-5">
            {error}
          </div>
        )}

        {/* YouTube Player */}
        {videoId && (
          <div className="relative bg-black rounded-2xl overflow-hidden mb-5" style={{ paddingTop: '56.25%' }}>
            <div id="yt-mount" className="absolute inset-0 w-full h-full" />
            {/* Subtitle overlay */}
            {subtitle && (
              <div className="absolute bottom-14 left-0 right-0 flex justify-center px-6 pointer-events-none z-10">
                <p className="bg-black/85 backdrop-blur-sm text-white text-sm rounded-lg px-4 py-2 text-center max-w-lg leading-relaxed shadow-lg">
                  {subtitle}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Progress bar while preparing */}
        {phase === 'preparing' && total > 0 && (
          <div className="mb-5">
            <div className="flex justify-between text-xs text-zinc-500 mb-1.5">
              <span>{statusMsg}</span>
              <span>{pct}%</span>
            </div>
            <div className="bg-zinc-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-indigo-500 h-full transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {phase === 'preparing' && total === 0 && (
          <p className="text-center text-sm text-zinc-500 animate-pulse mb-5">{statusMsg}</p>
        )}

        {/* Play button */}
        {phase === 'ready' && (
          <div className="text-center">
            {ready < total && (
              <p className="text-xs text-zinc-500 mb-3">{ready}/{total} segments ready — rest loading in background</p>
            )}
            <button
              onClick={handlePlay}
              className="bg-indigo-600 hover:bg-indigo-500 rounded-xl px-10 py-3.5 font-semibold text-sm transition-colors"
            >
              ▶ Play with Translation
            </button>
          </div>
        )}

        {/* Playing status */}
        {phase === 'playing' && (
          <p className="text-center text-xs text-zinc-600">
            {ready < total ? `Loading remaining segments… ${ready}/${total}` : `All ${total} segments loaded ✓`}
          </p>
        )}
      </div>
    </main>
  );
}
