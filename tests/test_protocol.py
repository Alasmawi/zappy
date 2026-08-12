#!/usr/bin/env python3
"""End-to-end protocol tests for the Zappy server.

Every test spawns a real server on a free port, talks to it over TCP and
checks the exact wire format the subject asks for.

    make test          (or)      python3 tests/test_protocol.py
"""

import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server", "zappy_server")

TESTS = []
PASSED = 0
FAILED = []


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Conn:
    """A line oriented TCP connection."""

    def __init__(self, port, timeout=5.0):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout)
        self.sock.settimeout(timeout)
        self.buf = b""

    def line(self, timeout=5.0):
        self.sock.settimeout(timeout)
        while b"\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("connection closed by server")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode(errors="replace").rstrip("\r")

    def lines(self, n, timeout=5.0):
        return [self.line(timeout) for _ in range(n)]

    def send(self, text):
        self.sock.sendall((text + "\n").encode())

    def send_burst(self, texts):
        """Sends many commands in a single write, so the server sees them at once."""
        self.sock.sendall("".join(t + "\n" for t in texts).encode())

    def ask(self, text, timeout=5.0):
        self.send(text)
        return self.line(timeout)

    def drain(self, seconds=0.3):
        """Everything that arrives within `seconds`."""
        out = []
        end = time.time() + seconds
        while True:
            left = end - time.time()
            if left <= 0:
                break
            try:
                out.append(self.line(left))
            except (socket.timeout, TimeoutError, EOFError, OSError):
                break
        return out

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Server:
    def __init__(self, width=10, height=10, teams=("red",), clients=6, t=1000,
                 extra=()):
        self.port = free_port()
        cmd = [SERVER, "-p", str(self.port), "-x", str(width), "-y", str(height),
               "-n", *teams, "-c", str(clients), "-t", str(t), *extra]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        for _ in range(300):
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.1).close()
                return
            except OSError:
                time.sleep(0.01)
        raise RuntimeError("server did not start")

    def connect(self, team="red"):
        c = Conn(self.port)
        assert c.line() == "WELCOME", "server must greet with WELCOME"
        if team is not None:
            c.send(team)
        return c

    def player(self, team="red"):
        """Connects and finishes the handshake: returns (conn, slots, w, h)."""
        c = self.connect(team)
        slots = int(c.line())
        w, h = (int(v) for v in c.line().split())
        return c, slots, w, h

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.stop()

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(3)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def wait_for(conn, item, tries=80):
    """Waits until `item` lies on the square the player stands on.

    A square never holds more than three kinds of stone, and the server
    rotates which resource claims the free slots, so on a tiny world one
    simply waits a few respawns for the one it needs -- eating whatever
    grows back in the meantime, or the wait itself would be fatal.
    """
    for _ in range(tries):
        see = conn.ask("see")
        if not see.startswith("{"):
            return False
        square = see[1:-1].split(",")[0].split()
        if item in square:
            return True
        if "food" in square:
            conn.ask("pick food")
    return False


def bring_stones(conn, stones, rounds=120):
    """Collects the stones a ritual needs and lays them on the square.

    A square holds at most three kinds of stone, so on a tiny world it locks
    up until somebody takes something off it -- hence picking up everything
    in sight, which frees the slots for the kinds still missing.  Dropping
    is not bound by the generation rules, which is how all three end up on
    the same square at the end.
    """
    need = {stone: stones.count(stone) for stone in stones}
    have = dict.fromkeys(need, 0)

    for _ in range(rounds):
        if all(have[s] >= need[s] for s in need):
            return all(conn.ask(f"drop {s}") == "ok"
                       for s in stones)
        see = conn.ask("see")
        if not see.startswith("{"):
            return False
        for item in see[1:-1].split(",")[0].split():
            if item == "player":
                continue
            if conn.ask(f"pick {item}") != "ok":
                continue
            if item in have:
                have[item] += 1
    return False


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {name}")
    else:
        FAILED.append(f"{name}: {detail}")
        print(f"  FAIL {name}   {detail}")


