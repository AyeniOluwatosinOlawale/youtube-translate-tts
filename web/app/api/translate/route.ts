import { NextRequest, NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { Innertube } from 'youtubei.js';
import OpenAI, { toFile } from 'openai';

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

// Fetch captions from YouTube — returns null if unavailable
async function fetchCaptions(videoId: string): Promise<string | null> {
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    if (!items || items.length === 0) return null;
    return items.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

// Download audio using youtubei.js internal API — avoids streaming URL bot-detection
async function downloadAudioBuffer(videoId: string): Promise<Buffer> {
  const yt = await Innertube.create({ retrieve_player: false });
  const info = await yt.getInfo(videoId);

  const format = info.chooseFormat({ type: 'audio', quality: 'best' });
  if (!format?.url) {
    throw new Error('No audio format URL found for this video.');
  }

  const res = await fetch(format.url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch audio: HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
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

      const videoId = extractVideoId(url.trim());
      if (!videoId) {
        await send({ step: 'error', message: 'Could not extract a video ID from that URL.' });
        return;
      }

      // Step 1a: Try captions first (fast, no API cost)
      await send({ step: 'downloading', message: 'Fetching transcript from YouTube...' });
      let transcript = await fetchCaptions(videoId);

      // Step 1b: No captions — fall back to audio download + Whisper
      if (!transcript) {
        await send({ step: 'downloading', message: 'No captions found — downloading audio...' });
        let audioBuffer: Buffer;
        try {
          audioBuffer = await downloadAudioBuffer(videoId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await send({ step: 'error', message: `Could not download audio: ${msg}` });
          return;
        }

        await send({ step: 'transcribing', message: 'Transcribing audio with AI...' });
        try {
          const audioFile = await toFile(audioBuffer, 'audio.mp4', { type: 'audio/mp4' });
          const result = await client.audio.transcriptions.create({
            model: 'gpt-4o-mini-transcribe',
            file: audioFile,
            response_format: 'text',
          });
          transcript = result as unknown as string;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await send({ step: 'error', message: `Transcription failed: ${msg}` });
          return;
        }
      } else {
        await send({ step: 'transcribing', message: 'Transcript ready.' });
      }

      if (!transcript?.trim()) {
        await send({ step: 'error', message: 'No speech or captions found in this video.' });
        return;
      }

      // Step 2: Translate
      await send({ step: 'translating', message: `Translating to ${language}...` });
      const translationResponse = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT.replace(/{language}/g, language) },
          { role: 'user', content: transcript },
        ],
        temperature: 0.3,
        max_tokens: 16384,
      });
      const translation = translationResponse.choices[0].message.content?.trim() ?? '';

      // Step 3: TTS
      await send({ step: 'speaking', message: 'Generating speech...' });
      const mp3Buffer = await synthesizeSpeech(client, translation, voice);
      const audioBase64 = mp3Buffer.toString('base64');

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
