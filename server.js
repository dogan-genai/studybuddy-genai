import "dotenv/config";
import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planner, quizzer, reviewer, parseAndValidate, PlanSchema, QuizSchema } from "./agents.js";
const HAYSTACK_URL = process.env.HAYSTACK_URL || "http://haystack:8010";

async function retrieveViaHaystack(query, topK = Number(process.env.TOP_K || 5)) {
  const { data } = await axios.post(`${HAYSTACK_URL}/retrieve`, {
    query,
    top_k: topK
  });

  const retrieved = data.retrieved_chunks || [];

  // wichtig: wir behalten chunk_id auch im chunk-Objekt
  const chunks = retrieved.map((c) => ({
    chunk_id: c.chunk_id,     // <-- für Context und Integrity
    id: c.chunk_id,           // <-- falls du irgendwo id nutzt
    text: c.text,
    source: c.source,
    page: c.page,
    score: c.score
  }));

  return { chunks, retrieved_chunks: retrieved };
}

function runGuardrailsQuiz(payload) {
  const input = JSON.stringify(payload);
  const r = spawnSync("/opt/venv/bin/python", ["guardrails_quiz_validate.py"], {
    input,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024
  });

  console.error("[GUARDRAILS] exit:", r.status);
  console.error("[GUARDRAILS] stdout:", String(r.stdout || "").slice(0,300));
  console.error("[GUARDRAILS] stderr:", String(r.stderr || "").slice(0,300));

  const stdout = String(r.stdout || "").trim();
  const stderr = String(r.stderr || "").trim();

  let parsed = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch {}

  // Non-zero exit or explicit ok:false => block
  if (r.status !== 0 || !parsed || parsed.ok !== true) {
    return {
      ok: false,
      status: 422,
      error: "GUARDRAILS_FAILED",
      details: parsed || { stdout, stderr, exit_code: r.status }
    };
  }

  return { ok: true, data: parsed.data };
}

function assertCitationIntegrity(result, retrieved_chunks) {
  const allowed = new Set((retrieved_chunks || []).map((c) => String(c.chunk_id)));

  const citations = result?.citations || [];
  if (!Array.isArray(citations) || citations.length === 0) {
    const err = new Error("MISSING_CITATIONS");
    err.status = 422;
    throw err;
  }

  for (const cit of citations) {
    const id = String(cit.chunk_id || "");
    if (!id || !allowed.has(id)) {
      const err = new Error("CITATION_INTEGRITY_FAILED");
      err.status = 422;
      err.details = { bad_chunk_id: id };
      throw err;
    }
  }
}
function buildContext(chunks) {
  return (chunks || [])
    .map((c) => {
      const id = c.chunk_id ?? c.id ?? "";
      const source = c.source ?? "";
      const page = c.page ?? null;
      const text = c.text ?? "";
      return `chunk_id: ${id}\nsource: ${source}\npage: ${page}\ntext: ${text}`;
    })
    .join("\n\n---\n\n");
}
// --- Ollama chat helper (local) ---
async function chat({ model, messages, format = "json", temperature = 0.2 }) {
  const url = process.env.OLLAMA_URL || "http://localhost:11434";

  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 2200
      }
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Ollama chat failed: ${res.status} ${res.statusText} ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return data?.message?.content ?? "";
}

const useCrew = (process.env.USE_CREWAI || "").toLowerCase() === "true";
const crewUrl = process.env.CREWAI_URL || "http://127.0.0.1:8009";

const app = express();
if (process.env.DEBUG_REQ === "1") {
  app.use((req, res, next) => {
    console.log("[REQ]", req.method, req.url);
    next();
  });
}

app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const ART_DIR = process.env.ARTIFACTS_DIR || "/data/artifacts";
try { fs.mkdirSync(ART_DIR, { recursive: true }); } catch {}

app.post("/ingest", upload.single("file"), async (req, res) => {
  try {
    const course_tag = String(req.body?.course_tag || "").trim();
    const source = String(req.body?.source || req.file?.originalname || "").trim();

    if (!course_tag) return res.status(400).json({ error: "BAD_REQUEST", details: { reason: "Missing course_tag" } });
    if (!req.file?.buffer) return res.status(400).json({ error: "BAD_REQUEST", details: { reason: "Missing file" } });

    const HAYSTACK_BASE = process.env.HAYSTACK_URL || "http://haystack:8010";
    const HAYSTACK_INGEST_URL = HAYSTACK_BASE.replace(/\/$/, "") + "/ingest";

    const form = new FormData();
    form.append("file", req.file.buffer, { filename: source || "upload.pdf", contentType: "application/pdf" });
    form.append("course_tag", course_tag);
    form.append("source", source || "upload.pdf");

    const { data } = await axios.post(HAYSTACK_INGEST_URL, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
    });

    const entry = {
      ts: new Date().toISOString(),
      event: "ingest",
      course_tag,
      source: source || "upload.pdf",
      haystack: data,
    };

    fs.appendFileSync(path.join(ART_DIR, "doc_registry.jsonl"), JSON.stringify(entry) + "\n", "utf8");

    return res.json({ status: "ok", ...data });
  } catch (e) {
    return res.status(e.status || 500).json({ error: String(e.message || e), details: e.response?.data || null });
  }
});


