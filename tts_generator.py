import platform
import subprocess
import tempfile
import time
from pathlib import Path

from openai import OpenAI, RateLimitError

SUPPORTED_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
MAX_TTS_CHARS = 4096


def generate_speech(
    client: OpenAI,
    text: str,
    output_path: str | Path,
    voice: str = "nova",
) -> Path:
    output_path = Path(output_path)
    _validate_voice(voice)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    chunks = _split_text(text)
    audio_pieces: list[bytes] = []
    for chunk in chunks:
        audio_pieces.append(_synthesize(client, chunk, voice))

    if len(audio_pieces) == 1:
        output_path.write_bytes(audio_pieces[0])
    else:
        _concatenate(audio_pieces, output_path)

    return output_path


def generate_and_play(client: OpenAI, text: str, voice: str = "nova") -> None:
    _validate_voice(voice)
    chunks = _split_text(text)
    for chunk in chunks:
        audio_bytes = _synthesize(client, chunk, voice)
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        play_audio(tmp_path)
        Path(tmp_path).unlink(missing_ok=True)


def play_audio(path: str | Path) -> None:
    path = str(path)
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(["afplay", path], check=True)
        elif system == "Linux":
            subprocess.run(["ffplay", "-nodisp", "-autoexit", path], check=True, capture_output=True)
        elif system == "Windows":
            subprocess.run(
                ["powershell", "-c", f"(New-Object Media.SoundPlayer '{path}').PlaySync()"],
                check=True,
            )
        else:
            print(f"  [Audio saved but playback not supported on {system}. Play manually: {path}]")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"  [Could not play audio automatically. File saved at: {path}]")


def _synthesize(client: OpenAI, text_chunk: str, voice: str) -> bytes:
    for attempt in range(3):
        try:
            response = client.audio.speech.create(
                model="tts-1",
                voice=voice,
                input=text_chunk,
                response_format="mp3",
            )
            return response.content
        except RateLimitError:
            if attempt == 2:
                raise
            wait = 5 * (attempt + 1)
            print(f"  Rate limited — retrying in {wait}s...")
            time.sleep(wait)
    return b""


def _split_text(text: str) -> list[str]:
    if len(text) <= MAX_TTS_CHARS:
        return [text]

    chunks: list[str] = []
    current = ""
    for sentence in _sentence_iter(text):
        if len(current) + len(sentence) <= MAX_TTS_CHARS:
            current += sentence
        else:
            if current:
                chunks.append(current.strip())
            # If a single sentence exceeds the limit, hard-split it
            while len(sentence) > MAX_TTS_CHARS:
                chunks.append(sentence[:MAX_TTS_CHARS])
                sentence = sentence[MAX_TTS_CHARS:]
            current = sentence
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _sentence_iter(text: str):
    terminators = (". ", "! ", "? ", ".\n", "!\n", "?\n")
    start = 0
    i = 0
    while i < len(text):
        for t in terminators:
            if text[i:i + len(t)] == t:
                yield text[start:i + len(t)]
                start = i + len(t)
                i = start
                break
        else:
            i += 1
    if start < len(text):
        yield text[start:]


def _concatenate(audio_pieces: list[bytes], output_path: Path) -> None:
    from pydub import AudioSegment
    import io

    combined = AudioSegment.empty()
    for piece in audio_pieces:
        segment = AudioSegment.from_mp3(io.BytesIO(piece))
        combined += segment
    combined.export(str(output_path), format="mp3")


def _validate_voice(voice: str) -> None:
    if voice not in SUPPORTED_VOICES:
        raise ValueError(
            f"Invalid voice '{voice}'. Choose from: {', '.join(SUPPORTED_VOICES)}"
        )
