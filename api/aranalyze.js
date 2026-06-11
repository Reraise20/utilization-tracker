export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } }
};

// ─── Gemini (primary) ───────────────────────────────────────────────────────
// Accepts a `model` parameter so callers can pick gemini-2.5-flash-lite (default,
// fastest), gemini-2.5-flash (better quality, still fast), or gemini-2.5-pro (best).
//
// TRANSPARENCY UPGRADE:
//  • thinkingBudget is bounded so reasoning tokens can't silently eat the output budget
//  • finishReason is checked after every call
//  • if the model stops at MAX_TOKENS, we auto-continue (up to 3 rounds) and stitch
//  • full metadata (provider, model, finishReason, continuations, token usage)
//    is returned to the client so the UI can show exactly what happened

const MAX_CONTINUATIONS = 3;

async function geminiCall(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini error: ${response.status}`);
  }
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts
    ?.filter(p => p.text && !p.thought)
    .map(p => p.text)
    .join("\n") || "";
  return {
    text,
    finishReason: cand?.finishReason || "UNKNOWN",
    usage: {
      promptTokens:   data.usageMetadata?.promptTokenCount    || 0,
      outputTokens:   data.usageMetadata?.candidatesTokenCount || 0,
      thoughtTokens:  data.usageMetadata?.thoughtsTokenCount  || 0
    }
  };
}

async function callGemini(system, message, model) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");

  const modelName = model || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_KEY}`;

  const generationConfig = {
    maxOutputTokens: 65536,
    temperature: 0.1,
    // Cap reasoning so the visible report always gets the bulk of the budget.
    // (gemini-2.5-flash thinks dynamically by default; unbounded thinking was a
    // hidden cause of mid-report truncation.)
    thinkingConfig: { thinkingBudget: 4096 }
  };

  // First pass
  const baseBody = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: message }] }],
    generationConfig
  };

  let result = await geminiCall(url, baseBody);
  if (!result.text) throw new Error("Gemini returned no content (finishReason: " + result.finishReason + ")");

  let fullText      = result.text;
  let continuations = 0;
  let usage         = { ...result.usage };

  // Auto-continuation loop — stitch truncated output back together
  while (result.finishReason === "MAX_TOKENS" && continuations < MAX_CONTINUATIONS) {
    continuations++;
    const contBody = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        { role: "user",  parts: [{ text: message }] },
        { role: "model", parts: [{ text: fullText }] },
        { role: "user",  parts: [{ text:
          "Your previous response was cut off mid-output. Continue EXACTLY where you left off — " +
          "do not repeat anything already written, do not restart sections, do not add a preamble. " +
          "If you were inside a markdown table, continue with the next table row." }] }
      ],
      generationConfig
    };
    result = await geminiCall(url, contBody);
    if (!result.text) break;
    fullText += result.text;
    usage.promptTokens  += result.usage.promptTokens;
    usage.outputTokens  += result.usage.outputTokens;
    usage.thoughtTokens += result.usage.thoughtTokens;
  }

  return {
    text: fullText,
    meta: {
      provider: "gemini",
      model: modelName,
      finishReason: result.finishReason,
      truncated: result.finishReason === "MAX_TOKENS",
      continuations,
      usage
    }
  };
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

  return {
    text,
    meta: {
      provider: "anthropic-fallback",
      model: "claude-sonnet-4-6",
      finishReason: data.stop_reason || "unknown",
      truncated: data.stop_reason === "max_tokens",
      continuations: 0,
      usage: {
        promptTokens:  data.usage?.input_tokens  || 0,
        outputTokens:  data.usage?.output_tokens || 0,
        thoughtTokens: 0
      }
    }
  };
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

    // 1️⃣ Try Gemini (caller can specify model; defaults to flash-lite)
    try {
      const out = await callGemini(system, message, model);
      return res.status(200).json({ text: out.text, provider: "gemini", model: out.meta.model, meta: out.meta });
    } catch (geminiError) {
      console.warn("[aranalyze] Gemini failed, falling back to Anthropic:", geminiError.message);
    }

    // 2️⃣ Fallback to Anthropic Claude
    const out = await callAnthropic(system, message);
    return res.status(200).json({ text: out.text, provider: "anthropic-fallback", meta: out.meta });

  } catch (e) {
    console.error("[aranalyze] Both providers failed:", e.message);
    res.status(500).json({ error: e.message });
  }
}