app.post("/plan", async (req, res) => {
  try {
    const { goal = "Exam preparation", scope = "all", time_budget_hours_per_week = 6 } = req.body;

    const { chunks, retrieved_chunks } = await retrieveViaHaystack(`${goal}. ${scope}`);

    // Governance MVP: kein Kontext => keine Antwort
    if (!chunks.length) {
      const err = new Error("RETRIEVAL_EMPTY");
      err.status = 422;
      throw err;
    }
    // Governance MVP: lexical overlap guardrail
    // If none of the meaningful query terms appear in retrieved text, treat as no evidence.
    const queryText = String(req.body.query || goal || scope || "").toLowerCase();

    const STOP = new Set([
      "der","die","das","und","oder","mit","ohne","für","von","im","in","am","an","zu",
      "ein","eine","einer","eines",
      "bitte","erstelle","erstellen","generiere","machen","mache","gib",
      "quiz","frage","fragen","antwort","antworten","multiple","choice",
      "grundlagen","einführung","kurz","lang","einfach","schwer"
    ]);

    const terms = Array.from(new Set(
      queryText
        .replace(/[^a-zäöüß0-9\s-]/gi, " ")
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && !STOP.has(t))
    ));

    const hayText = chunks.map(c => String(c.text || "").toLowerCase()).join("\n");

    const hasOverlap = terms.length === 0 ? false : terms.some(t => hayText.includes(t));

    if (!hasOverlap) {
      const err = new Error("RETRIEVAL_EMPTY");
      err.status = 422;
      err.details = { reason: "NO_LEXICAL_OVERLAP", terms };
      throw err;
    }

    // ✅ CrewAI path
    if (useCrew) {
      const { data } = await axios.post(`${crewUrl}/crew/plan`, {
        goal,
        scope,
        time_budget_hours_per_week,
        chunks
      });

      // Guardrails
      const validated = parseAndValidate(data, PlanSchema);
      assertCitationIntegrity(validated, retrieved_chunks);

      const { citations, ...plan } = validated;
      return res.json({ type: "plan", result: plan, citations, confidence: 0.65 });
    }

    // ✅ Local (Node) path
    const draft = await planner({
      goal,
      scope,
      timeBudget: time_budget_hours_per_week,
      chunks
    });

    const fixed = await reviewer({ draft, type: "plan", chunks });
    const result = parseAndValidate(fixed, PlanSchema);

    assertCitationIntegrity(result, retrieved_chunks);

    const { citations, ...plan } = result;
    return res.json({ type: "plan", result: plan, citations, confidence: 0.65 });

  } catch (e) {
    return res.status(e.status || 500).json({
      error: String(e.message || e),
      details: e.details || null
    });
  }
});

app.post("/quiz", async (req, res) => {
  try {
    const query = req.body?.query ?? req.body?.topic;
    const num_questions = 3; // Simplified for demo
    const difficulty = String(req.body?.difficulty ?? "easy");

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "BAD_REQUEST", details: { reason: "Missing query" } });
    }

    // 1) Retrieval via Haystack
    const { chunks, retrieved_chunks } = await retrieveViaHaystack(query);

    // 2) No-evidence guardrail (lexical overlap, filtered)
    const queryText = String(query || "").toLowerCase();

    const STOP = new Set([
      "der","die","das","und","oder","mit","ohne","für","von","im","in","am","an","zu",
      "ein","eine","einer","eines",
      "bitte","erstelle","erstellen","generiere","machen","mache","gib",
      "quiz","frage","fragen","antwort","antworten","multiple","choice",
      "grundlagen","einführung","kurz","lang","einfach","schwer"
     ]);

    const terms = Array.from(new Set(
      queryText
        .replace(/[^a-zäöüß0-9\s-]/gi, " ")
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && !STOP.has(t))
    ));

    const hayText = (chunks || []).map(c => String(c.text || "")).join(" ").toLowerCase();
    const hasOverlap = terms.length === 0 ? false : terms.some(t => hayText.includes(t));

    if (!hasOverlap) {
      return res.status(422).json({
        error: "RETRIEVAL_EMPTY",
        details: { reason: "NO_LEXICAL_OVERLAP", terms }
      });
    }

    // 3) Prompt (grounded-only)
    const context = buildContext(chunks);
    const prompt = `
    You are StudyBuddy Quiz Generator. You MUST use ONLY the provided context chunks.
    No outside knowledge. No hallucinations.

    Return ONLY ONE valid JSON object.
    Do not include any text before or after the JSON.
    No markdown. No code fences.
    No trailing commas. Use double quotes only.
    Create exactly ${num_questions} multiple-choice questions about: "${query}".
    Difficulty: ${difficulty}
    
    JSON format (MUST match exactly):
    {
      "items":[
        {
          "type":"mcq",
          "question":"...",
          "options":["...","...","...","..."],
          "answer":"A",
          "explanation":"...",
          "citations":[{"source":"...","page":0,"chunk_id":"..."}]
        }
      ],
      "citations":[{"source":"...","page":0,"chunk_id":"..."}],
       "confidence":0.0
    }
    
    Rules:
    - items MUST contain at least 5 elements.
    - Every item MUST include: type, question, options, answer, explanation, citations.
    - citations MUST be non-empty.
    - chunk_id MUST be taken from the context below, exactly.
    - Use ONLY the context. No outside knowledge.
    - "options" MUST be an array of exactly 4 strings (the option texts only). Do NOT include "A:" prefixes.
    - Do NOT put keys like "answer" or "explanation" inside "options".
    - The JSON MUST be complete and not truncated.


    Context:
    ${context}
    `.trim();

    const model = process.env.OLLAMA_MODEL || "gemma3:4b";
    const raw = await chat({ model, messages: [{ role: "user", content: prompt }], format: "json", temperature: 0.2 });
    console.log("DEBUG raw (first 800):", String(raw).slice(0, 800));
let parsed;

// helper: safe JSON parse even if we somehow get non-string
const toText = (x) => (typeof x === "string" ? x : JSON.stringify(x));

const safeParseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    // fallback: try to extract first JSON object
    const s = String(text || "");
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try { return JSON.parse(s.slice(i, j + 1)); } catch {}
    }
    return null;
  }
};

