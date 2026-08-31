# Hey Jini — AI Agent App: Master Plan

## 1. OBJECTIVE

Build **"Hey Jini"**, an Android AI agent app (Flutter) that:

- Activates by the wake phrase **"Hey Jini"** (like calling a person by name). It never activates without the wake phrase, unless the user manually turns on "always-on mode" from inside the app.
- Listens, understands, and speaks naturally (Bengali + English at minimum).
- Controls the phone: taps anywhere on screen, scrolls, opens apps, changes settings, browses the web, watches YouTube, replies to chats/messages automatically, and performs multi-step tasks on any website — continuously, for as long as the task requires.
- Is a world-class expert in **cyber security / bug bounty** (via tools like Termux + targeted scanners) and **software development** (can write, run, and debug code).
- Is not a single AI model — it is an **agent layer that uses other AI providers' APIs** (Google Gemini, OpenAI, Anthropic, Groq, etc.). The user can add/swap API keys from within the app.
- Builds a persistent **personal memory** about the user: preferences, habits, contacts, frequently used apps, writing style — so it understands and serves the user like a human assistant.
- Understands *how* a task is being done, not just *what* — it analyzes logic and patterns (e.g., when asked to find a bug, it explains the logic/pattern of the vulnerability, not just "sir, there's a bug").

## 2. CONTEXT SUMMARY

- Repo: `wasimmostakim2965-ui/AI-agent-hey-jini` (fresh, only README).
- Framework: **Flutter** (Dart) — mandatory per user requirement. Native Android capabilities via platform channels (Kotlin/Java).
- Primary platform: **Android** (iOS is out of scope initially — iOS does not allow cross-app screen control).
- Core enablers on Android:
  - **Accessibility Service** → read screen content + perform taps/swipes/gestures system-wide.
  - **MediaProjection** → screenshots when accessibility alone isn't enough (vision fallback).
  - **Foreground service + wake-word engine** → always-listening "Hey Jini" detection, battery-conscious.
  - **Termux integration** → security tooling (nmap, nuclei, etc.) and code execution.
- LLMs are accessed **only through external APIs**; no on-device LLM in v1. Provider keys are user-supplied and stored encrypted.

## 3. APPROACH OVERVIEW

### 3.1 High-level architecture

```
                ┌───────────────────────────────┐
                │          Flutter UI           │
                │ (chat, settings, API keys,    │
                │  memory viewer, task monitor) │
                └───────────────┬───────────────┘
                                │
                ┌───────────────▼───────────────┐
                │          Agent Core           │
                │  Planner → Tool Executor →    │
                │  Verifier loop (ReAct-style)  │
                └───┬───────────┬───────────┬───┘
                    │           │           │
        ┌───────────▼──┐  ┌─────▼──────┐  ┌─▼─────────────┐
        │  Voice Layer │  │ Phone Tool │  │  LLM Router   │
        │ wake word,   │  │ layer      │  │  (pluggable   │
        │ STT, TTS     │  │ a11y, taps │  │  providers)   │
        └──────────────┘  └────────────┘  └───────────────┘
                    │           │           │
        ┌───────────▼───────────▼───────────▼───┐
        │        Memory & Context Store         │
        │  (user profile, prefs, history, RAG)  │
        └───────────────────────────────────────┘
```

### 3.2 Key components

1. **Wake Word Engine ("Hey Jini")**
   - On-device keyword spotting (Picovoice Porcupine custom keyword, or openWakeWord). Runs in a foreground service.
   - Only after the wake phrase does the mic stream to STT. Manual toggle in app for always-on mode.

2. **Voice Layer**
   - STT: Android SpeechRecognizer (offline where possible) or Whisper API.
   - TTS: Android TTS / Google Cloud TTS / ElevenLabs (pluggable).
   - Bengali + English language support.

3. **LLM Router (API Abstraction)**
   - Unified interface: `LlmProvider { complete(messages, tools) }`.
   - Adapters: Gemini, OpenAI, Anthropic, Groq, OpenRouter, custom endpoint.
   - In-app API key management (add/remove/set default), keys stored in Android Keystore-backed encrypted storage.
   - Fallback chain: if primary provider fails/rate-limits → next provider.

4. **Agent Core (Brain)**
   - ReAct-style loop: think → choose tool → act → observe → repeat until done.
   - Task planner for multi-step goals (decompose → execute → verify).
   - Long-running task manager: tasks survive app switching; progress visible in a notification + in-app task monitor.

