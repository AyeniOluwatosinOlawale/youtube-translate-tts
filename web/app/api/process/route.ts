import { NextRequest, NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import OpenAI from 'openai';

export const maxDuration = 300;

const TRANSLATE_PROMPT = `Translate the following JSON array of strings into {language}.
Return ONLY a valid JSON object: {"translations": ["...", "..."]}
Same count, same order. No extra text.`;

async function fetchCaptions(videoId: string) {
  const langs = [undefined, 'en', 'a.en', 'en-US'];
  for (const lang of langs) {
    try {
      const items = lang
        ? await YoutubeTranscript.fetchTranscript(videoId, { lang })
        : await YoutubeTranscript.fetchTranscript(videoId);
      if (items?.length) return items;
    } catch { /* try next */ }
  }
  throw new Error(
    'No captions found for this video. ' +
    'Try a different video — most popular YouTube videos have auto-generated captions.'
  );
}

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

      // 1. Fetch captions with timestamps
      let items: { text: string; offset: number; duration: number }[];
      try {
        items = await fetchCaptions(videoId);
      } catch (e) {
        await send({ type: 'error', message: e instanceof Error ? e.message : 'Caption fetch failed.' });
        return;
      }

      await send({ type: 'total', count: items.length });

      // 2. Translate all segments in one GPT call
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
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        translations = JSON.parse(raw).translations ?? texts;
      } catch { /* fallback to original */ }

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
