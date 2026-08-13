/**
 * Lobby crypto: password generation, PBKDF2-SHA256 key derivation and
 * AES-GCM wrap/unwrap of the roomKey.
 *
 * Flow (all client-side; the server never sees a plaintext password or a
 * plaintext roomKey):
 *   password + salt --PBKDF2-SHA256--> KEK --AES-GCM--> wrappedRoomKey
 *   password correctness == AES-GCM unwrap succeeds
 */
import { KDF_ITERATIONS, KDF_VERSION } from "./lobbyTypes";

/**
 * Human-friendly alphabet: uppercase Base32 (A-Z, 2-7) minus 0/O/1/I/L.
 * 31 chars — no lookalike pairs, no ambiguous digits/letters.
 */
export const LOBBY_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const getCrypto = (): Crypto => {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error("WebCrypto is not available in this environment");
  }
  return cryptoObj;
};

const randomBytes = (length: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
};

/** Random room display name — not security relevant. */
export const generateLobbyPassword = (): string => {
  const chars: string[] = [];
  const alphabet = LOBBY_PASSWORD_ALPHABET;
  for (let i = 0; i < 10; i++) {
    // rejection sampling keeps the distribution uniform (31 != power of 2)
    let index: number;
    do {
      index = getCrypto().getRandomValues(new Uint32Array(1))[0] % 32;
    } while (index >= alphabet.length);
    chars.push(alphabet[index]);
  }
  // format 4-4-2, e.g. "K7PM-4XQH-Z2"
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars
    .slice(8, 10)
    .join("")}`;
};

/** High-entropy manage token: 32 random bytes as 64 hex chars. */
export const generateManageToken = (): string => {
  const bytes = randomBytes(32);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** SHA-256 hex digest (used for the manageTokenHash stored on the server). */
export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await getCrypto().subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

/**
 * Derive the key-encryption key (KEK) from the lobby password.
 * PBKDF2-SHA256 with the registry-stored salt + iteration count.
 */
export const deriveKek = async (
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> => {
  const baseKey = await getCrypto().subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return getCrypto().subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: the KEK never leaves the browser
    ["encrypt", "decrypt"],
  );
};

/** Wrap the roomKey with the KEK (AES-GCM, fresh 12-byte IV). */
export const wrapRoomKey = async (
  kek: CryptoKey,
  roomKey: string,
): Promise<{
  wrappedRoomKey: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}> => {
  const iv = randomBytes(12);
  const ciphertext = await getCrypto().subtle.encrypt(
    { name: "AES-GCM", iv },
    kek,
    new TextEncoder().encode(roomKey),
  );
  return { wrappedRoomKey: new Uint8Array(ciphertext), iv };
};

/**
 * Unwrap the roomKey with the KEK. Returns the plaintext roomKey on success
 * or null when the password is wrong (AES-GCM authentication fails).
 */
export const unwrapRoomKey = async (
  kek: CryptoKey,
  wrappedRoomKey: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<string | null> => {
  try {
    const plaintext = await getCrypto().subtle.decrypt(
      { name: "AES-GCM", iv },
      kek,
      wrappedRoomKey,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null; // wrong password / tampered blob
  }
};

/** Fresh KDF parameters for a new wrap (v1 = PBKDF2-SHA256). */
export const newKdfParams = () => ({
  kdfVersion: KDF_VERSION as 1,
  kdfIterations: KDF_ITERATIONS,
});
