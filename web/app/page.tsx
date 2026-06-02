'use client';

import { useState, useRef } from 'react';

const LANGUAGES = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Japanese', 'Korean', 'Chinese (Simplified)', 'Arabic',
  'Hindi', 'Russian', 'Dutch', 'Polish', 'Turkish',
];

const VOICES = ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'];

const STEPS = [
  { key: 'downloading', label: 'Download audio' },
  { key: 'transcribing', label: 'Transcribe speech' },
  { key: 'translating', label: 'Translate text' },
  { key: 'speaking', label: 'Generate audio' },
] as const;

type StepKey = typeof STEPS[number]['key'] | 'idle' | 'done' | 'error';

interface Result {
  transcript: string;
  translation: string;
  audio: string;
}

const STEP_ORDER: StepKey[] = ['downloading', 'transcribing', 'translating', 'speaking', 'done'];

export default function Home() {
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState('Spanish');
  const [voice, setVoice] = useState('nova');
  const [currentStep, setCurrentStep] = useState<StepKey>('idle');
  const [stepMessage, setStepMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);

  const isBusy = currentStep !== 'idle' && currentStep !== 'done' && currentStep !== 'error';

  function isStepComplete(key: string): boolean {
    if (currentStep === 'done') return true;
    const cur = STEP_ORDER.indexOf(currentStep as StepKey);
    const check = STEP_ORDER.indexOf(key as StepKey);
    return check < cur;
  }

  function isStepActive(key: string): boolean {
    return currentStep === key;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || isBusy) return;

    setCurrentStep('downloading');
    setStepMessage('');
    setResult(null);
    setError('');

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), language, voice }),
      });

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const data = JSON.parse(part.slice(6));
          setCurrentStep(data.step as StepKey);
          if (data.message) setStepMessage(data.message);
          if (data.step === 'done') {
            setResult({ transcript: data.transcript, translation: data.translation, audio: data.audio });
          }
          if (data.step === 'error') {
            setError(data.message ?? 'Unknown error');
          }
        }
      }
    } catch (err) {
      setCurrentStep('error');
      setError(err instanceof Error ? err.message : 'Network error');
    }
  }

  function downloadAudio() {
    if (!result) return;
    const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `translated_${language.toLowerCase().replace(/\s+/g, '_')}.mp3`;
    a.click();
    URL.revokeObjectURL(blobUrl);
  }

  const audioSrc = result ? `data:audio/mpeg;base64,${result.audio}` : '';

  return (
    <main className="min-h-screen bg-[#080808] text-white flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl">

        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-600 mb-5">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight mb-1">YouTube Translator</h1>
          <p className="text-zinc-500 text-sm">Transcribe · Translate · Speak</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 mb-8">
          <div>
            <label className="block text-xs font-medium uppercase tracking-widest text-zinc-500 mb-2">
              YouTube URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              disabled={isBusy}
              required
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm placeholder-zinc-600 outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium uppercase tracking-widest text-zinc-500 mb-2">
                Language
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={isBusy}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
              >
                {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium uppercase tracking-widest text-zinc-500 mb-2">
                Voice
              </label>
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                disabled={isBusy}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
              >
                {VOICES.map((v) => (
                  <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={isBusy || !url.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed rounded-xl py-3 font-medium text-sm transition-colors"
          >
            {isBusy ? 'Processing…' : 'Translate'}
          </button>
        </form>

        {/* Progress */}
        {currentStep !== 'idle' && currentStep !== 'error' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6 space-y-3">
            {STEPS.map(({ key, label }) => {
              const done = isStepComplete(key);
              const active = isStepActive(key);
              return (
                <div key={key} className="flex items-center gap-3 text-sm">
                  <span className={`w-5 h-5 flex items-center justify-center rounded-full text-xs flex-shrink-0
                    ${done ? 'bg-green-500 text-black' : active ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-600'}`}>
                    {done ? '✓' : active ? (
                      <span className="animate-spin inline-block">↻</span>
                    ) : '·'}
                  </span>
                  <span className={done ? 'text-zinc-400' : active ? 'text-white' : 'text-zinc-600'}>
                    {active && stepMessage ? stepMessage : label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Error */}
        {currentStep === 'error' && (
          <div className="bg-red-950/60 border border-red-800 rounded-xl p-4 mb-6 text-sm text-red-300">
            <span className="font-medium">Error: </span>{error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 mb-3">Original Transcript</p>
              <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">
                {result.transcript}
              </p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 mb-3">
                Translation · {language}
              </p>
              <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">
                {result.translation}
              </p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 mb-4">Translated Audio</p>
              <audio
                ref={audioRef}
                src={audioSrc}
                controls
                className="w-full mb-4 rounded-lg"
              />
              <button
                onClick={downloadAudio}
                className="w-full border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800 rounded-xl py-2.5 text-sm transition-colors"
              >
                Download MP3
              </button>
            </div>

            <button
              onClick={() => { setCurrentStep('idle'); setResult(null); setUrl(''); }}
              className="w-full text-zinc-500 hover:text-zinc-300 text-sm py-2 transition-colors"
            >
              Start over
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
