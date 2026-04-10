export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } }
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { system, message } = req.body;

    // Trim message if extremely large (Claude context limit safety)
    const trimmedMessage = message && message.length > 60000
      ? message.slice(0, 60000) + "\n\n[Data truncated due to size — analyze what is provided above]"
      : message;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: system,
        messages: [{ role: "user", content: trimmedMessage }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "API error" });

    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
