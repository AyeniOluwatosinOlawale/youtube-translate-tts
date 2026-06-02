// Edge runtime: runs on Cloudflare's global network, not AWS Lambda.
// Cloudflare IPs are not blocked by YouTube the way Lambda datacenter IPs are.
export const runtime = 'edge';

type CaptionEvent = {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
};

type CaptionTrack = {
  baseUrl: string;
  languageCode?: string;
};

async function parseCaption(baseUrl: string) {
  const u = new URL(baseUrl);
  u.searchParams.set('fmt', 'json3');
  const res = await fetch(u.toString());
  if (!res.ok) return null;
  const data = await res.json() as { events?: CaptionEvent[] };
  const events = data.events ?? [];
  const items = events
    .filter(e => e.segs?.length && typeof e.tStartMs === 'number')
    .map(e => ({
      text: (e.segs ?? []).map(s => s.utf8 ?? '').join('').replace(/\n/g, ' ').trim(),
      offset: e.tStartMs as number,
      duration: e.dDurationMs ?? 3000,
    }))
    .filter(i => i.text.length > 0);
  return items.length > 0 ? items : null;
}

type ClientDef = {
  headers: Record<string, string>;
  context: Record<string, unknown>;
};

const CLIENTS: ClientDef[] = [
  {
    headers: { 'User-Agent': 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 17_5_1 like Mac OS X)' },
    context: { client: { clientName: 'IOS', clientVersion: '19.09.3', deviceMake: 'Apple', deviceModel: 'iPhone14,3', osName: 'iPhone', osVersion: '17.5.1.21F90', hl: 'en', gl: 'US' } },
  },
  {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Origin': 'https://www.youtube.com', 'Referer': 'https://www.youtube.com/' },
    context: { client: { clientName: 'WEB', clientVersion: '2.20240401.00.00', hl: 'en', gl: 'US' } },
  },
  {
    headers: { 'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 Safari/538.1' },
    context: { client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en', gl: 'US' }, thirdParty: { embedUrl: 'https://www.youtube.com/' } },
  },
];

export async function GET(req: Request) {
  const videoId = new URL(req.url).searchParams.get('videoId');
  if (!videoId) return new Response(JSON.stringify({ error: 'videoId required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  let lastStatus = 'unknown';

  for (const client of CLIENTS) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...client.headers },
        body: JSON.stringify({ videoId, context: client.context }),
      });

      if (!res.ok) { lastStatus = `http_${res.status}`; continue; }

      const data = await res.json() as {
        playabilityStatus?: { status?: string };
        captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
      };

      lastStatus = data.playabilityStatus?.status ?? 'no_status';
      const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks?.length) continue;

      const track = tracks.find(t => t.languageCode?.startsWith('en')) ?? tracks[0];
      if (!track?.baseUrl) continue;

      const items = await parseCaption(track.baseUrl);
      if (items) {
        return new Response(JSON.stringify({ items }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      lastStatus = `threw:${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return new Response(JSON.stringify({ items: null, debug: lastStatus }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
