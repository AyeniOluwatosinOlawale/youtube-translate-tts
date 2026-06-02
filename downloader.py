import glob
import json
import subprocess
from pathlib import Path

import yt_dlp


def is_youtube_url(input_str: str) -> bool:
    s = input_str.strip().lower()
    return any(
        pattern in s
        for pattern in ("youtube.com/watch", "youtu.be/", "youtube.com/shorts/", "youtube.com/live/")
    )


def download_audio(url: str, output_dir: str | Path) -> str:
    output_dir = Path(output_dir)
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(output_dir / "%(id)s.%(ext)s"),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    matches = glob.glob(str(output_dir / "*.mp3"))
    if not matches:
        raise RuntimeError(
            "yt-dlp completed but no .mp3 file was found in the temp directory. "
            "Make sure ffmpeg is installed and on PATH."
        )
    return matches[0]


def detect_live_stream(url: str) -> bool:
    try:
        result = subprocess.run(
            ["yt-dlp", "--simulate", "--dump-json", "--no-warnings", url],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return False
        info = json.loads(result.stdout)
        return bool(info.get("is_live") or info.get("live_status") == "is_live")
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return False


def get_live_stream_url(url: str) -> str:
    result = subprocess.run(
        ["yt-dlp", "-g", "--no-warnings", "-f", "bestaudio", url],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to extract live stream URL from {url}.\n"
            f"yt-dlp error: {result.stderr.strip()}"
        )
    stream_url = result.stdout.strip()
    if not stream_url:
        raise RuntimeError("yt-dlp returned an empty stream URL.")
    return stream_url
