import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../env.js";
import {
  registerUser,
  loginUser,
  registerCustodianViaInvite,
  PlatformRoleMismatchError,
  PhoneAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidInviteError,
} from "./service.js";
import {
  mintAccessToken,
  mintRefreshToken,
  verifyRefreshToken,
  InvalidRefreshTokenError,
} from "./tokens.js";
import { ROLE_PLATFORM_LOCK } from "../../plugins/auth.js";
import type { ClientPlatform } from "../../plugins/auth.js";

const phoneSchema = z
  .string()
  .regex(/^\+256[0-9]{9}$/, "Phone must be in +256XXXXXXXXX format");

const registerSchema = z.object({
  phone: phoneSchema,
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
  role: z.enum(["STUDENT", "OWNER"]),
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1),
});

const registerCustodianSchema = z.object({
  inviteToken: z.string().min(1),
  phone: phoneSchema,
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
});

function getPlatformHeader(req: {
  headers: Record<string, unknown>;
}): ClientPlatform | null {
  const h = req.headers["x-client-platform"];
  return h === "mobile_app" || h === "web_dashboard" ? h : null;
}

const REFRESH_COOKIE_NAME = "refresh_token";
const REFRESH_COOKIE_PATH = "/api/v1/auth/refresh";

function refreshCookieMaxAgeSeconds(): number {
  // JWT_REFRESH_TTL_WEB is a duration string like "7d" — parse just the
  // day/hour/minute/second suffix cases we actually configure via env
  // defaults.
  const match = env.JWT_REFRESH_TTL_WEB.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60; // fallback: 7 days

  const num = match[1];
  const unit = match[2];
  if (!num || !unit) return 7 * 24 * 60 * 60;

  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const multiplier = multipliers[unit] ?? 86400; // unreachable given the regex, but a safe default

  return Number(num) * multiplier;
}

export default async function authRoutes(app: FastifyInstance) {
  const strictRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/register", strictRateLimit, async (req, reply) => {
    const platform = getPlatformHeader(req);
    if (!platform) {
      return reply.code(400).send({ error: "MISSING_PLATFORM_HEADER" });
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    try {
      const user = await registerUser({ ...parsed.data, platform });
      const accessToken = mintAccessToken(user.id, user.role, platform);
      const refreshToken = mintRefreshToken(user.id, user.role, platform);

      if (platform === "web_dashboard") {
        reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
          httpOnly: true,
          sameSite: "strict",
          secure: true,
          path: REFRESH_COOKIE_PATH,
          maxAge: refreshCookieMaxAgeSeconds(),
        });
        return reply.code(201).send({ userId: user.id, role: user.role, accessToken });
      }

      return reply.code(201).send({ userId: user.id, role: user.role, accessToken, refreshToken });
    } catch (err) {
      if (err instanceof PlatformRoleMismatchError) {
        return reply.code(403).send({ error: "PLATFORM_ROLE_MISMATCH", message: err.message });
      }
      if (err instanceof PhoneAlreadyRegisteredError) {
        return reply.code(409).send({ error: "PHONE_ALREADY_REGISTERED" });
      }
      throw err;
    }
  });

  app.post("/register/custodian", strictRateLimit, async (req, reply) => {
    const platform = getPlatformHeader(req);
    if (!platform) {
      return reply.code(400).send({ error: "MISSING_PLATFORM_HEADER" });
    }

    const parsed = registerCustodianSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    try {
      const user = await registerCustodianViaInvite({ ...parsed.data, platform });
      const accessToken = mintAccessToken(user.id, user.role, platform);
      const refreshToken = mintRefreshToken(user.id, user.role, platform);

      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        path: REFRESH_COOKIE_PATH,
        maxAge: refreshCookieMaxAgeSeconds(),
      });

      return reply.code(201).send({ userId: user.id, role: user.role, accessToken });
    } catch (err) {
      if (err instanceof PlatformRoleMismatchError) {
        return reply.code(403).send({ error: "PLATFORM_ROLE_MISMATCH", message: err.message });
      }
      if (err instanceof InvalidInviteError) {
        return reply.code(400).send({ error: "INVALID_INVITE" });
      }
      if (err instanceof PhoneAlreadyRegisteredError) {
        return reply.code(409).send({ error: "PHONE_ALREADY_REGISTERED" });
      }
      throw err;
    }
  });

  app.post("/login", strictRateLimit, async (req, reply) => {
    const platform = getPlatformHeader(req);
    if (!platform) {
      return reply.code(400).send({ error: "MISSING_PLATFORM_HEADER" });
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY" });
    }

    try {
      const user = await loginUser({ ...parsed.data, platform });
      const accessToken = mintAccessToken(user.id, user.role, platform);
      const refreshToken = mintRefreshToken(user.id, user.role, platform);

      if (platform === "web_dashboard") {
        reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
          httpOnly: true,
          sameSite: "strict",
          secure: true,
          path: REFRESH_COOKIE_PATH,
          maxAge: refreshCookieMaxAgeSeconds(),
        });
        return reply.send({ userId: user.id, role: user.role, accessToken });
      }

      return reply.send({ userId: user.id, role: user.role, accessToken, refreshToken });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        // Same response for wrong password vs. unknown phone — don't
        // leak which is which.
        return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
      }
      if (err instanceof PlatformRoleMismatchError) {
        return reply.code(403).send({ error: "PLATFORM_ROLE_MISMATCH", message: err.message });
      }
      throw err;
    }
  });

  app.post("/refresh", async (req, reply) => {
    const platform = getPlatformHeader(req);
    if (!platform) {
      return reply.code(400).send({ error: "MISSING_PLATFORM_HEADER" });
    }

    const refreshToken =
      platform === "web_dashboard"
        ? req.cookies[REFRESH_COOKIE_NAME]
        : (req.body as { refreshToken?: string } | undefined)?.refreshToken;

    if (!refreshToken) {
      return reply.code(401).send({ error: "MISSING_REFRESH_TOKEN" });
    }

    try {
      const { sub, role } = verifyRefreshToken(refreshToken);

      // Re-check the platform lock at refresh time too — covers the edge
      // case where a role's platform restriction changes after a token
      // was already issued.
      const lockedTo = ROLE_PLATFORM_LOCK[role];
      if (lockedTo !== null && lockedTo !== platform) {
        return reply.code(403).send({ error: "PLATFORM_ROLE_MISMATCH" });
      }

      const accessToken = mintAccessToken(sub, role, platform);
      return reply.send({ accessToken });
    } catch (err) {
      if (err instanceof InvalidRefreshTokenError) {
        return reply.code(401).send({ error: "INVALID_REFRESH_TOKEN" });
      }
      throw err;
    }
  });

  app.post("/logout", async (req, reply) => {
    // Web: clear the refresh cookie server-side. Mobile: stateless —
    // there's no server-side refresh-token revocation list in this pass,
    // so logout there just means "the client discards its tokens." Worth
    // knowing as a real limitation, not a hidden one.
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return reply.code(204).send();
  });
}
