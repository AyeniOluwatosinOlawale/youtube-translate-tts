import { NextRequest, NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { Innertube } from 'youtubei.js';
import OpenAI, { toFile } from 'openai';

export const maxDuration = 300;

const TRANSLATE_PROMPT = `Translate the following JSON array of strings into {language}.
Return ONLY a valid JSON object: {"translations": ["...", "..."]}
Same count, same order. No extra text.`;

type CaptionItem = { text: string; offset: number; duration: number };

/* ---- Try YouTube captions (fast path) ---- */
async function fetchCaptions(videoId: string): Promise<CaptionItem[] | null> {
  for (const lang of [undefined, 'en', 'a.en', 'en-US']) {
    try {
      const items = lang
        ? await YoutubeTranscript.fetchTranscript(videoId, { lang })
        : await YoutubeTranscript.fetchTranscript(videoId);
      if (items?.length) return items;
    } catch { /* next lang */ }
  }
  return null;
}

/* ---- Fallback: download audio → OpenAI transcription with timestamps ---- */
async function transcribeAudio(videoId: string, client: OpenAI): Promise<CaptionItem[]> {
  // Get signed streaming URL via youtubei.js internal API
  const yt = await Innertube.create();
  const info = await yt.getInfo(videoId);
  const format = info.chooseFormat({ type: 'audio', quality: 'best' });

  if (!format?.url) {
    throw new Error('Could not get audio URL — video may be private or age-restricted.');
  }

  const audioRes = await fetch(format.url, {
    headers: {
      // Mimic YouTube Android app to avoid CDN blocks
      'User-Agent': 'com.google.android.youtube/19.09.36 (Linux; U; Android 11) gzip',
      'Referer': 'https://www.youtube.com/',
    },
  });

  if (!audioRes.ok) {
    throw new Error(`Audio download failed (HTTP ${audioRes.status}). Try a different video.`);
  }

  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  if (audioBuffer.length > 24 * 1024 * 1024) {
    throw new Error('Video is too long (>~25 min). Try a shorter clip.');
  }

  // Transcribe with timestamps so we can sync audio segments to video
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
    return raw.segments.map((s) => ({
      text: s.text.trim(),
      offset: Math.round(s.start * 1000),
      duration: Math.round((s.end - s.start) * 1000),
    }));
  }

  // No segment timestamps returned — treat as one block
  return [{ text: raw.text ?? '', offset: 0, duration: 600_000 }];
}

/* ---- Main SSE handler ---- */
export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();

  const send = async (data: object) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      const { videoId, language, voice } = await req.json();

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        await send({ type: 'error', message: 'OPENAI_API_KEY not set on server.' });
        return;
      }
      const client = new OpenAI({ apiKey });

      // 1. Get caption/transcript items with timestamps
      await send({ type: 'status', message: 'Fetching transcript…' });

      let items: CaptionItem[];
      const captions = await fetchCaptions(videoId);

      if (captions) {
        items = captions;
        await send({ type: 'status', message: `Found ${items.length} caption segments.` });
      } else {
        await send({ type: 'status', message: 'No captions — downloading audio to transcribe…' });
        try {
          items = await transcribeAudio(videoId, client);
          await send({ type: 'status', message: `Transcribed ${items.length} segments.` });
        } catch (e) {
          await send({ type: 'error', message: e instanceof Error ? e.message : 'Transcription failed.' });
          return;
        }
      }

      await send({ type: 'total', count: items.length });

      // 2. Translate all segments in one GPT call
      await send({ type: 'status', message: `Translating ${items.length} segments to ${language}…` });
      const texts = items.map((i) => i.text);
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

      // Send segment metadata to client
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

      // 3. Generate TTS in parallel batches of 5
      const BATCH = 5;
      for (let i = 0; i < items.length; i += BATCH) {
        const indices = Array.from({ length: Math.min(BATCH, items.length - i) }, (_, k) => i + k);
        await Promise.all(
          indices.map(async (idx) => {
            try {
              const text = (translations[idx] ?? items[idx].text).trim();
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
