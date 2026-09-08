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
//
// --- Function calling ---------------------------------------------------
// This endpoint now declares tools mirroring ARC's local skills (see
// FUNCTION_DECLARATIONS below and tryLocalSkill()/executeFunctionCall() in
// index.html). Two request shapes hit this handler:
//   1. Normal turn: body = { message, history, userName, model, nowISO,
//      tzOffsetMinutes }. If Gemini decides to call one or more tools instead
//      of replying in text, the response is { functionCalls, modelTurnParts }
//      instead of { reply } — the client executes the calls locally and
//      re-POSTs.
//   2. Follow-up turn after local execution: body = { history, functionResults,
//      modelTurnParts, userName, model } (message omitted). The handler
//      reconstructs the conversation (prior turns + the model's function-call
//      turn + a function-response turn) and asks Gemini for the final spoken
//      reply.
// NOTE: the exact request/response shape for Gemini function calling (the
// "function" role, functionCall/functionResponse part names, OBJECT/STRING
// schema casing) reflects Google's documented format as of this writing but
// hasn't been exercised against the live API from this environment — verify
// against https://ai.google.dev/gemini-api/docs/function-calling before
// relying on it, and check the shape of a real 200 response the first time
// you test it end to end.

const GEMINI_MODEL_DEFAULT = 'gemini-3.1-pro-preview'; // kept in sync with index.html's GEMINI_MODEL_DEFAULT

const ALLOWED_ORIGINS = (process.env.ARC_ALLOWED_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FUNCTION_DECLARATIONS = [
  {
    name: 'set_reminder',
    description:
      "Schedule a one-time reminder for a specific future date/time. Use this when the user asks to be reminded of something and their phrasing doesn't match a simple 'remind me at/in ... to ...' pattern (e.g. relative dates, vague times, multi-step requests).",
    parameters: {
      type: 'OBJECT',
      properties: {
        iso_datetime: {
          type: 'STRING',
          description:
            "Absolute date/time the reminder should fire, as a full ISO 8601 UTC timestamp (e.g. \"2026-09-08T03:30:00.000Z\"). Compute this from the current date/time and the user's UTC offset given in context, plus what the user said.",
        },
        task: { type: 'STRING', description: 'What to remind the user about, in a few words.' },
      },
      required: ['iso_datetime', 'task'],
    },
  },
  {
    name: 'set_alarm',
    description:
      'Schedule a one-time alarm for a specific future date/time (like set_reminder, but announced as an alarm going off rather than a task).',
    parameters: {
      type: 'OBJECT',
      properties: {
        iso_datetime: {
          type: 'STRING',
          description: 'Absolute date/time the alarm should go off, as a full ISO 8601 UTC timestamp.',
        },
      },
      required: ['iso_datetime'],
    },
  },
  {
    name: 'set_timer',
    description: 'Start a countdown timer for a duration measured from right now (not a specific clock time).',
    parameters: {
      type: 'OBJECT',
      properties: {
        seconds: { type: 'NUMBER', description: 'Duration of the timer in seconds.' },
        label: { type: 'STRING', description: 'Optional short label for what the timer is for.' },
      },
      required: ['seconds'],
    },
  },
  {
    name: 'list_reminders',
    description: "List the user's currently pending reminders and alarms.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'clear_reminders',
    description: "Cancel and remove all of the user's pending reminders and alarms.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'add_note',
    description: 'Save a short note for the user to look at later.',
    parameters: {
      type: 'OBJECT',
      properties: { text: { type: 'STRING', description: 'The note content.' } },
      required: ['text'],
    },
  },
  {
    name: 'list_notes',
    description: "Read back the user's saved notes.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'open_site',
    description: 'Open a website for the user in a new browser tab.',
    parameters: {
      type: 'OBJECT',
      properties: {
        site: { type: 'STRING', description: 'Site name or URL, e.g. "youtube" or "https://youtube.com".' },
      },
      required: ['site'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate an arithmetic expression and return the numeric result.',
    parameters: {
      type: 'OBJECT',
      properties: { expression: { type: 'STRING', description: 'A plain arithmetic expression, e.g. "12 * 4 + 3".' } },
      required: ['expression'],
    },
  },
];

function systemPrompt(userName, nowISO, tzOffsetMinutes) {
  const name = userName || 'sir';
  const now = nowISO || new Date().toISOString();
  const offsetNote =
    typeof tzOffsetMinutes === 'number'
      ? `The user's local UTC offset is ${tzOffsetMinutes} minutes (JS Date.getTimezoneOffset() convention: positive means behind UTC).`
      : "The user's UTC offset was not provided — ask, or assume UTC, if a time-of-day tool call needs it.";
  return (
    `You are ARC (Autonomous Reactive Companion), a witty, formal, endlessly capable personal AI assistant in the spirit of a classic sci-fi HUD companion. ` +
    `Address the user as "${name}". Keep spoken replies concise (1-3 sentences) unless asked for detail, since they will be read aloud by text-to-speech. ` +
    `Be dry, precise, and quietly confident. ` +
    `Current date/time (ISO, UTC): ${now}. ${offsetNote} ` +
    `You have tools for reminders, alarms, timers, notes, opening sites, and calculation. Most straightforward phrasing is already handled locally before it reaches you, so only ` +
    `by the time you're asked, prefer calling the matching tool over describing what you'd do — but only when the user is clearly asking for one of those actions. For anything else, just reply conversationally.`
  );
}

async function callGemini(apiKey, useModel, systemInstructionText, contents) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent`;
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstructionText }] },
      contents,
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
    }),
  });
  return upstream;
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
  const { message, history, userName, model, nowISO, tzOffsetMinutes, functionResults, modelTurnParts } =
    req.body || {};

  const isFollowUp = Array.isArray(functionResults) && functionResults.length > 0;

  if (!isFollowUp && (!message || typeof message !== 'string')) {
    res.status(400).json({ error: 'Missing "message" string in request body.' });
    return;
  }

  const useModel = (typeof model === 'string' && model.trim()) || GEMINI_MODEL_DEFAULT;
  const priorTurns = Array.isArray(history) ? history.slice(-12) : [];

  let contents;
  if (isFollowUp) {
    contents = [
      ...priorTurns,
      { role: 'model', parts: Array.isArray(modelTurnParts) && modelTurnParts.length ? modelTurnParts : [] },
      {
        role: 'function',
        parts: functionResults.map((fr) => ({
          functionResponse: { name: fr.name, response: fr.response || {} },
        })),
      },
    ];
  } else {
    contents = [...priorTurns, { role: 'user', parts: [{ text: message }] }];
  }

  const sysPrompt = systemPrompt(userName, nowISO, tzOffsetMinutes);

  let upstream;
  try {
    upstream = await callGemini(apiKey, useModel, sysPrompt, contents);
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

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const functionCallParts = parts.filter((p) => p.functionCall);

  if (functionCallParts.length) {
    res.status(200).json({
      functionCalls: functionCallParts.map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} })),
      modelTurnParts: parts,
    });
    return;
  }

  const reply = parts.map((p) => p.text).filter(Boolean).join(' ') || "I didn't get a usable response back.";
  res.status(200).json({ reply });
};