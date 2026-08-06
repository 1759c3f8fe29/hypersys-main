# Flyer → ChatGPT / Gemini / DeepSeek level: Gap Analysis & Roadmap

Ye document current codebase ke actual audit se bana hai (file:line references diye hain).
Har item me: **kya missing hai**, **kyun matter karta hai**, **kya karna hoga**.

---

## 0. Pehle ek reality check (important)

Do alag cheezein hain — inhe mix mat karna:

| | Kya hai | Aap match kar sakte ho? |
|---|---|---|
| **Model layer** | GPT-5, Gemini, DeepSeek ka apna trained model | ❌ Nahi — isme $100M+ aur GPU clusters lagte hain |
| **Product layer** | Chat UI, memory, tools, files, search, artifacts, sharing, reliability | ✅ **Bilkul ha sakta hai** |

Flyer ek **product-layer** competitor hai — models NVIDIA NIM + Mistral se aa rahe hain.
Isme koi sharm ki baat nahi: Perplexity, Poe, Cursor sab yahi karte hain aur billion-dollar
companies hain. Toh goal ye hona chahiye:

> "ChatGPT jaisa model banana" ❌
> "ChatGPT se behtar **product** banana, kisi aur ke models pe" ✅

Neeche jo bhi likha hai wo isi goal ke liye hai.

---

## P0 — Ye abhi TOOTA hua ya KHATARNAK hai (pehle ye fix karo)

Inke bina baaki features banane ka matlab nahi. Ye teen cheezein aapko paisa,
users, ya dono kharch karwa sakti hain.

### P0.1 🔴 API proxy pe koi auth aur koi rate limit nahi hai

**Evidence:** `api/_guard.js` sirf CORS aur ek Origin allowlist karta hai. Line 52-56:

```js
// A present Origin must be in the allowlist. Requests with no Origin at all
// (server-to-server, tooling) are allowed.
if (allowed.length > 0 && origin && !allowed.includes(origin)) {
```

**Problem:** `Origin` header optional hai. Koi bhi banda `curl -X POST https://yourapp.vercel.app/api/nvidia`
chala ke bina Origin ke aapki NVIDIA/Mistral key unlimited use kar sakta hai. Na login chahiye,
na rate limit hai. Ye ek **free public LLM API** hai jo aap unknowingly host kar rahe ho.

`api/nvidia.js:10` bas `applyGuard()` call karta hai — koi user identity check nahi.

**Fix karna hoga:**
1. Firebase ID token verify karo har `/api/*` call pe (`firebase-admin` se `verifyIdToken`)
2. Per-user rate limit — Upstash Redis ya Firestore counter (e.g. 50 msg/day free tier)
3. Guest users ke liye alag lower limit (IP + fingerprint pe)
4. Per-request token cap enforce karo server-side (client `max_tokens` bhej raha hai — usko trust mat karo)
5. Anomaly alert — ek user ne 1000 req/hour maara toh email aaye

**Effort:** 2-3 din. **Ye sabse zaroori kaam hai.**

### P0.2 🔴 PDF / Word / Excel upload dikhte hain par parse nahi hote

**Evidence:** `ChatInput.tsx:298` ye sab accept karta hai:

```
accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.js,.ts,.tsx,.jsx,.py,.html,.css"
```

Lekin `Chat.tsx:385-390` — non-image file ke liye:

```js
reader.readAsDataURL(file);   // base64 blob, bas
```

Aur koi PDF/docx parser exist hi nahi karta (grep: `pdfjs|mammoth|xlsx|readAsText` → 0 results).

**Problem:** User PDF upload karta hai, UI accept karta hai, model ko sirf filename ya ek
useless base64 string milti hai. Model phir hallucinate karta hai ya "I can't see the file"
bolta hai. Ye **feature promise karke deliver nahi karna** hai — trust turant tootta hai.

**Fix karna hoga:**
| File type | Library |
|---|---|
| PDF | `pdfjs-dist` (text layer extract) + scanned ke liye OCR fallback |
| DOCX | `mammoth` |
| XLSX/CSV | `SheetJS` |
| PPTX | `jszip` + slide XML parse |
| Code/txt | `readAsText` — abhi bhi galat, dataURL ja raha hai |

Extract karke text ko system context me daalo, aur bade docs ke liye chunk + embed karo (P1.3 dekho).

**Effort:** 3-4 din.

### P0.3 🔴 Puri conversation history har turn me bheji jaati hai — koi limit nahi

**Evidence:** `Chat.tsx:737`

```js
const historyMessages: AiChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
```

Koi truncation nahi, koi token counting nahi, koi summarization nahi.

