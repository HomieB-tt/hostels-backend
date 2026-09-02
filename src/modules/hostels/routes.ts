import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHostelInvite } from "../auth/service.js";
import {
  searchHostels,
  getHostelDetail,
  saveHostel,
  unsaveHostel,
  saveRoom,
  unsaveRoom,
  listSavedItems,
  HostelNotFoundError,
  RoomNotFoundError,
} from "./service.js";
import { env } from "../../env.js";

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200).optional(),
  university: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const savedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export default async function hostelRoutes(app: FastifyInstance) {
  // Public — no auth. Browsing hostels shouldn't require an account.
  app.get("/", async (req, reply) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_QUERY", details: parsed.error.flatten() });
    }

    const result = await searchHostels(parsed.data);
    return reply.send(result);
  });

  // "Saved" tab — STUDENT-only. Registered before the /:hostelId param
  // route for readability; Fastify's router prioritizes static paths
  // over parametric ones regardless of order, so this isn't load-bearing,
  // just clearer to read top-to-bottom.
  app.get(
    "/saved",
    { preHandler: [app.authenticate, app.requireRole("STUDENT")] },
    async (req, reply) => {
      const parsed = savedQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_QUERY" });
      }

      const result = await listSavedItems(req.authUser.id, parsed.data);
      return reply.send(result);
    },
  );

  // Save/unsave the WHOLE hostel.
  app.post(
    "/:hostelId/save",
    { preHandler: [app.authenticate, app.requireRole("STUDENT")] },
    async (req, reply) => {
      const { hostelId } = req.params as { hostelId: string };

      try {
        await saveHostel(req.authUser.id, hostelId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof HostelNotFoundError) {
          return reply.code(404).send({ error: "HOSTEL_NOT_FOUND" });
        }
        throw err;
      }
    },
  );

  app.delete(
    "/:hostelId/save",
    { preHandler: [app.authenticate, app.requireRole("STUDENT")] },
    async (req, reply) => {
      const { hostelId } = req.params as { hostelId: string };
      await unsaveHostel(req.authUser.id, hostelId);
      return reply.code(204).send();
    },
  );

  // Save/unsave ONE SPECIFIC ROOM within a hostel — distinct from saving
  // the whole hostel above. A student can do both independently for the
  // same hostel (e.g. save the hostel generally, and separately bookmark
  // one particular room they liked).
  app.post(
    "/:hostelId/rooms/:roomId/save",
    { preHandler: [app.authenticate, app.requireRole("STUDENT")] },
    async (req, reply) => {
      const { hostelId, roomId } = req.params as { hostelId: string; roomId: string };

      try {
        await saveRoom(req.authUser.id, hostelId, roomId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RoomNotFoundError) {
          return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
        }
        throw err;
      }
    },
  );

  app.delete(
    "/:hostelId/rooms/:roomId/save",
    { preHandler: [app.authenticate, app.requireRole("STUDENT")] },
    async (req, reply) => {
      const { roomId } = req.params as { roomId: string };
      await unsaveRoom(req.authUser.id, roomId);
      return reply.code(204).send();
    },
  );

  // Public — hostel detail with rooms/beds and live availability status.
  app.get("/:hostelId", async (req, reply) => {
    const { hostelId } = req.params as { hostelId: string };

    const hostel = await getHostelDetail(hostelId);
    if (!hostel) {
      return reply.code(404).send({ error: "HOSTEL_NOT_FOUND" });
    }

    return reply.send(hostel);
  });

  app.post(
    "/:hostelId/invites",
    {
      preHandler: [
        app.authenticate,
        app.requireRole("OWNER"),
        app.requirePropertyScope,
      ],
    },
    async (req, reply) => {
      const { hostelId } = req.params as { hostelId: string };

      const invite = await createHostelInvite({
        hostelId,
        createdByUserId: req.authUser.id,
      });

      // The frontend/web dashboard is responsible for turning this into
      // an actual shareable link (or, once SMS/WhatsApp sending exists,
      // for triggering delivery directly) — for now this just hands back
      // the token and a pre-built URL the owner can copy and send
      // manually.
      return reply.code(201).send({
        inviteToken: invite.token,
        inviteUrl: `${env.WEB_DASHBOARD_ORIGIN}/onboard-custodian?token=${invite.token}`,
        expiresAt: invite.expiresAt,
      });
    },
  );
}

