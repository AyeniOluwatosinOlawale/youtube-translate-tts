import os
import tempfile
import time
from pathlib import Path

from openai import OpenAI, RateLimitError

MAX_BYTES = 24 * 1024 * 1024  # 24 MB, safely under the 25 MB API limit

SUPPORTED_EXTENSIONS = {".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".flac"}


def transcribe_audio(client: OpenAI, audio_path: str | Path) -> str:
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")
    if audio_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type '{audio_path.suffix}'. "
            f"Supported types: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )
    if audio_path.stat().st_size == 0:
        raise ValueError(f"Audio file is empty: {audio_path}")

    file_size = audio_path.stat().st_size
    if file_size <= MAX_BYTES:
        return _transcribe_single(client, audio_path)

    print(f"  File is {file_size / (1024*1024):.1f} MB — splitting into chunks for transcription...")
    with tempfile.TemporaryDirectory() as tmp_dir:
        chunks = _split_audio(audio_path, Path(tmp_dir))
        transcripts = []
        for i, chunk in enumerate(chunks, 1):
            print(f"  Transcribing chunk {i}/{len(chunks)}...")
            transcripts.append(_transcribe_single(client, chunk))
        return " ".join(transcripts)


def _transcribe_single(client: OpenAI, audio_path: Path) -> str:
    for attempt in range(3):
        try:
            with open(audio_path, "rb") as f:
                response = client.audio.transcriptions.create(
                    model="gpt-4o-mini-transcribe",
                    file=f,
                    response_format="text",
                )
            return response
        except RateLimitError:
            if attempt == 2:
                raise
            wait = 5 * (attempt + 1)
            print(f"  Rate limited — retrying in {wait}s...")
            time.sleep(wait)
    return ""


def _split_audio(audio_path: Path, tmp_dir: Path) -> list[Path]:
    from pydub import AudioSegment

    audio = AudioSegment.from_file(str(audio_path))
    file_size = audio_path.stat().st_size
    total_ms = len(audio)

    # Calculate how many milliseconds fit in 24 MB with a 5% safety margin
    chunk_ms = int((MAX_BYTES / file_size) * total_ms * 0.95)
    chunk_ms = max(chunk_ms, 5_000)  # minimum 5-second chunks

    chunks: list[Path] = []
    start = 0
    index = 0
    while start < total_ms:
        end = min(start + chunk_ms, total_ms)
        chunk = audio[start:end]
        chunk_path = tmp_dir / f"chunk_{index:04d}.mp3"
        chunk.export(str(chunk_path), format="mp3")
        chunks.append(chunk_path)
        start = end
        index += 1

    return chunks
