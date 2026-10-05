/** Pure helpers for the schedule picker: repeat-mode state <-> Spring 6-field cron + summary text. */

export type RepeatMode =
  | 'DAILY'
  | 'WEEKDAYS'
  | 'SPECIFIC_DAYS'
  | 'WEEKLY'
  | 'MONTHLY'
  | 'HOURLY'
  | 'ONCE';

export type ScheduleType = 'RECURRING' | 'ONCE';

export const REPEAT_MODES: { mode: RepeatMode; label: string }[] = [
  { mode: 'DAILY', label: 'Every day' },
  { mode: 'WEEKDAYS', label: 'Every weekday' },
  { mode: 'SPECIFIC_DAYS', label: 'Specific days' },
  { mode: 'WEEKLY', label: 'Every week' },
  { mode: 'MONTHLY', label: 'Every month' },
  { mode: 'HOURLY', label: 'Every few hours' },
  { mode: 'ONCE', label: 'Just once' },
];

/** Day-of-week, Monday-first, with cron token + short/long labels. */
export const DOW: { key: string; short: string; long: string }[] = [
  { key: 'MON', short: 'Mon', long: 'Monday' },
  { key: 'TUE', short: 'Tue', long: 'Tuesday' },
  { key: 'WED', short: 'Wed', long: 'Wednesday' },
  { key: 'THU', short: 'Thu', long: 'Thursday' },
  { key: 'FRI', short: 'Fri', long: 'Friday' },
  { key: 'SAT', short: 'Sat', long: 'Saturday' },
  { key: 'SUN', short: 'Sun', long: 'Sunday' },
];

export interface ScheduleState {
  mode: RepeatMode;
  hour: number; // 1-12
  minute: number; // 0-59
  ampm: 'AM' | 'PM';
  specificDays: string[]; // DOW keys
  weeklyDay: string; // DOW key
  dayOfMonth: number; // 1-31
  intervalHours: number;
  onceDate: string; // yyyy-mm-dd
}

export interface ScheduleValue {
  scheduleType: ScheduleType;
  cron?: string;
  runAt?: string; // ISO
  summary: string;
}

export function defaultScheduleState(): ScheduleState {
  return {
    mode: 'DAILY',
    hour: 9,
    minute: 0,
    ampm: 'AM',
    specificDays: ['MON', 'WED', 'FRI'],
    weeklyDay: 'MON',
    dayOfMonth: 1,
    intervalHours: 2,
    onceDate: '',
  };
}

function to24(hour: number, ampm: 'AM' | 'PM'): number {
  const h = hour % 12;
  return ampm === 'PM' ? h + 12 : h;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function timeLabel(state: ScheduleState): string {
  return `${state.hour}:${pad(state.minute)} ${state.ampm}`;
}

function dayLong(key: string): string {
  return DOW.find((d) => d.key === key)?.long ?? key;
}

function orderDays(days: string[]): string[] {
  const order = DOW.map((d) => d.key);
  return [...days].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function buildCron(state: ScheduleState): string | null {
  const h = to24(state.hour, state.ampm);
  const m = state.minute;
  switch (state.mode) {
    case 'DAILY':
      return `0 ${m} ${h} * * *`;
    case 'WEEKDAYS':
      return `0 ${m} ${h} * * MON-FRI`;
    case 'SPECIFIC_DAYS':
      return state.specificDays.length ? `0 ${m} ${h} * * ${orderDays(state.specificDays).join(',')}` : null;
    case 'WEEKLY':
      return `0 ${m} ${h} * * ${state.weeklyDay}`;
    case 'MONTHLY':
      return `0 ${m} ${h} ${state.dayOfMonth} * *`;
    case 'HOURLY':
      return `0 0 */${Math.max(1, state.intervalHours)} * * *`;
    case 'ONCE':
      return null;
  }
}

export function buildRunAt(state: ScheduleState): string | null {
  if (state.mode !== 'ONCE' || !state.onceDate) return null;
  const h = to24(state.hour, state.ampm);
  const dt = new Date(`${state.onceDate}T${pad(h)}:${pad(state.minute)}:00`);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function buildSummary(state: ScheduleState): string {
  const t = timeLabel(state);
  switch (state.mode) {
    case 'DAILY':
      return `Runs every day at ${t}.`;
    case 'WEEKDAYS':
      return `Runs every weekday at ${t}.`;
    case 'SPECIFIC_DAYS':
      return state.specificDays.length
        ? `Runs every ${joinAnd(orderDays(state.specificDays).map(dayLong))} at ${t}.`
        : 'Select at least one day.';
    case 'WEEKLY':
      return `Runs every ${dayLong(state.weeklyDay)} at ${t}.`;
    case 'MONTHLY':
      return `Runs on the ${ordinal(state.dayOfMonth)} of every month at ${t}.`;
    case 'HOURLY':
      return `Runs every ${Math.max(1, state.intervalHours)} hours, around the clock.`;
    case 'ONCE':
      return state.onceDate ? `Runs once on ${state.onceDate} at ${t}.` : 'Pick a date to run on.';
  }
}

export function buildScheduleValue(state: ScheduleState): ScheduleValue {
  if (state.mode === 'ONCE') {
    return { scheduleType: 'ONCE', runAt: buildRunAt(state) ?? undefined, summary: buildSummary(state) };
  }
  return { scheduleType: 'RECURRING', cron: buildCron(state) ?? undefined, summary: buildSummary(state) };
}

function applyTime24(state: ScheduleState, h24: number, minute: number): void {
  state.minute = isNaN(minute) ? 0 : minute;
  const ampm: 'AM' | 'PM' = h24 >= 12 ? 'PM' : 'AM';
  let hour12 = h24 % 12;
  if (hour12 === 0) hour12 = 12;
  state.hour = hour12;
  state.ampm = ampm;
}

/** Best-effort reverse of {@link buildCron}/{@link buildRunAt} to re-populate the picker on edit. */
export function parseSchedule(scheduleType: string, cron?: string, runAt?: string): ScheduleState {
  const state = defaultScheduleState();
  if (scheduleType === 'ONCE' && runAt) {
    const d = new Date(runAt);
    if (!isNaN(d.getTime())) {
      state.mode = 'ONCE';
      state.onceDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      applyTime24(state, d.getHours(), d.getMinutes());
    }
    return state;
  }
  if (!cron) return state;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 6) return state;
  const [, min, hr, dom, , dow] = parts;
  const minute = parseInt(min, 10);

  if (hr.startsWith('*/')) {
    state.mode = 'HOURLY';
    state.intervalHours = parseInt(hr.slice(2), 10) || 2;
    return state;
  }
  applyTime24(state, parseInt(hr, 10), minute);

  if (dom !== '*' && !isNaN(parseInt(dom, 10))) {
    state.mode = 'MONTHLY';
    state.dayOfMonth = parseInt(dom, 10);
    return state;
  }
  if (dow === '*') {
    state.mode = 'DAILY';
    return state;
  }
  if (dow === 'MON-FRI') {
    state.mode = 'WEEKDAYS';
    return state;
  }
  const days = dow.split(',').filter(Boolean);
  if (days.length === 1) {
    state.mode = 'WEEKLY';
    state.weeklyDay = days[0];
  } else {
    state.mode = 'SPECIFIC_DAYS';
    state.specificDays = days;
  }
  return state;
}