**Problem:** 50-message chat = har turn pe 30k+ tokens bhej rahe ho. Teen cheezein hoti hain:
cost linearly badhta hai, latency badhti hai, aur context limit cross hone pe provider
**hard error** deta hai — chat permanently dead ho jaati hai, user ko pata bhi nahi chalta kyun.
Long chats me ye guaranteed hoga.

**Fix karna hoga:**
1. `gpt-tokenizer` ya `tiktoken` se token count karo
2. Sliding window — last N messages full, purane summarize
3. Rolling summary: jab 60% context bhar jaye, purane messages ka summary banake replace karo
4. Har model ka actual context limit `MODEL_REGISTRY` (`ai.ts:16`) me add karo — abhi wo info hai hi nahi
5. UI me context usage bar dikhao

**Effort:** 3-4 din.

---

## P1 — Ye features ChatGPT ko "ChatGPT" banate hain

Ye wo cheezein hain jinke bina product "demo" lagta hai, "tool" nahi.

### P1.1 Tool / Function calling — **sabse bada missing piece**

**Evidence:** grep `tools:|tool_calls|function_call` → poore `src/` me **zero results**.

Abhi ka flow hardcoded hai: `evaluateUserIntent()` (`ai.ts:255`) ek chhota model se poochta hai
"image chahiye? search chahiye?" aur phir if-else chalta hai. Ye 2023 ka pattern hai.

ChatGPT/Gemini me model khud decide karta hai ki kaunsa tool, kitni baar, kis order me chalana hai —
aur ek turn me kai tools chala sakta hai. Aapka system ek turn me ek hi cheez kar sakta hai.

**Kya banana hoga:**
- Proper tool-calling loop (Mistral aur NIM dono OpenAI-compatible `tools` support karte hain)
- Tool registry: `web_search`, `generate_image`, `run_code`, `read_file`, `create_document`, `browse_url`
- Multi-step agent loop with max-iteration guard
- UI me tool calls stream karke dikhao ("Searching…", "Running Python…") — abhi `statusText` hai, usko extend karo

**Ye ek hi change** aapke intent classifier, search router, aur image router — teeno ko replace kar dega
aur behtar kaam karega. **Effort:** 1-2 hafte. **Highest leverage item in this doc.**

### P1.2 Code execution (Code Interpreter)

Abhi bilkul nahi hai. ChatGPT/Gemini dono me hai aur ye data analysis, math, chart banane ke liye
sabse zyada use hone wala feature hai — aur hallucination bhi sabse zyada yahi rokta hai
(model guess karne ki jagah actually calculate karta hai).

**Options:** Pyodide (browser me Python, sabse sasta, sandbox free), E2B/Daytona (real VM, powerful),
ya Judge0 (multi-language). Pyodide se start karo — zero infra cost.

### P1.3 RAG / long document handling

Bade PDFs poore context me nahi ghusenge. Chahiye: chunking, embeddings, vector store,
retrieval. Firestore me vector search ab native hai, ya Supabase pgvector use karo.
P0.2 ke baad ye natural next step hai.

### P1.4 Persistent memory (ChatGPT "Memory" jaisa)

grep `memory` → sirf toast state ka `memoryState` mila. Actual user memory nahi hai.

Model ko yaad rehna chahiye: user ka naam, profession, preferences, ongoing projects.
Ek `memories` collection + har turn ke baad extraction + system prompt me inject.
Plus user ko dikhane/edit/delete karne ka UI (privacy ke liye zaroori).

### P1.5 Message editing aur conversation branching

ChatGPT me user apna message edit karke alternate branch bana sakta hai, aur
`< 2/3 >` se responses ke beech navigate kar sakta hai. Abhi regenerate hai, branching nahi.

Iske liye Firestore data model me `parentMessageId` chahiye — messages ko **tree** banao,
flat list nahi. **Ye baad me karna mushkil hai — data model abhi decide kar lo.**

### P1.6 Sharing aur export

Public share links (`/share/:id`), markdown/PDF export, conversation import.
ChatGPT ka share feature uska sabse bada organic growth channel raha hai.
Abhi kuch nahi hai.

### P1.7 Projects / folders / custom instructions

Conversations ko group karna, per-project custom instructions aur files.
Abhi flat conversation list hai (`firestore-db.ts`).

### P1.8 Artifacts / Canvas

Code aur documents ke liye side-by-side editable panel — live preview ke saath.
`react-resizable-panels` already installed hai, toh UI foundation maujood hai.
Claude Artifacts aur ChatGPT Canvas dono ka ye flagship feature hai.

---

## P2 — Quality aur polish (yahi "professional" vs "hobby project" decide karta hai)

