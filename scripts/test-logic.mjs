// Pruebas de la lógica pura y del almacenamiento simulado (sin DOM). Ejecutar: npm test
import assert from 'node:assert/strict';
import {
  baseName, parentPath, joinPath, isUnder, breadcrumbs, displayPath, splitName, extOf, uniqueName, validateName, formatSize, percent,
  trashLabel, daysLeft, norm, kind, guessMime, sortEntries, extraCopies, isZip, isEditable, MAX_NAME, DAY_MS,
} from '../www/js/util.js';
import { createMock, INTERNAL, SDCARD } from '../www/js/mock.js';

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log('✔', name);
};
const I = (p) => `${INTERNAL}/${p}`;
const names = (r) => r.entries.map((e) => e.name);
const volumes = [{ path: INTERNAL, label: 'Almacenamiento interno' }, { path: SDCARD, label: 'Tarjeta SD' }];

// ------------------------------------------------------------------ util
await t('rutas', () => {
  assert.equal(baseName('/a/b/c.txt'), 'c.txt');
  assert.equal(parentPath('/a/b/c.txt'), '/a/b');
  assert.equal(joinPath('/a/b', 'c'), '/a/b/c');
  assert.ok(isUnder('/a/b/c', '/a/b'));
  assert.ok(isUnder('/a/b', '/a/b'));
  assert.ok(!isUnder('/a/bc', '/a/b'), 'no confundir prefijos de nombre');
});

await t('migas y ruta legible', () => {
  const b = breadcrumbs(`${INTERNAL}/DCIM/Camera`, volumes);
  assert.deepEqual(b.map((x) => x.label), ['Almacenamiento interno', 'DCIM', 'Camera']);
  assert.equal(b[2].path, `${INTERNAL}/DCIM/Camera`);
  assert.equal(displayPath(`${SDCARD}/Fotos`, volumes), 'Tarjeta SD/Fotos');
});

await t('splitName / extOf', () => {
  assert.deepEqual(splitName('foto.final.jpg'), { base: 'foto.final', ext: '.jpg' });
  assert.deepEqual(splitName('README'), { base: 'README', ext: '' });
  assert.deepEqual(splitName('.env'), { base: '.env', ext: '' });
  assert.equal(extOf('A.PDF'), 'pdf');
});

await t('uniqueName', () => {
  const taken = new Set(['foto.jpg']);
  assert.equal(uniqueName('foto.jpg', taken), 'foto (2).jpg');
  taken.add('foto (2).jpg');
  assert.equal(uniqueName('foto.jpg', taken), 'foto (3).jpg');
  assert.equal(uniqueName('FOTO.JPG', taken), 'FOTO (3).JPG');
  assert.equal(uniqueName('foto (2).jpg', taken), 'foto (3).jpg');
  assert.equal(uniqueName('otro.jpg', taken), 'otro.jpg');
  assert.equal(uniqueName('v1.2', new Set(['v1.2']), true), 'v1.2 (2)', 'carpeta: el punto no es extensión');
});

await t('validateName', () => {
  assert.equal(validateName('hola.txt'), '');
  assert.notEqual(validateName('   '), '');
  assert.notEqual(validateName('a/b'), '');
  assert.notEqual(validateName('..'), '');
  assert.notEqual(validateName('x'.repeat(MAX_NAME + 1)), '');
  assert.notEqual(validateName('Hola.TXT', new Set(['hola.txt'])), '');
  assert.equal(validateName('ñandú ✓.txt'), '');
});

await t('formatSize / percent', () => {
  assert.equal(formatSize(0), '0 B');
  assert.match(formatSize(1536), /1[,.]5 KB/);
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(5, 0), 0);
  assert.equal(percent(9, 4), 100);
});

await t('papelera: etiquetas y días', () => {
  const now = 1_000_000_000_000;
  assert.equal(daysLeft(now, 30, now), 30);
  assert.equal(trashLabel(now, 30, now), 'Se elimina en 30 días');
  assert.equal(trashLabel(now - 29.5 * DAY_MS, 30, now), 'Se elimina en menos de 1 día');
  assert.equal(trashLabel(now, 0, now), 'Se queda hasta que la vacíes');
});

