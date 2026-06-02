import { NextRequest, NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import OpenAI from 'openai';

export const maxDuration = 300;

const LANGUAGES = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Japanese', 'Korean', 'Chinese (Simplified)', 'Arabic',
  'Hindi', 'Russian', 'Dutch', 'Polish', 'Turkish',
];

const SYSTEM_PROMPT = `You are a professional translator and localization expert.
Translate the following transcript into {language}.

Rules:
- Output ONLY the translated text, nothing else
- No explanations, no notes, no markdown formatting
- Preserve the speaker's tone and style
- Format for natural spoken audio — no bullet points, no headers
- If the source language is already {language}, return the text unchanged`;

function extractVideoId(url: string): string | null {
  const match = url.match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function splitText(text: string, maxChars = 4096): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let current = '';
  const terminators = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];

  let i = 0;
  let segStart = 0;
  while (i < text.length) {
    let found = false;
    for (const t of terminators) {
      if (text.slice(i, i + t.length) === t) {
        const seg = text.slice(segStart, i + t.length);
        if (current.length + seg.length <= maxChars) {
          current += seg;
        } else {
          if (current) chunks.push(current.trim());
          current = seg;
        }
        segStart = i + t.length;
        i = segStart;
        found = true;
        break;
      }
    }
    if (!found) i++;
  }
  const tail = text.slice(segStart);
  if (tail) current += tail;
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function synthesizeSpeech(client: OpenAI, text: string, voice: string): Promise<Buffer> {
  const chunks = splitText(text);
  const buffers: Buffer[] = [];
  for (const chunk of chunks) {
    const response = await client.audio.speech.create({
      model: 'tts-1',
      voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
      input: chunk,
      response_format: 'mp3',
    });
    buffers.push(Buffer.from(await response.arrayBuffer()));
  }
  return Buffer.concat(buffers);
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
      const body = await req.json();
      const { url, language, voice } = body as { url: string; language: string; voice: string };

      if (!url?.trim()) {
        await send({ step: 'error', message: 'YouTube URL is required.' });
        return;
      }
      if (!LANGUAGES.includes(language)) {
        await send({ step: 'error', message: `Unsupported language: ${language}` });
        return;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        await send({ step: 'error', message: 'Server misconfiguration: OPENAI_API_KEY is not set.' });
        return;
      }
      const client = new OpenAI({ apiKey });

      // Step 1: Fetch transcript from YouTube captions
      await send({ step: 'downloading', message: 'Fetching transcript from YouTube...' });

      const videoId = extractVideoId(url.trim());
      if (!videoId) {
        await send({ step: 'error', message: 'Could not extract a video ID from that URL. Make sure it is a valid YouTube link.' });
        return;
      }

      let transcript: string;
      try {
        const items = await YoutubeTranscript.fetchTranscript(videoId);
        if (!items || items.length === 0) {
          await send({ step: 'error', message: 'No captions found for this video. Try a video that has subtitles enabled.' });
          return;
        }
        transcript = items.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await send({
          step: 'error',
          message: `Could not fetch captions: ${msg}. Try a video with subtitles/captions enabled.`,
        });
        return;
      }

      if (!transcript.trim()) {
        await send({ step: 'error', message: 'Transcript is empty.' });
        return;
      }

      // Step 2 (merged): emit transcribing done
      await send({ step: 'transcribing', message: 'Transcript ready.' });

      // Step 3: Translate
      await send({ step: 'translating', message: `Translating to ${language}...` });
      const translationResponse = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT.replace(/{language}/g, language),
          },
          { role: 'user', content: transcript },
        ],
        temperature: 0.3,
        max_tokens: 16384,
      });
      const translation = translationResponse.choices[0].message.content?.trim() ?? '';

      // Step 4: TTS
      await send({ step: 'speaking', message: 'Generating speech...' });
      const mp3Buffer = await synthesizeSpeech(client, translation, voice);
      const audioBase64 = mp3Buffer.toString('base64');

      // Step 5: Done
      await send({ step: 'done', transcript, translation, audio: audioBase64 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      await send({ step: 'error', message });
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
