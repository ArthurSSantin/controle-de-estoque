// Leitor próprio de QR code e código de barras (frontend/code-reader.js),
// usado quando o navegador não tem BarcodeDetector nativo. As imagens de
// fixtures/codes/ simulam foto de câmera (rotação, perspectiva, desfoque,
// luz desigual) e foram conferidas com leitores independentes (zbar).
const { test, expect } = require('@playwright/test');
const FIXTURES = require('../fixtures/codes/codes.json');

test.beforeEach(async ({ page }) => {
  await page.route('**/__reader.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/code-reader.js"></script>' })
  );
  await page.goto('/__reader.html');
});

// Desenha a imagem num canvas (girada `rotate` graus) e roda o leitor.
function decodeFixture(page, file, rotate = 0) {
  return page.evaluate(async ({ file, rotate }) => {
    const img = new Image();
    img.src = '/tests/fixtures/codes/' + file;
    await img.decode();
    const swap = rotate % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = swap ? img.height : img.width;
    c.height = swap ? img.width : img.height;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return window.CodeReader.decode(d.data, c.width, c.height);
  }, { file, rotate });
}

for (const fx of FIXTURES) {
  test(`lê ${fx.format} (${fx.file}) em qualquer orientação`, async ({ page }) => {
    for (const rotate of [0, 90, 180, 270]) {
      expect(await decodeFixture(page, fx.file, rotate), `girado ${rotate}°`).toEqual({ format: fx.format, text: fx.text });
    }
  });
}

test('imagem sem código não inventa leitura', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const out = [];
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 480;
    const ctx = c.getContext('2d');
    // fundo liso, ruído e texto
    ctx.fillStyle = '#ccc';
    ctx.fillRect(0, 0, 640, 480);
    out.push(window.CodeReader.decode(ctx.getImageData(0, 0, 640, 480).data, 640, 480));
    const noise = ctx.getImageData(0, 0, 640, 480);
    let seed = 1;
    for (let i = 0; i < noise.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = seed & 255;
    }
    out.push(window.CodeReader.decode(noise.data, 640, 480));
    ctx.fillStyle = '#eee';
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 22px sans-serif';
    for (let y = 30; y < 480; y += 28) ctx.fillText('Pneu 205/55 R16 91V ||| III 1111 lll', 10, y);
    out.push(window.CodeReader.decode(ctx.getImageData(0, 0, 640, 480).data, 640, 480));
    return out;
  });
  expect(results).toEqual([null, null, null]);
});

test('Reed-Solomon corrige até o limite e recusa além dele (exemplo da ISO 18004)', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { rsDecode, FORMAT_CODES, VERSION_CODES } = window.CodeReader._internals;
    // "01234567", versão 1-M: 16 codewords de dados + 10 de correção
    const block = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55];
    const corrupt = (positions) => {
      const b = Uint8Array.from(block);
      positions.forEach((p, i) => { b[p] ^= 0x5a + i; });
      return b;
    };
    const five = corrupt([0, 7, 13, 20, 25]);
    const okFive = rsDecode(five, 10) && five.join() === block.join();
    const six = corrupt([1, 4, 9, 14, 19, 24]);
    const okSix = rsDecode(six, 10);
    return { okFive, okSix, format0: FORMAT_CODES[0].code, version7: VERSION_CODES[0].code };
  });
  expect(r.okFive, '5 erros (limite de 10 codewords de correção)').toBe(true);
  expect(r.okSix, '6 erros não pode "corrigir" pra lixo').toBe(false);
  expect(r.format0).toBe(0x5412);
  expect(r.version7).toBe(0x07c94);
});

test('um quadro de câmera sem código é processado rápido', async ({ page }) => {
  const ms = await page.evaluate(() => {
    const w = 1280;
    const h = 720;
    const data = new Uint8ClampedArray(w * h * 4);
    let seed = 7;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = data[i + 1] = data[i + 2] = 120 + (seed & 63);
      data[i + 3] = 255;
    }
    window.CodeReader.decode(data, w, h); // aquece o JIT
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) window.CodeReader.decode(data, w, h);
    return (performance.now() - t0) / 5;
  });
  expect(ms).toBeLessThan(250);
});
