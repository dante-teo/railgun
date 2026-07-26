import { CronExpressionParser } from "cron-parser";

export type CronScheduleResult =
  | { readonly valid: true; readonly schedule: string }
  | { readonly valid: false; readonly schedule: string; readonly error: string };

export const normalizeCronSchedule = (value: string): string => value.trim().split(/\s+/u).join(" ");

export const parseCronSchedule = (value: string): CronScheduleResult => {
  const schedule = normalizeCronSchedule(value);
  if (schedule.split(" ").filter(Boolean).length !== 5) {
    return { valid: false, schedule, error: "Use exactly five fields: minute hour day-of-month month day-of-week." };
  }
  try {
    CronExpressionParser.parse(schedule);
    return { valid: true, schedule };
  } catch {
    return { valid: false, schedule, error: "Enter a valid five-field cron schedule." };
  }
};
