-- ============================================================================
-- Migration: conferência de estoque (presença/ausência física confirmada por
-- item, com data). Rode uma vez no SQL Editor do Supabase, além do
-- schema.sql e das demais migrations já existentes.
-- ============================================================================

alter table tires add column if not exists conferido_status text
  check (conferido_status in ('presente', 'ausente'));
alter table tires add column if not exists conferido_em timestamptz;
