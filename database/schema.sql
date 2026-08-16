-- Schema do banco de dados — Controle de Estoque de Pneus
-- Feito para o Supabase (Postgres). Cole este script no SQL Editor do seu projeto Supabase.

create extension if not exists "pgcrypto";

create table if not exists tires (
  id           uuid primary key default gen_random_uuid(),
  marca        text not null,
  medida       text not null,            -- ex: "185/65 R14"
  quantidade   integer not null default 0,
  preco        text,                      -- opcional, guardado como texto (ex: "350,00")
  condicao     text not null default 'novo' check (condicao in ('novo', 'usado')),
  novo         boolean not null default true,   -- tag "recém-adicionado" (some ao marcar como visto)
  nota_ref     text,                      -- referência da nota fiscal, quando entrada via scanner
  created_at   timestamptz not null default now()
);

create index if not exists idx_tires_medida on tires (medida);
create index if not exists idx_tires_condicao on tires (condicao);

-- Row Level Security
alter table tires enable row level security;

-- Política aberta para começar a desenvolver rápido.
-- ⚠️ Antes de ir para produção com dados reais, troque por uma política
-- que exija autenticação (ex: usando Supabase Auth) em vez de liberar tudo.
create policy "allow all (dev)"
  on tires
  for all
  using (true)
  with check (true);
