// supabase/functions/process/index.ts
// Sekarang bukan lagi dipanggil otomatis dari trigger database — capture sudah
// memproses inline. Function ini dipertahankan sebagai endpoint "proses ulang"
// buat catatan lama yang macet di status raw / gagal diproses (summary null dll).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ===== AI helpers (inlined dari _shared/ai.ts) =====
// Kode ini digandakan di ketiga function (capture/process/ask) supaya tiap
// function berdiri sendiri dan tetap bisa di-deploy satu-satu lewat Supabase
// Dashboard (yang tidak ikut mem-bundle folder _shared/).

export const EMBEDDING_DIM = 1024;
const MAX_RETRIES = 2;
const TIMEOUT_MS = 15000;

// Model yang valid per Jan 2026. Kalau provider ganti/deprecate nama model,
// ganti di sini saja — semua function ikut kepakai.
const AI_ORDER: Array<[string, string]> = [
  ["gemini", "gemini-2.0-flash"],
  ["gemini", "gemini-1.5-flash"],
  ["groq", "llama-3.3-70b-versatile"],
  ["groq", "llama-3.1-8b-instant"],
];

const EMBED_PROVIDERS = [
  { name: "voyage", keyEnv: "VOYAGE_API_KEY", model: "voyage-3" },
  { name: "openai", keyEnv: "OPENAI_API_KEY", model: "text-embedding-3-small" },
  { name: "cohere", keyEnv: "COHERE_API_KEY", model: "embed-english-v3-light" },
];

const NOTE_PROMPT = `Kamu asisten second-brain yang membantu mengembangkan ide, bukan cuma meringkas.
Diberi satu catatan mentah, balas HANYA JSON valid tanpa markdown, persis format ini:
{"summary": "ringkasan 1 kalimat", "tags": ["tag1","tag2"], "note_type": "idea|task|reflection|quote|other", "insight": "2-3 kalimat: kembangkan ide ini, kaitkan dengan sudut pandang/langkah yang relevan, kasih satu saran konkret buat langkah atau ide berikutnya"}
Tulis insight dengan nada santai tapi membantu, bukan generik.`;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function safeParseNoteJSON(raw: string) {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const p = JSON.parse(cleaned);
    if (!p.summary) return null;
    return {
      summary: String(p.summary),
      tags: Array.isArray(p.tags) ? p.tags.map(String).slice(0, 8) : [],
      note_type: typeof p.note_type === "string" ? p.note_type : "other",
      insight: typeof p.insight === "string" ? p.insight : null,
    };
  } catch {
    return null;
  }
}

async function callGemini(content: string, apiKey: string, model: string) {
  const res = await withTimeout(
    fetch(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { role: "system", parts: [{ text: NOTE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: content }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.3, responseMimeType: "application/json" },
      }),
    }),
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const parsed = safeParseNoteJSON(raw);
  if (!parsed) throw new Error(`Gemini ${model}: gagal parse JSON`);
  return parsed;
}

async function callGroq(content: string, apiKey: string, model: string) {
  const res = await withTimeout(
    fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: NOTE_PROMPT }, { role: "user", content }],
        max_tokens: 400,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    }),
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Groq ${model} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseNoteJSON(raw);
  if (!parsed) throw new Error(`Groq ${model}: gagal parse JSON`);
  return parsed;
}

/** Selalu balikin hasil terpakai (summary/tags/note_type/insight tidak pernah null). */
export async function generateNoteInsights(content: string) {
  const errors: string[] = [];
  for (const [provider, model] of AI_ORDER) {
    const keyNames = provider === "gemini" ? ["GEMINI_API_KEY_1", "GEMINI_API_KEY"] : ["GROQ_API_KEY_1", "GROQ_API_KEY"];
    const key = keyNames.map((k) => Deno.env.get(k)).find(Boolean);
    if (!key) continue;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return provider === "gemini" ? await callGemini(content, key, model) : await callGroq(content, key, model);
      } catch (e) {
        errors.push(String(e));
      }
    }
  }
  console.error("generateNoteInsights: semua provider gagal ->", errors.join(" | "));
  return {
    summary: content.length > 80 ? content.slice(0, 77) + "..." : content,
    tags: [] as string[],
    note_type: "other",
    insight: null as string | null,
  };
}

async function embedVoyage(text: string, key: string) {
  const res = await withTimeout(
    fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: [text], model: "voyage-3" }),
    }),
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data?.[0]?.embedding as number[] | undefined;
}

