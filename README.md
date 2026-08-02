# Flyer — Multi-Model AI Chat

A sleek, fast AI chat app with vision, image generation, voice input/output, and
persistent history. Built with Vite + React + TypeScript + Tailwind + shadcn/ui.

## Features

- 💬 **Multi-model chat** — GLM, DeepSeek, Kimi, MiniMax, Qwen, Llama via NVIDIA NIM, plus **Mistral** (Large/Small/Codestral/Nemo)
- 🌐 **Auto web search** — time-sensitive/factual questions are grounded with live results (SerpApi) and cited
- 👁️ **Vision** — upload an image and ask about it (auto-routes to a vision model)
- 🎨 **Image generation** — text-to-image with downloadable results
- 🔐 **Auth** — email/password and **Sign in with Google** (Firebase Auth)
- ☁️ **Cloud history** — conversations & messages stored in Firestore
- 🎙️ **Voice** — speech-to-text input and text-to-speech playback
- 🔁 **Regenerate**, copy, download, accent theming, guest mode

## Tech stack

- Vite • React 18 • TypeScript • Tailwind CSS • shadcn/ui • framer-motion
- Firebase (Auth + Firestore + Realtime DB)
- NVIDIA NIM API for chat/vision • Pollinations for image generation

## Getting started

```sh
npm install
npm run dev
```

Create a `.env` (copy `.env.example`) with your `VITE_NVIDIA_API_KEY` and
`VITE_FIREBASE_*` values.

> **Mistral and SerpApi keys are server-side secrets** — they are NOT in `.env`
> and never reach the browser. See "Server API (Mistral + web search)" below.

### Firebase setup

1. Enable **Email/Password** and **Google** providers in Firebase Auth.
2. Add your dev/prod domains to the Auth **authorized domains** list.
3. Create a **Firestore** database (collections `conversations` and `messages`
   are created automatically).
4. **Deploy the security rules** (this is what makes chat history load — without
   them Firestore returns *"Missing or insufficient permissions"* and the sidebar
   shows nothing):

   ```sh
   firebase deploy --only firestore:rules
   ```

   The rules in `firestore.rules` scope every read/write to the document's
   `userId`, so each signed-in user only ever sees their own conversations.

### Server API (Mistral + web search)

Mistral and SerpApi can't be called from the browser (CORS + key exposure), so
they run behind a Firebase Function (`functions/`) that Hosting exposes at
`/api/**`. The browser only ever calls same-origin `/api/mistral` and
`/api/search`.

```sh
cd functions && npm install && cd ..

# Set the secrets once (stored encrypted by Firebase, never committed):
firebase functions:secrets:set MISTRAL_API_KEY
firebase functions:secrets:set SERPAPI_API_KEY

# Deploy everything:
npm run build
firebase deploy --only functions,hosting,firestore:rules
```

**Local development:** run the Functions emulator alongside Vite. The dev server
proxies `/api` to `http://127.0.0.1:5001/<project>/us-central1/api` (see
`vite.config.ts` — adjust the project id if yours differs):

```sh
firebase emulators:start --only functions   # terminal 1
npm run dev                                  # terminal 2
```

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run test` — run unit tests (vitest)
