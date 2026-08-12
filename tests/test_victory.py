#!/usr/bin/env python3
"""Plays a whole game to its end and checks the win condition.

Six clients are driven by hand -- this is a test harness, not an AI -- all
the way from level 1 to level 8, so that the last thing the server does is
announce the winning team.  It is the only way to exercise the victory path
without waiting for the bots to get there on their own.

The six are advanced in lockstep, one action each per round, because life
drains in real time: a player left idle while the others act simply starves.

    python3 tests/test_victory.py
"""

import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
sys.path.insert(0, os.path.join(ROOT, "client"))

import test_protocol                                   # noqa: E402
from test_protocol import Server, check, FAILED        # noqa: E402
from ai.rules import RITUAL, STONES                    # noqa: E402

SIZE = 3
TIME_UNIT = 100
RITUAL_TILE = (0, 0)
FEED_TARGET = 2600          # enough to sit through a 300 time unit ritual
DIRS = {1: (0, -1), 2: (1, 0), 3: (0, 1), 4: (-1, 0)}    # N E S W

PUSHED = ("message ", "moving ", "evolution in progress", "current level")


class Puppet:
    """One client, driven step by step by the test."""

    def __init__(self, conn):
        self.conn = conn
        self.id = None
        self.x = self.y = 0
        self.dir = 1
        self.life = 1260
        self.bag = {s: 0 for s in STONES}
        self.view = None
        self.steps = 0

    # -- one command at a time ------------------------------------------

    def send(self, command):
        self.conn.send(command)

    def answer(self, timeout=20):
        while True:
            line = self.conn.line(timeout)
            if not line.startswith(PUSHED):
                return line

    def ask(self, command, timeout=20):
        self.send(command)
        return self.answer(timeout)

    # -- book keeping ---------------------------------------------------

    def apply(self, command, answer):
        if command == "advance" and answer == "ok":
            dx, dy = DIRS[self.dir]
            self.x = (self.x + dx) % SIZE
            self.y = (self.y + dy) % SIZE
        elif command.startswith("pick ") and answer == "ok":
            what = command.split()[1]
            if what == "food":
                self.life += 126
            else:
                self.bag[what] += 1

    def read_inventory(self, answer):
        for item in answer[1:-1].split(","):
            name, _, count = item.strip().partition(" ")
            if name == "food":
                self.life = int(count)
            elif name in self.bag:
                self.bag[name] = int(count)

    @staticmethod
    def parse_view(answer):
        if not answer.startswith("{"):
            return [[]]
        return [square.split() for square in answer[1:-1].split(",")]

    # -- movement -------------------------------------------------------

    def face(self, want):
        while self.dir != want:
            self.ask("right")
            self.dir = self.dir % 4 + 1

    def goto(self, tx, ty):
        for _ in range(SIZE * 2 + 2):
            if (self.x, self.y) == (tx, ty):
                return True
            dx = (tx - self.x) % SIZE
            dy = (ty - self.y) % SIZE
            if dx:
                self.face(2 if dx == 1 else 4)
            else:
                self.face(3 if dy == 1 else 1)
            self.apply("advance", self.ask("advance"))
        return (self.x, self.y) == (tx, ty)


# ---------------------------------------------------------------- rounds

def lockstep(puppets, choose):
    """Every puppet performs one action, all six pipelined together."""
    commands = {}
    for p in puppets:
        command = choose(p)
        if command:
            commands[p] = command
            p.send(command)
    for p, command in commands.items():
        p.apply(command, p.answer())


def refresh_all(puppets):
    for p in puppets:
        p.send("inventory")
    for p in puppets:
        p.read_inventory(p.answer())


