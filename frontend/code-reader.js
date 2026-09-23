// Leitor próprio de QR code e de códigos de barras 1D (EAN-13, UPC-A, EAN-8,
// Code 128, Code 39) — sem biblioteca de terceiros. O app usa quando o
// navegador não tem a BarcodeDetector API nativa (iPhone/Safari, Firefox).
//
// Entrada: pixels RGBA (ImageData.data), largura e altura.
// Saída: { format, text } ou null.
//
// Algoritmos seguem a ISO/IEC 18004 (QR) e as especificações GS1/ISO dos
// códigos 1D: binarização adaptativa por blocos, localização dos três
// padrões localizadores pela razão 1:1:3:1:1, homografia de 4 pontos
// (3 localizadores + padrão de alinhamento), leitura das informações de
// formato/versão por distância de Hamming, correção de erros Reed-Solomon
// sobre GF(256) (Berlekamp-Massey + Chien + Forney) e decodificação dos
// modos numérico, alfanumérico, byte, kanji e ECI.
(function (global) {
  'use strict';

  /* ======================================================================
     Imagem
  ====================================================================== */

  function toLuminance(rgba, width, height) {
    const n = width * height;
    const lum = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      lum[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
    return lum;
  }

  function downscale2(lum, w, h) {
    const W = w >> 1;
    const H = h >> 1;
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const r0 = 2 * y * w;
      const r1 = r0 + w;
      for (let x = 0; x < W; x++) {
        const c = 2 * x;
        out[y * W + x] = (lum[r0 + c] + lum[r0 + c + 1] + lum[r1 + c] + lum[r1 + c + 1] + 2) >> 2;
      }
    }
    return { lum: out, w: W, h: H };
  }

  function otsuThreshold(values, start, end, stride) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = start; i < end; i += stride) {
      hist[values[i]]++;
      n++;
    }
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let bestT = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        bestT = t;
      }
    }
    return bestT;
  }

  // Binarização adaptativa: limiar por bloco de 8x8 a partir da média local,
  // suavizado pela vizinhança 5x5 de blocos. Aguenta sombra e iluminação
  // desigual, que é o normal numa foto de etiqueta. 1 = preto.
  function binarize(lum, w, h) {
    const out = new Uint8Array(w * h);
    if (w < 40 || h < 40) {
      const t = otsuThreshold(lum, 0, lum.length, 1);
      for (let i = 0; i < lum.length; i++) out[i] = lum[i] <= t ? 1 : 0;
      return out;
    }
    const B = 8;
    const bw = Math.ceil(w / B);
    const bh = Math.ceil(h / B);
    const black = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      const y0 = Math.min(by * B, h - B);
      for (let bx = 0; bx < bw; bx++) {
        const x0 = Math.min(bx * B, w - B);
        let sum = 0;
        let min = 255;
        let max = 0;
        for (let y = y0; y < y0 + B; y++) {
          const row = y * w;
          for (let x = x0; x < x0 + B; x++) {
            const v = lum[row + x];
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }
        let avg = sum / (B * B);
        if (max - min <= 24) {
          // bloco sem contraste (fundo liso): assume branco, a não ser que os
          // vizinhos já indiquem que estamos numa área escura
          avg = min / 2;
          if (by > 0 && bx > 0) {
            const nb = (black[(by - 1) * bw + bx] + 2 * black[by * bw + bx - 1] + black[(by - 1) * bw + bx - 1]) / 4;
            if (min < nb) avg = nb;
          }
        }
        black[by * bw + bx] = avg;
      }
    }
    for (let by = 0; by < bh; by++) {
      const y0 = Math.min(by * B, h - B);
      for (let bx = 0; bx < bw; bx++) {
        const x0 = Math.min(bx * B, w - B);
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = Math.min(Math.max(by + dy, 0), bh - 1);
          for (let dx = -2; dx <= 2; dx++) {
            const xx = Math.min(Math.max(bx + dx, 0), bw - 1);
            sum += black[yy * bw + xx];
          }
        }
        const t = sum / 25;
        for (let y = y0; y < y0 + B; y++) {
          const row = y * w;
          for (let x = x0; x < x0 + B; x++) out[row + x] = lum[row + x] <= t ? 1 : 0;
        }
      }
    }
    return out;
  }

  /* ======================================================================
     GF(256) e Reed-Solomon (polinômio primitivo 0x11D, raízes α^0..α^(n-1))
  ====================================================================== */

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
  }
  function gfDiv(a, b) {
    if (!a) return 0;
    return GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]];
  }
  function gfPow(e) {
    return GF_EXP[((e % 255) + 255) % 255];
  }

  function rsSyndromes(block, nsym) {
    const S = new Uint8Array(nsym);
    let any = false;
    for (let j = 0; j < nsym; j++) {
      const a = GF_EXP[j];
      let v = 0;
      for (let k = 0; k < block.length; k++) v = gfMul(v, a) ^ block[k];
      S[j] = v;
      if (v) any = true;
    }
    return any ? S : null;
  }

  // Corrige `block` (dados + EC, coeficiente de maior grau primeiro) no
  // lugar. Retorna false se houver mais erros do que o código aguenta.
  function rsDecode(block, nsym) {
    const S = rsSyndromes(block, nsym);
    if (!S) return true;
    const n = block.length;

    // Berlekamp-Massey → polinômio localizador Λ (coeficientes crescentes)
    let C = [1];
    let Bp = [1];
    let L = 0;
    let m = 1;
    let b = 1;
    for (let i = 0; i < nsym; i++) {
      let d = S[i];
      for (let k = 1; k <= L; k++) d ^= gfMul(C[k] || 0, S[i - k]);
      if (d === 0) {
        m++;
        continue;
      }
      const coef = gfDiv(d, b);
      const T = C.slice();
      while (C.length < Bp.length + m) C.push(0);
      for (let k = 0; k < Bp.length; k++) C[k + m] ^= gfMul(coef, Bp[k]);
      if (2 * L <= i) {
        L = i + 1 - L;
        Bp = T;
        b = d;
        m = 1;
      } else {
        m++;
      }
    }
    if (2 * L > nsym) return false;
    C = C.slice(0, L + 1);

    // Chien: posições (expoentes) p com Λ(α^-p) = 0
    const positions = [];
    for (let p = 0; p < n; p++) {
      const xinv = gfPow(-p);
      let v = 0;
      for (let k = C.length - 1; k >= 0; k--) v = gfMul(v, xinv) ^ C[k];
      if (v === 0) positions.push(p);
    }
    if (positions.length !== L) return false;

    // Ω = S·Λ mod x^nsym; Forney (primeira raiz consecutiva α^0): e = X·Ω(X⁻¹)/Λ'(X⁻¹)
    const Om = new Uint8Array(nsym);
    for (let i = 0; i < nsym; i++) {
      let v = 0;
      for (let k = 0; k <= i && k < C.length; k++) v ^= gfMul(C[k], S[i - k]);
      Om[i] = v;
    }
    for (const p of positions) {
      const xinv = gfPow(-p);
      let om = 0;
      for (let k = nsym - 1; k >= 0; k--) om = gfMul(om, xinv) ^ Om[k];
      let dv = 0;
      for (let k = 1; k < C.length; k += 2) dv ^= gfMul(C[k], gfPow(-p * (k - 1)));
      if (dv === 0) return false;
      block[n - 1 - p] ^= gfMul(gfPow(p), gfDiv(om, dv));
    }
    return rsSyndromes(block, nsym) === null;
  }

  /* ======================================================================
     QR — tabelas
  ====================================================================== */

  // ISO 18004, tabela 9: codewords de correção por bloco e número de blocos,
  // por nível [L, M, Q, H] e versão (índice 0 não usado).
  const ECC_PER_BLOCK = [
    [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const NUM_BLOCKS = [
    [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];
  // bits de nível no formato: L=01, M=00, Q=11, H=10 → índice nas tabelas acima
  const EC_LEVEL_FROM_BITS = [1, 0, 3, 2];
  const EC_LEVEL_NAMES = ['L', 'M', 'Q', 'H'];

  function alignmentPositions(version) {
    if (version === 1) return [];
    const size = version * 4 + 17;
    const num = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (num * 2 - 2)) * 2;
    const out = [6];
    for (let pos = size - 7; out.length < num; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  function rawDataModules(version) {
    let r = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const num = Math.floor(version / 7) + 2;
      r -= (25 * num - 10) * num - 55;
      if (version >= 7) r -= 36;
    }
    return r;
  }

  function bchRemainder(value, poly, polyDegree) {
    let v = value << polyDegree;
    for (let bit = 31; bit >= polyDegree; bit--) {
      if (v & (1 << bit)) v ^= poly << (bit - polyDegree);
    }
    return v;
  }

  // Todos os 32 códigos de formato válidos (BCH(15,5), já com a máscara
  // 0x5412) e os 34 de versão (BCH(18,6), versões 7-40) — calculados em vez
  // de copiados de tabela, pra não depender de digitação.
  const FORMAT_CODES = [];
  for (let d = 0; d < 32; d++) FORMAT_CODES.push({ code: ((d << 10) | bchRemainder(d, 0x537, 10)) ^ 0x5412, data: d });
  const VERSION_CODES = [];
  for (let v = 7; v <= 40; v++) VERSION_CODES.push({ code: (v << 12) | bchRemainder(v, 0x1f25, 12), version: v });

  function popcount(x) {
    let c = 0;
    while (x) {
      x &= x - 1;
      c++;
    }
    return c;
  }

  function bestCodeMatch(table, bitsA, bitsB, maxDist) {
    let best = null;
    let bestDist = maxDist + 1;
    for (const entry of table) {
      for (const bits of [bitsA, bitsB]) {
        if (bits === null) continue;
        const d = popcount(entry.code ^ bits);
        if (d < bestDist) {
          bestDist = d;
          best = entry;
        }
      }
    }
    return best;
  }

  const DATA_MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
  ];

  function functionPatternMap(version) {
    const size = version * 4 + 17;
    const f = new Uint8Array(size * size);
    const region = (left, top, width, height) => {
      for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) f[y * size + x] = 1;
    };
    region(0, 0, 9, 9);
    region(size - 8, 0, 8, 9);
    region(0, size - 8, 9, 8);
    const pos = alignmentPositions(version);
    const last = pos.length - 1;
    for (let a = 0; a < pos.length; a++) {
      for (let b = 0; b < pos.length; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
        region(pos[a] - 2, pos[b] - 2, 5, 5);
      }
    }
    region(6, 9, 1, size - 17);
    region(9, 6, size - 17, 1);
    if (version >= 7) {
      region(size - 11, 0, 3, 6);
      region(0, size - 11, 6, 3);
    }
    return f;
  }

  /* ======================================================================
     QR — leitura da matriz de módulos
  ====================================================================== */

  function readFormat(m, size) {
    const get = (x, y) => m[y * size + x];
    let a = 0;
    for (let x = 0; x < 6; x++) a = (a << 1) | get(x, 8);
    a = (a << 1) | get(7, 8);
    a = (a << 1) | get(8, 8);
    a = (a << 1) | get(8, 7);
    for (let y = 5; y >= 0; y--) a = (a << 1) | get(8, y);
    let b = 0;
    for (let y = size - 1; y >= size - 7; y--) b = (b << 1) | get(8, y);
    for (let x = size - 8; x < size; x++) b = (b << 1) | get(x, 8);
    const match = bestCodeMatch(FORMAT_CODES, a, b, 3);
    if (!match) return null;
    return { ecLevel: EC_LEVEL_FROM_BITS[match.data >> 3], mask: match.data & 7 };
  }

  function readVersion(m, size) {
    const get = (x, y) => m[y * size + x];
    let a = 0;
    for (let y = 5; y >= 0; y--) for (let x = size - 9; x >= size - 11; x--) a = (a << 1) | get(x, y);
    let b = 0;
    for (let x = 5; x >= 0; x--) for (let y = size - 9; y >= size - 11; y--) b = (b << 1) | get(x, y);
    const match = bestCodeMatch(VERSION_CODES, a, b, 3);
    return match ? match.version : null;
  }

  function readCodewords(m, size, version, mask) {
    const func = functionPatternMap(version);
    const maskFn = DATA_MASKS[mask];
    const total = Math.floor(rawDataModules(version) / 8);
    const out = new Uint8Array(total);
    let byteIdx = 0;
    let bitIdx = 0;
    let cur = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const y = upward ? size - 1 - vert : vert;
        for (let c = 0; c < 2; c++) {
          const x = right - c;
          if (func[y * size + x]) continue;
          let bit = m[y * size + x];
          if (maskFn(y, x)) bit ^= 1;
          cur = (cur << 1) | bit;
          if (++bitIdx === 8) {
            if (byteIdx < total) out[byteIdx++] = cur;
            bitIdx = 0;
            cur = 0;
          }
        }
      }
      upward = !upward;
    }
    return byteIdx === total ? out : null;
  }

  // Desfaz o entrelaçamento dos blocos, corrige cada um e junta os dados.
  function correctAndJoin(raw, version, ecLevel) {
    const numBlocks = NUM_BLOCKS[ecLevel][version];
    const eccLen = ECC_PER_BLOCK[ecLevel][version];
    const total = raw.length;
    const numShort = numBlocks - (total % numBlocks);
    const shortLen = Math.floor(total / numBlocks);
    const blocks = [];
    for (let i = 0; i < numBlocks; i++) {
      blocks.push(new Uint8Array(shortLen + (i < numShort ? 0 : 1)));
    }
    const shortData = shortLen - eccLen;
    let k = 0;
    for (let i = 0; i < shortData; i++) for (let b = 0; b < numBlocks; b++) blocks[b][i] = raw[k++];
    for (let b = numShort; b < numBlocks; b++) blocks[b][shortData] = raw[k++];
    for (let i = 0; i < eccLen; i++) {
      for (let b = 0; b < numBlocks; b++) {
        const dataLen = b < numShort ? shortData : shortData + 1;
        blocks[b][dataLen + i] = raw[k++];
      }
    }
    const data = [];
    for (let b = 0; b < numBlocks; b++) {
      if (!rsDecode(blocks[b], eccLen)) return null;
      const dataLen = blocks[b].length - eccLen;
      for (let i = 0; i < dataLen; i++) data.push(blocks[b][i]);
    }
    return Uint8Array.from(data);
  }

  /* ======================================================================
     QR — fluxo de bits
  ====================================================================== */

  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  function decodeBytes(bytes, charset) {
    const arr = Uint8Array.from(bytes);
    if (charset === 'iso-8859-1') return Array.from(arr, (c) => String.fromCharCode(c)).join('');
    try {
      return new TextDecoder(charset || 'utf-8', { fatal: true }).decode(arr);
    } catch (e) {
      // sem ECI, a norma diz ISO-8859-1; na prática quase tudo é UTF-8 —
      // tenta UTF-8 primeiro e só cai pro Latin-1 se não for UTF-8 válido
      return Array.from(arr, (c) => String.fromCharCode(c)).join('');
    }
  }

  function decodeBitstream(data, version) {
    let pos = 0;
    const totalBits = data.length * 8;
    const read = (n) => {
      if (pos + n > totalBits) throw new Error('fim dos dados');
      let v = 0;
      for (let i = 0; i < n; i++) {
        v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1);
        pos++;
      }
      return v;
    };
    const sizeClass = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    let text = '';
    let charset = null;
    let pendingBytes = [];
    const flushBytes = () => {
      if (pendingBytes.length) {
        text += decodeBytes(pendingBytes, charset);
        pendingBytes = [];
      }
    };

    while (totalBits - pos >= 4) {
      const mode = read(4);
      if (mode === 0) break;
      if (mode === 0x1) {
        flushBytes();
        let count = read([10, 12, 14][sizeClass]);
        while (count >= 3) {
          const v = read(10);
          if (v > 999) throw new Error('numérico inválido');
          text += String(v).padStart(3, '0');
          count -= 3;
        }
        if (count === 2) {
          const v = read(7);
          if (v > 99) throw new Error('numérico inválido');
          text += String(v).padStart(2, '0');
        } else if (count === 1) {
          const v = read(4);
          if (v > 9) throw new Error('numérico inválido');
          text += String(v);
        }
      } else if (mode === 0x2) {
        flushBytes();
        let count = read([9, 11, 13][sizeClass]);
        while (count >= 2) {
          const v = read(11);
          if (v >= 45 * 45) throw new Error('alfanumérico inválido');
          text += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45];
          count -= 2;
        }
        if (count === 1) {
          const v = read(6);
          if (v >= 45) throw new Error('alfanumérico inválido');
          text += ALNUM[v];
        }
      } else if (mode === 0x4) {
        const count = read([8, 16, 16][sizeClass]);
        for (let i = 0; i < count; i++) pendingBytes.push(read(8));
      } else if (mode === 0x8) {
        flushBytes();
        const count = read([8, 10, 12][sizeClass]);
        const sjis = [];
        for (let i = 0; i < count; i++) {
          const v = read(13);
          let assembled = (Math.floor(v / 0xc0) << 8) | (v % 0xc0);
          assembled += assembled < 0x1f00 ? 0x8140 : 0xc140;
          sjis.push(assembled >> 8, assembled & 0xff);
        }
        try {
          text += new TextDecoder('shift_jis').decode(Uint8Array.from(sjis));
        } catch (e) {
          text += decodeBytes(sjis, 'iso-8859-1');
        }
      } else if (mode === 0x7) {
        flushBytes();
        const first = read(8);
        let eci;
        if ((first & 0x80) === 0) eci = first & 0x7f;
        else if ((first & 0xc0) === 0x80) eci = ((first & 0x3f) << 8) | read(8);
        else if ((first & 0xe0) === 0xc0) eci = ((first & 0x1f) << 16) | read(16);
        else throw new Error('ECI inválido');
        charset = eci === 26 ? 'utf-8' : eci === 1 || eci === 3 ? 'iso-8859-1' : eci === 20 ? 'shift_jis' : null;
      } else if (mode === 0x3) {
        read(16); // structured append: índice/total/paridade — lemos cada símbolo isolado
      } else if (mode === 0x5 || mode === 0x9) {
        if (mode === 0x9) read(8); // FNC1 2ª posição: indicador de aplicação
      } else {
        throw new Error('modo desconhecido');
      }
    }
    flushBytes();
    return text;
  }

  function decodeMatrix(m, size) {
    const version = (size - 17) / 4;
    if (!Number.isInteger(version) || version < 1 || version > 40) return null;
    if (version >= 7) {
      const read = readVersion(m, size);
      if (read !== version) return null;
    }
    const format = readFormat(m, size);
    if (!format) return null;
    const raw = readCodewords(m, size, version, format.mask);
    if (!raw) return null;
    const data = correctAndJoin(raw, version, format.ecLevel);
    if (!data) return null;
    try {
      return { text: decodeBitstream(data, version), version, ecLevel: EC_LEVEL_NAMES[format.ecLevel] };
    } catch (e) {
      return null;
    }
  }

  function transpose(m, size) {
    const t = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t[x * size + y] = m[y * size + x];
    return t;
  }

  /* ======================================================================
     QR — localização na imagem
  ====================================================================== */

  function foundPatternCross(s) {
    const total = s[0] + s[1] + s[2] + s[3] + s[4];
    if (total < 7) return false;
    const mod = total / 7;
    const v = mod / 2;
    return (
      Math.abs(mod - s[0]) < v &&
      Math.abs(mod - s[1]) < v &&
      Math.abs(3 * mod - s[2]) < 3 * v &&
      Math.abs(mod - s[3]) < v &&
      Math.abs(mod - s[4]) < v
    );
  }

  // Confere o padrão 1:1:3:1:1 cruzando o centro candidato na direção (dx,dy).
  function crossCheck(bits, w, h, x0, y0, dx, dy, maxCount, originalTotal) {
    const s = [0, 0, 0, 0, 0];
    const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
    let x = x0;
    let y = y0;
    if (!inb(x, y)) return NaN;
    while (inb(x, y) && bits[y * w + x]) { s[2]++; x -= dx; y -= dy; }
    if (!inb(x, y)) return NaN;
    while (inb(x, y) && !bits[y * w + x] && s[1] <= maxCount) { s[1]++; x -= dx; y -= dy; }
    if (!inb(x, y) || s[1] > maxCount) return NaN;
    while (inb(x, y) && bits[y * w + x] && s[0] <= maxCount) { s[0]++; x -= dx; y -= dy; }
    if (s[0] > maxCount) return NaN;
    x = x0 + dx;
    y = y0 + dy;
    while (inb(x, y) && bits[y * w + x]) { s[2]++; x += dx; y += dy; }
    if (!inb(x, y)) return NaN;
    while (inb(x, y) && !bits[y * w + x] && s[3] < maxCount) { s[3]++; x += dx; y += dy; }
    if (!inb(x, y) || s[3] >= maxCount) return NaN;
    while (inb(x, y) && bits[y * w + x] && s[4] < maxCount) { s[4]++; x += dx; y += dy; }
    if (s[4] >= maxCount) return NaN;
    const total = s[0] + s[1] + s[2] + s[3] + s[4];
    if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
    if (!foundPatternCross(s)) return NaN;
    const end = dx ? x : y;
    return end - s[4] - s[3] - s[2] / 2;
  }

  function findFinderCandidates(bits, w, h) {
    const centers = [];
    const step = h >= 300 ? 2 : 1;
    const s = [0, 0, 0, 0, 0];

    const handle = (y, xEnd) => {
      const total = s[0] + s[1] + s[2] + s[3] + s[4];
      let cx = xEnd - s[4] - s[3] - s[2] / 2;
      // confere na vertical pela coluna do centro e, se um módulo sujo logo
      // acima/abaixo do localizador atrapalhar, pelas colunas vizinhas do miolo
      const mod = total / 7;
      let cy = NaN;
      for (const off of [0, -mod, mod]) {
        cy = crossCheck(bits, w, h, Math.floor(cx + off), y, 0, 1, s[2], total);
        if (!isNaN(cy)) break;
      }
      if (isNaN(cy)) return false;
      // re-mede o centro horizontal na linha do centro vertical; se um
      // módulo sujo estragar essa linha, fica com a medida da linha original
      // (que já passou no 1:1:3:1:1 e cruza o miolo, confirmado acima)
      const cx2 = crossCheck(bits, w, h, Math.floor(cx), Math.floor(cy), 1, 0, s[2], total);
      if (!isNaN(cx2)) cx = cx2;
      const size = total / 7;
      for (const c of centers) {
        if (Math.abs(cy - c.y) <= size && Math.abs(cx - c.x) <= size) {
          const diff = Math.abs(size - c.size);
          if (diff <= 1 || diff <= c.size) {
            const n = c.count + 1;
            c.x = (c.count * c.x + cx) / n;
            c.y = (c.count * c.y + cy) / n;
            c.size = (c.count * c.size + size) / n;
            c.count = n;
            return true;
          }
        }
      }
      centers.push({ x: cx, y: cy, size, count: 1 });
      return true;
    };

    for (let y = 0; y < h; y += step) {
      s.fill(0);
      let state = 0;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (bits[row + x]) {
          if (state & 1) state++;
          s[state]++;
        } else if (!(state & 1)) {
          if (state === 4) {
            if (foundPatternCross(s) && handle(y, x)) {
              s.fill(0);
              state = 0;
            } else {
              s[0] = s[2];
              s[1] = s[3];
              s[2] = s[4];
              s[3] = 1;
              s[4] = 0;
              state = 3;
            }
          } else {
            s[++state]++;
          }
        } else {
          s[state]++;
        }
      }
      if (state === 4 && foundPatternCross(s)) handle(y, w);
    }
    return centers;
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Ordena os três localizadores em (topo-esq, topo-dir, baixo-esq): o
  // topo-esquerdo é o oposto à maior distância; o produto vetorial decide
  // qual dos outros dois é o da direita.
  function orderFinders(p) {
    const d01 = dist(p[0], p[1]);
    const d12 = dist(p[1], p[2]);
    const d02 = dist(p[0], p[2]);
    let A;
    let B;
    let C;
    if (d12 >= d01 && d12 >= d02) { B = p[0]; A = p[1]; C = p[2]; }
    else if (d02 >= d12 && d02 >= d01) { B = p[1]; A = p[0]; C = p[2]; }
    else { B = p[2]; A = p[0]; C = p[1]; }
    if ((C.x - B.x) * (A.y - B.y) - (C.y - B.y) * (A.x - B.x) < 0) {
      const t = A;
      A = C;
      C = t;
    }
    return { tl: B, tr: C, bl: A };
  }

  function candidateTriples(centers) {
    let cand = centers.filter((c) => c.count >= 2);
    if (cand.length < 3) cand = centers.slice();
    if (cand.length < 3) return [];
    cand.sort((a, b) => b.count - a.count);
    cand = cand.slice(0, 12);
    const out = [];
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        for (let k = j + 1; k < cand.length; k++) {
          const t = [cand[i], cand[j], cand[k]];
          const sizes = t.map((c) => c.size);
          const minS = Math.min(...sizes);
          const maxS = Math.max(...sizes);
          if (maxS > minS * 2) continue;
          const ms = (sizes[0] + sizes[1] + sizes[2]) / 3;
          const d = [dist(t[0], t[1]), dist(t[0], t[2]), dist(t[1], t[2])].sort((a, b) => a - b);
          const [l1, l2, hyp] = d;
          if (l1 < ms * 8) continue;
          const score =
            Math.abs(l1 - l2) / l2 + Math.abs(hyp - Math.hypot(l1, l2)) / hyp + (0.5 * (maxS - minS)) / ms;
          if (score < 1) out.push({ score, finders: orderFinders(t) });
        }
      }
    }
    return out.sort((a, b) => a.score - b.score).slice(0, 4);
  }

  // Distância percorrendo preto→branco→preto a partir do centro de um
  // localizador em direção a outro ponto (Bresenham). Dá o tamanho do
  // módulo ao longo da grade, correto mesmo com o código girado.
  function runBWB(bits, w, h, fromX, fromY, toX, toY) {
    fromX = Math.floor(fromX); fromY = Math.floor(fromY); toX = Math.floor(toX); toY = Math.floor(toY);
    const steep = Math.abs(toY - fromY) > Math.abs(toX - fromX);
    if (steep) {
      [fromX, fromY] = [fromY, fromX];
      [toX, toY] = [toY, toX];
    }
    const dx = Math.abs(toX - fromX);
    const dy = Math.abs(toY - fromY);
    let error = -dx / 2;
    const xstep = fromX < toX ? 1 : -1;
    const ystep = fromY < toY ? 1 : -1;
    let state = 0;
    const xLimit = toX + xstep;
    for (let x = fromX, y = fromY; x !== xLimit; x += xstep) {
      const rx = steep ? y : x;
      const ry = steep ? x : y;
      const black = rx >= 0 && ry >= 0 && rx < w && ry < h ? bits[ry * w + rx] === 1 : false;
      if ((state === 1) === black) {
        if (state === 2) return Math.hypot(x - fromX, y - fromY);
        state++;
      }
      error += dy;
      if (error > 0) {
        if (y === toY) break;
        y += ystep;
        error -= dx;
      }
    }
    if (state === 2) return Math.hypot(toX + xstep - fromX, toY - fromY);
    return NaN;
  }

  function runBWBBothWays(bits, w, h, fromX, fromY, toX, toY) {
    let result = runBWB(bits, w, h, fromX, fromY, toX, toY);
    let scale = 1;
    let otherX = fromX - (toX - fromX);
    if (otherX < 0) { scale = fromX / (fromX - otherX); otherX = 0; }
    else if (otherX >= w) { scale = (w - 1 - fromX) / (otherX - fromX); otherX = w - 1; }
    let otherY = Math.floor(fromY - (toY - fromY) * scale);
    scale = 1;
    if (otherY < 0) { scale = fromY / (fromY - otherY); otherY = 0; }
    else if (otherY >= h) { scale = (h - 1 - fromY) / (otherY - fromY); otherY = h - 1; }
    otherX = Math.floor(fromX + (otherX - fromX) * scale);
    result += runBWB(bits, w, h, fromX, fromY, otherX, otherY);
    return result - 1;
  }

  function moduleSizeOneWay(bits, w, h, a, b) {
    const e1 = runBWBBothWays(bits, w, h, a.x, a.y, b.x, b.y);
    const e2 = runBWBBothWays(bits, w, h, b.x, b.y, a.x, a.y);
    if (isNaN(e1)) return e2 / 7;
    if (isNaN(e2)) return e1 / 7;
    return (e1 + e2) / 14;
  }

  // Resolve a homografia H (8 incógnitas) que leva 4 pontos (u,v) do espaço
  // de módulos pros 4 pontos (x,y) da imagem — eliminação de Gauss.
  function homography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = src[i];
      const [x, y] = dst[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        if (!f) continue;
        for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
      }
    }
    const hm = A.map((row, i) => row[8] / row[i]);
    return (u, v) => {
      const den = hm[6] * u + hm[7] * v + 1;
      return [(hm[0] * u + hm[1] * v + hm[2]) / den, (hm[3] * u + hm[4] * v + hm[5]) / den];
    };
  }

  // Procura o padrão de alinhamento (5x5: anel preto, anel branco, ponto
  // preto) perto de onde a geometria dos localizadores diz que ele está.
  function findAlignment(bits, w, h, H, dim, moduleSize) {
    const u = dim - 6.5;
    const [ex, ey] = H(u, u);
    const [ax, ay] = H(u + 1, u);
    const [bx, by] = H(u, u + 1);
    const a = [ax - ex, ay - ey];
    const b = [bx - ex, by - ey];
    const sample = (px, py) => {
      const x = Math.round(px);
      const y = Math.round(py);
      return x >= 0 && y >= 0 && x < w && y < h ? bits[y * w + x] : 0;
    };
    const score = (cx, cy) => {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const expectBlack = Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0;
          if (sample(cx + i * a[0] + j * b[0], cy + i * a[1] + j * b[1]) === expectBlack) s++;
        }
      }
      return s;
    };
    for (const factor of [4, 8, 16]) {
      const radius = factor * moduleSize;
      const step = Math.max(1, moduleSize / 3);
      let best = null;
      for (let dy = -radius; dy <= radius; dy += step) {
        for (let dx = -radius; dx <= radius; dx += step) {
          const sc = score(ex + dx, ey + dy);
          if (!best || sc > best.sc || (sc === best.sc && Math.hypot(dx, dy) < best.d)) {
            best = { sc, x: ex + dx, y: ey + dy, d: Math.hypot(dx, dy) };
          }
        }
      }
      if (best && best.sc >= 23) {
        // refina: média das posições (passo de 1px) que batem o padrão
        let sx = 0;
        let sy = 0;
        let n = 0;
        const r = Math.max(1, moduleSize * 0.75);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (score(best.x + dx, best.y + dy) >= best.sc) {
              sx += best.x + dx;
              sy += best.y + dy;
              n++;
            }
          }
        }
        return n ? { x: sx / n, y: sy / n } : { x: best.x, y: best.y };
      }
    }
    return null;
  }

  // Filtro barato antes de amostrar a grade inteira: a linha e a coluna 6
  // (padrões de sincronismo) alternam preto/branco entre os localizadores.
  // Candidatos falsos (listras de código de barras, texto) quase nunca batem.
  function timingScore(bits, w, h, H, dim) {
    let hits = 0;
    let n = 0;
    for (let i = 8; i < dim - 8; i++) {
      const expect = i % 2 === 0 ? 1 : 0;
      for (const [u, v] of [[i, 6], [6, i]]) {
        const [px, py] = H(u + 0.5, v + 0.5);
        const x = Math.floor(px);
        const y = Math.floor(py);
        n++;
        if (x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === expect) hits++;
      }
    }
    return hits / n;
  }

  function sampleGrid(bits, w, h, H, dim) {
    const m = new Uint8Array(dim * dim);
    for (let y = 0; y < dim; y++) {
      for (let x = 0; x < dim; x++) {
        const [px, py] = H(x + 0.5, y + 0.5);
        let ix = Math.floor(px);
        let iy = Math.floor(py);
        if (ix < -2 || iy < -2 || ix > w + 1 || iy > h + 1) return null;
        ix = Math.min(Math.max(ix, 0), w - 1);
        iy = Math.min(Math.max(iy, 0), h - 1);
        m[y * dim + x] = bits[iy * w + ix];
      }
    }
    return m;
  }

  // deslocamentos (em módulos) do 4º canto, do mais perto pro mais longe
  const BR_OFFSETS = [];
  for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) if (a || b) BR_OFFSETS.push([a * 0.75, b * 0.75]);
  BR_OFFSETS.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));

  function tryFinders(bits, w, h, f) {
    const { tl, tr, bl } = f;
    const moduleSize = (moduleSizeOneWay(bits, w, h, tl, tr) + moduleSizeOneWay(bits, w, h, tl, bl)) / 2;
    if (!(moduleSize >= 1)) return null;
    const tltr = Math.round(dist(tl, tr) / moduleSize);
    const tlbl = Math.round(dist(tl, bl) / moduleSize);
    let dim = Math.floor((tltr + tlbl) / 2) + 7;
    switch (dim & 3) {
      case 0: dim++; break;
      case 2: dim--; break;
      case 3: dim -= 2; break;
      default: break;
    }
    const dims = [dim, dim - 4, dim + 4, dim - 8, dim + 8].filter((d) => d >= 21 && d <= 177);
    for (const d of dims) {
      const br = { x: tr.x - tl.x + bl.x, y: tr.y - tl.y + bl.y };
      const far = d - 3.5;
      const H0 = homography([[3.5, 3.5], [far, 3.5], [3.5, far], [far, far]], [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], [br.x, br.y]]);
      if (!H0) continue;
      // nem o chute inicial acerta o sincronismo: candidato falso ou
      // dimensão errada — pula antes das buscas caras
      if (timingScore(bits, w, h, H0, d) < 0.6) continue;
      const attempts = [];
      let aligned = false;
      if (d > 21) {
        const ap = findAlignment(bits, w, h, H0, d, moduleSize);
        if (ap) {
          const Ha = homography(
            [[3.5, 3.5], [far, 3.5], [3.5, far], [far - 3, far - 3]],
            [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], [ap.x, ap.y]],
          );
          if (Ha) {
            attempts.push(Ha);
            aligned = true;
          }
        }
      }
      attempts.push(H0);
      if (!aligned) {
        // Sem padrão de alinhamento (versão 1, ou borrado demais) o 4º
        // canto é chutado como paralelogramo, o que erra com a foto em
        // perspectiva. Tenta cantos deslocados em volta do chute — o
        // Reed-Solomon descarta os errados.
        const ux = (tr.x - tl.x) / (far - 3.5);
        const uy = (tr.y - tl.y) / (far - 3.5);
        const vx = (bl.x - tl.x) / (far - 3.5);
        const vy = (bl.y - tl.y) / (far - 3.5);
        for (const [a, b] of BR_OFFSETS) {
          const H = homography(
            [[3.5, 3.5], [far, 3.5], [3.5, far], [far, far]],
            [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], [br.x + a * ux + b * vx, br.y + a * uy + b * vy]],
          );
          if (H) attempts.push(H);
        }
      }
      for (const H of attempts) {
        if (timingScore(bits, w, h, H, d) < 0.7) continue;
        const m = sampleGrid(bits, w, h, H, d);
        if (!m) continue;
        const res = decodeMatrix(m, d) || decodeMatrix(transpose(m, d), d);
        if (res) return res;
      }
    }
    return null;
  }

  function decodeQRFromBits(bits, w, h) {
    const centers = findFinderCandidates(bits, w, h);
    for (const { finders } of candidateTriples(centers)) {
      const res = tryFinders(bits, w, h, finders);
      if (res) return res;
    }
    return null;
  }

  function decodeQRFromLuminance(lum, w, h) {
    let L = lum;
    let W = w;
    let Hh = h;
    while (Math.max(W, Hh) > 1000) {
      const d = downscale2(L, W, Hh);
      L = d.lum;
      W = d.w;
      Hh = d.h;
    }
    const bits = binarize(L, W, Hh);
    let res = decodeQRFromBits(bits, W, Hh);
    if (!res) {
      // QR claro sobre fundo escuro (impresso "negativo")
      for (let i = 0; i < bits.length; i++) bits[i] ^= 1;
      res = decodeQRFromBits(bits, W, Hh);
    }
    return res;
  }

  /* ======================================================================
     1D — varredura por linhas
  ====================================================================== */

  // Transforma uma linha de luminância em larguras de faixa alternadas,
  // começando sempre por uma faixa branca (a zona de silêncio).
  function lineRuns(values) {
    const t = otsuThreshold(values, 0, values.length, 1);
    let min = 255;
    let max = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    if (max - min < 40) return null;
    const runs = [];
    let color = 0; // 0 = branco
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const c = values[i] <= t ? 1 : 0;
      if (c === color) count++;
      else {
        runs.push(count);
        color = c;
        count = 1;
      }
    }
    runs.push(count);
    return runs; // índices pares = branco, ímpares = preto
  }

  // Quão bem as larguras observadas batem com um padrão (em módulos):
  // soma dos desvios relativos, normalizada pela largura total.
  function patternVariance(runs, start, pattern) {
    let total = 0;
    let units = 0;
    for (let i = 0; i < pattern.length; i++) {
      total += runs[start + i];
      units += pattern[i];
    }
    if (total < units) return Infinity;
    const unit = total / units;
    let v = 0;
    let maxV = 0;
    for (let i = 0; i < pattern.length; i++) {
      const d = Math.abs(runs[start + i] - pattern[i] * unit) / unit;
      if (d > maxV) maxV = d;
      v += d;
    }
    if (maxV > 0.7) return Infinity;
    return v / pattern.length;
  }

  function bestMatch(runs, start, patterns, maxAvg) {
    let best = -1;
    let bestV = maxAvg;
    for (let i = 0; i < patterns.length; i++) {
      const v = patternVariance(runs, start, patterns[i]);
      if (v < bestV) {
        bestV = v;
        best = i;
      }
    }
    return best;
  }

  /* ---------- EAN-13 / UPC-A / EAN-8 ---------- */

  const L_PATTERNS = [
    [3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2],
    [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2],
  ];
  const G_PATTERNS = L_PATTERNS.map((p) => p.slice().reverse());
  const LG_PATTERNS = L_PATTERNS.concat(G_PATTERNS);
  const FIRST_DIGIT_PARITY = [0x00, 0x0b, 0x0d, 0x0e, 0x13, 0x19, 0x1c, 0x15, 0x16, 0x1a];

  function eanChecksumOk(digits) {
    let sum = 0;
    const n = digits.length;
    for (let i = 0; i < n - 1; i++) sum += digits[i] * ((n - 1 - i) % 2 === 1 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === digits[n - 1];
  }

  // Zona de silêncio (branco) antes do código, em módulos. Se a faixa
  // encosta na borda da imagem ela foi cortada pelo enquadramento — aí
  // basta um pouco de branco.
  function quietOk(runs, idx, unit, modules) {
    const q = runs[idx - 1];
    return idx - 1 === 0 ? q >= unit * 1.5 : q >= unit * modules;
  }

  function decodeEAN(runs) {
    for (let i = 1; i + 3 <= runs.length; i += 2) {
      // guarda inicial 1-1-1 (preto-branco-preto) com zona branca antes
      const g = runs[i] + runs[i + 1] + runs[i + 2];
      const unit = g / 3;
      if (patternVariance(runs, i, [1, 1, 1]) > 0.4) continue;
      if (!quietOk(runs, i, unit, 3)) continue;
      const res = decodeEAN13At(runs, i + 3, unit) || decodeEAN8At(runs, i + 3, unit);
      if (res) return res;
    }
    return null;
  }

  function decodeEAN13At(runs, p, unit) {
    if (p + 24 + 5 + 24 + 3 > runs.length) return null;
    const digits = [];
    let parity = 0;
    for (let d = 0; d < 6; d++) {
      const k = bestMatch(runs, p + d * 4, LG_PATTERNS, 0.4);
      if (k < 0) return null;
      digits.push(k % 10);
      if (k >= 10) parity |= 1 << (5 - d);
    }
    const first = FIRST_DIGIT_PARITY.indexOf(parity);
    if (first < 0) return null;
    const mid = p + 24;
    if (patternVariance(runs, mid, [1, 1, 1, 1, 1]) > 0.4) return null;
    for (let d = 0; d < 6; d++) {
      const k = bestMatch(runs, mid + 5 + d * 4, L_PATTERNS, 0.4);
      if (k < 0) return null;
      digits.push(k);
    }
    const end = mid + 5 + 24;
    if (patternVariance(runs, end, [1, 1, 1]) > 0.4) return null;
    const all = [first].concat(digits);
    if (!eanChecksumOk(all)) return null;
    const text = all.join('');
    // EAN-13 que começa com 0 é, por definição, um UPC-A — devolve os 12
    // dígitos, igual à BarcodeDetector nativa, pra bater com o que já foi
    // cadastrado lendo pelo celular Android.
    if (first === 0) return { format: 'upc_a', text: text.slice(1) };
    return { format: 'ean_13', text };
  }

  function decodeEAN8At(runs, p, unit) {
    if (p + 16 + 5 + 16 + 3 > runs.length) return null;
    const digits = [];
    for (let d = 0; d < 4; d++) {
      const k = bestMatch(runs, p + d * 4, L_PATTERNS, 0.4);
      if (k < 0) return null;
      digits.push(k);
    }
    const mid = p + 16;
    if (patternVariance(runs, mid, [1, 1, 1, 1, 1]) > 0.4) return null;
    for (let d = 0; d < 4; d++) {
      const k = bestMatch(runs, mid + 5 + d * 4, L_PATTERNS, 0.4);
      if (k < 0) return null;
      digits.push(k);
    }
    if (patternVariance(runs, mid + 5 + 16, [1, 1, 1]) > 0.4) return null;
    if (!eanChecksumOk(digits)) return null;
    return { format: 'ean_8', text: digits.join('') };
  }

  /* ---------- Code 128 ---------- */

  const C128 = [
    [2, 1, 2, 2, 2, 2], [2, 2, 2, 1, 2, 2], [2, 2, 2, 2, 2, 1], [1, 2, 1, 2, 2, 3], [1, 2, 1, 3, 2, 2],
    [1, 3, 1, 2, 2, 2], [1, 2, 2, 2, 1, 3], [1, 2, 2, 3, 1, 2], [1, 3, 2, 2, 1, 2], [2, 2, 1, 2, 1, 3],
    [2, 2, 1, 3, 1, 2], [2, 3, 1, 2, 1, 2], [1, 1, 2, 2, 3, 2], [1, 2, 2, 1, 3, 2], [1, 2, 2, 2, 3, 1],
    [1, 1, 3, 2, 2, 2], [1, 2, 3, 1, 2, 2], [1, 2, 3, 2, 2, 1], [2, 2, 3, 2, 1, 1], [2, 2, 1, 1, 3, 2],
    [2, 2, 1, 2, 3, 1], [2, 1, 3, 2, 1, 2], [2, 2, 3, 1, 1, 2], [3, 1, 2, 1, 3, 1], [3, 1, 1, 2, 2, 2],
    [3, 2, 1, 1, 2, 2], [3, 2, 1, 2, 2, 1], [3, 1, 2, 2, 1, 2], [3, 2, 2, 1, 1, 2], [3, 2, 2, 2, 1, 1],
    [2, 1, 2, 1, 2, 3], [2, 1, 2, 3, 2, 1], [2, 3, 2, 1, 2, 1], [1, 1, 1, 3, 2, 3], [1, 3, 1, 1, 2, 3],
    [1, 3, 1, 3, 2, 1], [1, 1, 2, 3, 1, 3], [1, 3, 2, 1, 1, 3], [1, 3, 2, 3, 1, 1], [2, 1, 1, 3, 1, 3],
    [2, 3, 1, 1, 1, 3], [2, 3, 1, 3, 1, 1], [1, 1, 2, 1, 3, 3], [1, 1, 2, 3, 3, 1], [1, 3, 2, 1, 3, 1],
    [1, 1, 3, 1, 2, 3], [1, 1, 3, 3, 2, 1], [1, 3, 3, 1, 2, 1], [3, 1, 3, 1, 2, 1], [2, 1, 1, 3, 3, 1],
    [2, 3, 1, 1, 3, 1], [2, 1, 3, 1, 1, 3], [2, 1, 3, 3, 1, 1], [2, 1, 3, 1, 3, 1], [3, 1, 1, 1, 2, 3],
    [3, 1, 1, 3, 2, 1], [3, 3, 1, 1, 2, 1], [3, 1, 2, 1, 1, 3], [3, 1, 2, 3, 1, 1], [3, 3, 2, 1, 1, 1],
    [3, 1, 4, 1, 1, 1], [2, 2, 1, 4, 1, 1], [4, 3, 1, 1, 1, 1], [1, 1, 1, 2, 2, 4], [1, 1, 1, 4, 2, 2],
    [1, 2, 1, 1, 2, 4], [1, 2, 1, 4, 2, 1], [1, 4, 1, 1, 2, 2], [1, 4, 1, 2, 2, 1], [1, 1, 2, 2, 1, 4],
    [1, 1, 2, 4, 1, 2], [1, 2, 2, 1, 1, 4], [1, 2, 2, 4, 1, 1], [1, 4, 2, 1, 1, 2], [1, 4, 2, 2, 1, 1],
    [2, 4, 1, 2, 1, 1], [2, 2, 1, 1, 1, 4], [4, 1, 3, 1, 1, 1], [2, 4, 1, 1, 1, 2], [1, 3, 4, 1, 1, 1],
    [1, 1, 1, 2, 4, 2], [1, 2, 1, 1, 4, 2], [1, 2, 1, 2, 4, 1], [1, 1, 4, 2, 1, 2], [1, 2, 4, 1, 1, 2],
    [1, 2, 4, 2, 1, 1], [4, 1, 1, 2, 1, 2], [4, 2, 1, 1, 1, 2], [4, 2, 1, 2, 1, 1], [2, 1, 2, 1, 4, 1],
    [2, 1, 4, 1, 2, 1], [4, 1, 2, 1, 2, 1], [1, 1, 1, 1, 4, 3], [1, 1, 1, 3, 4, 1], [1, 3, 1, 1, 4, 1],
    [1, 1, 4, 1, 1, 3], [1, 1, 4, 3, 1, 1], [4, 1, 1, 1, 1, 3], [4, 1, 1, 3, 1, 1], [1, 1, 3, 1, 4, 1],
    [1, 1, 4, 1, 3, 1], [3, 1, 1, 1, 4, 1], [4, 1, 1, 1, 3, 1], [2, 1, 1, 4, 1, 2], [2, 1, 1, 2, 1, 4],
    [2, 1, 1, 2, 3, 2],
  ];
  const C128_STOP = [2, 3, 3, 1, 1, 1, 2];
  const C128_START_A = 103;
  const C128_START_B = 104;
  const C128_START_C = 105;

  function decodeCode128(runs) {
    for (let i = 1; i + 6 <= runs.length; i += 2) {
      const start = bestMatch(runs, i, C128, 0.35);
      if (start < C128_START_A) continue;
      let unit = 0;
      for (let k = 0; k < 6; k++) unit += runs[i + k];
      unit /= 11;
      if (!quietOk(runs, i, unit, 3)) continue; // norma pede 10; foto costuma cortar
      const res = decodeCode128At(runs, i, start);
      if (res) return res;
    }
    return null;
  }

  function decodeCode128At(runs, p, start) {
    const values = [start];
    let q = p + 6;
    for (;;) {
      if (q + 7 <= runs.length && patternVariance(runs, q, C128_STOP) < 0.35) break;
      if (q + 6 > runs.length) return null;
      const v = bestMatch(runs, q, C128.slice(0, 103), 0.35);
      if (v < 0) return null;
      values.push(v);
      q += 6;
      if (values.length > 120) return null;
    }
    if (values.length < 3) return null;
    const check = values.pop();
    let sum = values[0];
    for (let k = 1; k < values.length; k++) sum += k * values[k];
    if (sum % 103 !== check) return null;

    let set = start === C128_START_A ? 'A' : start === C128_START_B ? 'B' : 'C';
    let text = '';
    let shift = false;
    let fnc4 = false;
    for (let k = 1; k < values.length; k++) {
      const v = values[k];
      const cur = shift ? (set === 'A' ? 'B' : 'A') : set;
      shift = false;
      if (cur === 'C') {
        if (v < 100) text += String(v).padStart(2, '0');
        else if (v === 100) set = 'B';
        else if (v === 101) set = 'A';
        else if (v === 102) { if (k > 1) text += '\u001d'; }
        continue;
      }
      if (v < 96) {
        let code = cur === 'A' ? (v < 64 ? v + 32 : v - 64) : v + 32;
        if (fnc4) { code += 128; fnc4 = false; }
        text += String.fromCharCode(code);
        continue;
      }
      if (v === 96 || v === 97) continue; // FNC3 / FNC2
      if (v === 98) { shift = true; continue; }
      if (v === 99) { set = 'C'; continue; }
      if (v === 100) { if (cur === 'B') fnc4 = true; else set = 'B'; continue; }
      if (v === 101) { if (cur === 'A') fnc4 = true; else set = 'A'; continue; }
      if (v === 102) { if (k > 1) text += '\u001d'; continue; }
    }
    return text ? { format: 'code_128', text } : null;
  }

  /* ---------- Code 39 ---------- */

  const C39_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
  const C39_ENCODINGS = [
    0x034, 0x121, 0x061, 0x160, 0x031, 0x130, 0x070, 0x025, 0x124, 0x064,
    0x109, 0x049, 0x148, 0x019, 0x118, 0x058, 0x00d, 0x10c, 0x04c, 0x01c,
    0x103, 0x043, 0x142, 0x013, 0x112, 0x052, 0x007, 0x106, 0x046, 0x016,
    0x181, 0x0c1, 0x1c0, 0x091, 0x190, 0x0d0, 0x085, 0x184, 0x0c4, 0x0a8,
    0x0a2, 0x08a, 0x02a,
  ];
  const C39_ASTERISK = 0x094;

  // 9 elementos → bitmask de largos (1 = largo); exige exatamente 3 largos.
  function c39Pattern(runs, p) {
    if (p + 9 > runs.length) return -1;
    const w = runs.slice(p, p + 9);
    const sorted = w.slice().sort((a, b) => b - a);
    const wideMin = sorted[2];
    const narrowMax = sorted[3];
    if (wideMin < narrowMax * 1.5) return -1;
    let mask = 0;
    for (let k = 0; k < 9; k++) mask = (mask << 1) | (w[k] >= wideMin ? 1 : 0);
    return mask;
  }

  function decodeCode39(runs) {
    for (let i = 1; i + 9 <= runs.length; i += 2) {
      if (c39Pattern(runs, i) !== C39_ASTERISK) continue;
      let width = 0;
      for (let k = 0; k < 9; k++) width += runs[i + k];
      if (!quietOk(runs, i, width / 12, 5)) continue;
      let text = '';
      let q = i + 10;
      for (;;) {
        const mask = c39Pattern(runs, q);
        if (mask < 0) break;
        if (mask === C39_ASTERISK) {
          if (text) return { format: 'code_39', text };
          break;
        }
        const idx = C39_ENCODINGS.indexOf(mask);
        if (idx < 0) break;
        text += C39_ALPHABET[idx];
        q += 10;
      }
    }
    return null;
  }

  function decodeRuns(runs) {
    return decodeEAN(runs) || decodeCode128(runs) || decodeCode39(runs);
  }

  function decodeLine(values) {
    const runs = lineRuns(values);
    if (!runs || runs.length < 20) return null;
    const fwd = decodeRuns(runs);
    if (fwd) return fwd;
    // de cabeça pra baixo: inverte a ordem (continua começando no branco)
    const rev = runs.slice().reverse();
    if (rev.length % 2 === 0) rev.push(0);
    return decodeRuns(rev);
  }

  function decode1DFromLuminance(lum, w, h) {
    const fractions = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9];
    const line = new Uint8Array(Math.max(w, h));
    const avgRows = (y) => {
      const out = line.subarray(0, w);
      const y0 = Math.max(y - 1, 0);
      const y1 = Math.min(y + 1, h - 1);
      for (let x = 0; x < w; x++) out[x] = (lum[y0 * w + x] + 2 * lum[y * w + x] + lum[y1 * w + x] + 2) >> 2;
      return out;
    };
    const avgCols = (x) => {
      const out = line.subarray(0, h);
      const x0 = Math.max(x - 1, 0);
      const x1 = Math.min(x + 1, w - 1);
      for (let y = 0; y < h; y++) out[y] = (lum[y * w + x0] + 2 * lum[y * w + x] + lum[y * w + x1] + 2) >> 2;
      return out;
    };
    for (const f of fractions) {
      const r = decodeLine(avgRows(Math.floor(h * f)));
      if (r) return r;
    }
    for (const f of fractions) {
      const r = decodeLine(avgCols(Math.floor(w * f)));
      if (r) return r;
    }
    return null;
  }

  /* ======================================================================
     API
  ====================================================================== */

  function decode(rgba, width, height) {
    const lum = toLuminance(rgba, width, height);
    const qr = decodeQRFromLuminance(lum, width, height);
    if (qr) return { format: 'qr_code', text: qr.text };
    return decode1DFromLuminance(lum, width, height);
  }

  const CodeReader = {
    decode,
    decodeQR(rgba, width, height) {
      const r = decodeQRFromLuminance(toLuminance(rgba, width, height), width, height);
      return r ? { format: 'qr_code', text: r.text, version: r.version, ecLevel: r.ecLevel } : null;
    },
    decode1D(rgba, width, height) {
      return decode1DFromLuminance(toLuminance(rgba, width, height), width, height);
    },
    // exposto só pros testes
    _internals: {
      gfMul, gfPow, rsDecode, decodeBitstream, decodeMatrix, alignmentPositions, rawDataModules,
      FORMAT_CODES, VERSION_CODES, ECC_PER_BLOCK, NUM_BLOCKS, C128, C39_ENCODINGS, decodeLine,
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CodeReader;
  else global.CodeReader = CodeReader;
})(typeof window !== 'undefined' ? window : globalThis);
