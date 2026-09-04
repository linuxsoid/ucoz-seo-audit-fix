/**
 * Тесты сборщика ZIP.
 *
 * Формат разбираем обратно своим кодом, а не библиотекой: смысл теста именно в том, чтобы
 * убедиться, что байты лежат там, где их ждёт любая читалка. Проверка библиотекой
 * доказывала бы только совместимость с этой библиотекой.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createZip } from '../src/zip.mjs';

const END_SIGNATURE = 0x06054b50;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Разбирает архив так, как это делает читалка: с конца, через центральный каталог. */
function readZip(buf) {
  // Хвост ищем с конца: перед ним может лежать что угодно.
  let end = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === END_SIGNATURE) {
      end = i;
      break;
    }
  }
  assert.notEqual(end, -1, 'в архиве нет хвоста End of Central Directory');

  const count = buf.readUInt16LE(end + 10);
  const centralSize = buf.readUInt32LE(end + 12);
  const centralOffset = buf.readUInt32LE(end + 16);
  assert.equal(centralOffset + centralSize, end, 'каталог не стыкуется с хвостом');

  const files = [];
  let p = centralOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), CENTRAL_SIGNATURE, `запись ${i} каталога без подписи`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    assert.equal(buf.readUInt32LE(localOffset), LOCAL_SIGNATURE, `${name}: локальный заголовок не там, где сказал каталог`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    files.push({ name, flags, method, crc, rawSize, compressedSize, compressed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { count, files };
}

/** Та же таблица CRC32, что требует формат. Считаем независимо от кода сборщика. */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

test('архив с одним текстовым файлом читается обратно', () => {
  const body = 'привет, это отчёт';
  const zip = createZip([{ name: 'otchet.md', data: body }]);
  const { count, files } = readZip(zip);

  assert.equal(count, 1);
  assert.equal(files[0].name, 'otchet.md');
  assert.equal(files[0].method, 8, 'метод должен быть deflate');
  assert.equal(inflateRawSync(files[0].compressed).toString('utf8'), body);
});

test('CRC32 и размеры совпадают с независимым расчётом', () => {
  const raw = Buffer.from('a'.repeat(5000) + 'конец', 'utf8');
  const { files } = readZip(createZip([{ name: 'a.txt', data: raw }]));

  assert.equal(files[0].rawSize, raw.length);
  assert.equal(files[0].crc, crc32(raw));
  assert.ok(files[0].compressedSize < raw.length, 'повторяющиеся данные должны сжаться');
});

test('кириллица в имени помечена флагом UTF-8 и читается', () => {
  const name = 'отчёт-для-человека.md';
  const { files } = readZip(createZip([{ name, data: 'x' }]));

  assert.equal(files[0].name, name);
  assert.equal(files[0].flags & 0x0800, 0x0800, 'без бита 11 читалка испортит кириллицу');
});

test('смещения не сбиваются на нескольких файлах', () => {
  const input = [
    { name: 'один.md', data: 'первый' },
    { name: 'два.json', data: JSON.stringify({ b: 'второй'.repeat(100) }) },
    { name: 'три.bin', data: Buffer.from([0, 1, 2, 255, 254]) },
    { name: 'четыре.txt', data: '' }
  ];
  const { count, files } = readZip(createZip(input));

  assert.equal(count, input.length);
  for (let i = 0; i < input.length; i += 1) {
    assert.equal(files[i].name, input[i].name);
    const expected = Buffer.isBuffer(input[i].data)
      ? input[i].data
      : Buffer.from(String(input[i].data), 'utf8');
    assert.deepEqual(inflateRawSync(files[i].compressed), expected, `${files[i].name}: содержимое не совпало`);
  }
});

test('бинарные данные не портятся', () => {
  // Последовательность всех байтов: если где-то данные пройдут через строку, тест упадёт.
  const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const { files } = readZip(createZip([{ name: 'bytes.bin', data: raw }]));
  assert.deepEqual(inflateRawSync(files[0].compressed), raw);
});

test('пустой список файлов даёт корректный пустой архив', () => {
  // Такое бывает, если проверка не дала ни одного файла. Архив должен остаться читаемым,
  // а не превратиться в мусор, который читалка не откроет.
  const zip = createZip([]);
  const { count } = readZip(zip);
  assert.equal(count, 0);
  assert.equal(zip.length, 22, 'пустой архив это только хвост');
});
