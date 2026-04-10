/**
 * GET /api/sources handler — list sources with delivery stats.
 * Extracted from sources.routes.ts for file-size compliance.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { eq, and, sql, desc } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { sources, events, deliveries } from "../db/schema.js";
import { ValidationError } from "../lib/errors.js";
import { paginationSchema } from "./schemas/common.js";

export async function handleListSources(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const queryParse = paginationSchema.safeParse(request.query);
  if (!queryParse.success) {
    const details = queryParse.error.errors.map((e) => e.message);
    throw new ValidationError(
      "Invalid pagination parameters",
      details
    );
  }

  const { limit, cursor } = queryParse.data;
  const tenantId = request.tenantId;

  // Count total sources for this tenant
  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sources)
    .where(eq(sources.tenantId, tenantId));
  const total = countResult[0]?.count ?? 0;

  // Build query with optional cursor
  const conditions = [eq(sources.tenantId, tenantId)];
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf-8");
      const sepIdx = decoded.indexOf("|");
      const cursorDate = decoded.slice(0, sepIdx);
      const cursorId = decoded.slice(sepIdx + 1);
      if (cursorDate && cursorId) {
        conditions.push(
          sql`("sources"."created_at", "sources"."id") < (${cursorDate}::timestamptz, ${cursorId}::uuid)`
        );
      }
    } catch {
      throw new ValidationError("Invalid cursor format");
    }
  }

  const sourceRows = await db
    .select({
      id: sources.id,
      tenantId: sources.tenantId,
      name: sources.name,
      slug: sources.slug,
      signatureHeader: sources.signatureHeader,
      signatureAlgo: sources.signatureAlgo,
      enabled: sources.enabled,
      createdAt: sources.createdAt,
      updatedAt: sources.updatedAt,
    })
    .from(sources)
    .where(and(...conditions))
    .orderBy(desc(sources.createdAt), desc(sources.id))
    .limit(limit);

  // Fetch delivery stats for returned sources
  const sourceIds = sourceRows.map((s) => s.id);
  const statsMap = await getDeliveryStats(db, tenantId, sourceIds);

  const sourcesResponse = sourceRows.map((s) => {
    const stats = statsMap.get(s.id) ?? {
      totalEvents: 0,
      successfulDeliveries: 0,
      failedDeliveries: 0,
    };
    return {
      id: s.id,
      tenant_id: s.tenantId,
      name: s.name,
      slug: s.slug,
      signature_header: s.signatureHeader,
      signature_algo: s.signatureAlgo,
      enabled: s.enabled,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
      stats: {
        total_events: stats.totalEvents,
        successful_deliveries: stats.successfulDeliveries,
        failed_deliveries: stats.failedDeliveries,
      },
    };
  });

  // Build next cursor from last item
  const lastSource = sourceRows[sourceRows.length - 1];
  const nextCursor =
    sourceRows.length === limit && lastSource
      ? Buffer.from(
          `${lastSource.createdAt.toISOString()}|${lastSource.id}`
        ).toString("base64")
      : undefined;

  return reply.status(200).send({
    sources: sourcesResponse,
    total,
    cursor: nextCursor,
  });
}

/* ────── Stats Helper ────── */

interface DeliveryStats {
  totalEvents: number;
  successfulDeliveries: number;
  failedDeliveries: number;
}

async function getDeliveryStats(
  db: Database,
  tenantId: string,
  sourceIds: string[]
): Promise<Map<string, DeliveryStats>> {
  const statsMap = new Map<string, DeliveryStats>();
  if (sourceIds.length === 0) return statsMap;

  // Format source IDs as a PostgreSQL array literal
  const pgArray = `{${sourceIds.join(",")}}`;

  const [eventCounts, deliveryCounts] = await Promise.all([
    db
      .select({
        sourceId: events.sourceId,
        count: sql<number>`count(*)::int`,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          sql`${events.sourceId} = ANY(${pgArray}::uuid[])`
        )
      )
      .groupBy(events.sourceId),
    db
      .select({
        sourceId: events.sourceId,
        status: deliveries.status,
        count: sql<number>`count(*)::int`,
      })
      .from(deliveries)
      .innerJoin(events, eq(deliveries.eventId, events.id))
      .where(
        and(
          eq(deliveries.tenantId, tenantId),
          sql`${events.sourceId} = ANY(${pgArray}::uuid[])`
        )
      )
      .groupBy(events.sourceId, deliveries.status),
  ]);

  for (const id of sourceIds) {
    statsMap.set(id, {
      totalEvents: 0,
      successfulDeliveries: 0,
      failedDeliveries: 0,
    });
  }

  for (const row of eventCounts) {
    const existing = statsMap.get(row.sourceId!);
    if (existing) existing.totalEvents = row.count;
  }

  for (const row of deliveryCounts) {
    const existing = statsMap.get(row.sourceId!);
    if (!existing) continue;
    if (row.status === "success") {
      existing.successfulDeliveries = row.count;
    } else if (
      row.status === "failed" ||
      row.status === "dead_letter"
    ) {
      existing.failedDeliveries += row.count;
    }
  }

  return statsMap;
}
