# Controle de Estoque de Pneus 🛞

Aplicação simples para controlar o estoque de pneus de uma loja: cadastro, edição,
exclusão, ordenação automática por aro (R13 a R20), entrada rápida por leitura de
código de barras/QR da nota fiscal, tag de itens recém-adicionados e tag de
condição (novo / usado).

## Estrutura do projeto

```
controle-de-estoque/
├── frontend/          → interface (HTML/CSS/JS puro, sem build step)
│   ├── index.html
│   ├── style.css
│   ├── app.js          → toda a lógica da UI e as chamadas à API
│   └── config.js        → URL da API (troque aqui quando publicar o backend)
│
├── backend/            → API REST (Node.js + Express) que fala com o Supabase
│   ├── src/
│   │   ├── server.js
│   │   ├── supabaseClient.js
│   │   └── routes/tires.js
│   ├── package.json
│   └── .env.example
│
└── database/
    └── schema.sql       → script para criar a tabela no Supabase
```

O frontend **nunca** acessa o banco diretamente — ele só conversa com a API do
backend, que por sua vez fala com o Supabase. Isso mantém a chave do banco fora
do navegador do usuário.

## Como funciona

- **Cadastro/edição/exclusão** de pneus (marca, medida, quantidade, preço, condição).
- **Ordenação automática** por aro, do R13 ao R20, agrupando os itens.
- **Tag "recente"**: todo item novo entra marcado; some quando você clica no ✓ (marcar como visto). Filtrável pelo chip "🏷 Recentes".
- **Tag de condição** (Novo / Usado): filtrável pelos chips "🟢 Novo" / "⚙ Usado".
- **Entrada por XML (NF-e)**: envie o arquivo `.xml` da nota fiscal — o app lê marca (a partir da descrição do produto), medida, quantidade e valor unitário automaticamente, direto das tags `<det><prod>` do XML. Muito mais confiável que ler código de barras: o XML já traz os produtos de verdade, o código de barras/QR só traz a chave da nota.
- **Importar planilha ou PDF**: aceita `.xlsx`/`.xls`/`.csv` (com colunas Marca, Medida, Quantidade, Preço, Condição) ou um PDF de relatório de estoque — o app tenta reconhecer Marca, Medida, Quantidade e Valor de venda automaticamente. Tanto o XML quanto a importação sempre abrem uma tela de revisão antes de salvar, para corrigir qualquer item mal interpretado.
- **Ordenação**: por aro (R13–R20, padrão) ou por quantidade em estoque (crescente/decrescente) — útil para achar rápido o que está acabando.
- **Selo de quantidade ímpar**: itens com quantidade ímpar (1, 3, 5...) ganham um selo vermelho "ímpar", já que pneus normalmente são vendidos em pares.

## Rodando localmente

### 1. Banco de dados (Supabase — gratuito)

