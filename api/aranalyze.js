export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } }
};

// ─── Kimchi models (CAST AI) ─────────────────────────────────────────────────
// All Kimchi-hosted models we route to. Add new model slugs here as needed.
const KIMCHI_MODELS = new Set([
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k2.6",
  "kimi-k2.5",
  "nemotron-3-super-fp4"
]);

// ─── Kimchi (OpenAI-compatible) ──────────────────────────────────────────────
// Used for open-weight models served via Kimchi by CAST AI.
async function callKimchi(system, message, model) {
  const KIMCHI_KEY = process.env.KIMCHI_API_KEY;
  if (!KIMCHI_KEY) throw new Error("KIMCHI_API_KEY not set");

  const url = "https://llm.kimchi.dev/openai/v1/chat/completions";

  const body = {
    model: model,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: message }
    ],
    temperature: 0.1,
    max_tokens: 32768
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${KIMCHI_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Kimchi error: ${response.status}`);
  }

  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Kimchi returned no content");
  return text;
}

// ─── Gemini (primary for Gemini-tagged tools) ────────────────────────────────
// Accepts a `model` parameter so callers can pick gemini-2.5-flash-lite (default,
// fastest), gemini-2.5-flash (better quality, still fast), or gemini-2.5-pro (best).
async function callGemini(system, message, model) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");

  const modelName = model || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_KEY}`;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: message }] }],
    generationConfig: { maxOutputTokens: 65536, temperature: 0.1 }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini error: ${response.status}`);
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    .map(p => p.text)
    .join("\n") || "";

  if (!text) throw new Error("Gemini returned no content");
  return text;
}

// ─── Anthropic Claude (fallback) ────────────────────────────────────────────
async function callAnthropic(system, message) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 32768,
      temperature: 0.1,
      system: system,
      messages: [{ role: "user", content: message }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Anthropic error: ${response.status}`);
  }

  const text = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  if (!text) throw new Error("Anthropic returned no content");
  return text;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { system, message, model } = req.body;

    // Route by model: Kimchi-hosted models go to Kimchi, everything else to Gemini.
    const useKimchi = model && KIMCHI_MODELS.has(model);

    if (useKimchi) {
      // 1️⃣ Try Kimchi
      try {
        const text = await callKimchi(system, message, model);
        return res.status(200).json({ text, provider: "kimchi", model });
      } catch (kimchiError) {
        console.warn("[aranalyze] Kimchi failed, falling back to Anthropic:", kimchiError.message);
      }
    } else {
      // 1️⃣ Try Gemini (caller can specify model; defaults to flash-lite)
      try {
        const text = await callGemini(system, message, model);
        return res.status(200).json({ text, provider: "gemini", model: model || "gemini-2.5-flash-lite" });
      } catch (geminiError) {
        console.warn("[aranalyze] Gemini failed, falling back to Anthropic:", geminiError.message);
      }
    }

    // 2️⃣ Fallback to Anthropic Claude (regardless of primary)
    const text = await callAnthropic(system, message);
    return res.status(200).json({ text, provider: "anthropic-fallback" });

  } catch (e) {
    console.error("[aranalyze] All providers failed:", e.message);
    res.status(500).json({ error: e.message });
  }
}
