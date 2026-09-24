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
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 4 },
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

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { responseMimeType: 'application/json' },
    });

    const parts = [{ text: promptText }];
    for (const f of files) {
      parts.push({
        inlineData: {
          mimeType: f.mimetype,
          data: f.buffer.toString('base64'),
        },
      });
    }

    const result = await model.generateContent(parts);
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
    res.status(500).json({ error: 'upstream_error', message: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Siding vision API (Gemini: ${MODEL_NAME}) listening on :${PORT}`);
});
