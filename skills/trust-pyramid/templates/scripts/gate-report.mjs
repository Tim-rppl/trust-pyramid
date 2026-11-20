// Summarizes .quality-state/gate-log.jsonl: what the gates actually caught, per week.
//   node scripts/gate-report.mjs [--log <file>] [--rules <id,id,...>]
// --rules lists the rule IDs you expect (e.g. every rule in lint/), so rules that never fired show up.
// Output: blocks per week and gate, blocks per rule, rules that fired in more than one week
// (the mistake keeps coming back: improve the error message or design it away), rules never fired.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** ISO week label, e.g. 2026-W47. */
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function summarize(entries, knownRules = []) {
  const weeks = new Map();
  const rules = new Map();
  for (const entry of entries) {
    const week = isoWeek(new Date(entry.date));
    const perGate = weeks.get(week) ?? new Map();
    perGate.set(entry.gate, (perGate.get(entry.gate) ?? 0) + 1);
    weeks.set(week, perGate);
    for (const rule of entry.rules?.length ? entry.rules : [`(check) ${entry.check}`]) {
      const stats = rules.get(rule) ?? { count: 0, weeks: new Set() };
      stats.count += 1;
      stats.weeks.add(week);
      rules.set(rule, stats);
    }
  }
  return {
    weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, gates]) => ({ week, total: [...gates.values()].reduce((a, b) => a + b, 0), gates: Object.fromEntries(gates) })),
    rules: [...rules].sort(([, a], [, b]) => b.count - a.count).map(([rule, { count, weeks: seen }]) => ({ rule, count, weeks: seen.size })),
    repeated: [...rules].filter(([, stats]) => stats.weeks.size > 1).map(([rule]) => rule),
    neverFired: knownRules.filter(rule => !rules.has(rule)),
  };
}

function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const log = option('--log') ?? '.quality-state/gate-log.jsonl';
  const known = (option('--rules') ?? '').split(',').map(rule => rule.trim()).filter(Boolean);
  const entries = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
  if (!entries.length) { console.log(`No gate interceptions recorded in ${log} yet.`); }
  const report = summarize(entries, known);
  if (entries.length) {
    console.log('Blocks per week');
    for (const { week, total, gates } of report.weeks) {
      console.log(`  ${week}  ${String(total).padStart(3)}  ${Object.entries(gates).map(([gate, n]) => `${gate} ${n}`).join(', ')}`);
    }
    console.log('\nBlocks per rule');
    for (const { rule, count, weeks } of report.rules) console.log(`  ${String(count).padStart(3)}  ${rule}  (${weeks} week${weeks === 1 ? '' : 's'})`);
    console.log(`\nRepeated across weeks: ${report.repeated.join(', ') || 'none'}`);
  }
  if (known.length) console.log(`Never fired: ${report.neverFired.join(', ') || 'none'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
