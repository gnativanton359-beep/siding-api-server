/**
 * Siding Vision API — small backend for the "Калькулятор сайдинга" artifact.
 *
 * Accepts 4 house-facade photos + a reference wall height, sends them to
 * Claude via the Anthropic API using YOUR OWN API KEY (kept only here, in
 * an environment variable, never sent to the browser), and returns a JSON
 * estimate of wall sizes, openings and corners that the calculator page
 * can drop straight into its inputs.
 *
 * ── Setup ──────────────────────────────────────────────────────────────
 * 1. npm install
 * 2. Set the ANTHROPIC_API_KEY environment variable (never commit it).
 * 3. npm start   → listens on PORT (default 3000)
 *
 * ── Deploy (pick one, both have a free tier) ──────────────────────────
 * Render.com:
 *   - New "Web Service" → connect this folder/repo
 *   - Build command: npm install
 *   - Start command: npm start
 *   - Environment → add ANTHROPIC_API_KEY = sk-ant-...
 *
 * Vercel (as a Node serverless function) also works, but Render/Railway/
 * Fly.io are simpler for a plain long-running Express server like this one.
 *
 * Once deployed you'll have a URL like:
 *   https://your-service.onrender.com
 * Paste that into the calculator's "Свой сервер (API endpoint)" field —
 * it POSTs to  <that URL>/estimate .
 *
 * ── CORS ───────────────────────────────────────────────────────────────
 * Artifacts run on the claude.site / claude.ai origin, so CORS is left
 * open (`cors()`), matching how the front-end calls it directly from the
 * browser. Tighten `origin` below if you want to restrict it.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable. Set it before starting the server.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 4 }, // 15MB/photo, up to 4 photos
});

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

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
      'Ответь СТРОГО JSON без пояснений вокруг, такой формы:\n' +
      '{"walls":[{"label":"Фасад спереди","w":0,"h":' + refH + '}, ...],' +
      '"openings":[{"label":"Окна","qty":0,"w":0,"h":0},{"label":"Двери","qty":0,"w":0,"h":0}],' +
      '"outerCorners":4,"innerCorners":0,"notes":"коротко, что предположено"}';

    const content = [{ type: 'text', text: promptText }];
    for (const f of files) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: f.mimetype,
          data: f.buffer.toString('base64'),
        },
      });
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content }],
    });

    const raw = (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

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
  console.log(`Siding vision API listening on :${PORT}`);
});
