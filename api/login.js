import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password are required." });
  }

  const SUPA_URL    = process.env.SUPA_URL;
  const SUPA_KEY    = process.env.SUPA_KEY;
  const PASS_SALT   = process.env.PASSWORD_SALT || "teamego_default_salt";

  if (!SUPA_URL || !SUPA_KEY) {
    return res.status(500).json({ success: false, error: "Server configuration error." });
  }

  // Hash the incoming password
  const passwordHash = crypto
    .createHash("sha256")
    .update(password + PASS_SALT)
    .digest("hex");

  try {
    // Lookup user in Supabase
    const resp = await fetch(
      `${SUPA_URL}/rest/v1/users?username=eq.${encodeURIComponent(username.toLowerCase())}&select=id,username,display_name,role,password_hash`,
      {
        headers: {
          "apikey": SUPA_KEY,
          "Authorization": `Bearer ${SUPA_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!resp.ok) {
      return res.status(500).json({ success: false, error: "Database error." });
    }

    const users = await resp.json();

    if (!users || users.length === 0) {
      return res.status(401).json({ success: false, error: "Invalid username or password." });
    }

    const user = users[0];

    if (user.password_hash !== passwordHash) {
      return res.status(401).json({ success: false, error: "Invalid username or password." });
    }

    return res.status(200).json({
      success: true,
      username: user.username,
      display_name: user.display_name || user.username,
      role: user.role || "member"
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error: " + e.message });
  }
}
