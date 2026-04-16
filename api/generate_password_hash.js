// Run this locally to generate password hashes for your team
// Usage: node generate_password_hash.js
// Then paste the hash into Supabase users table

const crypto = require("crypto");

const PASS_SALT = "teamego_default_salt"; // Must match PASSWORD_SALT in Vercel env

// ── Add your team members here ──────────────────────
const users = [
  { username: "hemanth",  displayName: "Hemanth",  password: "hemanth123",  role: "admin"  },
  // Add more team members below:
  // { username: "john",  displayName: "John Doe",  password: "john123",    role: "member" },
  // { username: "priya", displayName: "Priya",     password: "priya123",   role: "member" },
];

console.log("\n=== SQL to insert users into Supabase ===\n");
console.log("INSERT INTO users (username, display_name, password_hash, role) VALUES");
const rows = users.map(u => {
  const hash = crypto.createHash("sha256").update(u.password + PASS_SALT).digest("hex");
  return `  ('${u.username.toLowerCase()}', '${u.displayName}', '${hash}', '${u.role}')`;
});
console.log(rows.join(",\n") + ";");
console.log("\n=== Done ===\n");
