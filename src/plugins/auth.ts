import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { env } from "../env.js";

export type ClientPlatform = "mobile_app" | "web_dashboard";
export type UserRole = "STUDENT" | "CUSTODIAN" | "OWNER" | "ADMIN";

export interface AuthedUser {
  id: string;
  role: UserRole;
  platform: ClientPlatform;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthedUser;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: UserRole };
    user: { sub: string; role: UserRole };
  }
}

// Roles hard-restricted to a single platform, per spec §1. Exported so
// modules/auth (register/login/refresh) enforces the exact same mapping
// at token-issuance time as this plugin enforces at request time —
// one source of truth instead of two copies that could drift apart.
export const ROLE_PLATFORM_LOCK: Record<UserRole, ClientPlatform | null> = {
  STUDENT: "mobile_app",
  CUSTODIAN: "web_dashboard",
  OWNER: "web_dashboard",
  ADMIN: null, // admins may use either, still subject to normal auth
};

/**
 * Registers @fastify/jwt (mobile uses long-lived bearer tokens; web uses
 * short-lived 15m tokens paired with an httpOnly/SameSite=Strict/Secure
 * refresh cookie — the cookie plugin + refresh route live in
 * modules/auth). Also decorates `authenticate`, which:
 *   1. Verifies the JWT.
 *   2. Reads and validates the mandatory X-Client-Platform header.
 *   3. Rejects if the token's role isn't allowed on that platform.
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
  });

  app.decorate(
    "authenticate",
    async function authenticate(req: FastifyRequest, reply: FastifyReply) {
      const platformHeader = req.headers["x-client-platform"];

      if (
        platformHeader !== "mobile_app" &&
        platformHeader !== "web_dashboard"
      ) {
        return reply.code(400).send({
          error: "MISSING_PLATFORM_HEADER",
          message:
            "X-Client-Platform header must be 'mobile_app' or 'web_dashboard'.",
        });
      }

      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "INVALID_TOKEN" });
      }

      const { sub, role } = req.user;
      const lockedTo = ROLE_PLATFORM_LOCK[role];

      if (lockedTo !== null && lockedTo !== platformHeader) {
        return reply.code(403).send({
          error: "PLATFORM_ROLE_MISMATCH",
          message: `${role} accounts may only authenticate via ${lockedTo}.`,
        });
      }

      req.authUser = { id: sub, role, platform: platformHeader };
    },
  );

  app.decorate(
    "requireRole",
    (...allowed: UserRole[]) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.authUser || !allowed.includes(req.authUser.role)) {
          return reply.code(403).send({ error: "FORBIDDEN" });
        }
      },
  );
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: UserRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
