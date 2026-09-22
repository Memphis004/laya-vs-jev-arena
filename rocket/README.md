# Laya vs Jev — Rocket League

Two AI models drive two cars in a real Rocket League 1v1. Each model picks the
**tactic**; plain code does the **driving** at the game's 120 frames a second.

| Model asks (typed) | Answer |
|---|---|
| `tactic` — choice | SHOOT · CHALLENGE · DEFEND · SHADOW · GET_BOOST |
| `boost` — noul | is burning boost worth it right now? |

The model thinks in a background thread; the car always follows its latest answer, so a
1-second API round trip never freezes the car. Kickoffs and the "ball is in the air in
front of me, jump" reflex are handled by code for both bots.

## Setup (once)

1. Install **Rocket League** from the Epic Games Store (free, ~40 GB).
2. Install the **RLBot v5 launcher**: https://rlbot.org/v5/ (puts `RLBotServer` in place).
3. Create the bot environment:

```bash
cd rocket
python -m venv venv
venv\Scripts\python -m pip install -r requirements.txt
```

## Run a match

Terminal 1, from the repo root (model server, same one the snake and fight use):

```bash
python server.py 8740
```

Terminal 2:

```bash
cd rocket
venv\Scripts\python run_match.py
```

This warms Laya up, launches Rocket League through Epic, and starts **Laya (blue) vs
Jev (orange)**, five minutes. The top corners show each bot's current tactic, p50
latency, decisions per second and boost probability. The tactic also floats above
each car.

Or use the RLBot launcher GUI: add this folder, pick `laya.bot.toml` and `jev.bot.toml`,
start a match.

Every decision is logged to `rocket/logs/<bot>_<time>.jsonl` (state, tactic,
probabilities, latency).

## What to expect

Tested before any match, on the exact questions the bots ask:

| Situation | Jev | Laya |
|---|---|---|
| Ball racing at my goal | DEFEND (0.93) | GET_BOOST (0.30) |
| Behind the ball, open net | SHOOT (0.85) | GET_BOOST (0.30) |
| No boost, ball far away | GET_BOOST | GET_BOOST |

Jev weighs several facts at once and picks the right tactic with confidence. Laya,
out of the box, settles on one option whatever the situation. Splitting the choice
into per-tactic yes/no questions did not fix it (every probability stayed between
0.35 and 0.60). Laya's strength in the snake and the fight was speed on simple
perception; Rocket League tactics need multi-factor judgment, and there Jev leads.
Both bots get identical questions — nothing is tuned in either model's favour.