### P2.1 Math rendering nahi hai
`ChatMessage.tsx:345` me sirf `remarkGfm` hai. KaTeX nahi.
Koi bhi math/physics/ML question **tuta hua LaTeX** dikhayega. `remark-math` + `rehype-katex` add karo. **2 ghante ka kaam, bada visible impact.**

### P2.2 Streaming markdown flicker
Har chunk pe pura markdown re-parse hota hai. Incremental parsing ya `useDeferredValue` use karo.

### P2.3 Chat.tsx god component
Ye file ~1000+ lines hai aur usme system prompts, file handling, streaming, search flow, image flow —
sab kuch ek jagah hai. Todo: `useChatStream`, `useAttachments`, `useConversations` hooks banao,
system prompts `lib/prompts.ts` me nikalo. Warna har naya feature exponentially mushkil hoga.

### P2.4 Virtualized message list
1000-message chat browser hang kar degi. `react-virtuoso` use karo.

### P2.5 Testing aur CI
- `.github/` folder **exist hi nahi karta** — koi CI nahi
- Sirf `src/test/example.test.ts` hai — matlab effectively zero coverage
- Chahiye: GitHub Actions (typecheck + lint + test on PR), streaming/parsing ke unit tests, Playwright E2E

### P2.6 Error tracking
Sirf `@vercel/analytics` hai. Sentry add karo — abhi production me error aaye toh aapko pata hi nahi chalega.

### P2.7 Accessibility aur i18n
Screen reader announcements for streaming, focus management, keyboard shortcuts (Cmd+K, Cmd+/),
aur multi-language UI (India market ke liye Hindi/regional bada差 banayega).

### P2.8 PWA
`public/manifest.json` hai par service worker nahi dikha. Offline shell + install prompt add karo.

---

## P3 — Business layer (agar real product banana hai)

Bina iske ye scale nahi karega — P0.1 ka logical extension hai:

- **Usage quotas aur plans** — free/pro tiers, message limits
- **Billing** — Stripe ya Razorpay (India ke liye Razorpay behtar)
- **Admin dashboard** — usage, cost per user, error rates
- **Cost tracking** — har request ka token cost log karo, warna aapko pata nahi chalega paisa kahan ja raha hai
- **Abuse/moderation** — content filtering, ban system
- **Legal** — privacy policy, ToS, data deletion (DPDP Act India / GDPR)

---

## Suggested 90-day sequence

**Hafta 1-2 — Bleeding stop karo**
P0.1 auth + rate limiting → P0.3 context management → P2.1 KaTeX (quick win)

**Hafta 3-5 — Promises poore karo**
P0.2 document parsing → P2.3 Chat.tsx refactor (tool calling se pehle zaroori) → P2.5 CI setup

**Hafta 6-9 — Capability jump**
P1.1 tool calling architecture → P1.2 code execution (Pyodide) → P1.3 RAG

**Hafta 10-13 — Product depth**
P1.5 branching (data model!) → P1.4 memory → P1.6 sharing → P1.8 artifacts

---

## Do imaandaar baatein

**1. Model registry me kuch IDs shaq paida karti hain.**
`ai.ts:32-45` me `deepseek-v4-pro`, `kimi-k2.6`, `minimax-m3`, `nemotron-3-ultra-550b`,
`step-3.7-flash` listed hain. Comment kehta hai "Verified live", lekin kuch entries aisi
hain jo already fallback kar rahi hain — `minimax-m2.7` actually `llama-3.1-8b` pe jaata hai,
aur `qwen-3-next-80b` `llama-3.1-70b` pe. Matlab user ek model select karta hai aur doosra
model jawab deta hai, bina bataye. Ye **UI me hi galat naam dikhana** hai. Har ID production
me verify karo, aur jo available nahi hai use list se hatao — silently substitute mat karo.
(Aapne ye principle `ai.ts:169-171` me khud likha hai chat routing ke liye — registry pe bhi lagao.)

**2. Sabse zyada value ek jagah hai.**
Agar sirf ek cheez kar sakte ho: **P1.1 tool calling**. Wo aapke intent classifier,
search routing, image routing — sabko replace karke behtar kar dega, aur code execution,
RAG, artifacts sabka foundation ban jayega. Uske bina baaki sab bolt-on hacks rahenge.

Aur agar aapko differentiate karna hai — ChatGPT ko copy karke nahi jeetoge. India-specific
angle (Hindi/regional languages, local context, Razorpay pricing) ya ek vertical
(students, developers, doctors) pakdo. Broad chat assistant market me OpenAI/Google se
lad'na sabse mushkil raasta hai.
