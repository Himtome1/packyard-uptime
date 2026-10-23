// Incident state for the uptime checks: alert once when a check has failed THRESHOLD times in a row,
// send one recovery notice when it passes again. State is a small JSON file (or a cache entry on the runner).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { checks: {} }; }
}
export function saveState(path, state) {
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${path}.tmp`, path);
}

/**
 * Fold one run's results into the state. results: [{ id, label, ok, detail, skip? }].
 * Returns { down: [...], up: [...] } = checks that need a DOWN alert / a RECOVERED notice now.
 * Checks missing from this run (a server that was deleted) are dropped; an open incident on them gets a "gone" recovery.
 */
export function fold(state, results, threshold, nowIso) {
  const down = [], up = [];
  const seen = new Set();
  for (const r of results) {
    seen.add(r.id);
    const c = state.checks[r.id] ?? { fails: 0, alerted: false };
    c.label = r.label; c.last = nowIso; c.detail = r.detail;
    if (r.skip) { c.fails = 0; c.skipped = r.detail; }
    else if (r.ok) {
      if (c.alerted) up.push({ ...r, since: c.downSince });
      c.fails = 0; c.alerted = false; delete c.downSince; delete c.skipped;
    } else {
      c.fails += 1; delete c.skipped;
      if (c.fails === 1) c.downSince = nowIso;
      if (c.fails >= threshold && !c.alerted) down.push({ ...r, fails: c.fails, since: c.downSince });
    }
    state.checks[r.id] = c;
  }
  for (const [id, c] of Object.entries(state.checks)) {
    if (seen.has(id)) continue;
    if (c.alerted) up.push({ id, label: c.label, ok: true, detail: 'no longer monitored (server removed or ended)', since: c.downSince });
    delete state.checks[id];
  }
  return { down, up };
}

/** Mark DOWN alerts as sent (only after the mail went out, so a failed send is retried next run). */
export function markAlerted(state, down) { for (const d of down) if (state.checks[d.id]) state.checks[d.id].alerted = true; }

/** Send through Resend. Returns the message id. Throws on any non-2xx. */
export async function sendResend({ apiKey, from, to, subject, text, idempotencyKey }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body).id;
}

export const DOWN_HELP = [
  'What to do:',
  '- Paste this subject line to @cto in #engineering (or forward this email). That is all that is needed.',
  '- Ignore it if it is about your own canary server and you stopped that server on purpose.',
  '- Ignore any email with [TEST] in it: that is a drill.',
  '- A "[Packyard RECOVERED]" email follows when it clears; nothing to do then.',
  '',
  'You get one email per incident and one when it recovers. Runbook: engineering/uptime.md in the team workspace.',
  '',
].join('\n');

export function formatMail(where, kind, items) {
  const lines = items.map((i) => kind === 'down'
    ? `- ${i.label}: ${i.detail} (failing since ${i.since}, ${i.fails} checks in a row)`
    : `- ${i.label}: OK again, ${i.detail}${i.since ? ` (was down since ${i.since})` : ''}`);
  const subject = kind === 'down'
    ? `[Packyard DOWN] ${items.map((i) => i.label).join(', ').slice(0, 120)}`
    : `[Packyard RECOVERED] ${items.map((i) => i.label).join(', ').slice(0, 120)}`;
  const text = `${kind === 'down' ? 'Uptime check FAILED' : 'Uptime check recovered'} (${where}, ${new Date().toISOString()}):\n\n${lines.join('\n')}\n\n` +
    (kind === 'down' ? DOWN_HELP : '');
  return { subject, text };
}
