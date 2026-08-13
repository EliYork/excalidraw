// Minimal browser-global setup for the image-collab regression test:
// jsdom provides document/window; we inject a REAL WebCrypto implementation
// (jsdom has none) so the official encrypt/decrypt code paths actually run.
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
if (typeof window !== "undefined" && !window.crypto?.subtle) {
  Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
}
