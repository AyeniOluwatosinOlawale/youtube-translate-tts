import { NextRequest, NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { Innertube } from 'youtubei.js';
import OpenAI, { toFile } from 'openai';

export const maxDuration = 300;

const TRANSLATE_PROMPT = `Translate the following JSON array of strings into {language}.
Return ONLY a valid JSON object: {"translations": ["...", "..."]}
Same count, same order. No extra text.`;

type CaptionItem = { text: string; offset: number; duration: number };

/* ------------------------------------------------------------------ */
/* Strategy 1: youtube-transcript package (fast, no auth)              */
/* ------------------------------------------------------------------ */
async function fetchViaPackage(videoId: string): Promise<CaptionItem[] | null> {
  for (const lang of [undefined, 'en', 'a.en', 'en-US']) {
    try {
      const items = lang
        ? await YoutubeTranscript.fetchTranscript(videoId, { lang })
        : await YoutubeTranscript.fetchTranscript(videoId);
      if (items?.length) return items;
    } catch { /* try next */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Strategy 2: youtubei.js getInfo() → caption CDN fetch              */
/* getInfo() succeeds from server IPs (YouTube strips streaming URLs  */
/* but keeps captions in the same player response). We read           */
/* info.captions.caption_tracks and fetch the CDN JSON directly.     */
/* ------------------------------------------------------------------ */

async function parseCaptionItems(baseUrl: string): Promise<CaptionItem[] | null> {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('fmt', 'json3');
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = data.events ?? [];
    const items: CaptionItem[] = events
      .filter(e => e.segs?.length && typeof e.tStartMs === 'number')
      .map(e => ({
        text: (e.segs as Array<{ utf8?: string }>)
          .map(s => s.utf8 ?? '')
          .join('')
          .replace(/\n/g, ' ')
          .trim(),
        offset: e.tStartMs as number,
        duration: (e.dDurationMs as number) ?? 3000,
      }))
      .filter(i => i.text.length > 0);
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

async function fetchViaInnertube(videoId: string): Promise<{ items: CaptionItem[] | null; debug: string }> {
  try {
    const yt = await Innertube.create();
    const info = await yt.getInfo(videoId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captionsNode = (info as any).captions;
    if (!captionsNode) return { items: null, debug: 'captions node is null' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracks = captionsNode.caption_tracks as Array<{ base_url: string; language_code: string }> | undefined;
    if (!tracks?.length) {
      // Log what keys are actually present on the captions node
      const keys = Object.keys(captionsNode).join(',');
      return { items: null, debug: `caption_tracks empty; captions keys: ${keys}` };
    }

    const track = tracks.find(t => t.language_code?.startsWith('en')) ?? tracks[0];
    if (!track?.base_url) return { items: null, debug: `track found (${track?.language_code}) but no base_url` };

    const items = await parseCaptionItems(track.base_url);
    return { items, debug: items ? `ok: ${items.length} segments` : 'parseCaptionItems returned null' };
  } catch (e) {
    return { items: null, debug: `threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ------------------------------------------------------------------ */
/* Strategy 3: download audio → gpt-4o-mini-transcribe (last resort)  */
/* ------------------------------------------------------------------ */
async function transcribeAudio(videoId: string, client: OpenAI): Promise<CaptionItem[]> {
  const yt = await Innertube.create(); // retrieve_player:true needed for streaming URLs
  const info = await yt.getInfo(videoId);
  const format = info.chooseFormat({ type: 'audio', quality: 'best' });

  if (!format?.url) {
    throw new Error('Could not get audio stream URL — video may be private or age-restricted.');
  }

  const audioRes = await fetch(format.url, {
    headers: {
      'User-Agent': 'com.google.android.youtube/19.09.36 (Linux; U; Android 11) gzip',
      'Referer': 'https://www.youtube.com/',
    },
  });

  if (!audioRes.ok) {
    throw new Error(
      `Audio download failed (HTTP ${audioRes.status}). ` +
      'This video\'s audio is blocked from server access — try a video with captions enabled.'
    );
  }

  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  if (audioBuffer.length > 24 * 1024 * 1024) {
    throw new Error('Video audio exceeds 24 MB (>~25 min). Try a shorter video.');
  }

  const audioFile = await toFile(audioBuffer, 'audio.mp4', { type: 'audio/mp4' });
  const result = await client.audio.transcriptions.create({
    model: 'gpt-4o-mini-transcribe',
    file: audioFile,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  const raw = result as unknown as {
    text: string;
    segments?: { text: string; start: number; end: number }[];
  };

  if (raw.segments?.length) {
    return raw.segments.map(s => ({
      text: s.text.trim(),
      offset: Math.round(s.start * 1000),
      duration: Math.round((s.end - s.start) * 1000),
    }));
  }
  return [{ text: raw.text ?? '', offset: 0, duration: 600_000 }];
}

/* ------------------------------------------------------------------ */
/* SSE handler                                                         */
/* ------------------------------------------------------------------ */
export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();

  const send = async (data: object) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      const { videoId, language, voice, captions: prefetched } = await req.json();

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        await send({ type: 'error', message: 'OPENAI_API_KEY not set on server.' });
        return;
      }
      const client = new OpenAI({ apiKey });

      // --- Get caption items ---
      // Primary: use captions fetched by the browser (residential IP, not blocked by YouTube)
      let items: CaptionItem[] | null =
        Array.isArray(prefetched) && prefetched.length > 0 ? (prefetched as CaptionItem[]) : null;

      if (items) {
        await send({ type: 'status', message: `Using ${items.length} captions from browser.` });
      } else {
        // Server-side fallback strategies
        await send({ type: 'status', message: 'Fetching transcript (server fallback)…' });

        items = await fetchViaPackage(videoId);
        if (items) await send({ type: 'status', message: `Found ${items.length} caption segments.` });

        if (!items) {
          const { items: s2, debug } = await fetchViaInnertube(videoId);
          items = s2;
          if (items) await send({ type: 'status', message: `Fetched ${items.length} caption segments.` });
          else await send({ type: 'status', message: `Server caption fetch failed (${debug}). Trying audio…` });
        }

        if (!items) {
          await send({ type: 'status', message: 'Transcribing audio (last resort)…' });
          try {
            items = await transcribeAudio(videoId, client);
            await send({ type: 'status', message: `Transcribed ${items.length} segments from audio.` });
          } catch (e) {
            await send({ type: 'error', message: e instanceof Error ? e.message : 'All caption methods failed.' });
            return;
          }
        }
      }

      await send({ type: 'total', count: items.length });

      // --- Translate all segments in one GPT call ---
      await send({ type: 'status', message: `Translating ${items.length} segments to ${language}…` });
      const texts = items.map(i => i.text);
      let translations: string[] = texts;
      try {
        const resp = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: TRANSLATE_PROMPT.replace('{language}', language) },
            { role: 'user', content: JSON.stringify(texts) },
          ],
          temperature: 0.2,
        });
        const raw = (resp.choices[0].message.content ?? '{}')
          .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        translations = JSON.parse(raw).translations ?? texts;
      } catch { /* fallback to originals */ }

      // Send all segment metadata
      for (let i = 0; i < items.length; i++) {
        await send({
          type: 'segment',
          index: i,
          original: items[i].text,
          translated: translations[i] ?? items[i].text,
          offset: items[i].offset,
          duration: items[i].duration,
        });
      }

      // --- Generate TTS in parallel batches of 5 ---
      const BATCH = 5;
      for (let i = 0; i < items.length; i += BATCH) {
        const indices = Array.from({ length: Math.min(BATCH, items.length - i) }, (_, k) => i + k);
        await Promise.all(
          indices.map(async idx => {
            try {
              const text = (translations[idx] ?? items![idx].text).trim();
              if (!text) { await send({ type: 'audio', index: idx, audio: '' }); return; }
              const tts = await client.audio.speech.create({
                model: 'tts-1',
                voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
                input: text.slice(0, 4096),
                response_format: 'mp3',
              });
              const buf = Buffer.from(await tts.arrayBuffer());
              await send({ type: 'audio', index: idx, audio: buf.toString('base64') });
            } catch {
              await send({ type: 'audio', index: idx, audio: '' });
            }
          })
        );
      }

      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      await writer.close();
    }
  })();

  return new NextResponse(transform.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
