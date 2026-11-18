// Entrada por XML de NF-e: leitura dos produtos (marca, medida, quantidade,
// preço), itens que não são pneu, linhas que precisam de correção e o envio
// pra API. As notas de fixtures/nfe/ imitam as de distribuidoras: nfeProc
// com namespace, descrições escritas de vários jeitos e itens extras.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { buildFakeTires, installCommonMocks, bootIntoApp, waitForContentReady } = require('../helpers/mock-app');

const NFE = (name) => path.join(__dirname, '..', 'fixtures', 'nfe', name);

async function rowsOf(page) {
  return page.$$eval('#xmlRows .batch-row', (rows) =>
    rows.map((r) => ({
      marca: r.querySelector('.b-marca').value,
      medida: r.querySelector('.b-medida').value,
      qtd: r.querySelector('.b-qtd').value,
      preco: r.querySelector('.b-preco').value,
    }))
  );
}

async function abrirXml(page, file) {
  await page.click('#xmlBtn');
  await page.setInputFiles('#xmlFileInput', NFE(file));
  await expect(page.locator('#xmlResult')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(2) });
  await bootIntoApp(page);
  await waitForContentReady(page);
});

test('lê os pneus da nota com as medidas escritas de vários jeitos', async ({ page }) => {
  await abrirXml(page, 'nota-pneus.xml');
  await expect(page.locator('#xmlChaveShown')).toContainText('00123456');

  const rows = await rowsOf(page);
  const porMarca = Object.fromEntries(rows.map((r) => [r.marca, r]));
  expect(porMarca.Comforser).toEqual({ marca: 'Comforser', medida: '175/65 R14', qtd: '4', preco: '289,90' });
  expect(porMarca.Pirelli.medida, '"205/55 R16" com espaço').toBe('205/55 R16');
  expect(porMarca.Fastone.medida, 'ZR (alta velocidade)').toBe('225/45 R17');
  expect(porMarca.Wanli.medida, 'diagonal com hífen').toBe('185/70 R14');
  expect(porMarca.Tracmax.medida, 'sem o R').toBe('175/70 R13');
  expect(porMarca.Maxxis.medida, 'off-road em polegadas').toBe('31X10.50 R15');
  expect(porMarca.Dunlop.medida, 'aro 17.5 de caminhão não vira 17').toBe('215/75 R17.5');
  expect(porMarca.Continental.medida).toBe('225/65 R17');

  // a descrição original aparece pra conferir cada linha
  await expect(page.locator('#xmlRows .batch-desc').first()).toContainText('Na nota: PNEU 175/65R14 82T COMFORSER CF510');
});

test('válvula e câmara de ar ficam de fora, com aviso', async ({ page }) => {
  await abrirXml(page, 'nota-pneus.xml');
  await expect(page.locator('#xmlSkipped')).toContainText('VALVULA TR413 BICO');
  await expect(page.locator('#xmlSkipped')).toContainText('CAMARA DE AR ARO 13');
  const marcas = (await rowsOf(page)).map((r) => r.marca);
  expect(marcas).not.toContain('Valvula');
  expect(marcas).not.toContain('Camara');
});

test('pneu sem medida reconhecida é marcado; corrigido, a nota inteira é salva', async ({ page }) => {
  const bulks = [];
  page.on('request', (r) => { if (r.url().includes('/tires/bulk')) bulks.push(r.postDataJSON()); });
  await abrirXml(page, 'nota-pneus.xml');

  // o recapado veio sem medida na descrição: não salva nada, e diz qual linha
  await page.click('#saveXmlBtn');
  await expect(page.locator('#xmlErr')).toContainText('1 linha(s) marcada(s) em vermelho');
  const invalida = page.locator('#xmlRows .batch-row.invalid');
  await expect(invalida).toHaveCount(1);
  await expect(invalida.locator('.batch-desc')).toContainText('PNEU RECAPADO SEM MEDIDA');
  expect(bulks).toEqual([]);

  await invalida.locator('.b-medida').fill('175/70 R13');
  await page.click('#saveXmlBtn');
  await expect(page.locator('#xmlPanel')).not.toHaveClass(/open/);
  await expect(page.locator('#toast')).toContainText('novo(s)');

  expect(bulks).toHaveLength(1);
  const itens = bulks[0].items;
  expect(itens).toHaveLength(13);
  expect(itens.every((i) => i.notaRef === '00123456' && i.novo === true)).toBe(true);
  expect(itens.find((i) => i.marca === 'Dunlop')).toMatchObject({ medida: '215/75 R17.5', quantidade: 2, preco: '1500,00' });
});

test('erro da API ao salvar aparece pro usuário (não só "verifique sua conexão")', async ({ page }) => {
  await page.route('**/api/tires/bulk', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Banco de dados desatualizado: rode as migrations de database/ no SQL Editor do Supabase.' }) })
  );
  await abrirXml(page, 'nota-pneus.xml');
  await page.locator('#xmlRows .batch-row.invalid, #xmlRows .batch-row').last().locator('.rm').click();
  await page.click('#saveXmlBtn');
  await expect(page.locator('#xmlErr')).toContainText('Banco de dados desatualizado');
  await expect(page.locator('#xmlPanel')).toHaveClass(/open/);
});

test('nota antiga em ISO-8859-1 mantém os acentos', async ({ page }) => {
  await abrirXml(page, 'nota-latin1.xml');
  const rows = await rowsOf(page);
  expect(rows).toEqual([{ marca: 'Tracmax', medida: '175/70 R13', qtd: '3', preco: '245,50' }]);
  await expect(page.locator('#xmlRows .batch-desc')).toContainText('ESPECIFICAÇÃO');
});

test('arquivo que não é NF-e avisa em vez de travar', async ({ page }) => {
  await page.click('#xmlBtn');
  await page.setInputFiles('#xmlFileInput', { name: 'qualquer.xml', mimeType: 'text/xml', buffer: Buffer.from('<?xml version="1.0"?><rss><item>x</item></rss>') });
  await expect(page.locator('#xmlStatus')).toContainText('Não encontrei produtos');
  await page.setInputFiles('#xmlFileInput', { name: 'quebrado.xml', mimeType: 'text/xml', buffer: Buffer.from('<nfe><det>') });
  await expect(page.locator('#xmlStatus')).toContainText('não é um XML válido');
});