5. **Phone Control Layer (Tools)**
   - Accessibility Service: read UI tree, tap/swipe/type, open apps, navigate settings, global actions (home/back/recents).
   - Screen understanding: UI-tree first; screenshot + vision model (Gemini/GPT-4o style) as fallback.
   - Browser/Web tasks: drive Chrome (or in-app WebView) via accessibility gestures.
   - Chat auto-reply: read notifications, open the app, compose & send replies.

6. **Cyber Security & Bug Bounty Toolkit**
   - Termux bridge to run security tools (nmap, nuclei, subfinder, httpx, etc.) in a sandboxed environment.
   - Structured output parsing → LLM analyzes findings, explains the **logic/pattern** of each vulnerability, and drafts reports.
   - Strictly for authorized/own targets — app includes scope & consent confirmation before any scan.

7. **Software Development Toolkit**
   - Code execution sandbox (Termux): write, run, debug code (Python/JS/etc.).
   - Git integration; can work with this repo and others.

8. **Memory & Personalization**
   - Local DB (SQLite/Drift) + embeddings for semantic recall.
   - Stores: user profile, preferences, habits, contact context, past tasks, writing style.
   - Memory viewer in-app: user can inspect/edit/delete anything the agent remembers.

### 3.3 Tech stack

| Layer | Choice |
|---|---|
| App | Flutter (Dart), Riverpod for state |
| Native bridge | Kotlin platform channels |
| Wake word | Porcupine (custom "Hey Jini") or openWakeWord |
| STT | Android SpeechRecognizer / Whisper API |
| TTS | Android TTS / pluggable cloud TTS |
| LLM access | HTTP API adapters (Dio), provider-agnostic |
| Storage | Drift (SQLite), flutter_secure_storage for API keys |
| Phone control | Android AccessibilityService + MediaProjection |
| Security tooling | Termux (via intent/bridge) |
| Backend | None (fully on-device + external AI APIs) |

## 4. IMPLEMENTATION STEPS

**Phase 0 — Project scaffold**
1. Flutter project skeleton with clean architecture (`lib/core`, `lib/features/*`, platform channels).
2. CI: GitHub Actions workflow to build APK.

**Phase 1 — Voice foundation**
3. Wake-word service ("Hey Jini") + foreground service + manual always-on toggle.
4. STT + TTS pipeline; basic voice conversation loop end-to-end.

**Phase 2 — Brain**
5. LLM Router with provider adapters + in-app API key management (encrypted storage).
6. Agent Core loop (ReAct) with tool-calling interface.
7. Memory store + personalization (profile, preferences, RAG recall).

**Phase 3 — Hands (phone control)**
8. Accessibility Service: screen reading + tap/swipe/type primitives.
9. App navigation tools: open app, change settings, browser control, YouTube.
10. Chat auto-reply tool (notification read → reply).
11. Long-running task manager with progress notification.

**Phase 4 — Expertise packs**
12. Termux bridge + security toolkit (bug bounty workflow with scope confirmation).
13. Software development toolkit (code write/run/debug, git).

**Phase 5 — Polish**
14. Onboarding flow (permissions: accessibility, mic, overlay; API key setup).
15. Bengali/English UI, task history, memory viewer, privacy controls (wipe memory).

## 5. TESTING AND VALIDATION

- **Unit tests**: LLM router adapters (mock HTTP), agent planner logic, memory store.
- **Integration tests**: tool-calling loop with recorded API responses; accessibility action queue.
- **Manual/device test matrix** (real Android devices):
  - Wake word accuracy (quiet/noisy rooms, Bengali + English accents, screen off).
  - Phone control: open settings and toggle Wi-Fi; open YouTube and play a searched video; auto-reply to a test WhatsApp message; complete a 10+ step web task.
  - Security toolkit: run nuclei against a deliberately vulnerable lab target (e.g., OWASP Juice Shop / testphp.vulnweb.com) and verify report quality.
  - Memory: teach the agent a preference, restart the app, verify recall; verify memory wipe.
- **Safety checks**: agent asks confirmation before irreversible actions (payments, deletions, sending messages) unless user granted auto-approve; security scans require confirmed authorization scope.
- **Performance**: wake-word service battery drain < target threshold; task loop resilient to API failures (fallback chain works).
