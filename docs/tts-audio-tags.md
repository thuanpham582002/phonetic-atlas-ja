# Gemini TTS Audio Tags Reference

## Working tags (tested with gemini-3.1-flash-tts-preview)

| Tag | Effect | Reliability |
|-----|--------|-------------|
| `[whispers]` | Whisper (audible) | ✅ Good |
| `[excitedly]` | Enthusiastic | ✅ Good |
| `[bored]` | Monotone, uninterested | ✅ Good |
| `[sarcastically]` | Sarcastic tone | ✅ Good |
| `[chuckles]` / `[laughs]` | Non-verbal laugh | ✅ Good |
| `[gasp]` / `[sighs]` | Non-verbal sounds | ✅ Good |
| `[American accent]` | US pronunciation | ✅ Good |
| `[British accent]` | UK pronunciation | ✅ Good |
| `[Australian accent]` | AU pronunciation | ✅ Good |
| `[slowly]` | Reduced speed | ✅ Good |
| `[very fast]` | Increased speed | ✅ Good |
| `[pause]` | Intentional silence | ✅ Good |
| `[normal]` | Reset to default voice | ✅ Good |
| `[like a narrator]` | Documentary style | ✅ Decent |

## Tags to avoid

| Tag | Issue |
|-----|-------|
| `[quietly]` | Output nearly silent or inaudible |
| `[barely audible]` | Same as quietly |
| Any long `[like a ...]` prose | May be read aloud as part of transcript |

## Guidelines

- Use `[whispers]` instead of `[quietly]` for low-volume delivery
- Combine tags: `[American accent, slowly]`
- Tags affect delivery **after** they appear — use `[normal]` to reset
- Multi-speaker supported via `MultiSpeakerVoiceConfig` (API-level, not through inline tags alone)
- Compatible with Gemini 2.5 Flash Preview TTS and Gemini 3.1 Flash TTS Preview
