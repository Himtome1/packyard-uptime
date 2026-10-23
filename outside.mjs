#!/usr/bin/env node
// OUTSIDE uptime check, run on a GitHub-hosted runner every ~5 min (.github/workflows/uptime.yml).
// Checks the public site, the order page and one Minecraft status ping by name through the game edge.
// A failing check is re-checked once after RETRY_S seconds in the same run (GitHub cron can be late), so
// 2 failures in a row can alert within one run. One email per incident, one recovery notice.
// Env (repo secrets): RESEND_API_KEY, ALERT_TO, CANARY_HOST. Optional: SITE, STATE_FILE, RETRY_S, FORCE_FAIL_HOST.
import { fold, formatMail, loadState, markAlerted, saveState, sendResend } from './alerting.mjs';
import { httpCheck, mcPing } from './probes.mjs';

const env = process.env;
const site = env.SITE || 'https://packyard.ca';
const stateFile = env.STATE_FILE || 'state/state.json';
const retryS = Number(env.RETRY_S || 120);

const checks = [
  { id: 'site', label: 'packyard.ca home page (outside)', run: () => httpCheck(`${site}/`) },
  { id: 'order', label: 'packyard.ca/order (outside)', run: () => httpCheck(`${site}/order`) },
  { id: 'edge', label: 'Minecraft ping through the game edge (outside)', run: () => mcPing(env.CANARY_HOST) },
];
// [TEST] switch for the forced-fail drill: a name that does not exist, pinged through the edge.
if (env.FORCE_FAIL_HOST) checks.push({ id: 'test', label: '[TEST] forced-fail canary (outside)', run: () => mcPing(env.FORCE_FAIL_HOST) });

const runAll = async (list) => Promise.all(list.map(async (c) => {
  let r; try { r = await c.run(); } catch (e) { r = { ok: false, detail: `check error: ${e.message}` }; }
  return { id: c.id, label: c.label, ...r };
}));

const state = loadState(stateFile);
let results = await runAll(checks);
let { down, up } = fold(state, results, 2, new Date().toISOString());
const failing = checks.filter((c) => results.find((r) => r.id === c.id && !r.ok));
if (failing.length) {
  console.log(`failing: ${failing.map((c) => c.id).join(',')}; re-checking in ${retryS}s`);
  await new Promise((r) => setTimeout(r, retryS * 1000));
  const again = await runAll(failing);
  // Fold only the re-checked ones; the passing ones keep their state.
  const r2 = fold(state, [...results.filter((r) => r.ok), ...again], 2, new Date().toISOString());
  down = r2.down; up = [...up, ...r2.up];
  results = [...results.filter((r) => r.ok), ...again];
}
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id}: ${r.ok ? r.detail : r.detail.replace(env.CANARY_HOST ?? '\u0000', '<canary>')}`);

let sendFailed = false;
for (const [kind, items] of [['down', down], ['up', up]]) {
  if (!items.length) continue;
  const m = formatMail('outside check on a GitHub runner', kind, items);
  try {
    const id = await sendResend({ apiKey: env.RESEND_API_KEY, from: 'Packyard uptime <hello@packyard.ca>', to: env.ALERT_TO, subject: m.subject, text: m.text,
      idempotencyKey: `outside-${kind}-${items.map((i) => i.id).join(',')}-${items[0].since}` });
    if (kind === 'down') markAlerted(state, items);
    console.log(`ALERT ${kind} sent resend_id=${id}: ${m.subject}`);
  } catch (e) { sendFailed = true; console.log(`ALERT ${kind} SEND FAILED: ${e.message}`); }
}
state.lastRun = new Date().toISOString();
saveState(stateFile, state);
// The run only fails when an alert could not be emailed, so GitHub's own failed-run email is the fallback path.
if (sendFailed) process.exit(1);
