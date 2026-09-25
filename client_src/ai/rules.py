"""Game constants shared by the AI.

Everything here mirrors the subject's tables; the server is authoritative,
this is only what the bot believes about the world.
"""

STONES = ("jade", "peridot", "amber", "amethyst", "garnet", "ammolite")
RESOURCES = ("food",) + STONES

MAX_LEVEL = 8
FOOD_TIME_UNITS = 126

# level -> (players needed, {stone: count})
RITUAL = {
    1: (1, {"jade": 1}),
    2: (2, {"jade": 1, "peridot": 1, "amber": 1}),
    3: (2, {"jade": 2, "amber": 1, "garnet": 2}),
    4: (4, {"jade": 1, "peridot": 1, "amber": 2, "garnet": 1}),
    5: (4, {"jade": 1, "peridot": 2, "amber": 1, "amethyst": 3}),
    6: (6, {"jade": 1, "peridot": 2, "amber": 3, "garnet": 1}),
    7: (6, {"jade": 2, "peridot": 2, "amber": 2, "amethyst": 2,
            "garnet": 2, "ammolite": 1}),
}


def needs(level):
    """(players, stones) required to leave `level` behind."""
    return RITUAL.get(level, (0, {}))


def tile_offset(index):
    """Vision index -> (squares in front, squares to the right).

    Row k of the cone starts at index k*k and holds 2k+1 squares, the
    middle one being straight ahead.
    """
    k = 0
    while (k + 1) * (k + 1) <= index:
        k += 1
    return k, index - k * k - k


def path_to(forward, right):
    """Commands walking to a square of the vision cone, keeping our facing."""
    cmds = []
    if right > 0:
        cmds += ["right"] + ["advance"] * right + ["left"]
    elif right < 0:
        cmds += ["left"] + ["advance"] * (-right) + ["right"]
    cmds += ["advance"] * forward
    return cmds


def step_towards(direction):
    """One move towards the square a sound came from (1..8), see the subject.

    1 is straight ahead and the numbering runs counter-clockwise, so 3 is on
    our left, 5 behind us and 7 on our right.
    """
    if direction in (1, 2, 8):
        return ["advance"]
    if direction in (3, 4):
        return ["left", "advance"]
    if direction in (6, 7):
        return ["right", "advance"]
    return ["left", "left", "advance"]        # 5: turn around
