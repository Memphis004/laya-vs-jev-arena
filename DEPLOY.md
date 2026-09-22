# Deploy the arena on a VPS (Human vs Jev)

Five browser games — Snake, Kombat, Runner, Flappy, Tetris — where **you play against
Jev**, TypeSafe's decision model. One small Docker image (~50 MB). The games run in each
player's browser; the server only serves files and forwards Jev calls, so a 2-vCPU VPS
handles lots of players.

You need a **TypeSafe API key** (https://typesafe.ai). No key on the server? Players can
paste their own key on the front page instead.

---

## 1. Get a VPS

Any Linux VPS works. On Hostinger: pick a **KVM** plan (KVM 1 is plenty, KVM 2 is roomy),
and choose the **Ubuntu 24.04 with Docker** template so Docker comes pre-installed.

Log in from your terminal (the IP and root password are in hPanel → VPS → Overview):

```bash
ssh root@YOUR_VPS_IP
```

## 2. Run it — one command

```bash
docker run -d --name arena --restart unless-stopped -p 80:8732 --cpus 1 --memory 512m -e TYPESAFE_API_KEY=your_key_here ghcr.io/promptengineer48/laya-vs-jev-arena:latest
```

Open `http://YOUR_VPS_IP` and play. Done.

- `--cpus 1 --memory 512m` caps what the arena may use, so the rest of the VPS stays free.
- Leave out `-e TYPESAFE_API_KEY=...` if you want every player to bring their own key.

Update to the newest version later:

```bash
docker pull ghcr.io/promptengineer48/laya-vs-jev-arena:latest && docker rm -f arena
```

…then run the `docker run` command again.

## 3. (Optional) Your own domain with HTTPS

Point a domain's **A record** at the VPS IP (Hostinger: hPanel → Domains → DNS), then:

```bash
git clone https://github.com/PromptEngineer48/laya-vs-jev-arena.git
cd laya-vs-jev-arena
printf 'TYPESAFE_API_KEY=your_key_here\nDOMAIN=arena.yourdomain.com\n' > .env
docker compose up -d
```

Caddy gets a free HTTPS certificate automatically. Open `https://arena.yourdomain.com`.

---

## Protecting your key on a public server

Every AI match played on your server spends **your** Jev key. The server has three guards,
all set with environment variables (`-e NAME=value`, or in `.env` for compose):

| Variable | Default | What it limits |
|---|---|---|
| `JEV_RATE_PER_MIN` | 360 | Jev calls per minute from one visitor (one Jev side ≈ 150/min) |
| `JEV_MAX_INFLIGHT` | 24 | Jev calls running at once, whole server (≈ 8 live AI matches) |
| `JEV_DAILY_CAP` | 20000 | Jev calls per day on your key; `0` = no cap |

When the daily cap is hit, players see a message asking them to paste their own key, and
**Human vs Human keeps working**. A player's own key is stored only in their browser and
skips the daily cap. Also set a spending limit in your TypeSafe dashboard.

## Controls

| | Left player | Right player |
|---|---|---|
| Move | A / D | ← / → |
| Up / jump / flap | W (or Space) | ↑ (or Enter) |
| Down | S | ↓ |
| Actions | F G H | K L ; |

Two people can share one keyboard, or pick **Human** on one side and **Jev** on the other.

## Laya (local model)

The image leaves Laya out on purpose: on a CPU-only VPS it needs ~1.8 s per decision,
slower than Jev over the network. To race Laya vs Jev, run the repo on a machine with an
NVIDIA GPU (`pip install -r requirements.txt && python server.py`) — see README.md.
