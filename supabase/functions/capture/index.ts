// supabase/functions/capture/index.ts
// Simpan catatan mentah, LANGSUNG diproses AI di function yang sama (summary, tag,
// insight, embedding), baru dibalikin ke client. Nggak bergantung ke trigger DB /
// pg_net / setting service_role_key lagi -> jauh lebih gampang didiagnosis.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateNoteInsights, embedText } from "../_shared/ai.ts";

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
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    const source = typeof body?.source === "string" ? body.source : "web";
    if (!content) return json({ error: "content kosong" }, 400);

    // 1. Simpan dulu sebagai raw, biar nggak hilang kalau AI lambat/gagal.
    const { data: inserted, error: insertErr } = await supabase
      .from("notes")
      .insert({ user_id: userData.user.id, content, source, status: "raw" })
      .select("id, created_at")
      .single();
    if (insertErr) return json({ error: `Gagal simpan: ${insertErr.message}` }, 500);

    // 2. Proses AI inline (nggak lempar exception walau semua provider gagal).
    const [insights, embedding] = await Promise.all([
      generateNoteInsights(content),
      embedText(content),
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
      .eq("id", inserted.id)
      .select("*")
      .single();

    if (updateErr) {
      // Catatan aslinya sudah aman tersimpan (status raw) walau update gagal.
      return json({ ok: true, id: inserted.id, warning: `Tersimpan tapi gagal update hasil AI: ${updateErr.message}` });
    }

    return json({ ok: true, note: updated });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
