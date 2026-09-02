import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const KEY_LENGTH = 64;

/**
 * Deliberately uses Node's built-in crypto.scrypt rather than bcrypt/argon2
 * — no native module to compile, which matters on Alpine-based images
 * (see the various Docker build headaches earlier in this project).
 * scrypt is a legitimate, well-vetted password-hashing KDF, not a
 * shortcut — this isn't "good enough for now," it's a fine permanent
 * choice.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;

  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const storedBuf = Buffer.from(hashHex, "hex");

  // Lengths must match before timingSafeEqual — it throws on mismatched
  // buffer lengths rather than returning false.
  if (storedBuf.length !== derivedKey.length) return false;

  return timingSafeEqual(derivedKey, storedBuf);
}
