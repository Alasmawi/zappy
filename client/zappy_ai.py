#!/usr/bin/env python3
"""Zappy AI client.

Usage: ./client -n <team> -p <port> [-h <hostname>]
  -n is the name of the team
  -p is the port number
  -h is the name of the host, the default is localhost

Bonus options:
  -v, --verbose     narrate what the bot decides
  -s, --seed <n>    reproducible decisions
  --max-spawn <n>   how many teammates this process may launch (default 8)
  --no-spawn        never launch a teammate
"""

import os
import random
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ai.brain import Bot            # noqa: E402
from ai.protocol import Dead        # noqa: E402


def usage(stream=sys.stdout):
    print(__doc__.split("\n", 2)[2].rstrip(), file=stream)


def parse_args(argv):
    opt = {"team": None, "port": None, "host": "localhost", "verbose": False,
           "seed": None, "max_spawn": 8}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--help",):
            usage()
            sys.exit(0)
        elif a == "-n" and i + 1 < len(argv):
            opt["team"] = argv[i + 1]
            i += 2
        elif a == "-p" and i + 1 < len(argv):
            opt["port"] = int(argv[i + 1])
            i += 2
        elif a == "-h" and i + 1 < len(argv):
            opt["host"] = argv[i + 1]
            i += 2
        elif a in ("-v", "--verbose"):
            opt["verbose"] = True
            i += 1
        elif a in ("-s", "--seed") and i + 1 < len(argv):
            opt["seed"] = int(argv[i + 1])
            i += 2
        elif a == "--max-spawn" and i + 1 < len(argv):
            opt["max_spawn"] = int(argv[i + 1])
            i += 2
        elif a == "--no-spawn":
            opt["max_spawn"] = 0
            i += 1
        else:
            print(f"Error: unexpected argument '{a}'", file=sys.stderr)
            usage(sys.stderr)
            sys.exit(84)
    if not opt["team"] or not opt["port"]:
        print("Error: -n and -p are required", file=sys.stderr)
        usage(sys.stderr)
        sys.exit(84)
    return opt


class Spawner:
    """Launches a teammate when a ship has arrived and a slot is free.

    The child only receives the command line the user gave us -- no game
    state is ever shared between clients outside of the server.
    """

    def __init__(self, opt):
        self.opt = opt
        self.children = []
        self.left = opt["max_spawn"]
        self.last = 0.0

    def __call__(self, free_slots):
        self.children = [c for c in self.children if c.poll() is None]
        if self.left <= 0 or free_slots <= 0:
            return
        if time.time() - self.last < 2.0:
            return
        self.last = time.time()
        cmd = [sys.executable, os.path.abspath(__file__),
               "-n", self.opt["team"], "-p", str(self.opt["port"]),
               "-h", self.opt["host"], "--max-spawn", str(self.left - 1)]
        if self.opt["verbose"]:
            cmd.append("-v")
        try:
            self.children.append(subprocess.Popen(cmd))
            self.left -= 1
        except OSError as exc:
            print(f"could not launch a teammate: {exc}", file=sys.stderr)

    def stop(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()


def main(argv):
    opt = parse_args(argv)
    # so that a terminated bot still takes the teammates it launched with it
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    random.seed(opt["seed"] if opt["seed"] is not None else os.getpid())
    spawner = Spawner(opt)
    try:
        bot = Bot(opt["host"], opt["port"], opt["team"],
                  verbose=opt["verbose"], spawner=spawner)
    except (OSError, RuntimeError, Dead) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 84
    try:
        bot.run()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        spawner.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
