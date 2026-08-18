// supabase/functions/ask/index.ts
// User nanya -> embed pertanyaan (provider sama kayak yang dipakai buat notes,
// biar ruang embeddingnya konsisten) -> cari notes relevan lewat match_notes ->
// AI jawab pakai context itu (fallback gemini/groq, sama seperti capture).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedText, generateAnswer } from "../_shared/ai.ts";

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
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "question wajib diisi" }, 400);

    const queryEmbedding = await embedText(question);
    let matches: any[] = [];
    if (queryEmbedding) {
      const { data, error: matchErr } = await supabase.rpc("match_notes", {
        query_embedding: queryEmbedding,
        match_user_id: userData.user.id,
        match_count: 6,
      });
      if (matchErr) return json({ error: `match_notes gagal: ${matchErr.message}` }, 500);
      matches = data ?? [];
    }

    if (!matches.length) {
      return json({
        answer: "Belum ada catatan yang cukup relevan buat jawab ini — atau semua provider embedding lagi gagal. Coba catat dulu beberapa ide.",
        sources: [],
      });
    }

    const context = matches.map((m: any, i: number) => `[${i + 1}] ${m.summary ?? m.content}`).join("\n");
    const answer = await generateAnswer(question, context);

    return json({ answer, sources: matches });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
