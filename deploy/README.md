# Deployment

The bot makes **only outbound connections**. It needs no inbound ports, no public IP, no
domain, and no TLS certificate. That rules out one class of host and makes another
class trivially easy.

---

## Choosing a host

**Serverless will not work.** Discord's HTTP Interactions transport — what lets bots run
on Cloudflare Workers, Lambda, or Vercel — only ever delivers slash commands and button
clicks. It never delivers `messageCreate`. Reading a username typed into a channel
requires a persistent Gateway WebSocket, so the process must stay resident.

| Option                           | Cost             | Verdict                                                                                                                                      |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Oracle Cloud Always Free**     | Free             | **Recommended.** The only genuinely permanent free tier left. ARM, 2 OCPU / 12 GB since the June 2026 reduction — roughly 6× what this needs |
| **Raspberry Pi / spare machine** | Hardware you own | **Also good.** No inbound ports needed, so no router configuration                                                                           |
| Google Cloud `e2-micro`          | Free             | Solid fallback if Oracle has no capacity. Watch egress past 1 GB/month                                                                       |
| Hetzner / DigitalOcean / Vultr   | ~$4–6/mo         | Pay to skip Oracle's capacity lottery                                                                                                        |
| Railway                          | $5/mo credit     | Easiest deploy; bot burns ~$2–3 of the credit. Credit, not a free tier                                                                       |
| Fly.io                           | $5/mo minimum    | Free tier ended October 2024                                                                                                                 |
| Render (free)                    | Free             | ❌ Sleeps after 15 min idle, severing the Gateway connection                                                                                 |
| Cloudflare Workers               | Free             | ❌ Cannot hold a WebSocket                                                                                                                   |

> Your Cloudflare domain is not needed for this bot. It would only matter if GitHub OAuth
> verification were added later, at which point `cloudflared` gives you a free tunnel to a
> home machine with no port forwarding.

---

## Oracle Cloud (recommended)

### Create the instance

1. Sign up at <https://cloud.oracle.com>. A credit card is required for identity
   verification; Always Free resources are not charged.
2. **Compute → Instances → Create Instance**
3. **Image:** Canonical Ubuntu 24.04 — **Minimal aarch64** (must be the ARM build)
4. **Shape:** Ampere → `VM.Standard.A1.Flex` → **2 OCPU / 12 GB** (the current
   Always Free ceiling; more will be terminated)
5. Add your SSH public key, then create.

**"Out of host capacity"** is common in busy regions. Options, cheapest first:

- Retry the create page periodically — capacity frees up in waves
- Pick a less contested region at signup (**your home region cannot be changed later**)
- Use a retry script such as [`hitrov/oci-arm-host-capacity`](https://github.com/hitrov/oci-arm-host-capacity)

Oracle stops Always Free instances after **7 consecutive days of idle**. A bot holding a
Gateway connection generates continuous traffic, so this effectively never triggers.

### Provision

```bash
ssh ubuntu@<public-ip>

# Node 22+ (Ubuntu's apt version is too old for node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version    # expect v24.x or newer

# Oracle images ship a restrictive iptables config, but the bot needs no
# inbound ports at all -- leave it alone.

sudo useradd -r -m -d /opt/discord-util-bot -s /usr/sbin/nologin botuser
sudo git clone <your-repo-url> /opt/discord-util-bot
cd /opt/discord-util-bot
sudo -u botuser npm ci --omit=dev
sudo -u botuser npm run build
```

### Secrets

Never commit `.env` or the `.pem`. Copy them over separately:

```bash
# from your laptop
scp .env ubuntu@<ip>:/tmp/.env
scp ~/.config/discord-util-bot/app.pem ubuntu@<ip>:/tmp/app.pem

# on the server
sudo mv /tmp/.env /opt/discord-util-bot/.env
sudo mv /tmp/app.pem /opt/discord-util-bot/app.pem
sudo chown botuser:botuser /opt/discord-util-bot/{.env,app.pem}
sudo chmod 600 /opt/discord-util-bot/{.env,app.pem}
```

Then edit `/opt/discord-util-bot/.env`:

```ini
GITHUB_APP_PRIVATE_KEY_PATH=/opt/discord-util-bot/app.pem   # absolute; ~ is not expanded
DATA_DIR=/opt/discord-util-bot/data
NODE_ENV=production
DEV_GUILD_ID=                    # empty → global commands
GITHUB_DRY_RUN=false
```

### Run under systemd

```bash
sudo mkdir -p /opt/discord-util-bot/data
sudo chown botuser:botuser /opt/discord-util-bot/data

sudo cp deploy/discord-util-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now discord-util-bot

systemctl status discord-util-bot
journalctl -u discord-util-bot -f
```

The unit sets `Restart=always` with `StartLimitIntervalSec=0`. The bot exits deliberately
on unhandled errors rather than continuing in an undefined state; without disabling the
start limit, a crash loop would trip systemd's default and leave it down.

### Verify

```bash
sudo -u botuser npm run check-github      # GitHub side
sudo -u botuser npm run deploy-commands   # register globally (once)
journalctl -u discord-util-bot -n 50
```

---

## Docker

```bash
docker compose up -d
docker compose logs -f
```

Secrets come from `.env`; SQLite lives on a named volume so it survives rebuilds. The
image runs as the unprivileged `node` user and exposes no ports.

---

## Updating

```bash
cd /opt/discord-util-bot
sudo -u botuser git pull
sudo -u botuser npm ci --omit=dev
sudo -u botuser npm run build
sudo systemctl restart discord-util-bot
```

Run `npm run deploy-commands` only when a command's **definition** changed — name,
description, or options. Editing handler code does not require it.

---

## Backups

Everything durable is one SQLite file. WAL mode means copying it while running can catch
a partial write, so use SQLite's own backup:

```bash
sudo -u botuser sqlite3 /opt/discord-util-bot/data/bot.sqlite \
  ".backup '/opt/discord-util-bot/data/backup-$(date +%F).sqlite'"
```

Losing it costs channel configuration and invite history — not credentials, and not
anything on GitHub's side.

---

## Operating remotely

```bash
journalctl -u discord-util-bot -f              # live logs
journalctl -u discord-util-bot -p err -n 100   # errors only
systemctl restart discord-util-bot
```

`npm run doctor` works over SSH and echoes what the bot receives, which is the fastest
way to diagnose a channel that has stopped responding.
