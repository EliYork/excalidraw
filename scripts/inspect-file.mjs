// Inspect the byte layout of a stored room file (read-only diagnostic).
import { readFileSync } from "node:fs";

const p = process.argv[2];
const b = readFileSync(p);
console.log("len:", b.length);
console.log("first 16 bytes:", Array.from(b.slice(0, 16)).join(","));

// hypothesis A: concatBuffers format (compressData output)
const v = b.readUInt32BE(0);
const len1 = b.readUInt32BE(4);
console.log("as-concatBuffers: version =", v, "(expect 1)", "| chunk1 len =", len1);

if (v === 1 && len1 > 0 && 8 + len1 <= b.length) {
  const json = b.subarray(8, 8 + len1).toString("utf8");
  console.log("chunk1 json:", json.slice(0, 120));
  let off = 8 + len1;
  const len2 = b.readUInt32BE(off);
  console.log("chunk2 (iv) len =", len2, "(expect 12)");
  off += 4 + len2;
  const len3 = b.readUInt32BE(off);
  console.log("chunk3 (ciphertext) len =", len3);
  console.log("total check:", 4 + 4 + len1 + 4 + len2 + 4 + len3, "vs", b.length);
} else {
  // hypothesis B: bare iv(12) + AES-GCM ciphertext
  console.log(
    "not concatBuffers; bare iv(12)+ciphertext layout: iv =",
    Array.from(b.slice(0, 12)).join(","),
    "| ciphertext len =",
    b.length - 12,
    "(AES-GCM => plaintext+16, so plaintext would be",
    b.length - 12 - 16,
    "bytes)",
  );
}
