# Laya vs Jev — AI vs AI Arena

Two AI models go head to head in a **snake race** and a **Mortal-Kombat-style fight**.
Every move is a real decision from the model — nothing is scripted.

- **Laya** — open source, Apache 2.0, runs **locally** on your machine · [GitHub](https://github.com/NandhaKishorM/laya) · [Hugging Face](https://huggingface.co/convaiinnovations/laya)
- **Jev** — TypeSafe's closed model, runs over their **API** · [announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

Both take the same input and answer the same typed questions, so the only thing that
changes between the two sides is the model. From the **Prompt Engineer 48** YouTube video.

---

## Play Human vs Jev on your own server (Docker)

```bash
docker run -d --name arena --restart unless-stopped -p 80:8732 --cpus 1 --memory 512m -e TYPESAFE_API_KEY=your_key_here ghcr.io/promptengineer48/laya-vs-jev-arena:latest
```

Open `http://YOUR_SERVER_IP`. Full VPS guide, HTTPS and key protection: [DEPLOY.md](DEPLOY.md).

## Quickstart

**You need:** Python 3.10+, a browser, and (for Jev) a TypeSafe API key from
[console.typesafe.ai](https://console.typesafe.ai). Laya needs no key.

```bash
git clone https://github.com/PromptEngineer48/laya-vs-jev-arena.git
cd laya-vs-jev-arena
pip install -r requirements.txt
```

Add your Jev key:

```bash
cp .env.example .env          # Windows: copy .env.example .env
```

Open `.env` and paste your key after `TYPESAFE_API_KEY=`.

Start the server:

```bash
python server.py 8740
```

Then open:

| | |
|---|---|
| Front page | http://localhost:8740/ |
| Snake race | http://localhost:8740/snake/ |
| Kombat | http://localhost:8740/fight/ |

Pick a model for each side from the dropdowns and hit **Start race** / **Fight**.

### Good to know

- **The first Laya call takes ~30–60 s** — it downloads and loads the checkpoints once.
  That happens during "Priming…", before the clock starts.
- **Keep the tab in the foreground.** Browsers throttle background tabs, and the game only
  advances while the page is drawing.
- **No key?** Set both sides to Laya — or play yourself with *Human · keyboard*
  (arrow keys / A·D to steer, W to sprint).
- **Your key never reaches the browser.** `server.py` proxies every Jev call, so the key
  stays in the Python process.
- Change the **seed** to get a different apple layout; both sides always get the same one.
- **Export JSON** saves every number from a run — score, decisions/s, p50/p95 latency, tokens.

---

## How it works

`server.py` serves the page and exposes two backends that take the **same**
`{state, questions}` payload and return the **same** answer shape:

| Route | Backend | Notes |
| --- | --- | --- |
| `POST /api/laya` | `laya.Router` in-process | `pip install laya`; first call loads the checkpoints |
| `POST /api/jev`  | `https://api.typesafe.ai/v1/systemone` | key read from `.env` (`TYPESAFE_API_KEY`), never sent to the browser |

## The judgments

Both questions are asked in one request, so they run in parallel:

- `steer` — **choice** over `HARD_LEFT / LEFT / STRAIGHT / RIGHT / HARD_RIGHT`
- `sprint` — **noul**, whether a sprint gets to the apple sooner or overshoots it

Nothing can kill the snake: the body is passable and the **edges wrap around**. So the
state is just the arena size, the snake's length and speed, and the nearest apple's
distance and bearing — measured along the **shortest route**, which may run out one
edge and in the opposite one. Everything is relative to the snake's heading, so one
question works whichever way it faces.

## Fairness rules

- **Same seed** on both sides: identical apple sequence and identical spawn.
- **One shared pace**, derived from the *slowest* side's measured latency, so a slow
  model is not punished twice. Its disadvantage shows up as decisions/s, not speed.
- **Warm-up decision** before the clock starts, so nobody drives blind off the line
  and a local model's load time is not charged to the race.
- **Nothing dies** (`CFG.passThroughSelf`, `CFG.wrapWalls`): the snake glides over
  itself and wraps through the edges. A race is a fixed round (60 s by default, set in
  the header) and the most apples wins. The round runs on **simulated** seconds, so a
  throttled tab cannot run out the clock without the world having moved.
- **Wrapping is invisible to the drawing**: the spine is kept in unwrapped coordinates
  and the body is drawn again one arena over, so a snake mid-edge shows on both sides
  with no line across the screen. Setting either flag to `false` restores classic rules.
- **Turn budget** per answer: a decision is held until the next one lands, so without
  a cap a 1s round trip would spin the snake in a full circle.

`Export JSON` writes score, apples, survival, decisions, decisions/s, p50/p95 latency
and token usage per side.

## What I measured

In the video's recording: Laya won the snake race 90–50 and took the first fight by K.O.;
in the second fight Jev was ahead on health. Laya ran at ~133 ms p50 (13.4 decisions/s),
Jev at ~962 ms p50 (2.9 decisions/s) — Jev's latency includes my network round trip from
India. Asked the snake steering question on 8 fixed apple positions, Jev answered 8/8
correctly and Laya 7/8, with lower confidence. **Laya's edge here is speed, not judgment.**
Run your own seeds — that's what the harness is for.

## Kombat — the fighting benchmark

`fight/` is the same idea with a harsher clock: two canvas-drawn fighters, one
model each, health bars and a 90 second round.

- `action` — **choice** over `ADVANCE / RETREAT / PUNCH / KICK / BLOCK / JUMP`
- `commit` — **noul**, whether this is the moment for the slow heavy attack

State is what a fighter can see: both healths, the gap in pixels, whether each attack
would reach, and crucially what the opponent is doing *right now* — winding up,
striking, recovering and open, or blocking.

Attacks have real frame data (startup / active / recovery). Blocking cuts damage to
20%, and a whiffed kick leaves a long punish window. The whole round is paced so one
kick's startup is about 1.15 round trips of the **slower** model — otherwise the slow
side could never physically block, which would make the test meaningless rather than
hard. That tempo multiplier is shown in the header and written into the export.

## Play against the models yourself

Every arena has a **Human** option in each side's dropdown: You vs Laya, You vs Jev, or
two people on one keyboard (left side on WASD, right side on the arrows).

| Game | Left side | Right side |
|---|---|---|
| Snake | A / D steer, W sprint | same keys |
| Runner | A / D change lane | ← / → |
| Flappy | W or Space flap | ↑ or Enter |
| Tetris | A / D move · W rotate · S drop | ← / → · ↑ · ↓ |
| Kombat | A / D move · F punch · G kick · hold H block · W jump | ← / → · K · L · hold ; · ↑ |

A human plays with no delay, so where a game is paced to the slower player (Snake,
Kombat) a match against Jev runs at Jev's pace — slowed so the model *can* react.

## Runner, Flappy and Tetris

Three more arenas on the same server, same shared agent code:

| Game | URL | The model answers | Code does |
|---|---|---|---|
| Runner | `/runner/` | one yes/no per lane: is there a barrier? | moves to the clearest lane |
| Flappy | `/flappy/` | one yes/no per position: is the next gap here? | flies the bird to the likeliest gap |
| Tetris | `/tetris/` | one yes/no per distinct landing spot: would it leave the stack clean? | drops the piece on the best-rated spot |

Two design lessons from testing, both baked into the code:

- **Flapping is a reflex no model can do.** Even a perfect bird that sees the world 0.3 s
  late dies within seconds, so the model reads the next gap and code flies.
- **Tell Laya one thing per sentence.** "The next gap is near the top. The bird is in the
  middle." made Laya answer with the *bird's* position (0/6); describing only the gap
  gave 6/6.

## Layout

    index.html            the lab's front page, links both arenas
    server.py             static server + /api/jev proxy + /api/laya backend
    .env.example          copy to .env and add your TYPESAFE_API_KEY

    shared/
      agents.js           ModelAgent (any model id, pipelined; each game brings its
                          own questions and state) and HumanAgent (keyboard)
    snake/
      index.html          the two-arena race: agent pickers, seed, HUD, export
      game.js             arena, seeded RNG, snake physics, renderer
      standalone.html     the original single-player game, classic rules
    fight/
      index.html          the ring: health bars, decision panels, export
      fight.js            fighters, frame data, hit resolution, renderer
    runner/  flappy/  tetris/
      index.html + <game>.js   side-by-side arenas, seeded, shared/arena.css layout
    rocket/               Rocket League bots (RLBot v5), see rocket/README.md

Both arenas import `../shared/agents.js`, so the networking, metrics and pipelining
are written once. A game supplies its own `questions` and its own `senseState()`.
