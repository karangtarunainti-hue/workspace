# Cara pasang perbaikan ini

## 1. Jalankan migration
Lewat SQL Editor di Supabase Dashboard (project `wbijzttvsvodcztjpxyf`), jalankan isi
`supabase/migrations/0003_fix_processing.sql`. Ini akan:
- Matikan trigger lama yang rapuh (`notes_after_insert` / `trigger_process_note`)
- Tambah kolom `insight` di tabel `notes`

## 2. Deploy ulang 3 edge function
```bash
supabase functions deploy capture
supabase functions deploy process
supabase functions deploy ask
```
(function `_shared/ai.ts` ikut ke-deploy otomatis karena di-import oleh ketiganya)

## 3. Ganti index.html dashboard
Timpa `index.html` yang lama dengan yang baru di paket ini.

## Apa yang berubah & kenapa
- **Akar masalah 400 & catatan macet "sedang diproses"**: nama model Groq yang
  dipakai sebagai fallback (`qwen2.5-32b-chat`) tidak valid, jadi tiap kali Gemini
  gagal/limit, fallback ke Groq langsung ditolak (400). Sudah diganti ke
  `llama-3.3-70b-versatile` / `llama-3.1-8b-instant` yang valid.
- **Capture sekarang memproses AI langsung di function yang sama** (summary, tag,
  insight, embedding), bukan lewat trigger database yang manggil `net.http_post`.
  Trigger itu butuh setting `app.settings.service_role_key` di Postgres yang kalau
  belum di-set, gagalnya senyap — persis gejala yang kamu alami (`raw` selamanya).
  Sekarang errornya langsung kebalikin ke browser kalau ada masalah.
- **`ask` sekarang embed pertanyaan pakai provider yang sama** dengan yang dipakai
  buat notes (voyage → openai → cohere, urutan sama persis), supaya pencarian
  semantic-nya nggak asal karena beda "ruang" embedding.
- **Prompt AI dipaksa JSON mode** (`responseMimeType`/`response_format`) di kedua
  provider supaya parsing hasilnya nggak gampang gagal.
- **Tombol "Proses ulang"** muncul otomatis di kartu catatan yang kadung macet dari
  sebelumnya (status `raw` atau `processed` tapi `summary` kosong) — klik buat
  benerin catatan lama tanpa harus hapus & catat ulang.