def test(fn):
    TESTS.append(fn)
    return fn


# --------------------------------------------------------------------------
# handshake
# --------------------------------------------------------------------------

@test
def handshake():
    with Server(teams=("red", "blue"), clients=3) as srv:
        c = srv.connect("red")
        check("nb-client is the number of remaining slots", c.line() == "2")
        check("world dimensions come as 'x y'", c.line() == "10 10")

        c2 = srv.connect("red")
        check("the second client sees one slot less", c2.line() == "1")
        c2.line()

        bad = srv.connect("nosuchteam")
        check("an unknown team is refused", bad.line() == "ko")
        err = srv.proc.stderr.readline().decode().strip()
        check("an unknown team is reported on stderr",
              err == "Error: the team nosuchteam doesn't exist", err)
        for x in (c, c2, bad):
            x.close()


@test
def full_team_is_bounced():
    with Server(clients=1) as srv:
        c, _, _, _ = srv.player()
        extra = srv.connect("red")
        check("a full team is refused", extra.line() == "ko")
        c.close()
        extra.close()


@test
def unknown_command():
    with Server() as srv:
        c, _, _, _ = srv.player()
        check("garbage answers ko", c.ask("floop") == "ko")
        check("an empty line answers ko", c.ask("") == "ko")
        check("a known command with a junk argument answers ko",
              c.ask("advance now") == "ko")
        check("a missing argument answers ko", c.ask("pick") == "ko")
        check("the connection survives garbage",
              c.ask("inventory").startswith("{food "))
        c.close()


# --------------------------------------------------------------------------
# world, vision, inventory
# --------------------------------------------------------------------------

@test
def inventory_format():
    with Server() as srv:
        c, _, _, _ = srv.player()
        inv = c.ask("inventory")
        life = int(inv.split(",")[0].split()[1])
        check("inventory is brace delimited",
              inv.startswith("{food ") and inv.endswith("}"), inv)
        check("a player starts with 10 food (1260 time units)",
              1240 <= life <= 1260, inv)
        for stone in ("jade", "peridot", "amber", "amethyst", "garnet", "ammolite"):
            check(f"inventory lists {stone}", f"{stone} 0" in inv, inv)
        c.close()


@test
def vision_cone():
    with Server(width=9, height=9) as srv:
        c, _, _, _ = srv.player()
        see = c.ask("see")
        check("see is brace delimited",
              see.startswith("{") and see.endswith("}"), see)
        check("a level 1 player sees 4 squares",
              len(see[1:-1].split(",")) == 4, see)
        c.close()


@test
def toroidal_world():
    """In a one square world every move lands back on the same square."""
    with Server(width=1, height=1, clients=1) as srv:
        c, _, w, h = srv.player()
        check("a 1x1 world is announced", (w, h) == (1, 1))
        check("advance wraps around", c.ask("advance") == "ok")
        check("left turns", c.ask("left") == "ok")
        check("right turns", c.ask("right") == "ok")
        see = c.ask("see")
        check("the whole cone is the same square",
              len(see[1:-1].split(",")) == 4, see)
        c.close()


@test
def pick_and_drop():
    with Server(width=1, height=1, clients=1) as srv:
        c, _, _, _ = srv.player()
        check("the world grows a jade", wait_for(c, "jade"))
        check("picking a stone that is there", c.ask("pick jade") == "ok")
        check("the stone reached the inventory", "jade 1" in c.ask("inventory"))
        check("dropping it back", c.ask("drop jade") == "ok")
        check("the inventory is empty again", "jade 0" in c.ask("inventory"))
        check("dropping what we do not have is ko", c.ask("drop jade") == "ko")
        check("picking an unknown object is ko", c.ask("pick unobtainium") == "ko")
        c.close()


@test
def eating_extends_the_life():
    with Server(width=1, height=1, clients=1, t=1000) as srv:
        c, _, _, _ = srv.player()
        wait_for(c, "food")
        before = int(c.ask("inventory").split(",")[0].split()[1])
        check("picking food", c.ask("pick food") == "ok")
        after = int(c.ask("inventory").split(",")[0].split()[1])
        # the two pick/inventory actions themselves burn a few time units
        check("one food unit is worth 126 time units",
              108 <= after - before <= 126, f"{before} -> {after}")
        c.close()


