// Pruebas de la lógica pura (sin DOM). Ejecutar: npm test
import assert from 'node:assert/strict';
import {
  splitName, sanitizeName, uniqueName, validateRename, makeId, formatSize, daysLeft, daysLeftLabel, norm, guessMime, category, sortFiles,
  TRASH_MS, DAY_MS, MAX_NAME,
} from '../www/js/util.js';

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log('✔', name);
};

t('splitName', () => {
  assert.deepEqual(splitName('foto.final.jpg'), { base: 'foto.final', ext: '.jpg' });
  assert.deepEqual(splitName('README'), { base: 'README', ext: '' });
  assert.deepEqual(splitName('.env'), { base: '.env', ext: '' });
  assert.deepEqual(splitName('a.'), { base: 'a.', ext: '' });
});

t('sanitizeName', () => {
  assert.equal(sanitizeName('a/b\\c:d*e?.txt'), 'a_b_c_d_e_.txt');
  assert.equal(sanitizeName('   '), 'archivo');
  assert.equal(sanitizeName('..'), 'archivo');
  assert.equal(sanitizeName(''), 'archivo');
  assert.equal(sanitizeName(null), 'archivo');
  const long = sanitizeName('x'.repeat(400) + '.pdf');
  assert.ok(long.length <= MAX_NAME && long.endsWith('.pdf'));
});

t('uniqueName: duplicados -> nombre (2).ext', () => {
  const taken = new Set(['foto.jpg']);
  assert.equal(uniqueName('foto.jpg', taken), 'foto (2).jpg');
  taken.add('foto (2).jpg');
  assert.equal(uniqueName('foto.jpg', taken), 'foto (3).jpg');
  assert.equal(uniqueName('FOTO.JPG', taken), 'FOTO (3).JPG'); // sin distinguir mayúsculas
  assert.equal(uniqueName('foto (2).jpg', taken), 'foto (3).jpg'); // no apila " (2) (2)"
  assert.equal(uniqueName('otro.jpg', taken), 'otro.jpg');
  assert.equal(uniqueName('nota', new Set(['nota'])), 'nota (2)');
});

t('validateRename', () => {
  const taken = new Set(['b.txt']);
  assert.equal(validateRename('a', '.txt', taken), '');
  assert.match(validateRename('  ', '.txt', taken), /vacío/);
  assert.match(validateRename('a/b', '.txt', taken), /No puede contener/);
  assert.match(validateRename('..', '.txt', taken), /no válido/);
  assert.match(validateRename('b', '.txt', taken), /Ya existe/);
  assert.match(validateRename('B', '.txt', taken), /Ya existe/);
  assert.match(validateRename('x'.repeat(200), '.txt', taken), /Máximo/);
});

t('makeId conserva la extensión saneada', () => {
  assert.match(makeId('foto.JPG'), /\.jpg$/);
  assert.match(makeId('sin_ext'), /^[0-9a-f-]{36}$/);
  assert.match(makeId('raro.a b!'), /\.ab$/);
  assert.notEqual(makeId('a.txt'), makeId('a.txt'));
});

t('formatSize', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1536), '1,5 KB');
  assert.equal(formatSize(20 * 1024 * 1024), '20 MB');
});

t('basurero 30 días', () => {
  const now = Date.now();
  assert.equal(daysLeft(now, now), 30);
  assert.equal(daysLeft(now - 29 * DAY_MS, now), 1);
  assert.ok(daysLeft(now - TRASH_MS, now) <= 0);
  assert.match(daysLeftLabel(now - 29.5 * DAY_MS, now), /menos de 1 día/);
  assert.equal(daysLeftLabel(now - 10 * DAY_MS, now), 'Se elimina en 20 días');
});

t('norm, guessMime, category', () => {
  assert.equal(norm('Canción ÑANDÚ'), 'cancion nandu');
  assert.equal(guessMime('a.PDF'), 'application/pdf');
  assert.equal(guessMime('a.xyz'), 'application/octet-stream');
  assert.equal(category({ name: 'a.jpg', type: '' }), 'image');
  assert.equal(category({ name: 'a.bin', type: 'video/mp4' }), 'video');
  assert.equal(category({ name: 'a.zip', type: 'application/octet-stream' }), 'archive');
  assert.equal(category({ name: 'a.docx', type: '' }), 'doc');
  assert.equal(category({ name: 'a.apk', type: '' }), 'file');
});

t('sortFiles', () => {
  const f = [
    { id: 1, name: 'b10', size: 5, at: 1, trashedAt: 30 },
    { id: 2, name: 'b2', size: 50, at: 3, trashedAt: 10 },
    { id: 3, name: 'A', size: 9, at: 2, trashedAt: 20 },
  ];
  assert.deepEqual(sortFiles(f, 'recent', false).map((x) => x.id), [2, 3, 1]);
  assert.deepEqual(sortFiles(f, 'recent', true).map((x) => x.id), [1, 3, 2]);
  assert.deepEqual(sortFiles(f, 'name', false).map((x) => x.id), [3, 2, 1]); // b2 antes que b10
  assert.deepEqual(sortFiles(f, 'size', false).map((x) => x.id), [2, 3, 1]);
});

console.log(`\n${n} grupos de pruebas OK`);
