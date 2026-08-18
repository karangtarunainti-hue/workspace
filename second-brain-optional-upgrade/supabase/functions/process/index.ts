// Optimized process function with multi-API + multi-embedding fallback
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STANDARD_PROMPT = `Kamu adalah asisten second-brain yang membantu mengembangkan ide, bukan cuma meringkas. Diberi satu catatan mentah, balas HANYA JSON valid tanpa markdown, format:
{"summary": "ringkasan 1 kalimat", "tags": ["tag1","tag2"], "note_type": "idea|task|reflection|quote|other", "insight": "2-3 kalimat: kembangkan ide ini, kaitkan dengan sudut pandang atau langkah yang relevan, dan kasih satu saran konkret buat langkah/ide berikutnya"}.
Tulis insight dengan nada santai tapi tetap membantu, bukan generik.`;
const EMBEDDING_DIM = 1024;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 15000;

const AI_ORDER = [
  ["gemini", "gemini-2.0-flash"],
  ["gemini", "gemini-1.5-flash"],
  ["groq", "qwen2.5-32b-chat"],
  ["groq", "llama-3.1-8b-instant"],
];

const EMBED_PROVIDERS = [
  { name: "voyage", keyEnv: "VOYAGE_API_KEY", model: "voyage-3", dims: 1024 },
  { name: "openai", keyEnv: "OPENAI_API_KEY", model: "text-embedding-3-small", dims: 1536 },
  { name: "cohere", keyEnv: "COHERE_API_KEY", model: "embed-english-v3-light", dims: 1024 },
];

Deno.serve(async (req) => {
  try {
    const { note_id } = await req.json();
    if (!note_id) return new Response(JSON.stringify({ error: "note_id wajib diisi" }), { status: 400 });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: note, error } = await supabase.from("notes").select("id, content").eq("id", note_id).single();
    if (error || !note) throw error || new Error("note tidak ketemu");

    const parsed = await processWithRetry(note.content);

    const embedding = await createEmbeddingWithRetry(note.content);
    const normalizedEmbedding = embedding ? embedding.slice(0, EMBEDDING_DIM).concat(Array(Math.max(0, EMBEDDING_DIM - embedding.length)).fill(0)) : null;

    const { error: updateErr } = await supabase.from("notes")
      .update({ summary: parsed.summary, tags: parsed.tags, note_type: parsed.note_type, insight: parsed.insight, embedding: normalizedEmbedding, status: "processed" })
      .eq("id", note_id);
    if (updateErr) throw updateErr;

    // GitHub sync (fire-and-forget)
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/github-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ note_id }),
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

async function processWithRetry(content: string) {
  for (const [provider, model] of AI_ORDER) {
    const keys = provider === "gemini" ? ["GEMINI_API_KEY_1", "GEMINI_API_KEY"] : ["GROQ_API_KEY_1", "GROQ_API_KEY"];
    for (const keyName of keys) {
      const key = Deno.env.get(keyName);
      if (!key) continue;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          let result;
          if (provider === "gemini") result = await callGemini(content, key, model);
          else result = await callGroq(content, key, model);
          if (result.summary) return result;
        } catch (e) {
          if (attempt === MAX_RETRIES - 1) console.error(`${provider}/${model} failed:`, e);
        }
      }
    }
  }
  return { summary: content.slice(0, 80), tags: [], note_type: "other", insight: null };
}

async function createEmbeddingWithRetry(content: string) {
  for (const provider of EMBED_PROVIDERS) {
    const key = Deno.env.get(provider.keyEnv);
    if (!key) continue;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let embedding: number[] = [];
        if (provider.name === "voyage") embedding = await embedVoyage(content, key);
        else if (provider.name === "openai") embedding = await embedOpenAI(content, key);
        else if (provider.name === "cohere") embedding = await embedCohere(content, key);
        if (embedding.length > 0) return embedding;
      } catch (e) {
        if (attempt === MAX_RETRIES - 1) console.error(`${provider.name} failed:`, e);
      }
    }
  }
  return null;
}

async function callGemini(content: string, apiKey: string, model: string) {
  const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemInstruction: { role: "system", parts: [{ text: STANDARD_PROMPT }] }, contents: [{ role: "user", parts: [{ text: content }] }], generationConfig: { maxOutputTokens: 300, temperature: 0.2 } }),
  }), TIMEOUT_MS);

  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  return parseJSON(raw);
}

async function callGroq(content: string, apiKey: string, model: string) {
  const res = await withTimeout(fetch("https://api.groq.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: STANDARD_PROMPT }, { role: "user", content }], max_tokens: 300, temperature: 0.2 }),
  }), TIMEOUT_MS);

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  return parseJSON(raw);
}

async function embedVoyage(content: string, key: string) {
  const res = await withTimeout(fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: [content], model: "voyage-3" }),
  }), TIMEOUT_MS);

  if (!res.ok) throw new Error(`Voyage ${res.status}`);
  const data = await res.json();
  return data.data?.[0]?.embedding ?? [];
}

async function embedOpenAI(content: string, key: string) {
  const res = await withTimeout(fetch("https://api.openai.com/v1/embeddings", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: content, model: "text-embedding-3-small" }),
  }), TIMEOUT_MS);

  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return data.data?.[0]?.embedding ?? [];
}

async function embedCohere(content: string, key: string) {
  const res = await withTimeout(fetch("https://api.cohere.ai/v1/embed", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ texts: [content], model: "embed-english-v3-light", embedding_type: "float" }),
  }), TIMEOUT_MS);

  if (!res.ok) throw new Error(`Cohere ${res.status}`);
  const data = await res.json();
  return data.embeddings?.[0]?.embedding ?? [];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return Promise.race([promise, new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), ms);
  })]).finally(() => clearTimeout(timeout));
}

function parseJSON(raw: string) {
  try {
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return {
      summary: p.summary || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
      note_type: typeof p.note_type === "string" ? p.note_type : "other",
      insight: typeof p.insight === "string" ? p.insight : null,
    };
  } catch { return { summary: null, tags: [], note_type: "other", insight: null }; }
}