# --------------------------------------------------------------------------
# timing and back pressure
# --------------------------------------------------------------------------

@test
def timing_follows_the_time_unit():
    with Server(t=20) as srv:            # advance = 7/20 = 0.35s
        c, _, _, _ = srv.player()
        start = time.time()
        c.ask("advance")
        advance = time.time() - start
        start = time.time()
        c.ask("inventory")               # 1/20 = 0.05s
        inventory = time.time() - start
        check("advance takes 7/t", 0.30 < advance < 0.60, f"{advance:.3f}s")
        check("inventory takes 1/t", inventory < 0.20, f"{inventory:.3f}s")
        c.close()


@test
def commands_run_in_order():
    with Server(t=500) as srv:
        c, _, _, _ = srv.player()
        c.send_burst(["advance"] * 5 + ["inventory"])
        answers = c.lines(6)
        check("answers come back in the order the commands were sent",
              answers[:5] == ["ok"] * 5 and answers[5].startswith("{food"),
              str(answers))
        c.close()


@test
def at_most_ten_pending_commands():
    with Server(t=500) as srv:
        c, _, _, _ = srv.player()
        c.send_burst(["advance"] * 25)
        got = c.drain(1.5)
        check("no more than 10 requests are taken into account",
              len(got) == 10, f"got {len(got)} answers")
        check("the player is still usable afterwards",
              c.ask("inventory").startswith("{food"))
        c.close()


@test
def one_slow_player_does_not_block_the_others():
    with Server(t=4, clients=4) as srv:      # advance = 1.75s
        slow, _, _, _ = srv.player()
        fast, _, _, _ = srv.player()
        slow.send("advance")
        start = time.time()
        fast.ask("connect_nbr")              # 0/t, must answer at once
        check("a busy player does not stall the server",
              time.time() - start < 0.5, f"{time.time() - start:.3f}s")
        slow.close()
        fast.close()


@test
def death_of_a_starving_player():
    with Server(width=3, height=3, clients=1, t=8000) as srv:
        c, _, _, _ = srv.player()
        got = c.drain(3.0)
        check("the server announces the death", "death" in got, str(got[-3:]))
        c.close()


# --------------------------------------------------------------------------
# social actions
# --------------------------------------------------------------------------

@test
def broadcast_direction():
    with Server(width=5, height=5, clients=4) as srv:
        a, _, _, _ = srv.player()
        b, _, _, _ = srv.player()
        a.send("broadcast hello there")
        heard = b.line()
        check("the message format is 'message K,text'",
              heard.startswith("message "), heard)
        direction, _, text = heard[len("message "):].partition(",")
        check("the direction is a square number 0..8",
              direction.isdigit() and 0 <= int(direction) <= 8, heard)
        check("the text is passed through untouched", text == "hello there", heard)
        check("the emitter is acknowledged", a.line() == "ok")
        a.close()
        b.close()


@test
def broadcast_from_the_same_square():
    """A 1x1 world: the sound necessarily comes from square 0."""
    with Server(width=1, height=1, clients=2) as srv:
        a, _, _, _ = srv.player()
        b, _, _, _ = srv.player()
        a.send("broadcast here")
        check("a sound emitted from our own square is 0",
              b.line() == "message 0,here")
        a.close()
        b.close()