def forage(puppets, collector, wanted, budget=90.0):
    """Feeds everybody and collects the stones the next ritual needs.

    Returns once all six are well fed and the collector has the stones.
    """
    end = time.time() + budget
    rounds = 0
    while time.time() < end:
        rounds += 1
        if rounds % 4 == 1:
            refresh_all(puppets)
        fed = all(p.life >= FEED_TARGET for p in puppets)
        short = {s: n - collector.bag.get(s, 0)
                 for s, n in wanted.items() if collector.bag.get(s, 0) < n}
        if fed and not short:
            return True, ""

        for p in puppets:                       # everyone looks around
            p.send("see")
        for p in puppets:
            p.view = Puppet.parse_view(p.answer())

        def choose(p):
            square = p.view[0]
            if p.life < FEED_TARGET and "food" in square:
                return "pick food"
            if p is collector:
                for stone in short:
                    if stone in square:
                        return f"pick {stone}"
            # a straight line on a torus only ever visits one row, so walk
            # a staircase instead and cover the whole map
            p.steps += 1
            if p.steps % 3 == 0:
                p.dir = p.dir % 4 + 1
                return "right"
            return "advance"

        lockstep(puppets, choose)
    return False, (f"gave up after {rounds} rounds: "
                   f"life={[int(p.life) for p in puppets]} bag={collector.bag}")


def perform_ritual(puppets, level):
    """All six on one square, the stones on the ground, then enchantment."""
    collector = puppets[0]
    _, stones = RITUAL[level]

    ok, why = forage(puppets, collector, stones)
    if not ok:
        return False, f"level {level}: {why}"

    for p in puppets:
        if not p.goto(*RITUAL_TILE):
            return False, f"level {level}: a player could not reach the square"

    here = Puppet.parse_view(collector.ask("see"))[0]
    for stone, count in stones.items():
        for _ in range(count - here.count(stone)):
            if collector.ask(f"drop {stone}") != "ok":
                return False, f"level {level}: could not drop {stone}"
            collector.bag[stone] -= 1

    # 'evolution in progress' is normally a pushed line, but here it is the
    # answer to our own enchantment, so read it unfiltered
    collector.send("enchantment")
    answer = ""
    deadline = time.time() + 20
    while time.time() < deadline:
        answer = collector.conn.line(20)
        if answer in ("evolution in progress", "ko"):
            break
    if answer != "evolution in progress":
        return False, f"level {level} ritual refused: {answer}"

    # everybody, the starter included, must come out one level higher
    for p in puppets:
        deadline = time.time() + 25
        while time.time() < deadline:
            line = p.conn.line(25)
            if line == f"current level : {level + 1}":
                p.life -= 300           # the ritual was 300 time units long
                break
            if line in ("ko", "death"):
                return False, f"level {level}: player {p.id} got '{line}'"
        else:
            return False, f"level {level}: a player never levelled up"
    return True, ""


def learn_positions(gui, puppets):
    """The AI protocol never says where a player is; the graphic one does."""
    seen = {}
    for line in gui.drain(0.8):
        f = line.split()
        if f[0] in ("pnw", "ppo"):
            seen[int(f[1][1:])] = (int(f[2]), int(f[3]), int(f[4]))
    for puppet, pid in zip(puppets, sorted(seen)):
        puppet.id = pid
        puppet.x, puppet.y, puppet.dir = seen[pid]
    return len(seen) == len(puppets)


def main():
    if not os.path.exists(test_protocol.SERVER):
        print("server binary not found, run 'make' first")
        return 1

    print("== a full game, from level 1 to the victory ==")
    with Server(width=SIZE, height=SIZE, teams=("red",), clients=6,
                t=TIME_UNIT, extra=("--density", "4", "--seed", "7")) as srv:
        gui = srv.connect("GRAPHIC")
        gui.drain(0.5)
        puppets = [Puppet(srv.player()[0]) for _ in range(6)]
        check("six clients joined the family", len(puppets) == 6)
        check("the graphic client knows where they are",
              learn_positions(gui, puppets))

        won = True
        for level in range(1, 8):
            started = time.time()
            ok, why = perform_ritual(puppets, level)
            check(f"the whole family reaches level {level + 1}", ok,
                  why or f"{time.time() - started:.1f}s")
            if not ok:
                won = False
                break

        if won:
            events = gui.drain(1.5)
            check("the server announces the winning team",
                  "seg red" in events,
                  str([e for e in events if e[0] == "s"][-4:]))

        for p in puppets:
            p.conn.close()
        gui.close()
        time.sleep(0.3)
        srv.proc.terminate()
        out = srv.proc.stdout.read().decode()
        check("and says so on its standard output",
              "wins" in out, out.strip().split("\n")[-1] if out else "(no output)")

    print(f"\ntotal: {test_protocol.PASSED} passed, {len(FAILED)} failed")
    for f in FAILED:
        print("  -", f)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