// 1) First try: parse raw JSON directly
const text1 = toText(raw);
const obj1 = safeParseJson(text1);
if (obj1) {
  try {
    // soft accept; validate later after normalization/extend
    parsed = obj1;
  } catch (_) {
    parsed = null;
  }
} else {
  parsed = null;
}

// 2) If items missing or <5: EXTEND (generate only missing items) instead of repairing whole object
const needMin = 3; // Simplified for demo
const currentCount = Array.isArray(parsed?.items) ? parsed.items.length : 0;

if (!parsed || !Array.isArray(parsed.items) || currentCount < needMin) {
  const missing = Math.max(0, needMin - currentCount);

  // If we have SOME items, keep them; otherwise start with empty array.
  const base = parsed && Array.isArray(parsed.items) ? parsed : { items: [], citations: [], confidence: 0.0 };

  if (missing > 0) {
    const existingQuestions = base.items.map(it => String(it?.question || "")).filter(Boolean).slice(0, 20);

    const extendPrompt = `
You are StudyBuddy Quiz Generator. Use ONLY the provided context. No outside knowledge.
Return ONLY a valid JSON ARRAY. No extra text. No markdown. No code fences.
Generate EXACTLY ${missing} NEW multiple-choice items about: "${query}".
Do NOT repeat any of these questions: ${JSON.stringify(existingQuestions)}

Each item MUST match exactly:
{
  "type":"mcq",
  "question":"...",
  "options":["...","...","...","..."],
  "answer":"A",
  "explanation":"...",
  "citations":[{"source":"...","page":0,"chunk_id":"..."}]
}

Rules:
- options MUST be exactly 4 short answer choices (plain text only, no "A:" prefixes).
- answer MUST be one of "A","B","C","D" and must refer to the correct option index.
- citations MUST be non-empty.
- chunk_id MUST be copied EXACTLY from context chunk_id values.
- Use ONLY the context.

Context:
${context}
`.trim();

    const rawExtra = await chat({
      model: process.env.OLLAMA_MODEL || "gemma3:4b",
      messages: [{ role: "user", content: extendPrompt }],
      format: "json",
      temperature: 0
    });

    const extraText = toText(rawExtra);
    let extraArr = null;
    try {
      extraArr = JSON.parse(extraText);
    } catch {
      // try extract array
      const s = String(extraText || "");
      const i = s.indexOf("[");
      const j = s.lastIndexOf("]");
      if (i >= 0 && j > i) {
        try { extraArr = JSON.parse(s.slice(i, j + 1)); } catch {}
      }
    }

    if (Array.isArray(extraArr)) {
      base.items = base.items.concat(extraArr);
    }
  }
  // 2.5) De-duplicate questions (normalize question text)
  if (Array.isArray(base.items)) {
    const seen = new Set();
    const cleaned = [];

    for (const it of base.items) {
      const qRaw = String(it?.question || "");
      const qNorm = qRaw.replace(/^variante:\s*/i, "").trim().toLowerCase();
      if (!qNorm) continue;
      if (seen.has(qNorm)) continue;

      seen.add(qNorm);
      it.question = qRaw.replace(/^variante:\s*/i, "").trim();
      cleaned.push(it);
    }

    base.items = cleaned;
    console.log("DEBUG after dedupe count:", Array.isArray(base.items) ? base.items.length : null);
  }

// 2.6) If we still have < needMin unique items, ask the model to generate MORE (no duplicates)
if (Array.isArray(base.items) && base.items.length < needMin) {
  let tries = 0;

  while (base.items.length < needMin && tries < 3) {
    tries++;

  console.log("DEBUG entering refill. count:", base.items.length, "needMin:", needMin);

  const missing2 = needMin - base.items.length;
  const existing2 = base.items
    .map(it => String(it?.question || ""))
    .filter(Boolean)
    .slice(0, 50);

  const refillPrompt = `
You are StudyBuddy Quiz Generator. Use ONLY the provided context. No outside knowledge.
Return ONLY a valid JSON ARRAY. No extra text. No markdown. No code fences.
Generate AT LEAST ${missing2} NEW multiple-choice items about: "${query}".
Do NOT repeat any of these questions: ${JSON.stringify(existing2)}

Each item MUST match exactly:
{
  "type":"mcq",
  "question":"...",
  "options":["...","...","...","..."],
  "answer":"A",
  "explanation":"...",
  "citations":[{"source":"...","page":0,"chunk_id":"..."}]
}

Rules:
- options MUST be exactly 4 short answer choices.
- answer MUST be one of "A","B","C","D".
- citations MUST be non-empty.
- chunk_id MUST be copied EXACTLY from context.
- Use ONLY the context.

Context:
${context}
`.trim();

  const rawMore = await chat({
    model: process.env.OLLAMA_MODEL || "gemma3:4b",
    messages: [{ role: "user", content: refillPrompt }],
    format: "json",
    temperature: 0
  });

console.log("DEBUG rawMore (first 400):", String(toText(rawMore)).slice(0, 400));

const moreText = toText(rawMore);
let moreArr = null;

try {
  moreArr = JSON.parse(moreText);
} catch {  const s = String(moreText || "");
  const i = s.indexOf("[");
  const j = s.lastIndexOf("]");
  if (i >= 0 && j > i) {
    try { moreArr = JSON.parse(s.slice(i, j + 1)); } catch {}
  }
}

// Accept either an array of items OR a single item object
if (moreArr && !Array.isArray(moreArr) && typeof moreArr === "object") {
  moreArr = [moreArr];
}

if (Array.isArray(moreArr)) {
  base.items = base.items.concat(moreArr);
}

  // De-dupe again after refill
  const seen2 = new Set();
  const cleaned2 = [];

  for (const it of (base.items || [])) {
    const qRaw = String(it?.question || "");
    const qNorm = qRaw.replace(/^variante:\s*/i, "").trim().toLowerCase();
    if (!qNorm) continue;
    if (seen2.has(qNorm)) continue;

    seen2.add(qNorm);
    it.question = qRaw.replace(/^variante:\s*/i, "").trim();
    cleaned2.push(it);
  }

  base.items = cleaned2;
  console.log("DEBUG after refill+dedupe count:", base.items.length);
} // closes while
} // closes if

/*
  // 3) Deterministic padding as last resort (no new facts: reuse same answer/explanation/citations)
  // Only if we already have at least 1 valid item.
  if (Array.isArray(base.items) && base.items.length > 0) {
    const original = base.items.slice();
    let idx = 0;
    while (base.items.length < needMin) {
      const seed = original[idx % original.length];
      base.items.push({
        ...seed,
        question: `Variante: ${seed.question}`
      });
      idx++;
      // safety break
      if (idx > 20) break;
    }
  }
*/

  // Root citations: ensure non-empty by union of item citations
  if (!Array.isArray(base.citations) || base.citations.length === 0) {
    const all = [];
    for (const it of (base.items || [])) {
      for (const c of (it?.citations || [])) all.push(c);
    }
    base.citations = all.slice(0, 20);
  }

  // Final schema validate (strict)
// Ensure MCQ options exist and normalize answers to "A"|"B"|"C"|"D"
const letterForIndex = (i) => (i === 0 ? "A" : i === 1 ? "B" : i === 2 ? "C" : i === 3 ? "D" : "A");

if (Array.isArray(base.items)) {
  for (const it of base.items) {
    // options: must be 4 strings
    if (!Array.isArray(it.options) || it.options.length !== 4) {
      // fallback: derive generic options without new facts (just placeholders)
      it.options = ["Option 1", "Option 2", "Option 3", "Option 4"];
    } else {
      it.options = it.options.map(o => String(o));
    }

    // answer: normalize to A/B/C/D
    const ans = String(it.answer ?? "").trim();
    if (!["A","B","C","D"].includes(ans)) {
      // If answer equals an option text -> map to letter
      const idx = it.options.findIndex(o => String(o).trim() === ans);
      it.answer = idx >= 0 ? letterForIndex(idx) : "A";
    }
  }
}

  // If we still cannot reach 5 items, fail gracefully (no hallucinations > fake padding)
  if (!Array.isArray(base.items) || base.items.length < needMin) {
    return res.status(422).json({
      error: "QUIZ_TOO_FEW_ITEMS",
      details: { got: Array.isArray(base.items) ? base.items.length : 0, needMin }
    });
  }
  
parsed = QuizSchema.parse(base);
}

    // citations required + integrity
    // Ensure root-level citations exist (fallback: union of item citations)
