/**
 * Очередь на запуск браузера.
 *
 * Зачем. И Lighthouse, и браузерная диагностика поднимают под каждый вызов отдельный
 * headless Chrome. Один такой запуск это примерно 300 МБ и заметная нагрузка на процессор.
 * Пока запрос один, всё быстро. Если запросов приходит несколько сразу, они начинают
 * драться за процессор, и замедляются ВСЕ: замеряно на боевом сервере, три параллельных
 * прогона превратили 11 секунд в 36 у каждого. Плюс память складывается, а служба живёт
 * под лимитом cgroup рядом с чужими сервисами.
 *
 * Поэтому браузерные вызовы выполняются по очереди. Это не замедление, а наоборот:
 * первый в очереди получает результат за обычные 11 секунд вместо 36, остальные ждут
 * ровно столько, сколько идут предыдущие. Суммарное время то же, а память предсказуема.
 *
 * Очередь ограничена и по длине, и по ожиданию. Бесконечная очередь на публичном сервисе
 * это способ накопить сотню висящих запросов и лечь: лучше честно ответить «занято,
 * повторите через минуту», чем держать соединение до таймаута.
 *
 * Переменные окружения:
 *   BROWSER_CONCURRENCY  сколько браузеров разрешено одновременно (по умолчанию 1)
 *   BROWSER_QUEUE_MAX    сколько запросов может ждать в очереди (по умолчанию 6)
 *   BROWSER_QUEUE_WAIT_MS максимальное ожидание в очереди (по умолчанию 120000)
 */

const CONCURRENCY = Math.max(1, Number(process.env.BROWSER_CONCURRENCY ?? 1));
const QUEUE_MAX = Math.max(0, Number(process.env.BROWSER_QUEUE_MAX ?? 6));
const QUEUE_WAIT_MS = Math.max(5000, Number(process.env.BROWSER_QUEUE_WAIT_MS ?? 120000));

let active = 0;
const waiting = [];

/** Сколько сейчас работает и сколько ждёт. Нужно для /healthz и диагностики. */
export function browserSlotStats() {
  return { active, queued: waiting.length, concurrency: CONCURRENCY, queueMax: QUEUE_MAX };
}

/**
 * Выполняет fn, заняв слот браузера. Слот освобождается в любом случае, даже если fn
 * бросил исключение, иначе одна ошибка навсегда заклинила бы очередь.
 *
 * Бросает ошибку с человеческим текстом, если очередь переполнена или ожидание вышло.
 */
export async function withBrowserSlot(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function acquire() {
  if (active < CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  if (waiting.length >= QUEUE_MAX) {
    return Promise.reject(new Error(
      'Сейчас идут другие проверки браузером и очередь заполнена. Повторите запрос через минуту.'
    ));
  }

  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      reject(new Error('Не дождались свободного браузера: очередь слишком длинная. Повторите позже.'));
    }, QUEUE_WAIT_MS);
    waiting.push(entry);
  });
}

function release() {
  const next = waiting.shift();
  if (!next) {
    active = Math.max(0, active - 1);
    return;
  }
  // Слот не освобождаем, а сразу передаём следующему: счётчик active остаётся верным.
  clearTimeout(next.timer);
  next.resolve();
}
