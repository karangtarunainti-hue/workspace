# Upgrade opsional: AI kasih "insight" (masukan & pengembangan ide)

Fitur Second Brain di `index.html` sudah jalan penuh pakai edge function `capture`,
`ask`, dan tabel `notes` yang sudah ada di project Supabase `wbijzttvsvodcztjpxyf`.

Paket ini nambahin satu hal spesifik yang kamu minta: **AI bukan cuma meringkas &
kasih tag, tapi juga ngembangin ide-nya dan kasih saran langkah berikutnya** —
disimpan di kolom baru `insight`, ditampilkan di kartu catatan sebagai
"💡 Masukan AI".

## Cara deploy
1. Jalankan migration:
   ```bash
   supabase db push
   # atau jalankan isi supabase/migrations/0003_add_insight.sql lewat SQL editor
   ```
2. Deploy ulang function `process`:
   ```bash
   supabase functions deploy process
   ```

Tanpa langkah ini, fitur Second Brain tetap jalan normal (capture, ringkasan, tag,
tanya-jawab semantic, related notes by tag) — cuma kolom "Masukan AI" gak muncul
karena datanya belum ada.
