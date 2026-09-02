import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../../env.js";
import type { ClientPlatform, UserRole } from "../../plugins/auth.js";

export function mintAccessToken(
  userId: string,
  role: UserRole,
  platform: ClientPlatform,
): string {
  const ttl =
  platform === "web_dashboard"
  ? env.JWT_ACCESS_TTL_WEB
  : env.JWT_ACCESS_TTL_MOBILE;

  return jwt.sign({ sub: userId, role }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: ttl as NonNullable<SignOptions["expiresIn"]>,
  });
}

export function mintRefreshToken(
  userId: string,
  role: UserRole,
  platform: ClientPlatform,
): string {
  const ttl =
  platform === "web_dashboard"
  ? env.JWT_REFRESH_TTL_WEB
  : env.JWT_REFRESH_TTL_MOBILE;

  return jwt.sign(
    { sub: userId, role, typ: "refresh" },
    env.JWT_REFRESH_SECRET,
    { algorithm: "HS256", expiresIn: ttl as NonNullable<SignOptions["expiresIn"]> },
  );
}

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super("Refresh token is invalid, expired, or malformed.");
    this.name = "InvalidRefreshTokenError";
  }
}

export function verifyRefreshToken(token: string): {
  sub: string;
  role: UserRole;
} {
  let decoded: jwt.JwtPayload;

  try {
    decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as jwt.JwtPayload;
  } catch {
    throw new InvalidRefreshTokenError();
  }

  if (
    decoded.typ !== "refresh" ||
    typeof decoded.sub !== "string" ||
    typeof decoded.role !== "string"
  ) {
    throw new InvalidRefreshTokenError();
  }

  return { sub: decoded.sub, role: decoded.role as UserRole };
}
