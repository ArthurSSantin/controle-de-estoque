# Controle de Estoque de Pneus

Sistema web para controle de estoque de pneus de uma loja, com múltiplas contas isoladas por empresa. Funciona como PWA — pode ser instalado no celular e continua mostrando o último estoque salvo mesmo sem internet.

## Funcionalidades

- Cadastro, edição e exclusão de pneus (marca, medida, quantidade, preço, condição, fornecedor, código de barras), com exclusão reversível ("Desfazer").
- Ordenação automática por aro (R13–R22) ou por quantidade em estoque; busca por marca/medida e filtro por condição (novo/usado).
- Leitura de código de barras pela câmera do celular, tanto pra cadastrar quanto pra conferir um item já existente contra o estoque digital.
- Entrada rápida via XML de nota fiscal (NF-e), com leitura automática de marca, medida, quantidade e valor.
- Importação de planilhas (`.csv`) e relatórios em PDF, com tela de revisão antes de salvar.
- Sincronização com relatórios de estoque de terceiros (PDF/CSV), reconciliando quantidades automaticamente.
- Mesclagem automática de duplicados por marca, medida e condição.
- Exportação do estoque para `.xlsx` ou PDF, com seleção de quais colunas incluir e ordenação automática por medida (largura → perfil → aro).
- Histórico de movimentações (criação, edição, exclusão, entradas e saídas de quantidade) por item, com filtro por pneu e por período.
- Dashboard com gráfico de entradas x saídas de quantidade nos últimos 14 dias.
- Login multiempresa com isolamento de dados por conta (Row Level Security).
- Instalável como PWA (ícone na tela inicial, abre sem barra de navegador) e com Service Worker para a casca do app continuar acessível offline.

## Stack

- **Frontend:** HTML, CSS e JavaScript puro, sem build step. Geração de `.xlsx` (`frontend/xlsx-writer.js` + `frontend/zip-writer.js`), de `.pdf` (`frontend/pdf-writer.js` + `frontend/pdf-table.js`) e leitura de `.csv` (`frontend/csv-parser.js`) implementadas do zero, sem dependência de terceiros. A leitura de relatórios em PDF (import/sincronização) usa `pdf.js` via CDN com Subresource Integrity — só extração de texto, não geração.
- **Backend:** Supabase Edge Function (Deno), sem dependências — roteamento, CORS e acesso ao banco (PostgREST) e à autenticação (GoTrue) feitos direto com `fetch`. Testes em `supabase/tests/` (`node --experimental-strip-types --test supabase/tests/api.test.mjs`).
- **Banco de dados:** Supabase (PostgreSQL) com autenticação e RLS.
- **Testes:** suíte end-to-end com Playwright (`frontend/tests/`), rodando automaticamente em todo push/PR via GitHub Actions.

## Estrutura

```
controle-de-estoque/
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── auth.css
│   ├── auth.js          # login, cadastro e logout via Supabase Auth
│   ├── app.js            # CRUD de pneus, importação, filtros, histórico, dashboard, exportação
│   ├── config.js          # URL da API e chaves públicas do Supabase
│   ├── manifest.json      # manifesto do PWA
│   ├── sw.js              # Service Worker (cache da casca do app)
│   ├── icons/             # ícones do PWA (inclusive o maskable)
│   └── tests/             # suíte de testes end-to-end (Playwright) — ver frontend/tests/README.md
│
├── supabase/
│   └── functions/
│       └── api/
│           └── index.ts  # rotas de pneus e histórico (Edge Function)
│
├── database/
│   ├── schema.sql
│   ├── migration_historico.sql
│   ├── migration_fornecedor.sql
│   └── migration_codigo_barras.sql
│
└── .github/
    └── workflows/
        └── frontend-tests.yml  # roda a suíte de testes em todo push/PR
```

## Como rodar

### 1. Banco de dados

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, rode `database/schema.sql` e, em seguida, as migrations em `database/`.
3. Em **Project Settings → API**, copie a **Project URL** e a **anon key**.

### 2. Backend (Edge Function)

```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF
npx supabase functions deploy api
```

A API fica em `https://SEU_PROJECT_REF.supabase.co/functions/v1/api`.

Pra rodar localmente: `npx supabase start` (sobe o stack via Docker) e depois `npx supabase functions serve api`.

### 3. Frontend

```bash
cd frontend
npx serve .
```

Atualize `frontend/config.js` com a URL da API e as chaves do Supabase.

### 4. Testes (opcional)

```bash
cd frontend/tests
npm install
npx playwright install --with-deps chromium   # só na primeira vez
npm test
```

Detalhes de cada teste em [`frontend/tests/README.md`](frontend/tests/README.md).

## API

| Método | Rota              | Descrição                                                            |
|--------|-------------------|-----------------------------------------------------------------------|
| GET    | `/api/tires`      | lista os pneus                                                        |
| POST   | `/api/tires`      | cria um pneu                                                           |
| POST   | `/api/tires/bulk` | cria vários pneus de uma vez                                          |
| PUT    | `/api/tires/:id`  | atualiza um pneu                                                       |
| DELETE | `/api/tires/:id`  | remove um pneu                                                         |
| GET    | `/api/history`    | histórico de movimentações (`?limit=`, `?tireId=`, `?from=`, `?to=`) |

Todas as rotas exigem um token JWT do Supabase Auth no cabeçalho `Authorization`.

## Segurança

- Autenticação obrigatória em todas as rotas da API.
- Isolamento de dados por conta via Row Level Security no Postgres.
- Validação de entrada na Edge Function, independente do frontend.
- CORS restrito por `ALLOWED_ORIGIN` (secret da function) — configure com o(s) domínio(s) reais do app publicado, sem barra no final.

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](./LICENSE) para mais detalhes.
