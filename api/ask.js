// Vercel Serverless Function → POST /api/ask
//
// Единственная задача: убедиться, что запрос действительно пришёл из Telegram
// от конкретного пользователя, и переслать его в n8n.
//
// Токен бота живёт ЗДЕСЬ, в переменных окружения Vercel, а не в Code-ноде n8n:
// исходник Code-ноды выгружается в workflow.json дословно и уехал бы в LMS.
//
// Переменные окружения (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN  — токен бота из BotFather
//   N8N_CHAT_URL        — Production Chat URL ноды Chat Trigger
//   ALLOW_ANONYMOUS     — '1' только для локальной отладки вне Telegram

import crypto from 'node:crypto';

const MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_QUESTION_LENGTH = 1000;

/**
 * Проверяет подпись initData по алгоритму Telegram.
 * secret = HMAC_SHA256(key: 'WebAppData', data: bot_token)
 * hash   = HMAC_SHA256(key: secret,       data: data_check_string)
 * data_check_string — все поля кроме hash, «ключ=значение», отсортированные
 * по ключу и склеенные через \n.
 * Возвращает объект пользователя или null.
 */
function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // Сравнение постоянного времени: обычное === утекает информацию по таймингам.
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Протухшая подпись — это переигранный запрос.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  if (Math.floor(Date.now() / 1000) - authDate > MAX_AGE_SECONDS) return null;

  try {
    return JSON.parse(params.get('user') ?? 'null');
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  const chatUrl = process.env.N8N_CHAT_URL;
  if (!chatUrl) {
    return res.status(500).json({ error: 'Не задан N8N_CHAT_URL' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const question = String(body?.question ?? '').trim();
  const sessionId = String(body?.sessionId ?? '').slice(0, 64) || crypto.randomUUID();

  if (!question) return res.status(400).json({ error: 'Пустой вопрос' });
  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({ error: `Вопрос длиннее ${MAX_QUESTION_LENGTH} символов` });
  }

  const user = verifyInitData(body?.initData, process.env.TELEGRAM_BOT_TOKEN);
  const anonymous = process.env.ALLOW_ANONYMOUS === '1';

  if (!user && !anonymous) {
    // Без подписи запрос мог прислать кто угодно. Секрет в заголовке от
    // фронтенда защитой не является — он лежит в JS открытым текстом.
    return res.status(401).json({
      error: 'Не удалось подтвердить, что запрос пришёл из Telegram. Откройте приложение через кнопку меню бота.',
    });
  }

  try {
    const upstream = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sendMessage',
        sessionId,
        chatInput: question,
        // chat_id едет в теле: Chat Trigger не пробрасывает заголовки в workflow.
        tg_chat_id: user ? String(user.id) : '',
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const text = await upstream.text();
    const payload = safeParse(text);

    if (!upstream.ok && !payload) {
      return res.status(502).json({ error: `n8n ответил ${upstream.status}` });
    }

    res.setHeader('Cache-Control', 'no-store');
    // 202 из ветки Б означает «черновик ушёл на согласование» — это не ошибка.
    return res.status(upstream.status === 202 ? 202 : 200).json(payload ?? { output: text });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return res.status(504).json({
      error: timedOut
        ? 'n8n не ответил за 60 секунд. Проверьте, что workflow опубликован.'
        : 'Не удалось связаться с n8n.',
    });
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
