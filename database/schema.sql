-- Schema do banco de dados — Controle de Estoque de Pneus
-- Feito para o Supabase (Postgres). Cole este script no SQL Editor do seu projeto Supabase.

-- Schema do banco de dados — Controle de Estoque de Pneus (multiempresa)
-- Feito para o Supabase (Postgres). Cole este script no SQL Editor do seu projeto Supabase.
-- Se você já rodou a versão anterior deste script, rode este de novo por cima —
-- ele adiciona a coluna que faltava e troca a política de acesso.

create extension if not exists "pgcrypto";

create table if not exists tires (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) default auth.uid(),
  marca        text not null,
  medida       text not null,            -- ex: "185/65 R14"
  quantidade   integer not null default 0,
  preco        text,                      -- opcional, guardado como texto (ex: "350,00")
  condicao     text not null default 'novo' check (condicao in ('novo', 'usado')),
  novo         boolean not null default true,   -- tag "recém-adicionado" (some ao marcar como visto)
  nota_ref     text,                      -- referência da nota fiscal, quando entrada via scanner
  created_at   timestamptz not null default now()
);

-- Se a tabela já existia sem a coluna owner_id, esta linha adiciona:
alter table tires add column if not exists owner_id uuid references auth.users(id);

create index if not exists idx_tires_medida on tires (medida);
create index if not exists idx_tires_condicao on tires (condicao);
create index if not exists idx_tires_owner on tires (owner_id);

-- Row Level Security: cada empresa (usuário logado) só enxerga o próprio estoque.
alter table tires enable row level security;

drop policy if exists "allow all (dev)" on tires;
drop policy if exists "tires_select_own" on tires;
drop policy if exists "tires_insert_own" on tires;
drop policy if exists "tires_update_own" on tires;
drop policy if exists "tires_delete_own" on tires;

create policy "tires_select_own" on tires
  for select using (auth.uid() = owner_id);

create policy "tires_insert_own" on tires
  for insert with check (auth.uid() = owner_id);

create policy "tires_update_own" on tires
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy "tires_delete_own" on tires
  for delete using (auth.uid() = owner_id);

