#!/usr/bin/env python3
"""Checks on the AI client itself: the pure logic, and the time unit it
measures from the server.

    python3 tests/test_ai.py
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "client_src"))
sys.path.insert(0, os.path.join(ROOT, "tests"))

from ai import rules                     # noqa: E402
from ai.brain import Bot                 # noqa: E402
from test_protocol import Server, check, FAILED  # noqa: E402

import test_protocol                     # noqa: E402


def test_tile_offsets():
    """The vision cone indexes must map back to the subject's drawing."""
    expected = {
        0: (0, 0),                                    # our own square
        1: (1, -1), 2: (1, 0), 3: (1, 1),             # level 1 row
        4: (2, -2), 5: (2, -1), 6: (2, 0), 7: (2, 1), 8: (2, 2),
        9: (3, -3), 12: (3, 0), 15: (3, 3),           # level 3 row
    }
    bad = {i: rules.tile_offset(i) for i, want in expected.items()
           if rules.tile_offset(i) != want}
    check("vision indexes map to the right squares", not bad, str(bad))

    total = sum(2 * k + 1 for k in range(0, 9))
    check("a level 8 cone holds 81 squares", total == 81, str(total))


def test_paths():
    check("walking straight ahead", rules.path_to(2, 0) == ["advance"] * 2)
    check("walking to the right", rules.path_to(1, 2)
          == ["right", "advance", "advance", "left", "advance"])
    check("walking to the left", rules.path_to(0, -1)
          == ["left", "advance", "right"])


def test_sound_steps():
    """Square 1 is straight ahead and the numbering runs counter-clockwise."""
    check("a sound in front means walk on", rules.step_towards(1) == ["advance"])
    check("a sound on our left means turn left",
          rules.step_towards(3) == ["left", "advance"])
    check("a sound on our right means turn right",
          rules.step_towards(7) == ["right", "advance"])
    check("a sound behind means turn around",
          rules.step_towards(5) == ["left", "left", "advance"])


def test_ritual_table():
    check("level 1 is a solo ritual", rules.needs(1) == (1, {"jade": 1}))
    check("level 7 needs six players and every stone",
          rules.needs(7) == (6, {"jade": 2, "peridot": 2, "amber": 2,
                                 "amethyst": 2, "garnet": 2, "ammolite": 1}))
    check("there is nothing beyond level 8", rules.needs(8) == (0, {}))


def test_answers_stay_matched_past_the_window():
    """More than ten commands in one batch must not shift the answers.

    The client throttles itself at ten outstanding commands; if waiting for
    room ever swallowed an answer, every later reply would belong to the
    wrong command -- a bot would read a `see` as its inventory and starve
    while believing it was well fed.
    """
    from ai.protocol import Connection

    with Server(width=6, height=6, clients=2, t=1000) as srv:
        conn = Connection("127.0.0.1", srv.port, "red")
        # 18 commands: more than the ten the protocol allows in flight
        commands = ["inventory"] * 9 + ["advance"] * 9
        answers = conn.run(commands)
        check("every command got an answer", len(answers) == len(commands),
              f"{len(answers)} answers for {len(commands)} commands")
        check("the inventories came back as inventories",
              all(a.startswith("{food ") for a in answers[:9]), str(answers[:9]))
        check("and the moves as plain ok",
              all(a == "ok" for a in answers[9:]), str(answers[9:]))
        check("nothing is left outstanding", conn.pending == [], str(conn.pending))
        conn.close()


def test_calibration():
    """The bot has to work out `t` on its own: the protocol never sends it."""
    for wanted in (50, 100, 400):
        with Server(width=10, height=10, clients=2, t=wanted) as srv:
            bot = Bot("127.0.0.1", srv.port, "red")
            measured = bot.t
            bot.conn.close()
            off = abs(measured - wanted) / wanted
            check(f"t={wanted} is measured within 25% ({measured:.0f})",
                  off < 0.25, f"measured {measured:.1f}")


def test_bot_plays_a_game():
    """A single bot must at least survive and reach level 2 on its own."""
    with Server(width=8, height=8, clients=2, t=100) as srv:
        bot = Bot("127.0.0.1", srv.port, "red")
        for _ in range(60):
            bot.step()
            if bot.level > 1:
                break
        check("a lone bot reaches level 2", bot.level >= 2, f"level {bot.level}")
        check("and is still alive", bot.life > 0, f"life {bot.life}")
        bot.conn.close()


def main():
    if not os.path.exists(test_protocol.SERVER):
        print("server binary not found, run 'make' first")
        return 1
    for fn in (test_tile_offsets, test_paths, test_sound_steps,
               test_ritual_table, test_answers_stay_matched_past_the_window,
               test_calibration, test_bot_plays_a_game):
        print(f"\n== {fn.__name__} ==")
        try:
            fn()
        except Exception as exc:                        # noqa: BLE001
            FAILED.append(f"{fn.__name__} raised {exc!r}")
            print(f"  FAIL {fn.__name__} raised {exc!r}")
    print(f"\ntotal: {test_protocol.PASSED} passed, {len(FAILED)} failed")
    for f in FAILED:
        print("  -", f)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
