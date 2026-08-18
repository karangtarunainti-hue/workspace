// supabase/functions/process/index.ts
// Sekarang bukan lagi dipanggil otomatis dari trigger database — capture sudah
// memproses inline. Function ini dipertahankan sebagai endpoint "proses ulang"
// buat catatan lama yang macet di status raw / gagal diproses (summary null dll).

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
