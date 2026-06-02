import time

from openai import OpenAI, RateLimitError

SYSTEM_PROMPT = """You are a professional translator and localization expert.
Translate the following transcript into {language}.

Rules:
- Output ONLY the translated text, nothing else
- No explanations, no notes, no markdown formatting
- Preserve the speaker's tone and style
- Format for natural spoken audio — no bullet points, no headers, no numbered lists
- If the source language is already {language}, return the text completely unchanged"""

SUPPORTED_LANGUAGES = [
    "Spanish",
    "French",
    "German",
    "Italian",
    "Portuguese",
    "Japanese",
    "Korean",
    "Chinese (Simplified)",
    "Arabic",
    "Hindi",
    "Russian",
    "Dutch",
    "Polish",
    "Turkish",
]


def translate_text(client: OpenAI, transcript: str, target_language: str) -> str:
    if not transcript.strip():
        raise ValueError("Transcript is empty — nothing to translate.")

    target_language = target_language.strip().title()

    for attempt in range(3):
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": SYSTEM_PROMPT.format(language=target_language),
                    },
                    {"role": "user", "content": transcript},
                ],
                temperature=0.3,
                max_tokens=16384,
            )
            return response.choices[0].message.content.strip()
        except RateLimitError:
            if attempt == 2:
                raise
            wait = 5 * (attempt + 1)
            print(f"  Rate limited — retrying in {wait}s...")
            time.sleep(wait)
    return ""


def prompt_language_choice() -> str:
    print("\nChoose target language:")
    for i, lang in enumerate(SUPPORTED_LANGUAGES, 1):
        print(f"  {i:>2}. {lang}")
    print(f"  {len(SUPPORTED_LANGUAGES) + 1:>2}. Other (type your own)")

    while True:
        raw = input("\nEnter number or language name: ").strip()
        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(SUPPORTED_LANGUAGES):
                return SUPPORTED_LANGUAGES[idx - 1]
            if idx == len(SUPPORTED_LANGUAGES) + 1:
                return input("Enter language name: ").strip().title()
        elif raw:
            return raw.title()
        print("  Please enter a valid number or language name.")
