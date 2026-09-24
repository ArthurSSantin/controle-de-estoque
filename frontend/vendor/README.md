# Bibliotecas de terceiros vendorizadas

Arquivos de terceiros servidos pela **própria origem do app**. Nada aqui é
baixado de CDN em tempo de execução — o app funciona sem acesso a nenhum
domínio externo.

Não edite estes arquivos à mão. Para trocar de versão, siga o procedimento
no fim desta página.

## O que tem aqui

| Arquivo | Versão | Para que serve |
|---|---|---|
| `pdf.min.js` | pdf.js 3.11.174 | **Leitura** de relatório em PDF (importação e sincronização com o relatório da empresa). Carregado sob demanda, só quando o usuário abre a importação — ver `ensurePdfJs()` em `app.js`. |
| `pdf.worker.min.js` | pdf.js 3.11.174 | Worker do pdf.js, exigido por ele para processar o PDF fora da thread principal. Apontado por `PDFJS_WORKER_SRC` em `app.js`. |

A **geração** de PDF (exportar estoque) não usa nada disso: é
`pdf-writer.js` + `pdf-table.js`, implementados neste projeto. O mesmo vale
para `.xlsx` (`xlsx-writer.js` + `zip-writer.js`), leitura de `.csv`
(`csv-parser.js`), leitura de códigos de barras (`code-reader.js`) e
autenticação (`auth-client.js`).

## Integridade

SHA-384 dos arquivos exatos que estão nesta pasta, em base64 (o mesmo
formato do atributo `integrity` do HTML):

```
pdf.min.js         sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e
pdf.worker.min.js  sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2
```

Conferir a qualquer momento:

```bash
cd frontend/vendor
openssl dgst -sha384 -binary pdf.min.js        | openssl base64 -A; echo
openssl dgst -sha384 -binary pdf.worker.min.js | openssl base64 -A; echo
```

Estes hashes são **documentação e conferência manual**, não uma verificação
em tempo de execução: o app não checa o hash antes de carregar, e não deve
mesmo. SRI existe para proteger contra um servidor de terceiro adulterado, e
não há mais terceiro no caminho — quem conseguisse trocar um arquivo desta
pasta já poderia trocar o `app.js` ao lado, tornando a checagem inútil.

## Como atualizar a versão

1. Baixe os dois arquivos da versão nova (cdnjs ou o release oficial do
   pdf.js — as duas fontes publicam os mesmos binários).
2. Calcule o SHA-384 dos arquivos baixados com o comando acima e **compare
   com o hash publicado pela fonte** antes de substituir o que está aqui.
3. Substitua os arquivos, atualize a versão e os hashes nesta página.
4. Suba o `CACHE_VERSION` em `frontend/sw.js` — senão quem já tem o app
   instalado continua com a versão antiga em cache.
5. Rode a suíte (`cd frontend/tests && npm test`). O teste
   `specs/pdf-report.spec.js` lê um PDF de verdade com o pdf.js desta pasta,
   então ele pega uma atualização quebrada.