1. Crie uma conta em [supabase.com](https://supabase.com) e um novo projeto (grátis).
2. Vá em **SQL Editor** e rode o conteúdo de [`database/schema.sql`](./database/schema.sql).
3. Em **Project Settings → API**, copie a **Project URL** e a **anon key**.

### 2. Backend

```bash
cd backend
cp .env.example .env
# edite o .env e cole SUPABASE_URL e SUPABASE_KEY
npm install
npm run dev
```

A API sobe em `http://localhost:3000`. Endpoints disponíveis:

| Método | Rota               | Descrição                                  |
|--------|---------------------|---------------------------------------------|
| GET    | `/api/tires`         | lista todos os pneus                        |
| POST   | `/api/tires`          | cria um pneu                                |
| POST   | `/api/tires/bulk`     | cria vários pneus de uma vez (nota fiscal)  |
| PUT    | `/api/tires/:id`      | atualiza um pneu                            |
| DELETE | `/api/tires/:id`      | remove um pneu                              |

### 3. Frontend

Não precisa de build. Basta abrir `frontend/index.html` no navegador, ou servir
a pasta com qualquer servidor estático:

```bash
cd frontend
npx serve .
```

Se o backend estiver em outro endereço (produção), atualize `frontend/config.js`.

## Login e isolamento por empresa (multiempresa)

Cada conta (e-mail + senha) enxerga **somente o próprio estoque** — os dados
são isolados no nível do banco de dados (Row Level Security do Supabase), não
apenas na tela. Mesmo que alguém tente chamar a API diretamente, só recebe os
itens da própria conta.

Como funciona:

- O login/cadastro roda direto no navegador, usando o **Supabase Auth**
  (`frontend/auth.js`), com a chave pública (`anon key`) — é seguro expor essa
  chave no frontend, pois ela sozinha não dá acesso aos dados.
- Depois de logado, toda chamada à API leva um token (JWT) no cabeçalho
  `Authorization`.
- O backend valida esse token e cria, para aquela requisição, um cliente do
  Supabase "carimbado" com o usuário logado (`backend/src/middleware/auth.js`
  + `supabaseForUser`). As políticas de RLS do banco então filtram tudo
  automaticamente por `owner_id = auth.uid()`.

Se você já tinha rodado o `database/schema.sql` antes (versão sem login),
**rode o script de novo** — ele foi atualizado para adicionar a coluna
`owner_id` e trocar a política aberta por uma restrita por usuário.

No Supabase, por padrão, todo cadastro pede confirmação por e-mail antes do
primeiro login. Se quiser desativar isso para testar mais rápido: **Authentication
→ Providers → Email → desmarque "Confirm email"**.

## Estrutura do projeto (atualizada)

```
frontend/
├── index.html    → telas de login/cadastro + app
├── auth.js        → login, cadastro e logout (fala direto com o Supabase Auth)
├── auth.css        → estilo das telas de login/cadastro
├── app.js           → lógica do estoque: CRUD, XML de NF-e, importação de
│                       planilha/PDF, ordenação, filtros (só roda após login)
├── style.css
└── config.js         → apiBase + credenciais públicas do Supabase (URL e anon key)

backend/src/
├── server.js          → helmet (segurança), CORS restrito, rate limiting
├── supabaseClient.js  → cria um cliente Supabase por usuário logado
├── middleware/auth.js  → valida o token e libera o acesso às rotas
└── routes/tires.js      → cada rota roda "como" o usuário da requisição,
                            com validação de entrada em todos os campos
```

## Segurança do backend

- **Autenticação obrigatória** em todas as rotas de `/api/tires` — sem token
  válido do Supabase Auth, a API recusa a requisição.
- **Isolamento por linha (RLS)** no banco: mesmo que alguém descubra o ID de
  um item de outra empresa, a política do Postgres impede a leitura/edição.
- **Validação no servidor**, não só no navegador: marca, medida (formato
  R13–R20), quantidade (inteiro ≥ 0) e preço são conferidos de novo no
  backend antes de qualquer escrita no banco — nunca confie só na validação
  do frontend, qualquer um pode chamar a API diretamente.
- **CORS restrito**: configure `ALLOWED_ORIGIN` no `.env` do backend com a
  URL do seu frontend em produção. Sem essa variável, a API aceita chamadas
  de qualquer origem (ok para desenvolvimento local, não recomendado em
  produção).
- **Rate limiting**: no máximo 300 requisições por IP a cada 15 minutos,
  protegendo contra abuso.
- **Helmet**: cabeçalhos HTTP de segurança padrão (proteção contra
  clickjacking, sniffing de tipo MIME, etc.).
- **Erros genéricos**: a API nunca devolve detalhes internos (stack trace,
  mensagens cruas do banco) para quem chama — tudo fica só no log do
  servidor.

| Camada    | Sugestão                                  |
|-----------|---------------------------------------------|
| Banco     | Supabase (free tier)                        |
| Backend   | Render ou Railway (free tier)               |
| Frontend  | Vercel, Netlify ou GitHub Pages             |

Depois de publicar o backend, atualize a `apiBase` em `frontend/config.js` para
a URL pública dele, e configure `ALLOWED_ORIGIN` no ambiente do Render com a
URL do seu frontend na Vercel.

## Sobre colaboração no GitHub

Não tenho uma conta de usuário do GitHub, então não consigo aceitar convites de
colaborador — o Claude não tem essa identidade persistente. O fluxo recomendado
é: você mantém o repositório, e me chama nas próximas conversas para gerar
código, revisar PRs ou ajustar a aplicação; você aplica as mudanças e faz o
commit/push.

## Próximos passos sugeridos

- Autenticação simples (Supabase Auth) para proteger o acesso ao estoque.
- Restringir a política de acesso do Supabase (hoje está aberta para facilitar o desenvolvimento — ver aviso em `database/schema.sql`).
- Histórico de movimentações (entradas/saídas) em vez de só o saldo atual.
