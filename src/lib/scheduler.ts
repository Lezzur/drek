import { logger } from '../logger.js';

/**
 * Tiny in-process scheduler. Two modes per job:
 *   - intervalMs: fire every N ms (no immediate run on boot).
 *   - matches(now): cron-style — caller provides a predicate that's tested
 *     against a once-per-minute UTC tick.
 *
 * No external `node-cron` — keeps the bundle small and avoids the timezone
 * footguns of cron strings. Schedules express UTC explicitly via the
 * `dailyAt` / `weeklyAt` helpers.
 *
 * Same shape Neurocore's scheduler uses, so future cross-service work won't
 * have to learn two patterns.
 */

export type Job = {
  name: string;
  matches?: (now: Date) => boolean;
  intervalMs?: number;
  run: () => Promise<void>;
};

const handles: ReturnType<typeof setTimeout>[] = [];
let started = false;

export function startScheduler(jobs: Job[]): void {
  if (started) return;
  started = true;

  // Interval jobs — fire every N ms after the first tick. We don't fire on
  // boot; if a job wants that behavior it should call run() itself first.
  for (const j of jobs.filter((j) => j.intervalMs)) {
    const tick = async () => {
      try {
        await j.run();
      } catch (err) {
        logger.error({ err, job: j.name }, 'scheduler job failed');
      }
    };
    handles.push(setInterval(tick, j.intervalMs!));
    logger.info({ job: j.name, intervalMs: j.intervalMs }, 'scheduler interval registered');
  }

  // Cron-style jobs: tick every 60s on the minute boundary.
  const cronJobs = jobs.filter((j) => j.matches);
  if (cronJobs.length === 0) return;

  const fireAtMinute = async () => {
    const now = new Date();
    for (const j of cronJobs) {
      if (j.matches!(now)) {
        try {
          await j.run();
        } catch (err) {
          logger.error({ err, job: j.name }, 'scheduler cron failed');
        }
      }
    }
  };

  // Align to the next minute boundary so we don't fire mid-minute on boot.
  const msToNextMin = 60_000 - (Date.now() % 60_000);
  setTimeout(() => {
    void fireAtMinute();
    handles.push(setInterval(fireAtMinute, 60_000));
  }, msToNextMin);

  for (const j of cronJobs) {
    logger.info({ job: j.name }, 'scheduler cron registered');
  }
}

export function stopScheduler(): void {
  for (const h of handles) clearInterval(h);
  handles.length = 0;
  started = false;
}

/* Helpers for matchers */

export function dailyAt(utcHour: number, utcMinute = 0): (now: Date) => boolean {
  return (now: Date) =>
    now.getUTCHours() === utcHour && now.getUTCMinutes() === utcMinute;
}

export function weeklyAt(
  utcDay: number,
  utcHour: number,
  utcMinute = 0,
): (now: Date) => boolean {
  return (now: Date) =>
    now.getUTCDay() === utcDay &&
    now.getUTCHours() === utcHour &&
    now.getUTCMinutes() === utcMinute;
}