await t('tipos y mime', () => {
  const k = (name, dir = false) => kind({ name, dir });
  assert.equal(k('a.JPG'), 'image');
  assert.equal(k('a.mp4'), 'video');
  assert.equal(k('a.mp3'), 'audio');
  assert.equal(k('a.pdf'), 'pdf');
  assert.equal(k('a.zip'), 'archive');
  assert.equal(k('a.apk'), 'apk');
  assert.equal(k('a.txt'), 'text');
  assert.equal(k('x', true), 'folder');
  assert.equal(k('a.zzz'), 'file');
  assert.equal(guessMime('a.png'), 'image/png');
  assert.ok(isZip({ name: 'a.zip' }) && !isZip({ name: 'a.zip', dir: true }));
  assert.ok(isEditable({ name: 'a.txt' }) && !isEditable({ name: 'a.png' }));
});

await t('norm ignora acentos y mayúsculas', () => {
  assert.equal(norm('CANCIÓN Ñandú'), norm('cancion nandu'));
});

await t('sortEntries', () => {
  const l = [
    { name: 'b.txt', dir: false, size: 5, mtime: 1 }, { name: 'Zeta', dir: true, size: 0, mtime: 9 },
    { name: 'a10.txt', dir: false, size: 50, mtime: 3 }, { name: 'a2.txt', dir: false, size: 20, mtime: 2 },
  ];
  assert.deepEqual(sortEntries(l).map((e) => e.name), ['Zeta', 'a2.txt', 'a10.txt', 'b.txt'], 'carpetas primero, orden natural');
  assert.deepEqual(sortEntries(l, { key: 'size', dir: 'desc' }).map((e) => e.name), ['Zeta', 'a10.txt', 'a2.txt', 'b.txt']);
  assert.deepEqual(sortEntries(l, { key: 'date', dir: 'desc' }, false).map((e) => e.name), ['Zeta', 'a10.txt', 'a2.txt', 'b.txt']);
});

await t('extraCopies conserva la más antigua', () => {
  const g = [{ path: '/b', mtime: 5 }, { path: '/a', mtime: 1 }, { path: '/c', mtime: 9 }];
  assert.deepEqual(extraCopies(g).sort(), ['/b', '/c']);
});

// ------------------------------------------------------------------ almacenamiento simulado
await t('acceso: sin permiso se reporta', async () => {
  const fs = createMock({ granted: false });
  assert.equal((await fs.hasAccess()).granted, false);
  fs._setAccess(true);
  assert.equal((await fs.hasAccess()).granted, true);
});

await t('listar: oculta los ocultos salvo que se pida', async () => {
  const fs = createMock();
  assert.ok(!names(await fs.list({ path: INTERNAL })).includes('.oculto.txt'));
  assert.ok(names(await fs.list({ path: INTERNAL, showHidden: true })).includes('.oculto.txt'));
});

await t('crear carpeta/archivo y rechazar duplicados', async () => {
  const fs = createMock();
  const { path } = await fs.createFolder({ parent: INTERNAL, name: 'Nueva' });
  assert.equal(path, I('Nueva'));
  await assert.rejects(fs.createFolder({ parent: INTERNAL, name: 'Nueva' }));
  await fs.createFile({ parent: path, name: 'a.txt', text: 'hola' });
  assert.equal((await fs.readText({ path: I('Nueva/a.txt') })).text, 'hola');
  await fs.writeText({ path: I('Nueva/a.txt'), text: 'adiós' });
  assert.equal((await fs.readText({ path: I('Nueva/a.txt') })).text, 'adiós');
});

await t('renombrar', async () => {
  const fs = createMock();
  const r = await fs.rename({ path: I('Documents/notas.txt'), name: 'compras.txt' });
  assert.equal(r.path, I('Documents/compras.txt'));
  await assert.rejects(fs.rename({ path: I('Documents/compras.txt'), name: 'Trabajo' }));
});

await t('copiar: política renombrar / reemplazar / omitir', async () => {
  const fs = createMock();
  const src = I('Download/Factura noviembre.pdf');
  fs._put(I('Documents/Factura noviembre.pdf'), { size: 1 });
  assert.deepEqual((await fs.conflicts({ items: [src], dest: I('Documents') })).names, ['Factura noviembre.pdf']);

  let r = await fs.copy({ items: [src], dest: I('Documents'), policy: 'rename' });
  assert.equal(r.ok, 1);
  assert.ok(fs._nodes.has(I('Documents/Factura noviembre (2).pdf')));
  assert.ok(fs._nodes.has(src), 'copiar no quita el original');

  r = await fs.copy({ items: [src], dest: I('Documents'), policy: 'skip' });
  assert.equal(r.skipped, 1);
  assert.equal(r.ok, 0);

  r = await fs.copy({ items: [src], dest: I('Documents'), policy: 'replace' });
  assert.equal(r.ok, 1);
  assert.notEqual(fs._nodes.get(I('Documents/Factura noviembre.pdf')).size, 1, 'se reemplazó');
});

