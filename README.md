# Controle de Estoque de Pneus

Sistema web para controle de estoque de pneus de uma loja, com múltiplas contas isoladas por empresa.

## Funcionalidades

- Cadastro, edição e exclusão de pneus (marca, medida, quantidade, preço, condição, fornecedor, código de barras).
- Ordenação automática por aro (R13–R20) ou por quantidade em estoque.
- Entrada rápida via XML de nota fiscal (NF-e), com leitura automática de marca, medida, quantidade e valor.
- Importação de planilhas (`.xlsx`/`.xls`/`.csv`) e relatórios em PDF, com tela de revisão antes de salvar.
- Sincronização com relatórios de estoque de terceiros (PDF/Excel), reconciliando quantidades automaticamente.
- Mesclagem automática de duplicados por marca, medida e condição.
- Histórico de movimentações (criação, edição e exclusão) por item.
- Login multiempresa com isolamento de dados por conta (Row Level Security).

## Stack

- **Frontend:** HTML, CSS e JavaScript puro, sem build step.
- **Backend:** Node.js + Express.
- **Banco de dados:** Supabase (PostgreSQL) com autenticação e RLS.

## Estrutura

```
controle-de-estoque/
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── auth.css
│   ├── auth.js         # login, cadastro e logout via Supabase Auth
│   ├── app.js           # CRUD de pneus, importação, filtros e histórico
│   └── config.js         # URL da API e chaves públicas do Supabase
│
├── backend/
│   ├── src/
│   │   ├── server.js
│   │   ├── supabaseClient.js
│   │   ├── middleware/auth.js
│   │   └── routes/
│   │       ├── tires.js
│   │       └── history.js
│   ├── package.json
│   └── .env.example
│
└── database/
    ├── schema.sql
    ├── migration_historico.sql
    ├── migration_fornecedor.sql
    └── migration_codigo_barras.sql
```

## Como rodar

### 1. Banco de dados

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, rode `database/schema.sql` e, em seguida, as migrations em `database/`.
3. Em **Project Settings → API**, copie a **Project URL** e a **anon key**.

### 2. Backend

```bash
cd backend
cp .env.example .env   # preencha SUPABASE_URL e SUPABASE_KEY
npm install
npm run dev
```

A API sobe em `http://localhost:3000`.

### 3. Frontend

```bash
cd frontend
npx serve .
```

Atualize `frontend/config.js` com a URL da API e as chaves do Supabase.

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
- Validação de entrada no backend, independente do frontend.
- CORS restrito por `ALLOWED_ORIGIN`, rate limiting e headers de segurança via Helmet.

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](./LICENSE) para mais detalhes.
