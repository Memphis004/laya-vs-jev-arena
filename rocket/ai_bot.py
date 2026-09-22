"""Rocket League bot driven by a typed-decision model (Laya or Jev).

Same split as the snake and the fight: the MODEL picks the tactic, plain CODE drives
the car. Rocket League runs at 120 frames a second and neither model answers anywhere
near that fast (Laya ~0.1-0.3 s, Jev ~1 s), so:

  - a background thread keeps asking the model "what should I do now?" and stores the
    latest answer;
  - get_output(), called every frame, never waits for the model. It reads the latest
    tactic and steers toward that tactic's target at full frame rate.

The model is reached through the lab's server.py (http://localhost:8740), which runs
Laya once in-process and proxies Jev with the API key kept server-side. Both bots are
separate processes, so they share that one Laya instance instead of loading two.

    python ai_bot.py laya        (normally started by RLBot from laya.bot.toml)
    python ai_bot.py jev
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

from rlbot import flat
from rlbot.managers import Bot

BRAIN_URL = os.environ.get("BRAIN_URL", "http://localhost:8740")
GOAL_Y = 5120.0          # goals sit at y = +/-5120; blue (team 0) defends -y
LOG_DIR = Path(__file__).parent / "logs"

BACKENDS = {
    "laya": {"endpoint": "/api/laya", "model": "laya", "label": "LAYA · local"},
    "jev":  {"endpoint": "/api/jev",  "model": "jev-latest", "label": "JEV · API"},
}

TACTICS = ["SHOOT", "CHALLENGE", "DEFEND", "SHADOW", "GET_BOOST"]

QUESTIONS = {
    "tactic": {
        "type": "choice",
        "instructions": {
            "task": "You control one car in a one-on-one Rocket League match. Choose the tactic for the next moment of play.",
            "goal": "Score more goals than the opponent. A goal is scored by knocking the ball into the opponent's net.",
            "reading_the_state": "Distances are in Rocket League units; the field is about 8200 long and 10200 deep including goals. 'toward my goal' means the ball is heading for the net I defend. Boost is 0-100 and makes the car much faster.",
            "priorities": "If the ball is heading toward my goal and I am not between it and my goal, defend. If I am closer to the ball than the opponent, attack it. If I am low on boost and the play is far away, collect boost."
        },
        "criteria": {
            "SHOOT": "Line up behind the ball and hit it toward the opponent's goal. Use when I will reach the ball first and have a clear angle on goal.",
            "CHALLENGE": "Drive straight at the ball as fast as possible to beat the opponent to it. Use when the opponent is about to reach the ball.",
            "DEFEND": "Race back to my own goal and guard it. Use when the ball is heading toward my goal or the opponent is attacking and I am out of position.",
            "SHADOW": "Hang back between the ball and my goal, staying ready. Use when the opponent has the ball and a challenge would likely lose.",
            "GET_BOOST": "Go collect a full boost pad. Use when my boost is low and I have time because the ball is far away."
        }
    },
    "boost": {
        "type": "noul",
        "instructions": "Burning boost makes the car much faster but boost runs out. Should the car use boost right now?",
        "criteria": {
            "true": "Getting there first matters right now: a race to the ball, a counter-attack, or a save.",
            "false": "Boost is low, or there is no rush and it is better to save it."
        }
    }
}


def post(endpoint: str, payload: dict, timeout: float = 15.0) -> dict:
    req = urllib.request.Request(
        BRAIN_URL + endpoint, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


class Brain(threading.Thread):
    """Keeps asking the model for a tactic; the car reads whatever answer is latest."""

    def __init__(self, backend: dict, log_path: Path):
        super().__init__(daemon=True)
        self.backend = backend
        self.state: dict | None = None         # written by the game loop
        self.tactic = "CHALLENGE"              # sensible opener until the first answer
        self.boost_p = 1.0
        self.probs: dict = {}
        self.latency_ms = 0.0
        self.latencies: list[float] = []
        self.decisions = 0
        self.error = ""
        self.started = time.time()
        self.log = open(log_path, "a", encoding="utf-8")

    @property
    def rate(self) -> float:
        return self.decisions / max(1e-6, time.time() - self.started)

    @property
    def p50(self) -> float:
        s = sorted(self.latencies[-60:])
        return s[len(s) // 2] if s else 0.0

    def run(self):
        while True:
            state = self.state
            if state is None:
                time.sleep(0.05)
                continue
            t0 = time.time()
            try:
                res = post(self.backend["endpoint"],
                           {"model": self.backend["model"], "state": state, "questions": QUESTIONS})
                if "error" in res:
                    raise RuntimeError(res["error"])
                a = res["answers"]
                self.tactic = a["tactic"]["choice"]
                self.probs = a["tactic"].get("probabilities", {})
                self.boost_p = a["boost"].get("noul", 0.0)
                self.latency_ms = (time.time() - t0) * 1000
                self.latencies.append(self.latency_ms)
                self.decisions += 1
                self.error = ""
                self.log.write(json.dumps({"t": round(time.time(), 3), "state": state,
                                           "tactic": self.tactic, "probs": self.probs,
                                           "boost_p": self.boost_p,
                                           "ms": round(self.latency_ms)}) + "\n")
                self.log.flush()
            except Exception as exc:                  # server down, timeout, bad answer
                self.error = str(exc)[:80]
                time.sleep(0.5)


# ---------- geometry ----------
def v2(v) -> tuple[float, float]:
    return (float(v.x), float(v.y))


def dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def steer_toward(car: flat.PlayerInfo, target: tuple[float, float]) -> tuple[float, float]:
    """(steer, angle): steer in [-1,1] to face target, and the signed angle to it."""
    yaw = float(car.physics.rotation.yaw)
    loc = v2(car.physics.location)
    want = math.atan2(target[1] - loc[1], target[0] - loc[0])
    ang = (want - yaw + math.pi) % (2 * math.pi) - math.pi
    return max(-1.0, min(1.0, ang * 2.5)), ang


class AIBot(Bot):
    def __init__(self, which: str):
        self.which = which
        self.backend = BACKENDS[which]
        super().__init__(f"promptengineer48/{which}")
        LOG_DIR.mkdir(exist_ok=True)
        self.brain = Brain(self.backend, LOG_DIR / f"{which}_{int(time.time())}.jsonl")
        self.big_pads: list[tuple[int, tuple[float, float]]] = []
        self.controller = flat.ControllerState()
        self.jump_frames = 0

    def initialize(self):
        self.big_pads = [(i, v2(p.location)) for i, p in enumerate(self.field_info.boost_pads)
                         if p.is_full_boost]
        self.brain.start()
        self.logger.info(f"{self.backend['label']} ready, {len(self.big_pads)} big boost pads")

    # ---------- what the model sees ----------
    def describe(self, packet: flat.GamePacket) -> dict:
        me = packet.players[self.index]
        foe = next((p for i, p in enumerate(packet.players) if p.team != me.team), None)
        ball = packet.balls[0].physics
        side = -1.0 if me.team == 0 else 1.0            # sign of MY goal's y
        my_goal, their_goal = (0.0, side * GOAL_Y), (0.0, -side * GOAL_Y)
        b, bv, m = v2(ball.location), v2(ball.velocity), v2(me.physics.location)
        d_me = dist(m, b)
        d_foe = dist(v2(foe.physics.location), b) if foe else 99999
        toward_my_goal = bv[1] * side > 200
        me_between = (m[1] - b[1]) * side > 0            # I'm on my goal's side of the ball
        my_score = packet.teams[me.team].score if len(packet.teams) > me.team else 0
        their_score = packet.teams[1 - me.team].score if len(packet.teams) > 1 else 0
        return {
            "me": {"boost": int(me.boost),
                   "speed": int(math.hypot(*v2(me.physics.velocity))),
                   "distance_to_ball": int(d_me),
                   "distance_to_my_goal": int(dist(m, my_goal)),
                   "between_ball_and_my_goal": me_between},
            "opponent": {"distance_to_ball": int(d_foe),
                         "closer_to_ball_than_me": d_foe < d_me,
                         "boost": int(foe.boost) if foe else 0},
            "ball": {"in_my_half": b[1] * side > 0,
                     "heading_toward_my_goal": toward_my_goal,
                     "distance_to_my_goal": int(dist(b, my_goal)),
                     "distance_to_opponent_goal": int(dist(b, their_goal)),
                     "height": int(ball.location.z),
                     "speed": int(math.hypot(*bv))},
            "score": {"mine": my_score, "opponent": their_score,
                      "seconds_left": int(packet.match_info.game_time_remaining)},
        }

    # ---------- how the car carries out a tactic ----------
    def target_for(self, tactic: str, packet: flat.GamePacket) -> tuple[tuple[float, float], bool]:
        """(point to drive at, allowed to boost) for the current tactic."""
        me = packet.players[self.index]
        side = -1.0 if me.team == 0 else 1.0
        b = v2(packet.balls[0].physics.location)
        m = v2(me.physics.location)
        my_goal, their_goal = (0.0, side * GOAL_Y), (0.0, -side * GOAL_Y)

        if tactic == "SHOOT":
            # approach from behind the ball on the line from their goal, then hit through it
            gx, gy = b[0] - their_goal[0], b[1] - their_goal[1]
            n = math.hypot(gx, gy) or 1
            behind = (b[0] + gx / n * 350, b[1] + gy / n * 350)
            return (b if dist(m, b) < 700 else behind), True
        if tactic == "CHALLENGE":
            return b, True
        if tactic == "DEFEND":
            post_pt = (max(-800.0, min(800.0, b[0] * 0.3)), side * (GOAL_Y - 250))
            # once home, meet the ball if it's coming in
            return (b if dist(m, post_pt) < 600 and dist(b, my_goal) < 3000 else post_pt), True
        if tactic == "SHADOW":
            f = 0.4                                      # 40% of the way from ball to my goal
            return (b[0] + (my_goal[0] - b[0]) * f, b[1] + (my_goal[1] - b[1]) * f), False
        if tactic == "GET_BOOST":
            active = [(i, p) for i, p in self.big_pads if packet.boost_pads[i].is_active]
            pads = active or self.big_pads
            _, p = min(pads, key=lambda ip: dist(m, ip[1]))
            return p, False
        return b, True

    def get_output(self, packet: flat.GamePacket) -> flat.ControllerState:
        c = self.controller
        phase = packet.match_info.match_phase
        if len(packet.balls) == 0 or phase not in (flat.MatchPhase.Active, flat.MatchPhase.Kickoff):
            return c

        self.brain.state = self.describe(packet)          # the thread reads this

        me = packet.players[self.index]
        # kickoff is a pure reflex race; every other moment follows the model's tactic
        tactic = "CHALLENGE" if phase == flat.MatchPhase.Kickoff else self.brain.tactic
        target, may_boost = self.target_for(tactic, packet)
        steer, ang = steer_toward(me, target)

        c.steer = steer
        c.throttle = 1.0
        c.handbrake = abs(ang) > 1.9                    # tight U-turns
        speed = math.hypot(*v2(me.physics.velocity))
        c.boost = (may_boost and self.brain.boost_p > 0.5 and abs(ang) < 0.35
                   and speed < 2250 and me.boost > 0)

        # reflex jump: the ball is close and in the air in front of us (code, not model)
        b = packet.balls[0].physics.location
        close = dist(v2(me.physics.location), v2(b)) < 320
        if self.jump_frames > 0:
            self.jump_frames -= 1
            c.jump = self.jump_frames > 4
        elif close and 180 < float(b.z) < 500 and abs(ang) < 0.5:
            self.jump_frames = 12
            c.jump = True
        else:
            c.jump = False

        self.render_hud(packet, tactic)
        return c

    def render_hud(self, packet: flat.GamePacket, tactic: str):
        br = self.brain
        blue = packet.players[self.index].team == 0
        x = 0.02 if blue else 0.70
        colour = flat.Color(94, 242, 168, 255) if self.which == "laya" else flat.Color(94, 200, 242, 255)
        lines = [self.backend["label"],
                 f"tactic   {tactic}",
                 f"p50      {br.p50:5.0f} ms",
                 f"dec/s    {br.rate:5.1f}",
                 f"boost p  {br.boost_p:5.2f}"]
        if br.error:
            lines.append(f"error: {br.error}")
        self.renderer.begin_rendering("hud")
        self.renderer.draw_string_2d("\n".join(lines), x, 0.08, 1.4, colour,
                                     flat.Color(0, 0, 0, 150))
        self.renderer.draw_string_3d(tactic, flat.CarAnchor(self.index), 1.0, colour)
        self.renderer.end_rendering()


if __name__ == "__main__":
    which = (sys.argv[1] if len(sys.argv) > 1 else "laya").lower()
    if which not in BACKENDS:
        sys.exit(f"usage: python ai_bot.py [{'|'.join(BACKENDS)}]")
    AIBot(which).run()
