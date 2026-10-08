import { z } from "zod";
import { SchemaError } from "../errors.ts";
import { readRegularFile } from "./integrity.ts";
import { readPublishedStatus } from "./status.ts";

export const scheduleSchema = z.object({
  version: z.literal(1),
  utcHours: z.array(z.number().int().min(0).max(23)).min(1).max(24),
  minute: z.number().int().min(0).max(59),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  graceMinutes: z.number().int().min(1).max(1440),
});
export type MonitorSchedule = z.output<typeof scheduleSchema>;

/** Latest publication obligation whose grace period has elapsed, including weekend gaps. */
export function publicationDue(schedule: MonitorSchedule, now: Date): Date {
  const cutoff = now.getTime() - schedule.graceMinutes * 60_000;
  let last = -Infinity;
  for (let days = 0; days <= 8; days++) {
    const date = new Date(cutoff);
    date.setUTCDate(date.getUTCDate() - days);
    if (!schedule.weekdays.includes(date.getUTCDay())) continue;
    for (const hour of schedule.utcHours) {
      const candidate = new Date(date);
      candidate.setUTCHours(hour, schedule.minute, 0, 0);
      if (candidate.getTime() <= cutoff) last = Math.max(last, candidate.getTime());
    }
  }
  if (!Number.isFinite(last)) throw new SchemaError("Schedule has no publication obligation");
  return new Date(last);
}

export async function monitorPublication(dataDir: string, schedulePath: string, now = new Date()) {
  let schedule: MonitorSchedule;
  try {
    schedule = scheduleSchema.parse(
      JSON.parse((await readRegularFile(schedulePath, 65536)).toString("utf8")),
    );
  } catch (error) {
    throw new SchemaError("Invalid monitor schedule", { cause: error });
  }
  const due = publicationDue(schedule, now);
  const status = await readPublishedStatus(dataDir, now);
  const problems: string[] = [];
  if (!status) problems.push("No publication");
  else {
    if (Date.parse(status.publishedAt) < due.getTime())
      problems.push("Missed publication deadline");
    if (!status.sourceAcquiredAt || Date.parse(status.sourceAcquiredAt) < due.getTime())
      problems.push("Source snapshot predates required run");
  }
  return {
    healthy: problems.length === 0,
    checkedAt: now.toISOString(),
    requiredRunAt: due.toISOString(),
    deadlineAt: new Date(due.getTime() + schedule.graceMinutes * 60_000).toISOString(),
    problems,
    publication: status,
  };
}
