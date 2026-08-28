-- ============================================================================
-- Migration: histórico de movimentações (entradas/saídas de quantidade,
-- exclusões de item e edições de preço/marca/medida).
-- Rode isso uma vez no SQL Editor do Supabase, além do schema.sql já existente.
-- ============================================================================

create table if not exists tire_history (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- tire_id não tem FK para "tires" de propósito: quando o item é excluído,
  -- o histórico da exclusão precisa continuar existindo mesmo sem o item.
  tire_id uuid,
  marca text not null,
  medida text not null,
  condicao text not null,
  acao text not null check (acao in ('criado', 'editado', 'excluido', 'entrada', 'saida')),
  -- campo alterado, só usado quando acao = 'editado' (ex: 'marca', 'medida', 'preco')
  campo text,
  valor_anterior text,
  valor_novo text,
  created_at timestamptz not null default now()
);

create index if not exists tire_history_owner_created_idx
  on tire_history (owner_id, created_at desc);

alter table tire_history enable row level security;

drop policy if exists tire_history_select_own on tire_history;
create policy tire_history_select_own on tire_history
  for select using (owner_id = auth.uid());

drop policy if exists tire_history_insert_own on tire_history;
create policy tire_history_insert_own on tire_history
  for insert with check (owner_id = auth.uid());

-- Sem policy de update/delete: o histórico é só de leitura e inserção —
-- ninguém deve poder editar ou apagar um registro do log depois de criado.