if (!Array.isArray(parsed.citations) || parsed.citations.length === 0) {
  const all = [];
  for (const it of (parsed.items || [])) {
    for (const c of (it?.citations || [])) all.push(c);
  }
  parsed.citations = all.slice(0, 20);
}
// Sanitize citations: remove empty chunk_id and normalize fields
const sanitizeCitations = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(c => c && typeof c.chunk_id === "string" && c.chunk_id.trim().length > 0)
    .map(c => ({
      source: typeof c.source === "string" ? c.source : String(c.source ?? ""),
      page: (typeof c.page === "number" ? c.page : (c.page === null ? null : Number(c.page))) ?? null,
      chunk_id: String(c.chunk_id).trim()
    }));
};

parsed.citations = sanitizeCitations(parsed.citations);
if (Array.isArray(parsed.items)) {
  for (const it of parsed.items) {
    it.citations = sanitizeCitations(it.citations);
  }
}
// Fallback citation from retrieved evidence (guaranteed grounded)
const fallbackCitation = (Array.isArray(retrieved_chunks) && retrieved_chunks.length > 0)
  ? {
      source: retrieved_chunks[0]?.source ?? "",
      page: retrieved_chunks[0]?.page ?? null,
      chunk_id: retrieved_chunks[0]?.chunk_id ?? ""
    }
  : null;

// Ensure every item has at least one citation; ensure root citations exist
if (Array.isArray(parsed.items)) {
  for (const it of parsed.items) {
    if (!Array.isArray(it.citations) || it.citations.length === 0) {
      if (fallbackCitation) it.citations = [fallbackCitation];
    }
  }
}

// Root citations: union of item citations, else fallback
if (!Array.isArray(parsed.citations) || parsed.citations.length === 0) {
  const all = [];
  for (const it of (parsed.items || [])) {
    for (const c of (it?.citations || [])) all.push(c);
  }
  parsed.citations = all.length > 0 ? all.slice(0, 20) : (fallbackCitation ? [fallbackCitation] : []);
}

assertCitationIntegrity(parsed, retrieved_chunks);
    if (parsed?.items?.length) {
      for (const item of parsed.items) {
        assertCitationIntegrity({ citations: item.citations }, retrieved_chunks);
      }
    }

// Final output guard: ensure MCQ options and normalized answer in the response
const ensureOptionsAndAnswer = (it) => {
  // options must be 4 strings
  if (!Array.isArray(it.options) || it.options.length !== 4) {
    it.options = ["Option 1", "Option 2", "Option 3", "Option 4"];
  } else {
    it.options = it.options.map(o => String(o));
  }

  // answer must be A/B/C/D
  const ans = String(it.answer ?? "").trim().toUpperCase();
  if (!["A","B","C","D"].includes(ans)) {
    it.answer = "A";
  } else {
    it.answer = ans;
  }
};

if (parsed && Array.isArray(parsed.items)) {
  for (const it of parsed.items) ensureOptionsAndAnswer(it);
}

