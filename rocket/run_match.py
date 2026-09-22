"""Start Laya vs Jev in Rocket League.

Needs: Rocket League installed (Epic), the RLBot v5 launcher installed once (it puts
RLBotServer in %localappdata%), and the lab server running for the model backends:

    cd ..  &&  python server.py 8740
    venv\Scripts\python run_match.py
"""
import json
import time
import urllib.request
from pathlib import Path

from rlbot import flat
from rlbot.managers import MatchManager

HERE = Path(__file__).parent
BRAIN = "http://localhost:8740"


def brain_up() -> bool:
    try:
        body = json.dumps({"state": "ping", "questions": {"ok": {
            "type": "noul", "instructions": "Is this a ping?",
            "criteria": {"true": "yes", "false": "no"}}}}).encode()
        req = urllib.request.Request(BRAIN + "/api/laya", data=body,
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=180)       # first call loads Laya
        return True
    except Exception as exc:
        print(f"Model server not reachable at {BRAIN}: {exc}")
        return False


if __name__ == "__main__":
    print("Warming up the model server (first Laya call can take a minute)...")
    if not brain_up():
        raise SystemExit("Start it first:  python server.py 8740  (from the repo root)")

    with MatchManager() as man:
        man.start_match(HERE / "match.toml")
        print("Match started: Laya (blue) vs Jev (orange). Ctrl+C to stop.")
        while man.packet is None or man.packet.match_info.match_phase != flat.MatchPhase.Ended:
            time.sleep(1.0)
        t = man.packet.teams
        print(f"Final: Laya {t[0].score} - {t[1].score} Jev")
