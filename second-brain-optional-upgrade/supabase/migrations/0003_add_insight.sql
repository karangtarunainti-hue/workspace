-- Opsional: tambah kolom "insight" — masukan/pengembangan dari AI atas ide yang dicatat,
-- termasuk saran langkah lanjutan. Dipakai oleh process/index.ts versi upgrade.

alter table notes add column if not exists insight text;
