-- ============================================================================
-- Migration: código de barras (da etiqueta física do pneu, de fábrica/nota)
-- por linha de estoque. Rode uma vez no SQL Editor do Supabase, além do
-- schema.sql já existente.
-- ============================================================================

alter table tires add column if not exists codigo_barras text;

-- Evita cadastrar o mesmo código de barras em duas linhas do mesmo usuário
-- (null é permitido em qualquer quantidade — só bloqueia duplicata real).
create unique index if not exists idx_tires_owner_codigo_barras
  on tires (owner_id, codigo_barras)
  where codigo_barras is not null;
