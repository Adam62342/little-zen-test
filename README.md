# Page Summary (Sine mod)

Dia-style summary panel for Zen / Firefox. Click the toolbar button or press Alt+Shift+P.

- Reads the page text directly and streams a bullet summary into a native-looking panel.
- Follow-up questions, Copy, Regenerate.
- No API key: falls back to an offline extractive summarizer (instant, no network).
- Apple Intelligence (default): runs on-device through afm-server (http://127.0.0.1:11435/v1, model apple.local).
  Long pages are read in chunks to fit the small on-device context window.
- With a key (Anthropic, or any OpenAI-compatible endpoint such as OpenAI, Gemini, Groq, Ollama):
  full AI summaries + follow-ups. Set it in the mod's settings.

Disable the old "Perplexity Summarize" mod first (same Alt+Shift+P shortcut).
The API key is stored as a plain-text pref in your profile, not in this repo.