def expected_direction(listener, emitter, world):
    """Independent reference for the sound direction, used to cross-check
    the server: the square number is the neighbour whose direction best
    matches the shortest toroidal path to the emitter."""
    lx, ly, ldir = listener
    ex, ey = emitter
    w, h = world

    def shortest(a, b, size):
        d = (b - a) % size
        return d - size if d > size // 2 else d

    dx = shortest(lx, ex, w)
    dy = shortest(ly, ey, h)
    if dx == 0 and dy == 0:
        return 0
    # the eight unit vectors, counter-clockwise from east, in maths axes
    units = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
    vx, vy = dx, -dy                       # flip y: north is up
    norm = (vx * vx + vy * vy) ** 0.5
    best = max(range(8), key=lambda i: (units[i][0] * vx + units[i][1] * vy)
               / (norm * (units[i][0] ** 2 + units[i][1] ** 2) ** 0.5))
    facing = {1: 2, 2: 0, 3: 6, 4: 4}[ldir]   # N E S W as sectors
    return (best - facing) % 8 + 1


@test
def sound_direction_matches_the_reference():
    with Server(width=7, height=7, clients=8, t=200, extra=("--seed", "77")) as srv:
        gui = srv.connect("GRAPHIC")
        gui.drain(0.4)
        conns = [srv.player()[0] for _ in range(6)]
        # rotate everybody a different number of times so all facings occur
        for i, c in enumerate(conns):
            for _ in range(i % 4):
                c.ask("left")

        pos = {}
        for line in gui.drain(0.6):
            f = line.split()
            if f[0] in ("pnw", "ppo"):
                pos[int(f[1][1:])] = (int(f[2]), int(f[3]), int(f[4]))
        ids = sorted(pos)
        check("the gui knows all six players", len(ids) == 6, str(pos))

        mismatches = []
        for i, emitter_id in enumerate(ids):
            conns[i].send("broadcast ping")
            for j, listener_id in enumerate(ids):
                if j == i:
                    continue
                heard = conns[j].line(5)
                got = int(heard[len("message "):].split(",")[0])
                want = expected_direction(pos[listener_id], pos[emitter_id][:2],
                                          (7, 7))
                if got != want:
                    mismatches.append(
                        f"#{listener_id}{pos[listener_id]} hearing "
                        f"#{emitter_id}{pos[emitter_id][:2]}: got {got} want {want}")
            check(f"broadcast from #{emitter_id} acknowledged",
                  conns[i].line(5) == "ok")
        check("every sound direction matches the reference",
              not mismatches, "; ".join(mismatches[:4]))
        for c in conns:
            c.close()
        gui.close()


@test
def kick_pushes_the_neighbours():
    with Server(width=1, height=1, clients=3) as srv:
        a, _, _, _ = srv.player()
        b, _, _, _ = srv.player()
        a.send("kick")
        moved = b.line()
        check("the kicked player is told he moves",
              moved.startswith("moving "), moved)
        check("the direction is a square number",
              moved.split()[1].isdigit() and 1 <= int(moved.split()[1]) <= 8, moved)
        check("the kicker is acknowledged", a.line() == "ok")
        a.close()
        b.close()


@test
def kick_alone_is_ko():
    with Server(width=1, height=1, clients=1) as srv:
        c, _, _, _ = srv.player()
        check("kicking nobody is ko", c.ask("kick") == "ko")
        c.close()


@test
def fork_and_connect_nbr():
    with Server(clients=2) as srv:
        c, slots, _, _ = srv.player()
        check("one slot is left after the first client", slots == 1)
        check("connect_nbr agrees", c.ask("connect_nbr") == "1")
        check("fork is acknowledged", c.ask("fork") == "ok")
        time.sleep(1.0)             # 600/t = 0.6s at t=1000
        check("the arrived ship frees a slot", c.ask("connect_nbr") == "2")
        c.close()


# --------------------------------------------------------------------------
# evolution ritual
# --------------------------------------------------------------------------

@test
def enchantment_level_one():
    """A lone level 1 player standing on a jade evolves on his own."""
    with Server(width=1, height=1, clients=1) as srv:
        c, _, _, _ = srv.player()
        check("a jade is on the square", wait_for(c, "jade"))
        first = c.ask("enchantment")
        check("the ritual starts", first == "evolution in progress", first)
        second = c.line(timeout=5)
        check("the ritual ends on level 2", second == "current level : 2", second)
        see = c.ask("see")
        check("a level 2 player sees 9 squares",
              len(see[1:-1].split(",")) == 9, see)
        c.close()


