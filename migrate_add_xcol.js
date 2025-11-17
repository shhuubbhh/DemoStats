// migrate_add_xcol.js
import Database from "better-sqlite3";

try {
  const db = new Database("./data.sqlite");
  db.exec("ALTER TABLE messages ADD COLUMN x_link_count INTEGER DEFAULT 0;");
  console.log("Added x_link_count column successfully!");
  db.close();
} catch (err) {
  const msg = String(err);
  if (msg.toLowerCase().includes("duplicate column") || msg.toLowerCase().includes("already exists")) {
    console.log("Column x_link_count already exists. Nothing to do.");
  } else {
    console.error("Migration error:", err);
  }
}
