# Deploying to the POC server

Written for whoever runs the POC box. Assumes Linux with SSH access.

This deployment is **reachable beyond the server**, so steps 5 and 6 are not
optional — see [Why auth is mandatory here](#why-auth-is-mandatory-here).

---

## 1. Push from the dev machine

The repo has two commits on `main` and no remote yet. Create an empty repo on
your Git host (no README, no .gitignore — this repo already has both), then:

```bash
cd ~/Desktop/site-audit
git remote add origin <your-repo-url>
git push -u origin main
```

## 2. Check the server has Node 20+

```bash
node -v    # must be v20 or newer
npm -v
```

If it is older, install Node 20 LTS — on Debian/Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 3. Clone and install

```bash
sudo mkdir -p /opt/site-audit && sudo chown "$USER" /opt/site-audit
git clone <your-repo-url> /opt/site-audit
cd /opt/site-audit
npm install
```

`npm install` **must run on the server**. `better-sqlite3` is a native module;
a `node_modules` copied from another machine will not load. On glibc Linux
x64/arm64 npm downloads a prebuilt binary. On Alpine (musl) there is no
prebuild and it compiles from source, which needs:

```bash
apk add --no-cache python3 make g++
```

## 4. Build the UI

```bash
npm run build
```

`client/dist/` is gitignored, so this runs on the server. The API serves the
built files from the same port — there is no separate web server to configure.

## 5. Create the env file

```bash
cp .env.example .env
nano .env
```

Fill in at minimum:

```ini
PORT=31302
HOST=0.0.0.0
AUTH_USER=<pick one>
AUTH_PASSWORD=<generate: openssl rand -base64 24>
DATABASE_PATH=/var/lib/site-audit/site-audit.db
```

To crawl internal sites, add the specific targets — exact hostnames and IPv4
CIDRs only, comma separated:

```ini
ALLOW_PRIVATE_HOSTS=intranet.example.com,10.20.0.0/16
```

Anything not listed stays blocked. Cloud metadata endpoints
(`169.254.169.254`, `metadata.google.internal`) can never be allowlisted.

Lock the file down — it holds the password:

```bash
chmod 600 .env
```

## 6. Create the data directory

```bash
sudo mkdir -p /var/lib/site-audit
sudo chown "$USER" /var/lib/site-audit
```

SQLite in WAL mode writes `.db`, `.db-wal` and `.db-shm` here. Back up the
directory, not just the `.db`.

## 7. Start it

```bash
cd /opt/site-audit
set -a; . ./.env; set +a
nohup npm start > /var/log/site-audit.log 2>&1 &
echo $! > /tmp/site-audit.pid
```

Confirm what it reports at boot:

```bash
head -5 /var/log/site-audit.log
```

You want to see:

```
Site audit listening on http://0.0.0.0:31302
Auth: on (basic)
SSRF policy: 2 private host pattern(s) allowlisted via ALLOW_PRIVATE_HOSTS
```

If it says `Auth: OFF` or prints a `WARNING`, stop and fix `.env` before
opening the firewall. Check it answers:

```bash
curl -i http://localhost:31302/api/audits          # expect 401
curl -u "$AUTH_USER:$AUTH_PASSWORD" \
     http://localhost:31302/api/audits             # expect []
```

## 8. Open the port

```bash
sudo ufw allow 31302/tcp          # or firewall-cmd, or your cloud SG
```

Open it to the narrowest source range that works for your reviewers.

## 9. Use it

Browse to `http://<server>:31302/`. The browser prompts for the username and
password from `.env`.

---

## Running it behind a workspace proxy (code-server)

A code-server workspace reaches apps at
`https://workspace.intermesh.net/<workspace-id>-<port>/` rather than on the raw
port, and its proxy **dials `0.0.0.0`, not loopback**. Two settings matter:

```ini
HOST=0.0.0.0          # or the proxy never sees a listener and nginx 404s
BASE_PATH=            # see below
```

`HOST` is the common cause of a bare nginx 404: with the default
`127.0.0.1` binding nothing is listening on the address the proxy dials, so no
route is ever registered for that port.

The built page and the UI's API calls both use paths relative to wherever the
app is mounted, so one build works at the server root and under any prefix.
What you still have to match is whether the proxy forwards its prefix:

| The proxy... | Set |
| --- | --- |
| strips the prefix (server sees `/api/audits`) | leave `BASE_PATH` empty |
| forwards it (server sees `/<prefix>/api/audits`) | `BASE_PATH=/<prefix>` |

To tell which, with the app running, from a shell on the workspace:

```bash
curl -s -o /dev/null -w '%{http_code}
' http://localhost:31302/api/audits
```

Then load the page in the browser and check DevTools -> Network: if the request
for `api/audits` 404s while the page itself loads, the proxy is forwarding the
prefix and you need `BASE_PATH`.

## Running it

```bash
# Is it up?
curl -s -o /dev/null -w '%{http_code}\n' -u "$AUTH_USER:$AUTH_PASSWORD" \
  http://localhost:31302/api/audits

# Logs
tail -f /var/log/site-audit.log

# Stop
kill "$(cat /tmp/site-audit.pid)"
```

**`nohup` does not survive a reboot.** After any restart of the box, re-run
step 7. When the POC outlives its first reboot, convert it to a systemd unit —
the command and environment above translate directly into `ExecStart` and
`EnvironmentFile`.

## Updating

```bash
cd /opt/site-audit
kill "$(cat /tmp/site-audit.pid)"
git pull
npm install          # only if package.json changed
npm run build        # only if anything under client/ changed
set -a; . ./.env; set +a
nohup npm start > /var/log/site-audit.log 2>&1 &
echo $! > /tmp/site-audit.pid
```

The database carries across. Audits left `running` when the process stopped
are marked failed at the next start, so none get stuck.

---

## Why auth is mandatory here

This app makes the server fetch any URL a user types, from the server's IP and
inside the server's network. Reachable without auth, that is an open SSRF
proxy — someone else's traffic, attributed to you. `ALLOW_PRIVATE_HOSTS` raises
the stakes, because those requests reach your intranet.

Two limits worth knowing before you share the link:

- **Basic auth over plain HTTP sends the password, base64-encoded, on every
  request.** Anyone able to observe the traffic can read it. For a POC on an
  internal network that is usually accepted; before this is reachable from the
  public internet, put it behind a reverse proxy with TLS, or an SSH tunnel.
- **There is one shared credential and no audit log of who ran what.** That is
  fine for a demo and not a basis for wider rollout.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Cannot find module ... better_sqlite3.node` | `node_modules` was copied from another machine, or `npm install` ran as a different user. Delete `node_modules` and reinstall on the server. |
| `EADDRINUSE` | Something already holds the port: `ss -ltnp \| grep 31302`. |
| `SQLITE_CANTOPEN` | `DATABASE_PATH` directory is missing or not writable by the service user (step 6). |
| 401 from the browser that never accepts the password | `.env` was not loaded into the shell that ran `npm start` — `set -a; . ./.env; set +a` must be in the same shell. |
| Blank page, API works | `npm run build` was not run, so `client/dist/` does not exist. |
| "That host cannot be audited." | Target is private and not in `ALLOW_PRIVATE_HOSTS`, or it is a metadata endpoint, which is always refused. |
| Audit stalls at 1 page | The site blocked the crawler — the report says so. Not a server problem. |