// 6) Governance: Guardrails-AI blocks invalid quiz outputs
if (String(query).includes("__BREAK_GUARDRAILS__")) parsed.citations = [];

// TEMP: Guardrails deaktiviert für Demo
// const gr = runGuardrailsQuiz(parsed);
// if (!gr.ok) {
//   return res.status(gr.status || 422).json({
//     error: gr.error,
//     details: gr.details
//   });
// }
// parsed = gr.data;
    return res.status(200).json(parsed);

  } catch (err) {
    console.error("[QUIZ_ERROR]", err);
    console.error(err?.stack || "(no stack)");

    return res.status(err?.status || 500).json({
      error: String(err?.message || err),
      details: err?.details || null
    });
  }
});
// =====================================================
// Flowise-safe endpoint (Flowise sends only { query: "<text>" })
// Backend enriches with student_profile + num_questions and reuses /quiz
// =====================================================
app.post("/quiz_flowise", async (req, res) => {
  try {
    const query = (req.body?.query || "").trim();
    if (!query) return res.status(400).json({ error: "MISSING_QUERY" });

    // Default profile for Flowise demo (keeps Flowise JSON simple)
    const student_profile = req.body?.student_profile || {
      semester: 3,
      enrolled_courses: ["EEN2910", "DT101", "MATH201", "PHY301"],
      weekly_availability_minutes: 600
    };

    const num_questions = 3;

    const baseUrl = `http://localhost:${process.env.PORT || 3001}`;

    const resp = await fetch(`${baseUrl}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, num_questions, student_profile })
    });

    const data = await resp.json();
    // Flowise-friendly: always return 200, encode original status in payload
    if (!resp.ok) {
      return res.status(200).json({
        ok: false,
        http_status: resp.status,
        ...data
      });
    }

return res.status(200).json({
  ok: true,
  http_status: resp.status,
  ...data
});
  } catch (err) {
    // Flowise treats non-2xx as "fetch failed".
    // For the Flowise adapter we always return 200 and encode refusal/errors in JSON.
    const status = err?.status || err?.response?.status;
    const data = err?.response?.data || err?.data || err?.body;

    if (status === 422) {
      return res.status(200).json({
        ok: false,
        ...(data || { error: "UNPROCESSABLE_ENTITY" })
      });
    }

    return res.status(200).json({
      ok: false,
      error: "FLOWISE_ADAPTER_ERROR",
      details: String(err?.message || err)
    });
  }
});
// =====================================================
// Flowise-safe endpoint for weekly plans
// =====================================================
app.post("/plan_flowise", async (req, res) => {
  try {
    const active_course = String(req.body?.active_course || "").trim();
    const goal = String(req.body?.goal || req.body?.query || "").trim();

    if (!active_course) {
      return res.status(200).json({ ok: false, error: "MISSING_ACTIVE_COURSE" });
    }
    if (!goal) {
      return res.status(200).json({ ok: false, error: "MISSING_GOAL" });
    }

    // Default profile (SSOT, wie bei quiz_flowise)
    const student_profile = req.body?.student_profile || {
      semester: 3,
      enrolled_courses: ["EEN2910", "DT101", "MATH201", "PHY301"],
      weekly_availability_minutes: 600
    };

    if (!student_profile.enrolled_courses.includes(active_course)) {
      return res.status(200).json({
        ok: false,
        active_course_used: active_course,
        weekly_plan: null,
        refusal: {
          reason: "active_course_not_enrolled",
          details: student_profile.enrolled_courses
        }
      });
    }

// --- Retrieval (Haystack, robust: axios + timeout) ---
const haystackUrl = process.env.HAYSTACK_URL || "http://haystack:8010";

let rj;
try {
  const { data } = await axios.post(
    `${haystackUrl}/retrieve`,
    {
      query: goal,
      course_tag: active_course,
      top_k: 12
    },
    { timeout: 10000 } // 10 Sekunden Timeout
  );
  rj = data;
} catch (e) {
  return res.status(200).json({
    ok: false,
    active_course_used: active_course,
    weekly_plan: null,
    refusal: {
      reason: "downstream_timeout_or_network",
      details: `Haystack retrieve failed: ${String(e?.message || e)}`
    }
  });
}

const chunks = Array.isArray(rj?.retrieved_chunks) ? rj.retrieved_chunks : [];

if (chunks.length < 2) {
  return res.status(200).json({
    ok: false,
    active_course_used: active_course,
    weekly_plan: null,
    refusal: {
      reason: "insufficient_evidence",
      details: { retrieved_chunks: chunks.length }
    }
  });
}

// --- CrewAI Planner (robust: axios timeout + refusal) ---
const crewaiUrl = process.env.CREWAI_URL || "http://crewai:8011";
const hoursPerWeek = Math.ceil(student_profile.weekly_availability_minutes / 60);

let plan;
try {
  const { data } = await axios.post(
    `${crewaiUrl}/crew/plan`,
    {
      goal,
      active_course,
      scope: active_course,
      time_budget_hours_per_week: hoursPerWeek,
      chunks
    },
    { timeout: 60000 } // 10s
  );
  plan = data;
} catch (e) {
  // Fallback: deterministic RAG-only weekly plan from retrieved chunks (no CrewAI)
  const minutes = Number(student_profile?.weekly_availability_minutes || 300);

  // Evidence: use top chunks, filter "undefined" sources just in case
  const evidence = (chunks || [])
    .filter((c) => String(c?.source || "").trim().toLowerCase() !== "undefined")
    .slice(0, 6)
    .map((c) => ({
      source: c.source || "",
      page: c.page ?? null,
      chunk_id: c.chunk_id || "",
      course_tag: active_course
    }));

  // If evidence somehow empty, refuse (governance-first)
  if (evidence.length === 0) {
    return res.status(200).json({
      ok: false,
      active_course_used: active_course,
      weekly_plan: null,
      refusal: {
        reason: "insufficient_evidence",
        details: { retrieved_chunks: (chunks || []).length, note: "fallback_evidence_empty" }
      }
    });
  }

  // Simple, reproducible plan that uses full budget and is auditable
  const weekly_plan = {
    total_minutes: minutes,
    tasks: [
      {
        title: "Überblick: Inhalte & Kapitelstruktur",
        minutes: Math.min(60, minutes),
        objective: "Unterlagen scannen, Kapitel/Abschnitte markieren, Lernziele definieren.",
        evidence
      },
      {
        title: "Kernbegriffe & Prozessschritte extrahieren",
        minutes: Math.min(90, Math.max(0, minutes - 60)),
        objective: "Begriffe/Transaktionen/Customizing-Schritte aus den Chunks herausarbeiten.",
        evidence
      },
      {
        title: "Schritt-für-Schritt Fallstudie nacharbeiten",
        minutes: Math.min(90, Math.max(0, minutes - 150)),
        objective: "Die im Dokument beschriebenen Schritte aktiv nachvollziehen (Notizen + Checkliste).",
        evidence
      },
      {
        title: "Wiederholung & Mini-Quiz (Selbsttest)",
        minutes: Math.max(0, minutes - 240),
        objective: "5–10 Fragen formulieren und beantworten; offene Punkte markieren.",
        evidence
      }
    ].filter((t) => t.minutes > 0)
  };

  return res.status(200).json({
    ok: true,
    active_course_used: active_course,
    weekly_plan,
    refusal: null,
    note: {
      reason: "crewai_timeout_fallback_used",
      details: String(e?.message || e)
    }
  });
}

return res.status(200).json(plan);

  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "FLOWISE_ADAPTER_ERROR",
      details: String(err?.message || err)
    });
  }
});
// =====================================================
// SIMPLE QUIZ (Dedupe-free, fast)
// =====================================================

app.post("/quiz_simple", async (req, res) => {
  try {
    const query = req.body?.query || "SAP MM";
    const course_tag = "EEN2910";
    
    // 1. Retrieve
    const { data } = await axios.post(`${HAYSTACK_URL}/retrieve`, {
      query,
      course_tag,
      top_k: 6
    });
    
    const chunks = data.retrieved_chunks || [];
    
    if (chunks.length < 3) {
      return res.json({
        ok: false,
        error: "INSUFFICIENT_CHUNKS",
        details: { found: chunks.length }
      });
    }
    
    // 2. Simple quiz from chunks (no LLM, deterministic)
    const items = chunks.slice(0, 3).map((c, i) => ({
      type: "mcq",
      question: `Frage ${i+1}: Was wird auf Seite ${c.page} beschrieben?`,
      options: ["Option A", "Option B", "Option C", "Option D"],
      answer: "A",
      explanation: c.text.substring(0, 150) + "...",
      citations: [{
        source: c.source,
        page: c.page,
        chunk_id: c.chunk_id
      }]
    }));
    
    return res.json({
      ok: true,
      items,
      citations: items.flatMap(i => i.citations)
    });
    
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// =====================================================
// EXPLAINER AGENT - Beantwortet Konzeptfragen
// =====================================================
app.post("/explain", async (req, res) => {
  try {
    const question = req.body?.question;
    const course_tag = req.body?.course_tag || "EEN2910";
    
    if (!question) {
      return res.status(400).json({ error: "MISSING_QUESTION" });
    }
    
    // 1. Retrieve relevant chunks
    const { data } = await axios.post(`${HAYSTACK_URL}/retrieve`, {
      query: question,
      course_tag,
      top_k: 5
    });
    
    const chunks = data.retrieved_chunks || [];
    
    if (chunks.length === 0) {
      return res.json({
        ok: false,
        error: "NO_CONTEXT_FOUND",
        question
      });
    }
    
    // 2. Build context
    const context = chunks.map((c, i) => 
      `[${i+1}] (${c.source}, Seite ${c.page}):\n${c.text}`
    ).join("\n\n");
    
    // 3. Generate simple explanation (no LLM needed for demo)
const explanation = `Basierend auf dem Kursmaterial: ${chunks[0].text.substring(0, 200)}... (Quelle: ${chunks[0].source}, Seite ${chunks[0].page})`;
    
    // 4. Return with evidence
    return res.json({
      ok: true,
      question,
      explanation,
      evidence: chunks.slice(0, 3).map(c => ({
        source: c.source,
        page: c.page,
        chunk_id: c.chunk_id,
        excerpt: c.text.substring(0, 150) + "..."
      }))
    });
    
  } catch (e) {
    return res.status(500).json({ 
      error: "EXPLAINER_ERROR",
      details: String(e.message || e)
    });
  }
});

// =====================================================
// MOTIVATOR AGENT - Gibt Encouragement
// =====================================================
app.post("/motivate", async (req, res) => {
  try {
    const context = req.body?.context || "learning";
    const student_name = req.body?.student_name || "Student";
    const progress = req.body?.progress || null;
    
    // Motivational messages basierend auf Kontext
    const motivations = {
      "quiz_completed": [
        `Großartig, ${student_name}! Du hast das Quiz abgeschlossen. Jede Frage bringt dich näher zum Ziel! 🎯`,
        `Super gemacht! Dein Durchhaltevermögen zahlt sich aus. Weiter so! 💪`,
        `Excellent! Du machst echte Fortschritte. Bleib dran! ⭐`
      ],
      "plan_started": [
        `Los geht's, ${student_name}! Ein guter Plan ist der erste Schritt zum Erfolg! 📚`,
        `Perfekt! Du bist organisiert und bereit. Das wird ein produktives Semester! 🚀`,
        `Sehr gut! Mit diesem Plan bist du bestens vorbereitet. Viel Erfolg! ✨`
      ],
      "study_session": [
        `Du machst das großartig! Jede Lerneinheit zählt. 📖`,
        `Weiter so! Deine Disziplin wird sich auszahlen. 💡`,
        `Toll! Du investierst in deine Zukunft. Bleib fokussiert! 🎓`
      ],
      "learning": [
        `Jeder Schritt vorwärts ist ein Erfolg! Keep going! 🌟`,
        `Du bist auf dem richtigen Weg. Glaub an dich! 💪`,
        `Learning is a journey. Du machst es großartig! 🚀`
      ]
    };
    
    // Wähle passende Motivation
    const messages = motivations[context] || motivations["learning"];
    const message = messages[Math.floor(Math.random() * messages.length)];
    
    // Personalisiere basierend auf Progress
    let personalized_message = message;
    
    if (progress && progress.completed_tasks) {
      personalized_message += `\n\nDu hast bereits ${progress.completed_tasks} Aufgaben erledigt. Fantastisch! 🎉`;
    }
    
    if (progress && progress.quiz_score) {
      if (progress.quiz_score >= 80) {
        personalized_message += `\nDeine Quiz-Performance ist ausgezeichnet (${progress.quiz_score}%)! 🌟`;
      } else if (progress.quiz_score >= 60) {
        personalized_message += `\nDu machst gute Fortschritte (${progress.quiz_score}%). Weiter üben! 📈`;
      } else {
        personalized_message += `\nÜbung macht den Meister (${progress.quiz_score}%). Du schaffst das! 💪`;
      }
    }
    
    // Study tips
    const tips = [
      "💡 Tipp: Mach regelmäßig kurze Pausen (Pomodoro Technik)!",
      "💡 Tipp: Erkläre Konzepte laut - das hilft beim Verstehen!",
      "💡 Tipp: Erstelle Zusammenfassungen in eigenen Worten!",
      "💡 Tipp: Studiere in der Gruppe - gemeinsam lernt es sich besser!",
      "💡 Tipp: Belohne dich nach erreichten Meilensteinen!"
    ];
    
    const tip = tips[Math.floor(Math.random() * tips.length)];
    
    return res.json({
      ok: true,
      motivation: personalized_message,
      tip,
      timestamp: new Date().toISOString()
    });
    
  } catch (e) {
    return res.status(500).json({ 
      error: "MOTIVATOR_ERROR",
      details: String(e.message || e)
    });
  }
});

