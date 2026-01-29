import * as crypto from "crypto";

const SALT_LENGTH = 16;
const HASH_ITERATIONS = 100000;
const HASH_KEYLEN = 64;
const HASH_DIGEST = "sha512";

/**
 * Generate a secure random token.
 */
export function generateToken(): string {
  return crypto.randomBytes(3).toString("hex");
}

/**
 * Hash a token for secure storage.
 */
export function hashToken(token: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
  const hash = crypto
    .pbkdf2Sync(token, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST)
    .toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify a token against a stored hash.
 */
export function verifyToken(token: string, storedHash: string): boolean {
  const [salt, expectedHash] = storedHash.split(":");
  if (!salt || !expectedHash) return false;

  const actualHash = crypto
    .pbkdf2Sync(token, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST)
    .toString("hex");

  return crypto.timingSafeEqual(
    Buffer.from(actualHash, "hex"),
    Buffer.from(expectedHash, "hex")
  );
}
