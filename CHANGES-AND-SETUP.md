# Changes & Setup — Free multi-provider upgrade

Ye document is session me kiye gaye kaam ka summary hai, aur exact steps jo aapko
chahiye. Do purane docs bhi dekho: `ROADMAP.md` (full gap analysis) aur
`UI-RESEARCH.md` (UI findings).

---

## 1. Aapko abhi ye karna hai (mere kaam se independent)

### 🔴 Teen API keys rotate karo — URGENT
`.env.example` me pehle aapki **real** NVIDIA, Mistral, aur SerpApi keys committed thi.
Maine file placeholders se fix kar di, par wo keys **git history me hain**. Agar repo
kabhi public tha ya push hua, wo keys compromised hain. Teeno provider dashboards pe
jaake purani revoke karo aur nayi banao.

### Do stray files delete karo
Meri path galtiyon ki wajah se do bekaar files ban gayi (project se bahar, harmless):
- `C:\Users\Dan\hypersys-main-main\src\lib\documents.ts`
- (aur ek `Derek` folder me)

Ye aapke asli project `/home/santosh/hypersys-main-main` me nahi hain, alag jagah hain.
Bas delete kar dena.

---

## 2. `.env` setup (naya)

Ab app ek **multi-provider free router** use karta hai. Har provider ka apna free
tier hai, toh jitne zyada configure karoge, utni zyada capacity legitimately milegi.
Kam se kam ek zaroori hai; jitne de sako achha:

```
GEMINI_API_KEY="..."        # aistudio.google.com — sabse bada free tier, PDF/image natively padhta hai
GROQ_API_KEY="..."          # console.groq.com — sabse fast
CEREBRAS_API_KEY="..."      # cloud.cerebras.ai
OPENROUTER_API_KEY="..."    # openrouter.ai — asli DeepSeek समेत ':free' models
NVIDIA_API_KEY="..."        # build.nvidia.com (aapke paas already hai)
MISTRAL_API_KEY="..."       # console.mistral.ai (aapke paas already hai)

# Optional — production rate limiting (bina iske dev me sab chalega):
# UPSTASH_REDIS_REST_URL="..."
# UPSTASH_REDIS_REST_TOKEN="..."
# ALLOW_ANONYMOUS="false"   # guests band karke sign-in mandatory karna ho toh
# DAILY_LIMIT_USER="100"
# DAILY_LIMIT_GUEST="10"
```

Firebase token verification ke liye `.env` me `FIREBASE_PROJECT_ID` bhi hona chahiye
(aapke `VITE_FIREBASE_PROJECT_ID` ke barabar).

---

## 3. Verify karo (main shell down hone ki wajah se khud nahi chala paya)

```sh
npm install          # naye deps: pdfjs-dist, mammoth, xlsx, jszip, katex, remark-math, rehype-katex
npm run typecheck    # aapne ye already chalaya — clean tha ✅
npm run test         # aapne ye already chalaya — 12/12 pass ✅
npm run verify:models  # provider catalogs ke against model IDs check karta hai
npm run dev          # default model bhejo — /api/llm route ab dev me bhi kaam karta hai
```

`npm run verify:models` **zaroor chalao** — `providers.ts` me kuch model IDs
(deepseek-v4-pro, kimi-k2.6, minimax-m3, gemini-2.0-flash) provider catalogs se
verify hone chahiye. Jo available na ho, wo route hata do warna wo model 404 dega.

---

## 4. Is session me kya badla

### Naye files
| File | Kya karta hai |
|---|---|
| `src/lib/providers.ts` | Provider registry + model catalogue + failover rules |
| `api/llm.js` | Unified router — chain walk karke first working provider se stream (Vercel) |
| `api/_auth.js` | Firebase token verify + per-user daily quota |
| `src/lib/context-budget.ts` | Token budgeting, sliding window, summarization |
| `src/lib/documents.ts` | PDF/DOCX/XLSX/PPTX/text extraction |
| `src/test/context-budget.test.ts` | 11 tests (sab pass) |

### Badle hue files
| File | Kya badla |
|---|---|
| `.env.example` | Real keys → placeholders + naye providers |
| `src/lib/ai.ts` | Router se wired, classifier short-circuit, BYOK, dead STT/TTS hataya |
| `src/lib/search.ts` | Duplicate classifier hataya (~3x kam quota) |
| `src/pages/Chat.tsx` | Document extraction wired, follow-ups capture |
| `src/components/chat/ChatMessage.tsx` | KaTeX (math), ARIA live region, follow-up chips |
| `vite.config.ts` | Dev me `/api/llm` route, fake STT/TTS stubs hataye |
| `package.json` | Naye deps |

### Kya theek hua
- **Free capacity** — 6 providers, har ek ka apna free bucket, automatic failover
- **Better models** — asli DeepSeek, Gemini (native multimodal), Llama, Kimi, MiniMax
- **~3x kam quota burn** — duplicate classifier hataya + heuristics decisive hon toh API call skip
- **Long chats ab nahi tootengi** — token budgeting + summarization
- **PDF/Word/Excel ab actually padhta hai** — pehle useless base64 jaata tha
- **Math ab render hota hai** — KaTeX
- **Security** — proxy pe auth + rate limiting (pehle bilkul open tha)
- **Accessibility** — streaming ab screen reader ko announce hota hai
- **Follow-up suggestions** — search ka `related` data ab clickable chips me

---

## 5. Jo abhi bhi bacha hai (bade items, ROADMAP.md me detail)

- **Tool calling** — sabse bada. Maine deliberately nahi kiya kyunki ye 1200-line
  `Chat.tsx` ko deeply badalta hai aur bina testable build ke risky tha. Ab jab build
  green hai, ye agla sabse valuable kaam hai.
- **Code execution** (Pyodide) — hallucination sabse zyada yahi rokta hai
- **RAG** — bade documents ke liye (abhi 120k chars pe truncate hota hai)
- **Message edit + branching** — data model pehle decide karna hoga
- **Message list virtualization** — 200+ messages pe zaroori
- **Streaming render optimization** — lambe jawab me sabse zyada dikhega

---

## Ek imaandaar baat

Is session me **kaafi kuch likha, par sirf typecheck + tests verify hue** (wo bhi
aapne chalaye). Maine actual chat flow end-to-end nahi chalaya kyunki shell tool
poore session down raha. Toh `npm run dev` karke ek real message bhejo aur confirm
karo ki router se stream aa raha hai — X-Served-By header me dikhega kaunse provider
ne answer diya.
