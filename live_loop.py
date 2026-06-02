import subprocess
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

from openai import OpenAI

from transcriber import transcribe_audio
from translator import translate_text
from tts_generator import generate_and_play


def capture_segment(stream_url: str, duration_secs: int, output_path: str | Path) -> None:
    output_path = str(output_path)
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i", stream_url,
            "-t", str(duration_secs),
            "-vn",
            "-acodec", "mp3",
            "-ab", "128k",
            output_path,
        ],
        capture_output=True,
        timeout=duration_secs + 30,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed to capture live segment.\n"
            f"stderr: {result.stderr.decode(errors='replace')[-500:]}"
        )


def _process_segment(
    client: OpenAI,
    segment_path: Path,
    language: str,
    voice: str,
    segment_index: int,
) -> None:
    try:
        transcript = transcribe_audio(client, segment_path)
        if not transcript.strip():
            return

        translated = translate_text(client, transcript, language)
        if not translated.strip():
            return

        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"\n[{timestamp}] {translated}\n")

        generate_and_play(client, translated, voice)
    except Exception as exc:
        print(f"  [Segment {segment_index} error: {exc}]")
    finally:
        segment_path.unlink(missing_ok=True)


def run_live_loop(
    client: OpenAI,
    stream_url: str,
    language: str,
    voice: str = "nova",
    segment_secs: int = 15,
) -> None:
    print(f"\nStarting live translation loop — {segment_secs}s segments → {language}")
    print("Press Ctrl+C to stop.\n")

    tmp_dir = Path(tempfile.mkdtemp())
    segment_index = 0
    current_thread: threading.Thread | None = None

    try:
        while True:
            segment_path = tmp_dir / f"segment_{segment_index:06d}.mp3"

            try:
                capture_segment(stream_url, segment_secs, segment_path)
            except subprocess.TimeoutExpired:
                print("  [Stream capture timed out — stream may have ended]")
                break
            except RuntimeError as exc:
                print(f"  [Capture error: {exc}]")
                time.sleep(2)
                continue

            # Wait for previous segment's processing thread before starting new one
            # (keeps audio sequential — not overlapping)
            if current_thread and current_thread.is_alive():
                current_thread.join()

            current_thread = threading.Thread(
                target=_process_segment,
                args=(client, segment_path, language, voice, segment_index),
                daemon=True,
            )
            current_thread.start()
            segment_index += 1

    except KeyboardInterrupt:
        print("\n\nStopped by user.")
    finally:
        if current_thread and current_thread.is_alive():
            current_thread.join(timeout=10)
        # Clean up any leftover temp segment files
        for f in tmp_dir.glob("segment_*.mp3"):
            f.unlink(missing_ok=True)
        try:
            tmp_dir.rmdir()
        except OSError:
            pass
        print("Cleanup complete.")
