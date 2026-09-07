// /api/gemini.js
// Vercel serverless function (Node.js runtime). Proxies requests to the
// Gemini generateContent endpoint so GEMINI_API_KEY never reaches the browser.
//
// Env vars (set in Vercel Project Settings -> Environment Variables):
//   GEMINI_API_KEY      required. Your Gemini API key.
//   ARC_SHARED_SECRET   optional. If set, requests must include a matching
//                        "x-arc-secret" header (the ARC frontend sends this
//                        from the "Access secret" field in Settings).
//   ARC_ALLOWED_ORIGIN  optional. Comma-separated list of allowed Origins,
//                        e.g. "https://arc.vercel.app,https://arc.yourdomain.com".
//                        If set, requests with a mismatched Origin are rejected.
//
// Neither check is airtight on its own (this is a static site with no build
// step, so nothing "secret" can be baked into the client bundle) — they're
// meant to stop casual/automated abuse of the public endpoint, not a
// determined attacker. Set both for a single-user personal app like this.

const GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash';

const ALLOWED_ORIGINS = (process.env.ARC_ALLOWED_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function systemPrompt(userName) {
  const name = userName || 'sir';
  return (
    `You are ARC (Autonomous Reactive Companion), a witty, formal, endlessly capable personal AI assistant in the spirit of a classic sci-fi HUD companion. ` +
    `Address the user as "${name}". Keep spoken replies concise (1-3 sentences) unless asked for detail, since they will be read aloud by text-to-speech. ` +
    `Be dry, precise, and quietly confident.`
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  // --- Origin check (defense in depth, optional) ---
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: 'Origin not allowed.' });
    return;
  }

  // --- Shared secret check (optional) ---
  const expectedSecret = process.env.ARC_SHARED_SECRET;
  if (expectedSecret) {
    const provided = req.headers['x-arc-secret'];
    if (provided !== expectedSecret) {
      res.status(401).json({ error: 'Unauthorized.' });
      return;
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY is not set.' });
    return;
  }

  // Vercel Node functions auto-parse a JSON body into req.body.
  const { message, history, userName, model } = req.body || {};

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Missing "message" string in request body.' });
    return;
  }

  const useModel = (typeof model === 'string' && model.trim()) || GEMINI_MODEL_DEFAULT;
  const priorTurns = Array.isArray(history) ? history.slice(-10) : [];
  const contents = [...priorTurns, { role: 'user', parts: [{ text: message }] }];

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent`;

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt(userName) }] },
        contents,
      }),
    });
  } catch (err) {
    console.error('Network error reaching Gemini:', err);
    res.status(502).json({ error: 'Could not reach Gemini (network error).' });
    return;
  }

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    console.error('Gemini returned non-JSON response, status', upstream.status);
    res.status(502).json({ error: 'Gemini returned an unreadable response.' });
    return;
  }

  if (!upstream.ok) {
    console.error('Gemini API error', upstream.status, data);
    if (upstream.status === 429) {
      res.status(429).json({ error: 'Gemini rate limit hit — try again in a moment.' });
      return;
    }
    if (upstream.status === 404) {
      res.status(404).json({ error: `Model "${useModel}" not found — check the model name in settings.` });
      return;
    }
    const detail = data?.error?.message || `Gemini error (status ${upstream.status}).`;
    res.status(upstream.status).json({ error: detail });
    return;
  }

  const reply =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ') ||
    "I didn't get a usable response back.";

  res.status(200).json({ reply });
};
