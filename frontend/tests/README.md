# Testes automatizados (frontend)

Suíte de testes end-to-end com [Playwright](https://playwright.dev/) — roda
o `index.html`/`app.js` reais num navegador, com o Supabase e a API do
backend simulados (nunca chama serviços de verdade). Não faz parte do app
publicado; é ferramenta de desenvolvimento.

## Rodando

```bash
cd frontend/tests
npm install
npx playwright install --with-deps chromium   # só na primeira vez
npm test
```

- `npm run test:headed` — mesma coisa, mas com o navegador visível.
- `npm run test:ui` — abre o modo interativo do Playwright (ótimo pra
  depurar um teste específico).
- `npm run report` — abre o relatório HTML da última execução.

## O que cada arquivo cobre

| Arquivo | O que testa |
|---|---|
| `specs/smoke.spec.js` | O app carrega sem erro de console, estatísticas batem, as 4 abas trocam, manifest/ícones/service worker do PWA estão ok. |
| `specs/functional.spec.js` | Fluxos de uso real: cadastrar/editar/excluir (com desfazer) pneu, busca/filtro/ordenação, pop-out fecha ao clicar fora, seleção de colunas e exportação (.xlsx/PDF). |
| `specs/performance.spec.js` | Tempo até o estoque aparecer na tela, com limites (thresholds) — pego duplicatas, estoque grande (1000 itens) e falha de rede (cache offline). |
| `specs/regressions.spec.js` | Um teste por bug real já corrigido neste projeto (ver comentário no topo de cada `describe`) — existe pra esse bug nunca mais voltar sem ninguém perceber. |

## Como funciona o mock (`helpers/mock-app.js`)

Os testes nunca acessam o Supabase ou o backend real:

- `installCommonMocks(page, opts)` intercepta as chamadas de rede do
  navegador (`page.route`) e responde com dados fictícios em memória —
  simula `GET/POST/PUT/DELETE /api/tires`, `/api/tires/bulk` e
  `/api/history`, além de stubar o `supabase-js` (auth). Aceita
  `writeLatencyMs` (simula round-trip de um backend hospedado longe, tipo
  Render + Supabase) e `apiFail` (simula API fora do ar).
- `buildFakeTires(n, opts)` gera pneus fictícios com marca/medida únicas
  por construção — use `withDuplicates` pra injetar de propósito grupos que
  o app deve reconhecer como duplicados.
- `bootIntoApp(page)` pula a tela de login (não existe sessão de verdade
  nos testes) e entra direto no app.

## Adicionando um teste novo

1. Ache o `describe` mais parecido, ou crie um `specs/*.spec.js` novo.
2. Use `installCommonMocks` + `buildFakeTires` pra montar o cenário —
   evita reescrever a simulação de API em cada teste.
3. Achou um bug de verdade enquanto testava? Depois de corrigir, adicione
   o teste em `regressions.spec.js` explicando no comentário qual bug ele
   evita — é isso que impede o mesmo problema de voltar quieto num PR
   futuro.

## Rodando automaticamente

Roda sozinho em todo push na `master` e em todo PR que mexa em `frontend/`
— ver `.github/workflows/frontend-tests.yml`. Se algum teste falhar, o
relatório HTML fica disponível como artefato do job no GitHub Actions.
