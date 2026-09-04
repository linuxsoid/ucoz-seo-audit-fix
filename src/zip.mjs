/**
 * Минимальный сборщик ZIP-архивов.
 *
 * Зачем свой, а не библиотека. Нужно ровно одно: сложить десяток готовых файлов в один
 * архив и отдать его браузеру. Ради этого тащить зависимость не стоит, тем более что
 * сжатие в Node уже есть в модуле zlib, а формат ZIP в части, которая нам нужна, простой
 * и стабильный тридцать лет.
 *
 * Что поддерживается: метод deflate, имена в UTF-8, файлы любого размера до 4 ГБ.
 * Чего нет: паролей, папок, ZIP64, потоковой записи. Всё это здесь не нужно.
 *
 * Формат, если понадобится править. Архив состоит из трёх частей подряд:
 *   1. Для каждого файла: локальный заголовок и сразу за ним сжатые данные.
 *   2. Центральный каталог: по записи на каждый файл, с указанием смещения его заголовка.
 *   3. Хвост: сколько записей в каталоге, где он начинается и какой длины.
 * Читалка идёт с конца: находит хвост, по нему каталог, по каталогу файлы.
 */

import { deflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
// Версия 2.0: минимальная, поддерживающая deflate.
const VERSION_DEFLATE = 20;
// Бит 11 говорит читалке, что имя файла в UTF-8. Без него кириллица в именах ломается.
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;

/**
 * Собирает ZIP из списка файлов.
 * @param {Array<{name: string, data: Buffer|string}>} files
 * @returns {Buffer}
 */
export function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const stamp = dosDateTime(new Date());

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_DEFLATE, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_DEFLATE, 4);
    central.writeUInt16LE(VERSION_DEFLATE, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, end]);
}

/**
 * CRC32, как того требует формат ZIP. Таблица считается один раз при первом обращении:
 * без неё побайтовый расчёт на файле в мегабайт заметно медленнее.
 */
let crcTable = null;

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** ZIP хранит дату в формате MS-DOS: две упакованные 16-битные величины. */
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  };
}
