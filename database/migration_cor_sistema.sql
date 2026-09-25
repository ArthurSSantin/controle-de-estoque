-- ============================================================================
-- Migration: cor do sistema por conta (Configurações → Personalização do
-- sistema). Rode depois de migration_personalizacao.sql, uma vez, no SQL
-- Editor do Supabase. Conta sem cor (null) usa o vermelho padrão do app.
-- ============================================================================

alter table user_settings add column if not exists accent_color text;

alter table user_settings drop constraint if exists user_settings_accent_color_fmt;
alter table user_settings add constraint user_settings_accent_color_fmt
  check (accent_color is null or accent_color ~ '^#[0-9a-f]{6}$');
