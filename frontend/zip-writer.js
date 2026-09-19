/**
 * Escritor de ZIP mínimo, sem nenhuma dependência externa — camada baixa
 * usada pelo gerador de .xlsx (um arquivo .xlsx é um ZIP com XML dentro).
 *
 * Rodapé de decisões de design (leia antes de estender este módulo):
 *
 * - SEM streaming de entrada: addFile() recebe o arquivo inteiro em memória
 *   de uma vez (Uint8Array), não um stream. Isso é suficiente pro caso de
 *   uso (planilhas pequenas geradas pelo próprio app) e simplifica bastante
 *   o writer: como o tamanho comprimido só é conhecido DEPOIS de comprimir,
 *   ter os bytes completos em mãos evita precisar do mecanismo de "data
 *   descriptor" do formato ZIP (flag bit 3), que existe justamente pra
 *   quando o tamanho não é conhecido de antemão. Local file header aqui já
 *   sai com crc/tamanhos definitivos.
 *
 * - SEM ZIP64: os campos de tamanho/offset são de 32 bits (limite ~4GB por
 *   entrada e no total) e o de contagem de entradas é de 16 bits (65535).
 *   finalize() lança erro explícito se esses limites forem estourados, em
 *   vez de gerar silenciosamente um arquivo corrompido. Pro caso de uso
 *   (planilha de estoque) isso nunca deveria disparar; se um dia precisar
 *   de ZIP64, é a extensão mais provável deste módulo.
 *
 * - Compressão via `CompressionStream('deflate-raw')`, nativa do browser
 *   (e do Node 18+) — decide UMA VEZ por finalize() se a API está
 *   disponível; se não estiver (ambiente muito antigo) ou se comprimir uma
 *   entrada específica falhar por qualquer motivo, cai pro método STORE
 *   (sem compressão, method=0) só pra aquela entrada. Um ZIP com entradas
 *   STORE é 100% válido — só maior.
 *
 * - Nomes de arquivo sempre com a flag EFS (bit 11 do "general purpose bit
 *   flag") ligada, dizendo ao leitor de ZIP "isto é UTF-8". Como qualquer
 *   nome ASCII também é UTF-8 válido, ligar essa flag sempre é seguro e
 *   evita ter que decidir caso a caso — cobre nomes com acento/caracteres
 *   especiais sem lógica extra.
 *
 * - Caminho duplicado (dois addFile com o mesmo `path`) lança erro em vez
 *   de silenciosamente sobrescrever ou duplicar a entrada — ferramentas de
 *   ZIP divergem sobre qual delas "vale", então preferimos falhar cedo.
 *
 * - `finalize(mimeType)` aceita um mimeType opcional (default
 *   'application/zip') pra quem for empacotar um formato específico (ex: a
 *   camada de OOXML/.xlsx) poder pedir o Blob já com o content-type certo,
 *   sem precisar reembrulhar o Blob depois.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ZipWriter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const VERSION = 20; // 2.0 — suficiente pra deflate; nenhum recurso mais novo é usado
  const FLAG_UTF8 = 0x0800;
  const METHOD_STORE = 0;
  const METHOD_DEFLATE = 8;

  const MAX_UINT16 = 0xffff;
  const MAX_UINT32 = 0xffffffff;

  // --- CRC-32 (polinômio padrão 0xEDB88320 — o mesmo do zlib/PNG/todo mundo) ---
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // --- Data/hora no formato MS-DOS que o ZIP usa (bit-packing padrão do formato) ---
  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
      ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
    return { dosTime, dosDate };
  }

  async function deflateRaw(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    // não precisa esperar o write() — o close() já enfileira depois dele,
    // e é o reader abaixo que efetivamente drena o stream.
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
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

  const canDeflate = typeof CompressionStream !== 'undefined';

  async function compressEntry(bytes) {
    if (canDeflate) {
      try {
        return { method: METHOD_DEFLATE, data: await deflateRaw(bytes) };
      } catch (err) {
        // Ambiente diz suportar CompressionStream mas falhou nessa entrada
        // específica — não é motivo pra falhar o ZIP inteiro, só guarda sem
        // compressão.
      }
    }
    return { method: METHOD_STORE, data: bytes };
  }

  function u16(view, offset, value) {
    view.setUint16(offset, value, true);
  }
  function u32(view, offset, value) {
    view.setUint32(offset, value, true);
  }

  function buildLocalHeader(entry) {
    const buf = new ArrayBuffer(30);
    const view = new DataView(buf);
    u32(view, 0, SIG_LOCAL);
    u16(view, 4, VERSION);
    u16(view, 6, FLAG_UTF8);
    u16(view, 8, entry.method);
    u16(view, 10, entry.dosTime);
    u16(view, 12, entry.dosDate);
    u32(view, 14, entry.crc);
    u32(view, 18, entry.compData.length);
    u32(view, 22, entry.uncompSize);
    u16(view, 26, entry.nameBytes.length);
    u16(view, 28, 0); // extra field length
    return new Uint8Array(buf);
  }

  function buildCentralHeader(entry) {
    const buf = new ArrayBuffer(46);
    const view = new DataView(buf);
    u32(view, 0, SIG_CENTRAL);
    u16(view, 4, VERSION); // version made by
    u16(view, 6, VERSION); // version needed to extract
    u16(view, 8, FLAG_UTF8);
    u16(view, 10, entry.method);
    u16(view, 12, entry.dosTime);
    u16(view, 14, entry.dosDate);
    u32(view, 16, entry.crc);
    u32(view, 20, entry.compData.length);
    u32(view, 24, entry.uncompSize);
    u16(view, 28, entry.nameBytes.length);
    u16(view, 30, 0); // extra field length
    u16(view, 32, 0); // file comment length
    u16(view, 34, 0); // disk number start
    u16(view, 36, 0); // internal file attributes
    u32(view, 38, 0); // external file attributes
    u32(view, 42, entry.localOffset);
    return new Uint8Array(buf);
  }

  function buildEOCD(count, centralDirSize, centralDirOffset) {
    const buf = new ArrayBuffer(22);
    const view = new DataView(buf);
    u32(view, 0, SIG_EOCD);
    u16(view, 4, 0); // número deste disco
    u16(view, 6, 0); // disco onde o central directory começa
    u16(view, 8, count); // entradas do central directory neste disco
    u16(view, 10, count); // total de entradas do central directory
    u32(view, 12, centralDirSize);
    u32(view, 16, centralDirOffset);
    u16(view, 20, 0); // tamanho do comentário
    return new Uint8Array(buf);
  }

  function assertUint32(value, what) {
    if (value > MAX_UINT32) {
      throw new Error(`${what} excede o limite de ZIP sem ZIP64 (4GB): ${value} bytes.`);
    }
  }

  function createZipWriter() {
    const files = []; // [{ path, bytes }]
    const seenPaths = new Set();

    function addFile(path, bytes) {
      if (typeof path !== 'string' || !path) {
        throw new TypeError('addFile: "path" precisa ser uma string não vazia.');
      }
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('addFile: "bytes" precisa ser um Uint8Array.');
      }
      if (seenPaths.has(path)) {
        throw new Error(`addFile: já existe uma entrada com o caminho "${path}".`);
      }
      seenPaths.add(path);
      files.push({ path, bytes });
    }

    async function finalize(mimeType) {
      if (files.length > MAX_UINT16) {
        throw new Error(`finalize: ${files.length} arquivos excede o limite de ZIP sem ZIP64 (65535 entradas).`);
      }

      const encoder = new TextEncoder();
      const now = new Date();
      const { dosTime, dosDate } = dosDateTime(now);

      // Comprime todas as entradas em paralelo — cada CompressionStream é
      // independente, e a ordem de saída é reestabelecida depois pelo
      // índice original (Promise.all preserva a ordem do array de entrada).
      const compressed = await Promise.all(
        files.map(async (f) => {
          const { method, data } = await compressEntry(f.bytes);
          return {
            nameBytes: encoder.encode(f.path),
            method,
            compData: data,
            uncompSize: f.bytes.length,
            crc: crc32(f.bytes),
            dosTime,
            dosDate,
          };
        })
      );

      compressed.forEach((entry) => {
        assertUint32(entry.compData.length, `Tamanho comprimido de "${entry.nameBytes}"`);
        assertUint32(entry.uncompSize, `Tamanho de "${entry.nameBytes}"`);
      });

      const parts = [];
      let offset = 0;
      const localOffsets = [];

      compressed.forEach((entry) => {
        localOffsets.push(offset);
        const header = buildLocalHeader(entry);
        parts.push(header, entry.nameBytes, entry.compData);
        offset += header.length + entry.nameBytes.length + entry.compData.length;
      });

      assertUint32(offset, 'Deslocamento do central directory');
      const centralDirOffset = offset;

      let centralDirSize = 0;
      compressed.forEach((entry, i) => {
        const central = buildCentralHeader({ ...entry, localOffset: localOffsets[i] });
        parts.push(central, entry.nameBytes);
        centralDirSize += central.length + entry.nameBytes.length;
      });

      parts.push(buildEOCD(compressed.length, centralDirSize, centralDirOffset));

      return new Blob(parts, { type: mimeType || 'application/zip' });
    }

    return { addFile, finalize };
  }

  return { createZipWriter, _internals: { crc32, dosDateTime, canDeflate } };
});
