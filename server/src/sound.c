#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <math.h>

#define QUARTER_PI 0.78539816339744830962   /* 45 degrees, in radians */

/*
** Squares around a player are numbered starting at 1 for the square he is
** facing, then counter-clockwise:
**
**        3 2 1
**        4 . 8      <- the player looks towards 1
**        5 6 7
**
** Sound travels in a straight line and the world is round, so we take the
** shortest path between the emitter and the listener.
*/

/* World sectors, counter-clockwise: 0=E 1=NE 2=N 3=NW 4=W 5=SW 6=S 7=SE */
static int facing_sector(int dir)
{
    switch (dir) {
    case DIR_N: return 2;
    case DIR_E: return 0;
    case DIR_S: return 6;
    default:    return 4;
    }
}

static int shortest_delta(int from, int to, int size)
{
    int d = (to - from) % size;

    if (d < 0)
        d += size;
    if (d > size / 2)
        d -= size;
    return d;
}

static int sector_to_tile(int sector, int dir)
{
    int rel = (sector - facing_sector(dir)) % 8;

    if (rel < 0)
        rel += 8;
    return rel + 1;
}

int sound_direction(player_t *listener, int sx, int sy)
{
    int dx = shortest_delta(listener->x, sx, g_srv.world.w);
    int dy = shortest_delta(listener->y, sy, g_srv.world.h);
    double angle;
    int sector;

    if (dx == 0 && dy == 0)
        return 0;
    /* screen y grows southwards, flip it so that north is +90 degrees */
    angle = atan2((double)(-dy), (double)dx);
    sector = (int)floor(angle / QUARTER_PI + 0.5);
    sector %= 8;
    if (sector < 0)
        sector += 8;
    return sector_to_tile(sector, listener->dir);
}

/* Same numbering, but for an absolute orientation instead of a position. */
int relative_direction(player_t *listener, int dir)
{
    return sector_to_tile(facing_sector(dir), listener->dir);
}