@test
def enchantment_without_stones_is_refused():
    with Server(width=10, height=10, clients=1, extra=("--density", "0.02")) as srv:
        c, _, _, _ = srv.player()
        answers = []
        for _ in range(8):
            c.ask("advance")
            answers.append(c.ask("enchantment"))
        check("a ritual without the right stones is refused",
              any(a == "ko" for a in answers), str(answers))
        c.close()


@test
def enchantment_enrols_everybody_on_the_square():
    """One player starts, the other one standing there joins in and levels up too."""
    with Server(width=1, height=1, clients=2, t=200) as srv:
        a, _, _, _ = srv.player()
        b, _, _, _ = srv.player()
        check("a jade is on the square", wait_for(a, "jade"))
        check("the starter is told the ritual began",
              a.ask("enchantment") == "evolution in progress")
        check("the bystander joins the ritual",
              b.line(5) == "evolution in progress")
        check("the starter levels up", a.line(5) == "current level : 2")
        check("the bystander levels up too", b.line(5) == "current level : 2")

        # level 2 -> 3 wants three different stones on the square
        check("the stones for a level 2 ritual are gathered",
              bring_stones(a, ("jade", "peridot", "amber")))
        check("a level 2 ritual with two players starts",
              a.ask("enchantment") == "evolution in progress")
        check("the partner is enrolled", b.line(5) == "evolution in progress")
        check("the starter reaches level 3", a.line(5) == "current level : 3")
        check("the partner reaches level 3", b.line(5) == "current level : 3")
        a.close()
        b.close()


@test
def a_bystander_is_not_frozen_by_someone_elses_ritual():
    """Only the caller is busy for the 300 time units of a ritual.

    Holding the others still would stop them eating, and would let anyone
    starve a rival simply by chanting next to him.
    """
    with Server(width=1, height=1, clients=2, t=200) as srv:
        a, _, _, _ = srv.player()
        b, _, _, _ = srv.player()
        check("a jade is on the square", wait_for(a, "jade"))
        a.send("enchantment")
        check("the caller is told it began", a.line(5) == "evolution in progress")
        check("the bystander is enrolled", b.line(5) == "evolution in progress")

        # the ritual lasts 300/t = 1.5s; the bystander must still be served
        start = time.time()
        answer = b.ask("inventory", timeout=5)
        check("the bystander is still answered during the ritual",
              answer.startswith("{food ") and time.time() - start < 0.5,
              f"{answer!r} after {time.time() - start:.2f}s")
        check("and still levels up with everybody else",
              b.line(5) == "current level : 2")
        a.close()
        b.close()


@test
def ritual_stones_cannot_be_stolen_once_it_started():
    """The stones are consumed when the ritual starts, not when it ends."""
    with Server(width=1, height=1, clients=2, t=100) as srv:
        a, _, _, _ = srv.player()
        thief, _, _, _ = srv.player()
        check("a jade is on the square", wait_for(a, "jade"))
        a.send("enchantment")
        a.line(5)
        thief.line(5)                       # enrolled as well, but level 1
        check("the jade is already gone from the square",
              thief.ask("pick jade", timeout=5) == "ko")
        check("the ritual still succeeds", a.line(6) == "current level : 2")
        a.close()
        thief.close()


@test
def enchantment_alone_at_level_two_is_refused():
    with Server(width=1, height=1, clients=1, t=200) as srv:
        c, _, _, _ = srv.player()
        check("a jade is on the square", wait_for(c, "jade"))
        c.ask("enchantment")
        check("reached level 2", c.line(5) == "current level : 2")
        check("a level 2 ritual needs a partner", c.ask("enchantment") == "ko")
        c.close()


# --------------------------------------------------------------------------
# graphic client
# --------------------------------------------------------------------------

