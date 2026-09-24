-- ============================================================================
-- Migration: personalização por conta (nome do sistema e logo do cabeçalho).
-- Cada conta guarda a própria linha; conta sem linha usa o padrão do app
-- ("Estoque de Pneus" + a logo desenhada em CSS). O RLS abaixo garante que
-- uma conta nunca leia nem escreva a personalização de outra.
-- Rode isso uma vez no SQL Editor do Supabase, além do schema.sql e das
-- demais migrations já existentes.
-- ============================================================================

create table if not exists user_settings (
  -- owner_id é a chave primária de propósito: uma linha por conta, e o
  -- upsert do PUT /api/settings resolve o conflito por ela.
  owner_id      uuid primary key references auth.users(id) on delete cascade,
  -- null = usa o nome padrão do app
  app_name      text,
  -- null = usa a logo padrão. Guardada como data URL base64 (a imagem já
  -- chega recortada em 256x256 pelo frontend, alguns KB) — evita ter que
  -- criar e gerenciar um bucket de Storage só pra isso.
  logo_data_url text,
  updated_at    timestamptz not null default now(),

  constraint user_settings_app_name_len
    check (app_name is null or char_length(app_name) between 1 and 40),
  -- teto de segurança no banco, independente do que o frontend mandar:
  -- ~350k caracteres de base64 ≈ 260 KB de imagem.
  constraint user_settings_logo_len
    check (logo_data_url is null or char_length(logo_data_url) <= 350000)
);

alter table user_settings enable row level security;

drop policy if exists user_settings_select_own on user_settings;
create policy user_settings_select_own on user_settings
  for select using (owner_id = auth.uid());

drop policy if exists user_settings_insert_own on user_settings;
create policy user_settings_insert_own on user_settings
  for insert with check (owner_id = auth.uid());

-- insert + update: o upsert do PUT /api/settings passa pelas duas políticas.
drop policy if exists user_settings_update_own on user_settings;
create policy user_settings_update_own on user_settings
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists user_settings_delete_own on user_settings;
create policy user_settings_delete_own on user_settings
  for delete using (owner_id = auth.uid());
