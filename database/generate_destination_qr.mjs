import { createHash, randomBytes } from "node:crypto";

const siteId = Number(process.argv[2]);
if (!Number.isSafeInteger(siteId) || siteId < 1) {
  console.error("Usage: node database/generate_destination_qr.mjs <site_id>");
  process.exit(2);
}

const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

console.log(`QR payload (encode this text as the destination QR code):\n${token}`);
console.log("\nRegister the hash in Cloudflare D1 (the raw token is not stored):");
console.log(
  `npx.cmd wrangler d1 execute guio_db --remote --command "INSERT INTO destination_qr_codes (site_id, token_hash) VALUES (${siteId}, '${tokenHash}')"`
);
