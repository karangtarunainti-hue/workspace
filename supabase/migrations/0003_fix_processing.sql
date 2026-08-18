-- Perbaikan arsitektur: capture sekarang memproses AI langsung di dalam function-nya
-- sendiri (lihat supabase/functions/capture/index.ts), jadi trigger database yang
-- lama (notes_after_insert -> trigger_process_note -> net.http_post ke /process)
-- sudah tidak dipakai lagi. Trigger itu jadi sumber utama kenapa catatan macet di
-- status 'raw': dia bergantung pada setting `app.settings.service_role_key` yang
-- gampang belum ke-set, dan gagalnya senyap (nggak kelihatan di browser).

drop trigger if exists notes_after_insert on notes;
drop function if exists trigger_process_note();

-- Kolom baru: masukan/pengembangan ide dari AI (bukan cuma ringkasan+tag).
alter table notes add column if not exists insight text;