@test
def graphic_client():
    with Server(width=4, height=3, teams=("red", "blue"), clients=2) as srv:
        gui = srv.connect("GRAPHIC")
        lines = gui.drain(0.6)
        check("the map size is announced", "msz 4 3" in lines, str(lines[:3]))
        check("the time unit is announced",
              any(l.startswith("sgt ") for l in lines))
        check("the teams are announced",
              "tna red" in lines and "tna blue" in lines)
        tiles = [l for l in lines if l.startswith("bct ")]
        check("every tile is described", len(tiles) == 12, f"{len(tiles)} tiles")
        check("a tile carries the 7 resource counts",
              all(len(t.split()) == 10 for t in tiles), tiles[0] if tiles else "")

        p, _, _, _ = srv.player("red")
        evt = gui.drain(0.4)
        check("a new player is announced",
              any(e.startswith("pnw #") for e in evt), str(evt))
        p.send("broadcast hi")
        evt = gui.drain(0.5)
        check("broadcasts reach the gui",
              any(e.startswith("pbc #") and e.endswith("hi") for e in evt), str(evt))
        check("the gui can query a tile", gui.ask("bct 1 1").startswith("bct 1 1 "))
        check("the gui rejects unknown commands", gui.ask("nonsense") == "suc")
        check("the gui cannot play", gui.ask("advance") == "suc")
        p.close()
        gui.close()


@test
def the_server_never_hangs():
    """Rude clients must bounce off without taking the server with them."""
    with Server(width=12, height=12, clients=40, t=500) as srv:
        rude = []
        # a crowd of connections, some of which never finish the handshake
        for i in range(40):
            c = Conn(srv.port)
            c.line()
            if i % 3:
                c.send("red")
            rude.append(c)
        # a client that sends a huge line and never a newline
        flood = Conn(srv.port)
        flood.line()
        try:
            for _ in range(400):
                flood.sock.sendall(b"x" * 4096)
        except OSError:
            pass          # the server cut us off, which is the point
        # binary garbage and a half command
        noisy = Conn(srv.port)
        noisy.line()
        noisy.sock.sendall(bytes(range(256)) + b"\n")
        noisy.sock.sendall(b"advan")
        # clients that vanish without warning
        for c in rude[::4]:
            c.sock.close()

        fresh, _, w, h = srv.player()
        check("a new player still gets in", (w, h) == (12, 12))
        check("and is served normally", fresh.ask("inventory").startswith("{food"))
        check("and answers stay in order",
              fresh.ask("advance") == "ok" and fresh.ask("left") == "ok")
        check("the server is still alive", srv.proc.poll() is None,
              f"exit code {srv.proc.poll()}")
        fresh.close()
        for c in rude + [flood, noisy]:
            c.close()


@test
def a_disconnected_player_leaves_the_world():
    with Server(width=1, height=1, clients=3) as srv:
        a, _, _, _ = srv.player()
        b, _, _, _ = srv.player()
        gui = srv.connect("GRAPHIC")
        gui.drain(0.4)
        b.close()
        events = gui.drain(0.6)
        check("the gui is told the player is gone",
              any(e.startswith("pdi #") for e in events), str(events))
        check("the survivor keeps playing", a.ask("inventory").startswith("{food"))
        a.close()
        gui.close()


@test
def seed_is_reproducible():
    maps = []
    for _ in range(2):
        with Server(width=8, height=8, extra=("--seed", "1234")) as srv:
            gui = srv.connect("GRAPHIC")
            maps.append([l for l in gui.drain(0.6) if l.startswith("bct ")])
            gui.close()
    check("--seed reproduces the very same world",
          maps[0] == maps[1] and maps[0] != [], "")


# --------------------------------------------------------------------------

def main():
    if not os.path.exists(SERVER):
        print(f"server binary not found: {SERVER}\nrun 'make' first")
        return 1
    for fn in TESTS:
        print(f"\n== {fn.__name__} ==")
        try:
            fn()
        except Exception as exc:                       # noqa: BLE001
            FAILED.append(f"{fn.__name__} raised {exc!r}")
            print(f"  FAIL {fn.__name__} raised {exc!r}")
    print(f"\ntotal: {PASSED} passed, {len(FAILED)} failed")
    for f in FAILED:
        print("  -", f)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