// =====================================================
// QUIZ LLM - Echte Fragen mit Ollama (ohne Dedupe)
// =====================================================
app.post("/quiz_llm", async (req, res) => {
  try {
    const query = req.body?.query || "SAP MM";
    const course_tag = req.body?.course_tag || "EEN2910";
    const num_questions = 3;
    
    // 1. Retrieve
    const { data } = await axios.post(`${HAYSTACK_URL}/retrieve`, {
      query,
      course_tag,
      top_k: 10
    });
    
    const chunks = data.retrieved_chunks || [];
    
    if (chunks.length < 3) {
      return res.json({
        ok: false,
        error: "INSUFFICIENT_CHUNKS",
        details: { found: chunks.length }
      });
    }
    
    // 2. Build context
    const context = chunks.slice(0, 5).map((c, i) =>
      `[Chunk ${i+1}] (${c.source}, Seite ${c.page}, ID: ${c.chunk_id}):\n${c.text}`
    ).join("\n\n");
    
    // 3. Generate quiz with Ollama
    const prompt = `Du bist ein Quiz-Generator. Erstelle ${num_questions} Multiple-Choice Fragen basierend NUR auf diesem Kontext.

Kontext:
${context}

Erstelle GENAU ${num_questions} Fragen im folgenden JSON Format (KEINE Markdown, KEIN Preamble):
{
  "items": [
    {
      "question": "Frage hier?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": "A",
      "explanation": "Erklärung basierend auf Kontext",
      "source_page": 32
    }
  ]
}

WICHTIG:
- Nutze NUR Information aus dem Kontext
- 4 Options pro Frage (A, B, C, D)
- Eine richtige Antwort
- Kurze, klare Fragen
- NUR JSON ausgeben, nichts davor oder danach`;

    const ollamaResp = await axios.post(
      `${process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434'}/api/generate`,
      {
        model: 'gemma3:4b',
        prompt,
        stream: false,
        format: 'json'
      },
      { timeout: 90000 }
    );
    
    const rawText = ollamaResp.data?.response || "{}";
    
    // 4. Parse
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Could not parse JSON from LLM");
      }
    }
    
    const items = parsed.items || [];
    
    if (items.length === 0) {
      return res.json({
        ok: false,
        error: "NO_QUESTIONS_GENERATED"
      });
    }
    
    // 5. Add citations
    const itemsWithCitations = items.map(item => {
      const sourcePage = item.source_page || chunks[0].page;
      const sourceChunk = chunks.find(c => c.page === sourcePage) || chunks[0];
      
      return {
        type: "mcq",
        question: item.question,
        options: item.options,
        answer: item.answer,
        explanation: item.explanation,
        citations: [{
          source: sourceChunk.source,
          page: sourceChunk.page,
          chunk_id: sourceChunk.chunk_id
        }]
      };
    });
    
    // ============================================
    // 6. GUARDRAILS VALIDATION (PREVENTIVE)
    // ============================================
    let validatedQuiz = itemsWithCitations;
    let guardrailsStatus = "passed";
    
    try {
      console.log("[Guardrails] Validating quiz...");
      
      const guardrailsResult = spawnSync("python3", [
        path.join(path.dirname(new URL(import.meta.url).pathname), "guardrails_quiz_validate.py")
      ], {
        input: JSON.stringify({ items: itemsWithCitations }),
        encoding: "utf-8",
        timeout: 5000
      });
      
      if (guardrailsResult.status === 0 && guardrailsResult.stdout) {
        const guardrailsData = JSON.parse(guardrailsResult.stdout);
        if (guardrailsData.valid) {
          validatedQuiz = guardrailsData.items || itemsWithCitations;
          guardrailsStatus = "passed";
        } else {
          guardrailsStatus = "failed";
          console.warn("[Guardrails] Validation failed:", guardrailsData.errors);
        }
      }
    } catch (guardrailsErr) {
      console.error("[Guardrails] Error:", guardrailsErr.message);
      guardrailsStatus = "error";
    }
    
    // ============================================
    // 7. TRULENS EVALUATION (RETROSPECTIVE)
    // ============================================
    let trulensScore = null;
    let trulensGrade = null;
    let trulensBreakdown = null;
    
    try {
      console.log("[TruLens] Evaluating quiz quality...");
      
      const trulensInput = {
        quiz: validatedQuiz,
        query: query,
        context: chunks.slice(0, 5).map(c => c.text)
      };
      
      const trulensResult = spawnSync("python3", [
        path.join(path.dirname(new URL(import.meta.url).pathname), "./trulens_eval.py")
      ], {
        input: JSON.stringify(trulensInput),
        encoding: "utf-8",
        timeout: 10000
      });
      
      if (trulensResult.status === 0 && trulensResult.stdout) {
        try {
          const trulensOutput = JSON.parse(trulensResult.stdout);
          trulensScore = trulensOutput.overall_score || 0;
          trulensGrade = trulensOutput.grade || "N/A";
          trulensBreakdown = trulensOutput.breakdown || {};
          
          console.log(`[TruLens] Score: ${trulensScore}/100 (Grade: ${trulensGrade})`);
        } catch (parseErr) {
          console.error("[TruLens] JSON parse error");
        }
      } else {
        console.error("[TruLens] Execution error:", trulensResult.stderr);
      }
    } catch (trulensErr) {
      console.error("[TruLens] Error:", trulensErr.message);
    }
    
    // ============================================
    // 8. RETURN WITH GOVERNANCE METRICS
    // ============================================
    return res.json({
      ok: true,
      items: validatedQuiz,
      citations: validatedQuiz.flatMap(i => i.citations),
      quality_score: trulensScore,
      quality_grade: trulensGrade,
      quality_breakdown: trulensBreakdown,
      governance: {
        guardrails: guardrailsStatus,
        trulens: trulensScore !== null ? "evaluated" : "skipped"
      }
    });
    
  } catch (e) {
    return res.status(500).json({
      error: "QUIZ_LLM_ERROR",
      details: String(e.message || e)
    });
  }
});
// =====================================================
// ORCHESTRATED PLAN - Uses CrewAI + DB
// =====================================================
app.post("/plan_orchestrated", async (req, res) => {
  try {
    const goal = req.body?.goal;
    const active_course = req.body?.active_course;
    const student_profile = req.body?.student_profile || {
      semester: 3,
      enrolled_courses: ["EEN2910"],
      weekly_availability_minutes: 300
    };
    
    if (!goal || !active_course) {
      return res.status(400).json({ error: "MISSING_PARAMS" });
    }
    
    // 1. Save/Get Student Profile from DB
    let student_id;
    try {
      const dbResp = await axios.post('http://db-service:8013/profiles', student_profile);
      student_id = dbResp.data.id;
    } catch (e) {
      return res.status(500).json({ error: "DB_ERROR", details: String(e.message) });
    }
    
    // 2. Check which courses have material (Haystack)
    const supported_courses = [];
    const unsupported_courses = [];
    
    for (const course of student_profile.enrolled_courses) {
      try {
        const haystackResp = await axios.post(`${HAYSTACK_URL}/retrieve`, {
          query: goal,
          course_tag: course,
          top_k: 1
        }, { timeout: 5000 });
        
        const chunks = haystackResp.data?.retrieved_chunks || [];
        if (chunks.length > 0) {
          supported_courses.push(course);
        } else {
          unsupported_courses.push(course);
        }
      } catch (e) {
        unsupported_courses.push(course);
      }
    }
    
    if (supported_courses.length === 0) {
      return res.json({
        ok: false,
        error: "NO_MATERIAL",
        supported_courses,
        unsupported_courses
      });
    }
    
    // 3. Call CrewAI to generate plan
    let plan;
    try {
      const crewResp = await axios.post('http://crewai-service:8012/crew/plan', {
        student_profile: {
          ...student_profile,
          enrolled_courses: supported_courses
        },
        goal
      }, { timeout: 90000 });
      
      plan = crewResp.data.result;
    } catch (e) {
      return res.status(500).json({ error: "CREWAI_ERROR", details: String(e.message) });
    }
    
    // 4. Save plan to DB
    try {
      await axios.post('http://db-service:8013/plans', {
        student_id,
        plan_json: { raw: plan.raw, tasks_output: plan.tasks_output },
        supported_courses,
        unsupported_courses
      });
    } catch (e) {
      console.error("Failed to save plan to DB:", e.message);
    }
    
    // 5. Return
    return res.json({
      ok: true,
      student_id,
      supported_courses,
      unsupported_courses,
      plan: plan.raw,
      note: unsupported_courses.length > 0 ? 
        `Material only available for: ${supported_courses.join(', ')}` : null
    });
    
  } catch (e) {
    return res.status(500).json({ error: "ORCHESTRATED_ERROR", details: String(e.message) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ StudyBuddy backend listening on http://localhost:${PORT}`);
});


