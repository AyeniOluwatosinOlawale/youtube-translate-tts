import argparse
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from downloader import detect_live_stream, download_audio, get_live_stream_url, is_youtube_url
from live_loop import run_live_loop
from transcriber import transcribe_audio
from translator import prompt_language_choice, translate_text
from tts_generator import SUPPORTED_VOICES, generate_speech


def check_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise EnvironmentError(
            "ffmpeg is not installed or not on PATH.\n"
            "  macOS:  brew install ffmpeg\n"
            "  Ubuntu: sudo apt install ffmpeg\n"
            "  Windows: https://ffmpeg.org/download.html"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe, translate, and speak audio from YouTube or a local file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # YouTube video, pick language interactively
  python main.py --input "https://youtu.be/dQw4w9WgXcQ"

  # Local file, translate to Spanish
  python main.py --input ./talk.mp4 --language Spanish

  # YouTube live stream, real-time French subtitles + audio
  python main.py --input "https://youtube.com/watch?v=<live_id>" --language French

  # Custom voice and output directory
  python main.py --input ./speech.mp3 --language Japanese --voice shimmer --output-dir ./results
""",
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="YouTube URL or path to a local audio/video file",
    )
    parser.add_argument(
        "--language", "-l",
        default=None,
        help="Target language for translation (e.g. 'Spanish', 'French'). Prompted if omitted.",
    )
    parser.add_argument(
        "--voice", "-v",
        default="nova",
        choices=SUPPORTED_VOICES,
        help="TTS voice (default: nova)",
    )
    parser.add_argument(
        "--output-dir", "-o",
        default="output",
        help="Directory to save translated .mp3 files (default: output/)",
    )
    parser.add_argument(
        "--segment-secs",
        type=int,
        default=15,
        help="Seconds per live stream segment (default: 15, range: 5-60)",
    )
    return parser.parse_args()


def resolve_language(args: argparse.Namespace) -> str:
    if args.language:
        return args.language.strip().title()
    return prompt_language_choice()


def build_output_path(output_dir: str, language: str, voice: str) -> Path:
    short_id = uuid.uuid4().hex[:6]
    lang_slug = language.lower().replace(" ", "_").replace("(", "").replace(")", "")
    filename = f"translated_{lang_slug}_{short_id}.mp3"
    return Path(output_dir) / filename


def run_standard(
    client: OpenAI,
    args: argparse.Namespace,
    language: str,
) -> None:
    tmp_dir: str | None = None
    audio_path: str | None = None

    try:
        if is_youtube_url(args.input):
            print(f"Downloading audio from YouTube...")
            tmp_dir = tempfile.mkdtemp()
            audio_path = download_audio(args.input, tmp_dir)
            print(f"  Downloaded to temp file.")
        else:
            local = Path(args.input)
            if not local.exists():
                print(f"Error: File not found: {args.input}", file=sys.stderr)
                sys.exit(1)
            audio_path = str(local)

        print(f"Transcribing with gpt-4o-mini-transcribe...")
        transcript = transcribe_audio(client, audio_path)
        print(f"  Transcript ({len(transcript)} chars):\n  {transcript[:200]}{'...' if len(transcript) > 200 else ''}\n")

        print(f"Translating to {language}...")
        translated = translate_text(client, transcript, language)
        print(f"  Translation ({len(translated)} chars):\n  {translated[:200]}{'...' if len(translated) > 200 else ''}\n")

        output_path = build_output_path(args.output_dir, language, args.voice)
        print(f"Generating speech with voice '{args.voice}'...")
        generate_speech(client, translated, output_path, args.voice)
        print(f"\nDone! Audio saved to: {output_path}")

    finally:
        if tmp_dir and Path(tmp_dir).exists():
            shutil.rmtree(tmp_dir)


def main() -> None:
    load_dotenv()

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("Error: OPENAI_API_KEY not set. Add it to a .env file or export it.", file=sys.stderr)
        sys.exit(1)

    try:
        check_ffmpeg()
    except EnvironmentError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    args = parse_args()

    if args.segment_secs < 5 or args.segment_secs > 60:
        print("Error: --segment-secs must be between 5 and 60.", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=api_key)

    if is_youtube_url(args.input):
        print("Checking if this is a live stream...")
        is_live = detect_live_stream(args.input)
        if is_live:
            print("Live stream detected.")
            language = resolve_language(args)
            print(f"Extracting live stream URL...")
            stream_url = get_live_stream_url(args.input)
            run_live_loop(
                client=client,
                stream_url=stream_url,
                language=language,
                voice=args.voice,
                segment_secs=args.segment_secs,
            )
            return

    language = resolve_language(args)
    run_standard(client, args, language)


if __name__ == "__main__":
    main()
