-- ============================================================================
-- Migration: campo "fornecedor" nos pneus.
-- Rode uma vez no SQL Editor do Supabase, além do schema.sql já existente.
-- ============================================================================

alter table tires add column if not exists fornecedor text;
