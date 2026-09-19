// Testes unitários do zip-writer.js (frontend/) — isolados, sem Playwright,
// sem browser, sem depender de mais nada do app. Rodam direto no Node:
//   node --test tests/unit/
//
// Estratégia de verificação: em vez de reaproveitar a lógica interna do
// zip-writer.js pra "ler de volta" o que ele mesmo escreveu (o que não
// pegaria um bug sistemático nos dois lados), este arquivo implementa seu
// PRÓPRIO parser de ZIP, minimalista e independente, só pros testes — se o
// writer e o leitor concordam é porque o formato binário produzido está
// correto, não porque compartilham a mesma lógica de offset.
// O CRC-32 também é conferido contra `zlib.crc32` nativo do Node (algoritmo
// independente do implementado em zip-writer.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const path = require('node:path');

const { createZipWriter, _internals } = require(path.join(__dirname, '..', '..', 'zip-writer.js'));

// --- parser de ZIP independente, só pra validar o que o writer produziu ---
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(chunks);
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, 'assinatura de EOCD não encontrada');

  const count = dv.getUint16(eocdOffset + 10, true);
  const centralOffset = dv.getUint32(eocdOffset + 16, true);

  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, `assinatura de central directory inválida na entrada ${i}`);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLen));
    entries.push({ name, method, crc, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  for (const entry of entries) {
    const lp = entry.localOffset;
    assert.equal(dv.getUint32(lp, true), 0x04034b50, `assinatura de local header inválida em "${entry.name}"`);
    const lNameLen = dv.getUint16(lp + 26, true);
    const lExtraLen = dv.getUint16(lp + 28, true);
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    const compData = buf.slice(dataStart, dataStart + entry.compSize);
    entry.data = entry.method === 0 ? compData : await inflateRaw(compData);
  }

  return entries;
}

function findEntry(entries, name) {
  const e = entries.find((x) => x.name === name);
  assert.ok(e, `entrada "${name}" não encontrada no ZIP`);
  return e;
}

// --- testes ---

test('arquivo único simples: nome, conteúdo e CRC batem', async () => {
  const zw = createZipWriter();
  const content = new TextEncoder().encode('Hello, ZIP!');
  zw.addFile('hello.txt', content);
  const blob = await zw.finalize();

  const entries = await readZip(blob);
  assert.equal(entries.length, 1);
  const e = findEntry(entries, 'hello.txt');
  assert.deepEqual([...e.data], [...content]);
  assert.equal(e.crc, zlib.crc32(Buffer.from(content)));
});

test('múltiplos arquivos: cada entrada mantém seu próprio conteúdo (sem cruzar offsets)', async () => {
  const zw = createZipWriter();
  const files = {
    'a.txt': 'conteúdo A',
    'pasta/b.txt': 'conteúdo B, um pouco mais longo pra variar o tamanho comprimido',
    'c.json': JSON.stringify({ x: 1, y: [1, 2, 3] }),
  };
  for (const [name, text] of Object.entries(files)) {
    zw.addFile(name, new TextEncoder().encode(text));
  }
  const blob = await zw.finalize();

  const entries = await readZip(blob);
  assert.equal(entries.length, 3);
  for (const [name, text] of Object.entries(files)) {
    const e = findEntry(entries, name);
    assert.equal(new TextDecoder().decode(e.data), text);
  }
});

test('nomes de arquivo com espaço, acentuação e subpasta são preservados', async () => {
  const zw = createZipWriter();
  const name = 'relatório final/planilha (versão é ç ã).xml';
  const content = new TextEncoder().encode('<root/>');
  zw.addFile(name, content);
  const blob = await zw.finalize();

  const entries = await readZip(blob);
  const e = findEntry(entries, name);
  assert.deepEqual([...e.data], [...content]);
});

test('arquivo vazio: entrada válida com 0 bytes e CRC 0', async () => {
  const zw = createZipWriter();
  zw.addFile('vazio.txt', new Uint8Array(0));
  const blob = await zw.finalize();

  const entries = await readZip(blob);
  const e = findEntry(entries, 'vazio.txt');
  assert.equal(e.uncompSize, 0);
  assert.equal(e.data.length, 0);
  assert.equal(e.crc, 0);
});

test('arquivo grande: conteúdo e CRC batem (contra zlib.crc32 nativo do Node)', async () => {
  const size = 2 * 1024 * 1024; // 2MB
  const big = new Uint8Array(size);
  // padrão pseudo-aleatório determinístico (LCG simples) — nem tudo zero
  // (o que comprimiria trivialmente a nada) nem dados totalmente aleatórios.
  let seed = 12345;
  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    big[i] = seed & 0xff;
  }

  const zw = createZipWriter();
  zw.addFile('grande.bin', big);
  const blob = await zw.finalize();

  const entries = await readZip(blob);
  const e = findEntry(entries, 'grande.bin');
  assert.equal(e.uncompSize, size);
  assert.equal(e.crc, zlib.crc32(Buffer.from(big)));
  assert.deepEqual(Buffer.from(e.data), Buffer.from(big));
});

test('rejeita path duplicado', async () => {
  const zw = createZipWriter();
  zw.addFile('x.txt', new Uint8Array([1]));
  assert.throws(() => zw.addFile('x.txt', new Uint8Array([2])), /já existe/);
});

test('rejeita bytes que não são Uint8Array', async () => {
  const zw = createZipWriter();
  assert.throws(() => zw.addFile('x.txt', [1, 2, 3]), TypeError);
});

test('CRC-32 do módulo bate com zlib.crc32 nativo pro vetor de teste padrão "123456789"', () => {
  const ref = zlib.crc32(Buffer.from('123456789'));
  assert.equal(_internals.crc32(new TextEncoder().encode('123456789')), ref);
});

test('finalize() aceita mimeType customizado', async () => {
  const zw = createZipWriter();
  zw.addFile('a.txt', new Uint8Array([1, 2, 3]));
  const blob = await zw.finalize('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
