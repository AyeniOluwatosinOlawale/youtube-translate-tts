import { NextRequest, NextResponse } from 'next/server';
import ytdl from '@distube/ytdl-core';
import OpenAI, { toFile } from 'openai';
import { Readable } from 'stream';

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

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
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

      // Step 1: Download audio
      await send({ step: 'downloading', message: 'Downloading audio from YouTube...' });
      let audioBuffer: Buffer;
      try {
        const audioStream = ytdl(url.trim(), {
          filter: 'audioonly',
          quality: 'highestaudio',
        });
        audioBuffer = await streamToBuffer(audioStream as unknown as Readable);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await send({ step: 'error', message: `Could not download YouTube audio: ${msg}` });
        return;
      }

      // Step 2: Transcribe
      await send({ step: 'transcribing', message: 'Transcribing audio...' });
      const audioFile = await toFile(audioBuffer, 'audio.webm', { type: 'audio/webm' });
      const transcriptionResponse = await client.audio.transcriptions.create({
        model: 'gpt-4o-mini-transcribe',
        file: audioFile,
        response_format: 'text',
      });
      const transcript = transcriptionResponse as unknown as string;

      if (!transcript.trim()) {
        await send({ step: 'error', message: 'No speech detected in the audio.' });
        return;
      }

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
