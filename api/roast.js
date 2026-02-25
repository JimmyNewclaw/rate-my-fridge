function parseJsonSafe(text) {
  const raw = String(text || '').trim();

  const candidates = [];

  // Original raw text
  candidates.push(raw);

  // Strip markdown fences
  const noFences = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  candidates.push(noFences);

  // Extract likely JSON object block
  const firstBrace = noFences.indexOf('{');
  const lastBrace = noFences.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(noFences.slice(firstBrace, lastBrace + 1));
  }

  for (const c of candidates) {
    if (!c) continue;

    // 1) direct parse
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return parsed;
      if (typeof parsed === 'string') {
        try {
          const reparsed = JSON.parse(parsed);
          if (reparsed && typeof reparsed === 'object') return reparsed;
        } catch (_) {}
      }
    } catch (_) {}

    // 2) try unescaped JSON-in-string style payloads
    try {
      let t = c;
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1);
      }
      t = t
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"');
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }

  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Missing GOOGLE_API_KEY env var' });
    return;
  }

  try {
    const imageDataUrl = req.body && req.body.imageDataUrl;
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.includes(',')) {
      res.status(400).json({ error: 'Missing or invalid imageDataUrl' });
      return;
    }

    const mimeMatch = imageDataUrl.match(/^data:(.*?);base64,/);
    const mimeType = (mimeMatch && mimeMatch[1]) || 'image/jpeg';
    const base64Data = imageDataUrl.split(',')[1];

    const prompt = `You are Rate My Fridge, a funny but helpful roast chef.
Analyze this fridge image and return STRICT JSON only with this exact schema:
{
  "score": number, // decimal 1.00-10.00 with two decimal precision
  "roast_name": string,
  "roast": string, // playful, not mean
  "recipes": [
    { "title": "recipe 1", "instructions": "step-by-step instructions" },
    { "title": "recipe 2", "instructions": "step-by-step instructions" }
  ],
  "shopping_list": ["item 1", "item 2", "item 3"]
}
Rules:
- Score must use two decimal place precision (example: 7.34, not 7).
- Roast must be 4-5 sentences.
- Include a creative roast_name like "The Takeout Graveyard" or "Condiment Museum".
- Give exactly 2 recipe ideas based on visible ingredients.
- Recipe instructions should be clear and practical.
- Shopping list should be concise and practical (5-10 items).
- If image is unclear, still provide best-effort output.`;

    const apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data
                }
              }
            ]
          }
        ]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      res.status(apiRes.status).json({ error: `Gemini error: ${errText}` });
      return;
    }

    const data = await apiRes.json();
    const rawText = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts)
      ? data.candidates[0].content.parts.map((p) => p.text || '').join('\n')
      : '';

    const parsed = parseJsonSafe(rawText);
    if (!parsed) {
      res.status(502).json({ error: 'Could not parse model response', rawText });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