await t('mover y no meter una carpeta dentro de sí misma', async () => {
  const fs = createMock();
  const r = await fs.move({ items: [I('Download/Proyecto.zip')], dest: I('Documents') });
  assert.equal(r.ok, 1);
  assert.ok(!fs._nodes.has(I('Download/Proyecto.zip')) && fs._nodes.has(I('Documents/Proyecto.zip')));
  const bad = await fs.move({ items: [I('Documents')], dest: I('Documents/Trabajo') });
  assert.equal(bad.ok, 0);
  assert.equal(bad.failed.length, 1);
  const same = await fs.move({ items: [I('Documents/notas.txt')], dest: I('Documents') });
  assert.equal(same.skipped, 1, 'mover a la misma carpeta no hace nada');
});

await t('mover entre volúmenes conserva el contenido de carpetas', async () => {
  const fs = createMock();
  await fs.move({ items: [I('Documents/Trabajo')], dest: `${SDCARD}/Fotos viejas` });
  assert.ok(fs._nodes.has(`${SDCARD}/Fotos viejas/Trabajo/Informe.docx`));
  assert.ok(!fs._nodes.has(I('Documents/Trabajo')));
});

await t('papelera: enviar, listar, restaurar', async () => {
  const fs = createMock();
  const p = I('Documents/notas.txt');
  const r = await fs.trash({ items: [p] });
  assert.equal(r.ok, 1);
  assert.ok(!fs._nodes.has(p));
  const list = (await fs.trashList()).entries;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'notas.txt');
  assert.equal(list[0].orig, p);
  const back = await fs.trashRestore({ paths: [list[0].path] });
  assert.equal(back.ok, 1);
  assert.ok(fs._nodes.has(p));
  assert.equal((await fs.trashList()).entries.length, 0);
});

await t('papelera: restaurar cuando el original está ocupado no pisa nada', async () => {
  const fs = createMock();
  const p = I('Documents/notas.txt');
  const [tr] = (await fs.trash({ items: [p] })).trashed;
  fs._put(p, { size: 7, text: 'nuevo' });
  await fs.trashRestore({ paths: [tr] });
  assert.equal(fs._nodes.get(p).text, 'nuevo', 'el archivo nuevo sigue intacto');
  assert.ok(fs._nodes.has(I('Documents/notas (2).txt')), 'el restaurado queda con otro nombre');
});

await t('papelera: carpeta completa, vaciar y purga por antigüedad', async () => {
  const fs = createMock();
  await fs.trash({ items: [I('Documents/Trabajo')] });
  assert.ok(!fs._nodes.has(I('Documents/Trabajo/Informe.docx')));
  const [e] = (await fs.trashList()).entries;
  assert.ok(e.dir && e.size > 0);
  // purga: no borra lo reciente, sí lo viejo
  assert.equal((await fs.trashPurge({ days: 30 })).ok, 0);
  fs._metas.get(e.path).deletedAt = Date.now() - 31 * DAY_MS;
  assert.equal((await fs.trashPurge({ days: 30 })).ok, 1);
  assert.equal((await fs.trashList()).entries.length, 0);
  await fs.trash({ items: [I('Documents/notas.txt')] });
  assert.equal((await fs.trashEmpty()).ok, 1);
});

await t('papelera: cada volumen usa la suya', async () => {
  const fs = createMock();
  const [tr] = (await fs.trash({ items: [`${SDCARD}/Fotos viejas/playa.jpg`] })).trashed;
  assert.ok(tr.startsWith(`${SDCARD}/.ArchivosPapelera/`), tr);
});

await t('borrar definitivo', async () => {
  const fs = createMock();
  const r = await fs.delete({ items: [I('Documents/Trabajo')] });
  assert.equal(r.ok, 1);
  assert.ok(![...fs._nodes.keys()].some((k) => k.startsWith(I('Documents/Trabajo'))));
});

await t('zip y unzip, con nombre repetido', async () => {
  const fs = createMock();
  const z = I('Documents/Trabajo.zip');
  await fs.zip({ items: [I('Documents/Trabajo')], dest: z });
  assert.ok(fs._nodes.get(z).size > 0);
  await assert.rejects(fs.zip({ items: [I('Documents/Trabajo')], dest: z }), /existe/);
  const out = I('Documents/Extraido');
  const r = await fs.unzip({ path: z, dest: out });
  assert.equal(r.files, 2);
  assert.ok(fs._nodes.has(`${out}/Trabajo/Informe.docx`));
  await assert.rejects(fs.unzip({ path: I('Documents/notas.txt'), dest: I('Documents/X') }));
});

