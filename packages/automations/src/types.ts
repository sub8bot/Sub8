/** A wall-clock daily schedule: fires at hour:minute in the bot's timezone. */
export interface DailySchedule {
  type: "daily";
  hour: number;
  minute: number;
}

/** One clock time inside a trigger. */
export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** Anything `asMillis` accepts as "now". */
export type TimeInput = number | Date | string | null | undefined;

interface TriggerBase {
  /** Assigned on upsert; synthesized triggers (legacy interval/schedule) have none. */
  id?: string | null;
  lastRunAt: number;
  nextRunAt: number | null;
}

export interface IntervalTrigger extends TriggerBase {
  kind: "hourly" | "interval";
  intervalMs: number;
}

export interface TimesTrigger extends TriggerBase {
  kind: "daily" | "weekdays";
  times: TimeOfDay[];
}

export interface WeeklyTrigger extends TriggerBase {
  kind: "weekly";
  weekday: number;
  times: TimeOfDay[];
}

export interface MonthlyTrigger extends TriggerBase {
  kind: "monthly";
  monthDay: number;
  times: TimeOfDay[];
}

export interface AdvancedTrigger extends TriggerBase {
  kind: "advanced";
  months: number[];
  days: "every" | "weekdays";
  times: TimeOfDay[];
}

export interface CronTrigger extends TriggerBase {
  kind: "cron";
  cron: string;
}

export type Trigger =
  | IntervalTrigger
  | TimesTrigger
  | WeeklyTrigger
  | MonthlyTrigger
  | AdvancedTrigger
  | CronTrigger;

/** A parsed five-field cron expression, each field expanded to the set it matches. */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  source: string;
}

/** What `parseSchedule` recovers from free text: an elapsed interval or a wall-clock schedule. */
export interface ParsedCadence {
  intervalMs?: number;
  schedule?: DailySchedule;
  label: string;
}

/**
 * A standing routine as persisted on the bot. Every field but `id` is optional
 * because rows written by older builds are read back as-is and migrated lazily.
 */
export interface Routine {
  id: string;
  name?: string;
  groupKey?: string;
  instruction?: string;
  enabled?: boolean;
  lastRunAt?: number;
  createdAt?: number;
  updatedAt?: number;
  intervalMs?: number;
  /** `DailySchedule` once normalized; a string or a foreign object before that. */
  schedule?: unknown;
  nextRunAt?: number | null;
  nextRunTimeZone?: string;
  triggers?: Trigger[];
}

/** The slice of a bot these helpers read. */
export interface RoutineBot {
  id?: string;
  routines?: Routine[];
  vm?: { container?: string; deskUrl?: string; status?: string } | null;
}

/** The shape `upsertRoutine` accepts — mostly tool arguments, so every field is optional. */
export interface RoutineSpec {
  id?: string;
  name?: string;
  groupKey?: string;
  instruction?: string;
  intervalMs?: number | null;
  schedule?: unknown;
  triggers?: unknown[];
  enabled?: boolean;
  now?: number;
  timeZone?: string;
  forceNew?: boolean;
  forceReplace?: boolean;
  replace?: boolean;
  solo?: boolean;
}

export interface UpsertResult {
  routine: Routine | null;
  merged: boolean;
  rejected?: string;
}

/** One packed group of due routines, ready to become a single turn. */
export interface DuePack {
  groupKey: string | undefined;
  name: string | undefined;
  ids: string[];
  instruction: string;
}

/** `automations/<slug>/automation.json` on the desk. */
export interface AutomationJson {
  name: string;
  prompt: string;
  schedule?: string | Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
}

/**
 * The desk filesystem, injected instead of imported: this package must not
 * depend on the container tunnel. `server/vm.mjs` satisfies it as-is.
 */
export interface AutomationWriter {
  mkdirpInContainer(container: string, dir: string): Promise<unknown>;
  writeFileToContainer(container: string, dest: string, body: string): Promise<unknown>;
}
