// ============================================================================
// api/goals-ai-assist.js
// ----------------------------------------------------------------------------
// Takes the ai_payload produced by /api/goals-compute and returns prioritized
// recommendations to lift the rating before month-end.
//
// Uses Anthropic Claude (claude-sonnet-4-6) — same pattern as api/aranalyze.js.
// No npm dependencies. Reuses ANTHROPIC_API_KEY env var already set in Vercel.
//
// Usage:
//   POST /api/goals-ai-assist
//   body: <ai_payload object from goals-compute response>
// ============================================================================

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};

const CLAUDE_MODEL = "claude-sonnet-4-6";


// ── Anthropic Claude ────────────────────────────────────────────────────────
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
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      temperature: 0.2,
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

  return { text, usage: data.usage || null };
}


// ── System prompt — fixed across requests ───────────────────────────────────
const SYSTEM_PROMPT = `You are a performance coach for an offshore RCM (Revenue Cycle Management) team lead at a US gastroenterology billing operation. Your job is to analyze a single team member's monthly goal-sheet performance against their rubric and return concrete, prioritized actions they can take in the remaining days of the month to lift their final rating.

The rubric scores 11 metrics across 4 categories: Productivity (Utilization, Audit Completion, Attendance), Accuracy & TAT (ATA Accuracy, PKT, MCS past due, JIRA TAT), Continuous Improvement (Process Improvement Ideas, Grade Improvement, Client Escalation EWS), and a Reverse Metric (Warning Letter / No Call No Show).

Each metric has a rating 1-5 and a weightage. Final rating = sum of (rating × weightage). Score bands: 4.50+ = Outstanding (5), 3.50-4.49 = Exceeds (4), 2.50-3.49 = Meets (3), 1.50-2.49 = Below (2), <1.50 = Needs improvement (1).

OUTPUT RULES:
- Use markdown formatting. **Bold** headers and key numbers.
- Open with one sentence: where they stand and where they're trending.
- Then a **Top Priorities** section: 3 concrete actions, ordered by score lift. For each: what to do, target metric, expected rating jump, score impact (e.g. "+0.15").
- Then a **Watch-outs** section (1-2 lines): metrics that look fine but could slip.
- Then a **Already strong** section (1 line): metrics already at rating 5, acknowledge briefly.
- Total length: 200-350 words. Be specific with numbers, never vague. Use the actual metric values from the payload.
- Don't list every metric. Don't repeat the payload back. Don't add disclaimers about being an AI.
- Tone: direct, peer-to-peer, no fluff, no corporate-speak.`;


// ── Build the user message from the structured payload ──────────────────────
function buildUserMessage(payload) {
  const c = payload.context || {};
  const t = payload.current_totals || {};
  const p = payload.projected_totals;
  const gaps = (payload.gaps || []).slice(0, 8);

  let msg = `# Performance Snapshot for ${c.employee_name}\n`;
  msg += `Period: ${c.period} (${c.is_current_month ? `day ${c.days_elapsed} of ${c.days_total}` : "complete"})\n\n`;

  msg += `## Current State\n`;
  msg += `- Current total score: **${t.score}** -> rating ${t.rating} (${t.rating_label})\n`;
  if (p) {
    msg += `- Projected end-of-month: **${p.score}** -> rating ${p.rating} (${p.rating_label})\n`;
  }
  msg += `\n## Per-Metric Detail\n`;

  for (const m of payload.metrics) {
    const ach = m.achieved == null ? "no data yet" : m.achieved;
    const rat = m.rating == null ? "N/A" : `${m.rating}/5`;
    const proj = m.projected_rating != null && m.projected_rating !== m.rating
      ? ` -> projected ${m.projected_rating}/5`
      : "";
    msg += `- **${m.label}** [${m.weightage_pct}% wt, ${m.category}] - achieved: ${ach}, rating: ${rat}${proj}, weighted: ${m.weighted_score ?? "-"}\n`;
    msg += `  ${m.explanation}\n`;
  }

  if (gaps.length) {
    msg += `\n## Highest-Leverage Gaps (sorted by score lift if rating moves up one tier)\n`;
    for (const g of gaps) {
      msg += `- ${g.metric}: currently ${g.current_rating}/5, lifting one tier = +${g.score_lift_if_next_tier} score\n`;
    }
  }

  msg += `\nGenerate prioritized actions per the system instructions.`;
  return msg;
}


// ============================================================================
// MAIN HANDLER
// ============================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const payload = req.body;
    if (!payload || !payload.metrics || !payload.current_totals) {
      return res.status(400).json({ error: 'Body must be the ai_payload object from /api/goals-compute' });
    }

    const userMessage = buildUserMessage(payload);
    const result = await callAnthropic(SYSTEM_PROMPT, userMessage);

    return res.status(200).json({
      recommendations: (result.text || "(no content returned)").trim(),
      model: CLAUDE_MODEL,
      usage: result.usage,
      generated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('goals-ai-assist error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
