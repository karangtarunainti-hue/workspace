# Cara pasang perbaikan ini (versi standalone, lewat Dashboard)

Paket ini beda dari sebelumnya: `_shared/ai.ts` sudah **digabung langsung** ke
dalam masing-masing `capture/index.ts`, `process/index.ts`, dan `ask/index.ts`.
Nggak ada lagi import lintas folder — jadi aman dideploy satu-satu lewat
Supabase Dashboard (Edge Functions → Deploy new function / update function),
yang memang cuma ngirim isi satu file, bukan seluruh folder `supabase/functions`.

## 1. Jalankan migration
Lewat SQL Editor di Supabase Dashboard (project `wbijzttvsvodcztjpxyf`), jalankan isi
`supabase/migrations/0003_fix_processing.sql`.

## 2. Deploy ulang 3 edge function lewat Dashboard
Untuk masing-masing function (`capture`, `process`, `ask`):
- Buka Edge Functions di Dashboard
- Pilih function-nya (atau bikin baru kalau belum ada)
- Timpa isi `index.ts` dengan isi file yang sama namanya di paket ini
- Deploy

Tidak perlu upload folder `_shared` lagi — sudah tidak dipakai oleh ketiga
function ini.

## 3. Ganti index.html dashboard
Timpa `index.html` yang lama dengan yang baru di paket ini.

## Kenapa error "_shared/ai.ts" kemarin muncul
Deploy lewat Dashboard cuma mengirim file function yang kamu paste/upload —
tidak ikut membawa folder `_shared` yang ada di level atas `supabase/functions/`.
Jadi saat bundler nyari `../_shared/ai.ts`, filenya nggak ada di server.
Solusinya di paket ini: kode `ai.ts` digandakan (inline) ke masing-masing
function, jadi tiap function nggak butuh file lain sama sekali.

Kalau nanti mau deploy pakai Supabase CLI (`supabase functions deploy ...`)
dari root project, folder `_shared` yang asli (dengan import relatif) juga
tetap jalan — CLI ikut membundel seluruh `supabase/functions/`. Tapi versi
inline di paket ini tetap aman dipakai di kedua cara deploy.
