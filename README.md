# packyard-uptime

Outside uptime check for packyard.ca, run every ~5 minutes on GitHub-hosted runners.

- Checks the home page and the order page (HTTP 200), plus one Minecraft status ping by name through the game edge.
- A failing check is re-checked once after 2 minutes. Two failures in a row send one email; a recovery sends one more.
- Incident state is kept in the Actions cache. Hostnames and the alert address are repository secrets.
- One request per check, no load.

`probes.mjs` and `alerting.mjs` are shared with the inside check that runs on the server. MIT licensed.
