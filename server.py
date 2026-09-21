"""Static file server + model backends for the Typed Decision Lab.

Layout: /snake and /fight are the two arenas, /shared holds the model plumbing both
use. The server serves this whole folder and both API routes from one process.

Two decision backends, one request shape (TypeSafe System One: state + questions):

  POST /api/jev    -> proxied to api.typesafe.ai (the key stays in this process,
                      the browser never sees it)
  POST /api/laya   -> convaiinnovations/laya running locally, in-process, via the
                      `laya` package. Same state/questions payload, same answer
                      shape, no network hop.

    python server.py [port]
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
UPSTREAM = "https://api.typesafe.ai/v1/systemone"
MODEL = os.environ.get("JEV_MODEL", "jev-latest")
LAYA_CHECKPOINT = os.environ.get("LAYA_CHECKPOINT", "typed-decisions")


def load_key() -> str:
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("TYPESAFE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


API_KEY = load_key()

_laya_router = None
_laya_error = None


def laya_router():
    """Load the local Laya model once, on first use."""
    global _laya_router, _laya_error
    if _laya_router is not None or _laya_error is not None:
        return _laya_router
    try:
        from laya import Router
        print("loading laya (first call warms the checkpoints)...")
        _laya_router = Router(preload=True, max_loaded=3)
        print("laya ready")
    except Exception as exc:
        _laya_error = f"laya unavailable: {exc}. Install it with: pip install laya"
        print(_laya_error)
    return _laya_router


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):  # keep the console readable
        if "/api/jev" not in (self.path or ""):
            return
        sys.stderr.write("jev %s\n" % (fmt % args))

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/api/jev", "/api/laya"):
            return self._json(404, {"error": "not found"})

        try:
            n = int(self.headers.get("Content-Length") or 0)
            incoming = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            return self._json(400, {"error": f"bad request body: {exc}"})

        if route == "/api/laya":
            return self._laya(incoming)
        return self._typesafe(incoming)

    def _laya(self, incoming):
        router = laya_router()
        if router is None:
            return self._json(503, {"error": _laya_error})
        try:
            # Laya's router picks a checkpoint by language and by matching question ids to
            # its built-in workflows. Custom questions match none, so it falls back to the
            # base English checkpoint -- near chance on typed decisions, and on the snake it
            # answered HARD_LEFT whatever the state. Ask for the typed-decisions one.
            res = router.predict(incoming.get("state"), incoming.get("questions"),
                                 model=incoming.get("laya_checkpoint") or LAYA_CHECKPOINT)
        except Exception as exc:
            return self._json(500, {"error": f"laya predict failed: {exc}"})
        if not isinstance(res, dict):
            return self._json(500, {"error": "laya returned an unexpected payload"})
        res.setdefault("model", incoming.get("model") or "laya")
        return self._json(200, res)

    def _typesafe(self, incoming):
        if not API_KEY:
            return self._json(500, {"error": "TYPESAFE_API_KEY missing (set it in .env)"})

        payload = {
            "model": incoming.get("model", MODEL),
            "state": incoming.get("state"),
            "questions": incoming.get("questions"),
        }
        req = urllib.request.Request(
            UPSTREAM,
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return self._json(resp.status, json.loads(resp.read()))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:500]
            return self._json(exc.code, {"error": f"typesafe {exc.code}: {detail}"})
        except Exception as exc:  # network, timeout, malformed upstream JSON
            return self._json(502, {"error": f"upstream failure: {exc}"})

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8732
    if not API_KEY:
        print("WARNING: no TYPESAFE_API_KEY found; the Jev arena will report an error.")
    print(f"Lab    ->  http://localhost:{port}/")
    print(f"Snake  ->  http://localhost:{port}/snake/")
    print(f"Kombat ->  http://localhost:{port}/fight/")
    print(f"Jev proxy -> {UPSTREAM} (model {MODEL})")
    print(f"Laya      -> local in-process, checkpoint '{LAYA_CHECKPOINT}' (loaded on first call)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
