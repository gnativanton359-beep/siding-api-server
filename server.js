/**
 * Siding Vision API — small backend for the "Калькулятор сайдинга" page.
 *
 * Accepts up to 4 house-facade photos + a reference wall height, sends them
 * to Google Gemini (free-tier API) using YOUR OWN key (kept only here, in
 * an environment variable, never sent to the browser), and returns a JSON
 * estimate of wall sizes, openings and corners that the calculator page
 * can drop straight into its inputs.
 *
 * ── Setup ──────────────────────────────────────────────────────────────
 * 1. npm install
 * 2. Get a free key at https://aistudio.google.com/apikey (Google account,
 *    no card required) and set it as GEMINI_API_KEY.
 * 3. npm start   → listens on PORT (default 3000)
 *
 * ── Deploy (free tier) ────────────────────────────────────────────────
 * Render.com:
 *   - New "Web Service" → connect this folder/repo
 *   - Build command: npm install
 *   - Start command: npm start
 *   - Environment → add GEMINI_API_KEY = AIza...
 *
 * Once deployed you'll have a URL like:
 *   https://your-service.onrender.com
 * Paste that into the calculator's "Свой сервер (API endpoint)" field —
 * it POSTs to  <that URL>/estimate .
 *
 * ── CORS ───────────────────────────────────────────────────────────────
 * The calculator page calls this directly from the browser, so CORS is
 * left open (`cors()`). Tighten `origin` below if you want to restrict it.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable. Get a free key at https://aistudio.google.com/apikey and set it before starting the server.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
// Google renames/retires Gemini model IDs fairly often. Rather than hard-code
// one name, we keep an ordered list and walk down it: retry the first model
// a few times (for temporary overload), and if it's overloaded OR has been
// retired (404 "no longer available"), move on to the next candidate.
// You can override the whole list via GEMINI_MODELS="a,b,c" as an env var.
const MODEL_CANDIDATES = (process.env.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.8-flash,gemini-2.5-flash,gemini-2.0-flash')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const MODEL_NAME = MODEL_CANDIDATES[0]; // used only for the /health label

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isOverloaded(err) {
  const msg = (err && err.message) || String(err);
  return /503|overloaded|high demand/i.test(msg);
}
function isRetiredModel(err) {
  const msg = (err && err.message) || String(err);
  return /404|no longer available|not found/i.test(msg);
}
function isQuotaExceeded(err) {
  const msg = (err && err.message) || String(err);
  return /429|quota|RESOURCE_EXHAUSTED/i.test(msg);
}

// Tries modelName up to `attempts` times (with short backoff) before
// giving up; the caller decides what to do next (e.g. try a fallback model).
async function generateWithRetry(modelName, parts, attempts) {
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json' },
  });
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await model.generateContent(parts);
    } catch (err) {
      lastErr = err;
      if (!isOverloaded(err) || i === attempts - 1) throw err;
      await sleep(1200 * (i + 1)); // 1.2s, 2.4s, ...
    }
  }
  throw lastErr;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 4 }, // 15MB/photo, up to 4 photos
});

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, model: MODEL_NAME }));

const SLOT_LABELS = ['Фасад спереди', 'Фасад сзади', 'Фасад слева', 'Фасад справа'];

app.post('/estimate', upload.array('photos', 4), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length < 1) {
      return res.status(400).json({ error: 'invalid_request', message: 'Attach at least one photo under field "photos".' });
    }

    const refH = Math.max(0.5, parseFloat(req.body.refHeight) || 3);

    const promptText =
      'Ты помогаешь рассчитать виниловый сайдинг по фотографиям дома. ' +
      `Даны фото фасадов дома (до 4 штук), по порядку: ${SLOT_LABELS.slice(0, files.length).join(', ')}. ` +
      `Известная высота стены от отмостки/цоколя до карниза (одна и та же для всех фасадов, используй как масштаб): ${refH} м. ` +
      'Для каждого фасада на глаз оцени ширину стены в метрах (используя высоту как масштаб и пропорции дома), ' +
      'посчитай видимые окна (количество и среднюю ширину/высоту, м) и двери (количество и среднюю ширину/высоту, м), ' +
      'и есть ли фронтон (треугольная часть под крышей) — если да, прибавь его площадь к площади стены приблизительно. ' +
      'Также оцени общее число НАРУЖНЫХ углов дома и число ВНУТРЕННИХ углов (0, если дом простой прямоугольный). ' +
      'Если фасад плохо виден — дай разумную оценку по пропорциям и отметь это в notes. ' +
      'Ответь СТРОГО JSON без пояснений вокруг и без markdown-разметки, такой формы:\n' +
      '{"walls":[{"label":"Фасад спереди","w":0,"h":' + refH + '}, ...],' +
      '"openings":[{"label":"Окна","qty":0,"w":0,"h":0},{"label":"Двери","qty":0,"w":0,"h":0}],' +
      '"outerCorners":4,"innerCorners":0,"notes":"коротко, что предположено"}';

    const parts = [{ text: promptText }];
    for (const f of files) {
      parts.push({
        inlineData: {
          mimeType: f.mimetype,
          data: f.buffer.toString('base64'),
        },
      });
    }

    let result, lastErr;
    for (let m = 0; m < MODEL_CANDIDATES.length; m++) {
      const modelName = MODEL_CANDIDATES[m];
      try {
        result = await generateWithRetry(modelName, parts, m === 0 ? 3 : 2);
        break;
      } catch (err) {
        lastErr = err;
        // Overloaded, retired, or its free-tier daily quota is used up —
        // each model has its OWN quota, so try the next one in the list.
        if (!isOverloaded(err) && !isRetiredModel(err) && !isQuotaExceeded(err)) throw err;
      }
    }
    if (!result) throw lastErr || new Error('No Gemini model in GEMINI_MODELS worked.');
    const raw = result.response.text().trim();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) data = JSON.parse(match[0]);
      else throw new Error('Model did not return parseable JSON: ' + raw.slice(0, 300));
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    const message = isQuotaExceeded(err)
      ? 'Бесплатный дневной лимит запросов к Google Gemini исчерпан (у всех моделей). Попробуйте завтра, либо введите размеры вручную прямо сейчас.'
      : isOverloaded(err)
      ? 'Сервис распознавания фото сейчас перегружен у Google (это временно). Подождите минуту и попробуйте ещё раз, либо введите размеры вручную.'
      : (err.message || String(err));
    res.status(500).json({ error: 'upstream_error', message });
  }
});

app.listen(PORT, () => {
  console.log(`Siding vision API (Gemini: ${MODEL_NAME}) listening on :${PORT}`);
});
