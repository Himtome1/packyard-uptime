// Uptime probes: one request per check, no load. Pure Node, no dependencies.
// Used by uptime-watch.mjs (on the box) and copied unchanged into the public outside runner.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';

const varint = (n) => { const b = []; do { let t = n & 0x7f; n >>>= 7; if (n) t |= 0x80; b.push(t); } while (n); return Buffer.from(b); };

/** HTTP GET, ok when the status is 200. */
export async function httpCheck(url, timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'packyard-uptime/1' } });
    await r.arrayBuffer().catch(() => undefined);
    return { ok: r.status === 200, detail: `HTTP ${r.status} in ${Date.now() - t0} ms` };
  } catch (e) {
    return { ok: false, detail: `request failed: ${e.cause?.code ?? e.name ?? ''} ${e.message}`.trim() };
  }
}

/** Minecraft Java status ping (Server List Ping) by name: the hostname goes in the handshake, as a client does. */
export function mcPing(host, port = 25565, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let buf = Buffer.alloc(0);
    let done = false;
    const end = (ok, detail) => { if (done) return; done = true; sock.destroy(); resolve({ ok, detail }); };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => end(false, `no status reply within ${timeoutMs} ms`));
    sock.on('error', (e) => end(false, `connect failed: ${e.code ?? e.message}`));
    sock.on('connect', () => {
      const h = Buffer.from(host);
      const p = Buffer.concat([varint(0), varint(767), varint(h.length), h, Buffer.from([port >> 8, port & 255]), varint(1)]);
      sock.write(Buffer.concat([varint(p.length), p, varint(1), varint(0)]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        let i = 0;
        const rv = () => { let n = 0, s = 0, c; do { if (i >= buf.length) throw new RangeError('short'); c = buf[i++]; n |= (c & 0x7f) << s; s += 7; } while (c & 0x80); return n; };
        const len = rv(); if (buf.length - i < len) return;
        rv(); const jl = rv();
        const j = JSON.parse(buf.subarray(i, i + jl).toString('utf8'));
        end(true, `${j.version?.name ?? '?'} players ${j.players?.online ?? '?'}/${j.players?.max ?? '?'} in ${Date.now() - t0} ms`);
      } catch (e) { if (!(e instanceof RangeError)) end(false, `bad status reply: ${e.message}`); }
    });
    sock.on('close', () => end(false, 'closed without a status reply'));
  });
}

/** Steam A2S_INFO (Valheim, Project Zomboid), answering a challenge if the server asks for one. */
export function a2sInfo(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const q = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0')]);
    const s = dgram.createSocket('udp4');
    let done = false;
    const end = (ok, detail) => { if (done) return; done = true; clearTimeout(t); s.close(); resolve({ ok, detail }); };
    const t = setTimeout(() => end(false, `no A2S reply on ${port} within ${timeoutMs} ms`), timeoutMs);
    s.on('error', (e) => end(false, `udp error: ${e.code ?? e.message}`));
    s.on('message', (m) => {
      if (m.length >= 9 && m[4] === 0x41) { s.send(Buffer.concat([q, m.subarray(5, 9)]), port, host); return; }
      if (m.length > 6 && m[4] === 0x49) end(true, `A2S info on ${port} in ${Date.now() - t0} ms`);
      else end(false, `unexpected A2S reply 0x${(m[4] ?? 0).toString(16)}`);
    });
    s.send(q, port, host);
  });
}

/** Terraria: send Connect Request and read the first reply (password request, slot or version disconnect = alive). */
export function terrariaPing(host, port, version = 326, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const name = Buffer.from(`Terraria${version}`);
    const payload = Buffer.concat([Buffer.from([1]), varint(name.length), name]);
    const head = Buffer.alloc(2); head.writeUInt16LE(payload.length + 2);
    let done = false;
    const end = (ok, detail) => { if (done) return; done = true; sock.destroy(); resolve({ ok, detail }); };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => end(false, `no Terraria reply within ${timeoutMs} ms`));
    sock.on('error', (e) => end(false, `connect failed: ${e.code ?? e.message}`));
    sock.on('connect', () => sock.write(Buffer.concat([head, payload])));
    sock.on('data', (d) => {
      if (d.length < 3) return;
      const kind = d[2];
      end([2, 3, 37].includes(kind), `Terraria reply ${kind} in ${Date.now() - t0} ms`);
    });
    sock.on('close', () => end(false, 'closed without a Terraria reply'));
  });
}

/** Game check by address "<host>[:port]" and game id. A2S games try the given port, then port+1 (Valheim query). */
export async function gameCheck(game, address) {
  const [host, p] = address.split(':');
  let ip;
  try { ip = (await dns.lookup(host, { family: 4 })).address; } catch (e) { return { ok: false, detail: `DNS lookup failed: ${e.code ?? e.message}` }; }
  if (game === 'minecraft') return mcPing(host, Number(p || 25565));
  if (game === 'terraria') return terrariaPing(ip, Number(p));
  if (game === 'valheim' || game === 'zomboid') {
    const a = await a2sInfo(ip, Number(p));
    if (a.ok) return a;
    const b = await a2sInfo(ip, Number(p) + 1);
    return b.ok ? b : { ok: false, detail: `${a.detail}; ${b.detail}` };
  }
  return { ok: false, detail: `unknown game ${game}` };
}