async function embedOpenAI(text: string, key: string) {
  const res = await withTimeout(
    fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
    }),
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`OpenAI embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data?.[0]?.embedding as number[] | undefined;
}

async function embedCohere(text: string, key: string) {
  const res = await withTimeout(
    fetch("https://api.cohere.ai/v1/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ texts: [text], model: "embed-english-v3-light", embedding_type: "float", input_type: "search_document" }),
    }),
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Cohere embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings?.[0] as number[] | undefined;
}

function normalize(vec: number[]): number[] {
  if (vec.length === EMBEDDING_DIM) return vec;
  if (vec.length > EMBEDDING_DIM) return vec.slice(0, EMBEDDING_DIM);
  return vec.concat(Array(EMBEDDING_DIM - vec.length).fill(0));
}

/**
 * Dipakai oleh capture (buat notes) DAN ask (buat pertanyaan) supaya SELALU
 * lewat provider yang sama duluan -> ruang embedding konsisten, similarity valid.
 * Balikin null kalau semua provider embedding gagal (bukan lempar error).
 */
export async function embedText(text: string): Promise<number[] | null> {
  for (const provider of EMBED_PROVIDERS) {
    const key = Deno.env.get(provider.keyEnv);
    if (!key) continue;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let vec: number[] | undefined;
        if (provider.name === "voyage") vec = await embedVoyage(text, key);
        else if (provider.name === "openai") vec = await embedOpenAI(text, key);
        else vec = await embedCohere(text, key);
        if (vec && vec.length) return normalize(vec);
      } catch (e) {
        console.error(`embedText ${provider.name} gagal:`, String(e));
      }
    }
  }
  return null;
}

/** Jawab pertanyaan berdasarkan context catatan, pakai chain provider yang sama (gemini/groq). */
export async function generateAnswer(question: string, context: string): Promise<string> {
  const system = "Kamu adalah second-brain assistant milik user. Jawab pertanyaan HANYA berdasarkan catatan berikut. " +
    "Kalau catatannya tidak cukup buat jawab, bilang terus terang. Jawab singkat, jelas, bahasa Indonesia santai.\n\nCatatan:\n" + context;
  const errors: string[] = [];
  for (const [provider, model] of AI_ORDER) {
    const keyNames = provider === "gemini" ? ["GEMINI_API_KEY_1", "GEMINI_API_KEY"] : ["GROQ_API_KEY_1", "GROQ_API_KEY"];
    const key = keyNames.map((k) => Deno.env.get(k)).find(Boolean);
    if (!key) continue;
    try {
      if (provider === "gemini") {
        const res = await withTimeout(
          fetch(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { role: "system", parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: question }] }],
              generationConfig: { maxOutputTokens: 500, temperature: 0.4 },
            }),
          }),
          TIMEOUT_MS,
        );
        if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } else {
        const res = await withTimeout(
          fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model,
              messages: [{ role: "system", content: system }, { role: "user", content: question }],
              max_tokens: 500,
              temperature: 0.4,
            }),
          }),
          TIMEOUT_MS,
        );
        if (!res.ok) throw new Error(`Groq ${model} ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return text;
      }
    } catch (e) {
      errors.push(String(e));
    }
  }
  console.error("generateAnswer: semua provider gagal ->", errors.join(" | "));
  return "Maaf, semua AI provider lagi gagal jawab. Coba lagi sebentar ya.";
}


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing auth" }, 401);

    // Pakai token user (bukan service role) supaya RLS mencegah reprocess note orang lain.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Invalid session" }, 401);

    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body bukan JSON valid" }, 400);
    }
    const noteId = body?.note_id;
    if (!noteId) return json({ error: "note_id wajib diisi" }, 400);

    const { data: note, error: fetchErr } = await supabase.from("notes").select("id, content").eq("id", noteId).single();
    if (fetchErr || !note) return json({ error: "Catatan tidak ketemu (atau bukan milikmu)" }, 404);

    const [insights, embedding] = await Promise.all([
      generateNoteInsights(note.content),
      embedText(note.content),
    ]);

    const { data: updated, error: updateErr } = await supabase
      .from("notes")
      .update({
        summary: insights.summary,
        tags: insights.tags,
        note_type: insights.note_type,
        insight: insights.insight,
        embedding,
        status: "processed",
      })
      .eq("id", noteId)
      .select("*")
      .single();
    if (updateErr) return json({ error: updateErr.message }, 500);

    return json({ ok: true, note: updated });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
