#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdlib.h>
#include <string.h>

const char *const res_names[RES_COUNT] = {
    "food", "jade", "peridot", "amber", "amethyst", "garnet", "ammolite"
};

/*
** Densities are expressed as "expected quantity per tile".  They decrease
** with the rarity of the stone, so that the late-game rituals stay hard.
*/
static const double base_density[RES_COUNT] = {
    0.50,   /* food     */
    0.30,   /* jade     */
    0.15,   /* peridot  */
    0.10,   /* amber    */
    0.10,   /* amethyst */
    0.08,   /* garnet   */
    0.05    /* ammolite */
};

int res_from_name(const char *name)
{
    for (int i = 0; i < RES_COUNT; i++)
        if (!strcmp(name, res_names[i]))
            return i;
    return -1;
}

int wrap_x(world_t *w, int x)
{
    x %= w->w;
    return x < 0 ? x + w->w : x;
}

int wrap_y(world_t *w, int y)
{
    y %= w->h;
    return y < 0 ? y + w->h : y;
}

tile_t *tile_at(world_t *w, int x, int y)
{
    return &w->tiles[wrap_y(w, y) * w->w + wrap_x(w, x)];
}

void tile_add(world_t *w, int x, int y, int res, int n)
{
    tile_at(w, x, y)->r[res] += n;
    w->have[res] += n;
}

void tile_take(world_t *w, int x, int y, int res, int n)
{
    tile_at(w, x, y)->r[res] -= n;
    w->have[res] -= n;
}

void dir_vector(int dir, int *dx, int *dy)
{
    switch (dir) {
    case DIR_N: *dx = 0;  *dy = -1; break;
    case DIR_E: *dx = 1;  *dy = 0;  break;
    case DIR_S: *dx = 0;  *dy = 1;  break;
    default:    *dx = -1; *dy = 0;  break;
    }
}

/* The player's right-hand side: the facing rotated 90 degrees clockwise. */
void right_vector(int dir, int *dx, int *dy)
{
    dir_vector(dir % 4 + 1, dx, dy);
}

void world_init(world_t *w, int width, int height, double scale)
{
    memset(w, 0, sizeof(*w));
    w->w = width;
    w->h = height;
    w->tiles = xcalloc((size_t)width * (size_t)height, sizeof(tile_t));
    for (int i = 0; i < RES_COUNT; i++) {
        w->density[i] = base_density[i] * scale;
        w->target[i] = (int)(w->density[i] * width * height + 0.5);
        /* however small the map is, every resource must be reachable */
        if (w->target[i] < 1)
            w->target[i] = 1;
    }
    world_spawn_resources(w);
}

void world_free(world_t *w)
{
    free(w->tiles);
    w->tiles = NULL;
}

/*
** Generation rules (see README):
**   - at most one food per tile;
**   - at most one stone of a given type per tile;
**   - at most three different stone types per tile.
** Players may still stack whatever they like by dropping objects, these
** rules only constrain what the server itself creates.
*/
static int tile_accepts(tile_t *tl, int res)
{
    int kinds = 0;

    if (tl->r[res] > 0)
        return 0;
    if (res == RES_FOOD)
        return 1;
    for (int i = RES_JADE; i < RES_COUNT; i++)
        if (tl->r[i] > 0)
            kinds++;
    return kinds < 3;
}

/*
** A square only accepts three kinds of stone, so whichever resource is
** placed first takes the free slots.  Always starting with the same one
** would let it monopolise a small map -- either the common stones crowd
** out the ammolite the highest rituals need, or the other way round.  So
** the starting resource rotates, and over a few rounds every kind gets its
** turn on every square.
*/
int world_spawn_resources(world_t *w)
{
    int cells = w->w * w->h;
    int added = 0;

    w->spawn_turn = (w->spawn_turn + 1) % RES_COUNT;
    for (int i = 0; i < RES_COUNT; i++) {
        int res = (w->spawn_turn + i) % RES_COUNT;
        int missing = w->target[res] - w->have[res];
        int attempts = 0;

        while (missing > 0 && attempts < cells * 8) {
            int x = rnd_int(w->w);
            int y = rnd_int(w->h);
            tile_t *tl = tile_at(w, x, y);

            attempts++;
            if (!tile_accepts(tl, res))
                continue;
            tile_add(w, x, y, res, 1);
            gui_tile(x, y);
            missing--;
            added++;
        }
    }
    return added;
}

/*
** Resources are replenished periodically: without it the map is mined out
** long before anybody reaches level 8 and the game becomes unwinnable.
*/
void world_tick(world_t *w, double now)
{
    int added;

    if (now < w->next_respawn)
        return;
    w->next_respawn = now + (double)RESPAWN_PERIOD / (double)g_srv.opt.t;
    added = world_spawn_resources(w);
    if (added)
        log_msg("%d resource(s) grew back", added);
}
