import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createHostel,
  updateHostel,
  createRoom,
  updateRoom,
  deleteRoom,
  createBed,
  setBedStatus,
  deleteBed,
  HostelNotFoundError,
  RoomNotFoundError,
  BedNotFoundError,
  RoomNumberConflictError,
  BedLabelConflictError,
  InvalidBedStatusTransitionError,
  HasBookingHistoryError,
} from "./management.service.js";

const decimalString = z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a decimal amount");
const coordString = z.string().regex(/^-?\d{1,3}(\.\d{1,6})?$/, "Must be a decimal coordinate");

const createHostelSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
  university: z.string().min(1).max(200).optional(),
  latitude: coordString.optional(),
  longitude: coordString.optional(),
});

const updateHostelSchema = createHostelSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

const createRoomSchema = z.object({
  roomNumber: z.string().min(1).max(50),
  roomType: z.string().min(1).max(100),
  pricePerBedPerSemester: decimalString,
});

const updateRoomSchema = createRoomSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

const createBedSchema = z.object({
  bedLabel: z.string().min(1).max(20),
});

const setBedStatusSchema = z.object({
  status: z.enum(["AVAILABLE", "MAINTENANCE"]),
});

export default async function hostelManagementRoutes(app: FastifyInstance) {
  // Create a new hostel. No requirePropertyScope here — there's no
  // existing hostel to scope to yet; the transaction inside createHostel
  // assigns the creating owner as staff on it.
  app.post(
    "/",
    { preHandler: [app.authenticate, app.requireRole("OWNER")] },
    async (req, reply) => {
      const parsed = createHostelSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
      }

      const hostel = await createHostel(req.authUser.id, parsed.data);
      return reply.code(201).send(hostel);
    },
  );

  app.patch(
    "/:hostelId",
    {
      preHandler: [app.authenticate, app.requireRole("OWNER"), app.requirePropertyScope],
    },
    async (req, reply) => {
      const { hostelId } = req.params as { hostelId: string };
      const parsed = updateHostelSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
      }

      try {
        const hostel = await updateHostel(hostelId, parsed.data);
        return reply.send(hostel);
      } catch (err) {
        if (err instanceof HostelNotFoundError) {
          return reply.code(404).send({ error: "HOSTEL_NOT_FOUND" });
        }
        throw err;
      }
    },
  );

  // Rooms and beds: create/edit allowed for OWNER and CUSTODIAN alike
  // (day-to-day inventory management); delete is OWNER-only below.
  app.post(
    "/:hostelId/rooms",
    {
      preHandler: [
        app.authenticate,
        app.requireRole("OWNER", "CUSTODIAN"),
        app.requirePropertyScope,
      ],
    },
    async (req, reply) => {
      const { hostelId } = req.params as { hostelId: string };
      const parsed = createRoomSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
      }

      try {
        const room = await createRoom(hostelId, parsed.data);
        return reply.code(201).send(room);
      } catch (err) {
        if (err instanceof RoomNumberConflictError) {
          return reply.code(409).send({ error: "ROOM_NUMBER_CONFLICT" });
        }
        throw err;
      }
    },
  );

  app.patch(
    "/:hostelId/rooms/:roomId",
    {
      preHandler: [
        app.authenticate,
        app.requireRole("OWNER", "CUSTODIAN"),
        app.requirePropertyScope,
      ],
    },
    async (req, reply) => {
      const { hostelId, roomId } = req.params as { hostelId: string; roomId: string };
      const parsed = updateRoomSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
      }

      try {
        const room = await updateRoom(hostelId, roomId, parsed.data);
        return reply.send(room);
      } catch (err) {
        if (err instanceof RoomNotFoundError) {
          return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
        }
        if (err instanceof RoomNumberConflictError) {
          return reply.code(409).send({ error: "ROOM_NUMBER_CONFLICT" });
        }
        throw err;
      }
    },
  );

  app.delete(
    "/:hostelId/rooms/:roomId",
    { preHandler: [app.authenticate, app.requireRole("OWNER"), app.requirePropertyScope] },
    async (req, reply) => {
      const { hostelId, roomId } = req.params as { hostelId: string; roomId: string };

      try {
        await deleteRoom(hostelId, roomId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RoomNotFoundError) {
          return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
        }
        if (err instanceof HasBookingHistoryError) {
          return reply.code(409).send({ error: "HAS_BOOKING_HISTORY" });
        }
        throw err;
      }
    },
  );

  app.post(
    "/:hostelId/rooms/:roomId/beds",
    {
      preHandler: [
        app.authenticate,
        app.requireRole("OWNER", "CUSTODIAN"),
        app.requirePropertyScope,
      ],
    },
    async (req, reply) => {
      const { hostelId, roomId } = req.params as { hostelId: string; roomId: string };
      const parsed = createBedSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
      }

      try {
        const bed = await createBed(hostelId, roomId, parsed.data);
        return reply.code(201).send(bed);
      } catch (err) {
        if (err instanceof RoomNotFoundError) {
          return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
        }
        if (err instanceof BedLabelConflictError) {
          return reply.code(409).send({ error: "BED_LABEL_CONFLICT" });
        }
        throw err;
      }
    },
  );

  // Only toggles AVAILABLE <-> MAINTENANCE — see setBedStatus's own
  // comment for why HELD/OCCUPIED can't be set here directly.
  app.patch(
    "/:hostelId/rooms/:roomId/beds/:bedId",
    {
      preHandler: [
        app.authenticate,
        app.requireRole("OWNER", "CUSTODIAN"),
        app.requirePropertyScope,
      ],
    },
    async (req, reply) => {
      const { hostelId, roomId, bedId } = req.params as {
        hostelId: string;
        roomId: string;
        bedId: string;
      };
      const parsed = setBedStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
      }

      try {
        const bed = await setBedStatus(hostelId, roomId, bedId, parsed.data.status);
        return reply.send(bed);
      } catch (err) {
        if (err instanceof BedNotFoundError) {
          return reply.code(404).send({ error: "BED_NOT_FOUND" });
        }
        if (err instanceof InvalidBedStatusTransitionError) {
          return reply.code(409).send({ error: "INVALID_STATUS_TRANSITION", message: err.message });
        }
        throw err;
      }
    },
  );

  app.delete(
    "/:hostelId/rooms/:roomId/beds/:bedId",
    { preHandler: [app.authenticate, app.requireRole("OWNER"), app.requirePropertyScope] },
    async (req, reply) => {
      const { hostelId, roomId, bedId } = req.params as {
        hostelId: string;
        roomId: string;
        bedId: string;
      };

      try {
        await deleteBed(hostelId, roomId, bedId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RoomNotFoundError) {
          return reply.code(404).send({ error: "ROOM_NOT_FOUND" });
        }
        if (err instanceof BedNotFoundError) {
          return reply.code(404).send({ error: "BED_NOT_FOUND" });
        }
        if (err instanceof HasBookingHistoryError) {
          return reply.code(409).send({ error: "HAS_BOOKING_HISTORY" });
        }
        throw err;
      }
    },
  );
}
