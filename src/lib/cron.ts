// Checking cron lines before they're saved: a crontab is also checked by
// `crontab` itself, but /etc/cron.d files are not (cron just skips bad lines).

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];
const NAMES = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)$/i;
const SPECIAL = /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

function fieldOk(field: string, [lo, hi]: [number, number]): boolean {
  return field.split(",").every((part) => {
    const [base = "", step, extra] = part.split("/");
    if (extra !== undefined || base === "") return false;
    if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
    if (base === "*") return true;
    return base.split("-").every((v, _, all) => all.length <= 2 && (NAMES.test(v) || (/^\d+$/.test(v) && +v >= lo && +v <= hi)));
  });
}

export interface CronProblem {
  line: number;
  message: string;
}

/** Problems by line (1-based). `system`: /etc/crontab and /etc/cron.d have a
 *  user field before the command. */
export function cronProblems(text: string, system: boolean): CronProblem[] {
  const out: CronProblem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || ASSIGN.test(line)) return;
    const words = line.split(/\s+/);
    const need = system ? "a user and a command" : "a command";
    if (words[0]!.startsWith("@")) {
      if (!SPECIAL.test(words[0]!)) out.push({ line: i + 1, message: `unknown ${words[0]} (use @reboot, @daily, @hourly…)` });
      else if (words.length < (system ? 3 : 2)) out.push({ line: i + 1, message: `${words[0]} needs ${need}` });
      return;
    }
    if (words.length < 5 + (system ? 1 : 0) + 1) {
      out.push({ line: i + 1, message: `needs 5 time fields (minute hour day month weekday) and ${need}` });
      return;
    }
    const bad = RANGES.findIndex((r, f) => !fieldOk(words[f]!, r));
    if (bad !== -1) {
      const name = ["minute", "hour", "day of month", "month", "day of week"][bad];
      out.push({ line: i + 1, message: `the ${name} field “${words[bad]}” isn't valid` });
    }
  });
  return out;
}