await t('unzip rechaza rutas con ".." (zip-slip) y no deja basura', async () => {
  const fs = createMock();
  fs._put(I('Download/malo.zip'), { size: 10, zip: [['../../evil.txt', { dir: false, size: 1 }]] });
  await assert.rejects(fs.unzip({ path: I('Download/malo.zip'), dest: I('Download/malo') }), /no válidas/);
  assert.ok(!fs._nodes.has(I('Download/malo')), 'la carpeta de destino creada se limpia');
  assert.ok(!fs._nodes.has(I('evil.txt')));
});

await t('buscar: sin acentos ni mayúsculas, recursivo, respeta ocultos', async () => {
  const fs = createMock();
  assert.deepEqual(names(await fs.search({ root: INTERNAL, query: 'cancion NANDU' })), ['Canción ñandú.mp3']);
  assert.ok((await fs.search({ root: I('Documents'), query: 'informe' })).entries.length === 1);
  assert.equal((await fs.search({ root: INTERNAL, query: 'secreto' })).entries.length, 0);
  assert.equal((await fs.search({ root: INTERNAL, query: '.oculto', showHidden: true })).entries.length, 1);
  assert.equal((await fs.search({ root: INTERNAL, query: 'img', limit: 2 })).truncated, true);
  await assert.rejects(fs.search({ root: INTERNAL, query: '   ' }));
});

await t('categorías, recientes y archivos grandes', async () => {
  const fs = createMock();
  const imgs = await fs.category({ type: 'images' });
  assert.ok(imgs.entries.length >= 5 && imgs.entries.every((e) => kind(e) === 'image'));
  assert.ok(imgs.entries.some((e) => e.path.startsWith(SDCARD)), 'incluye la tarjeta SD');
  const page = await fs.category({ type: 'images', limit: 2, offset: 0 });
  assert.equal(page.entries.length, 2);
  assert.equal(page.more, true);
  const counts = await fs.categoryCounts();
  assert.equal(counts.images, imgs.entries.length);
  assert.equal(counts.apks, 1);
  const rec = (await fs.recent({ limit: 5 })).entries;
  assert.equal(rec.length, 5);
  assert.ok(rec.every((e, i) => i === 0 || rec[i - 1].mtime >= e.mtime));
  const big = (await fs.largest({})).entries;
  assert.equal(big[0].name, 'Película.mkv');
  assert.ok(big.every((e) => e.size >= 50 * 1024 * 1024));
});

await t('duplicados: mismo tamaño y mismo contenido', async () => {
  const fs = createMock();
  const { groups } = await fs.duplicates({ minSize: 1024 });
  const flat = groups.map((g) => g.items.map((e) => e.name).sort());
  assert.ok(flat.some((g) => g.includes('Factura noviembre.pdf') && g.includes('Factura noviembre (copia).pdf')));
  assert.ok(flat.some((g) => g.includes('IMG_0001.jpg') && g.includes('IMG_0001 copia.jpg')));
  assert.ok(!flat.some((g) => g.includes('IMG_0002.jpg')), 'mismo nombre de carpeta no basta: debe coincidir el contenido');
  const g = groups.find((x) => x.items.some((e) => e.name === 'Factura noviembre.pdf'));
  assert.equal(extraCopies(g.items).length, 1);
});

await t('abrir y compartir (solo archivos)', async () => {
  const fs = createMock();
  await fs.open({ path: I('Download/app-release.apk') });
  await fs.share({ paths: [I('Documents'), I('Documents/notas.txt')] });
  assert.deepEqual(fs._calls[0].slice(0, 2), ['open', I('Download/app-release.apk')]);
  assert.deepEqual(fs._calls[1][1], [I('Documents/notas.txt')]);
  await assert.rejects(fs.share({ paths: [I('Documents')] }));
});

await t('cancelar una operación', async () => {
  const fs = createMock();
  await fs.cancel({ opId: 'x1' });
  await assert.rejects(fs.copy({ items: [I('Download/Proyecto.zip')], dest: I('Documents'), opId: 'x1' }), (e) => e.code === 'CANCELLED');
  assert.ok(!fs._nodes.has(I('Documents/Proyecto.zip')), 'no se copió nada');
});

console.log(`\n${n} pruebas correctas`);
