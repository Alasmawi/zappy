#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct strbuf_s {
    char *s;
    size_t len;
    size_t cap;
} strbuf_t;

static void sb_add(strbuf_t *sb, const char *txt)
{
    size_t l = strlen(txt);

    if (sb->len + l + 1 > sb->cap) {
        while (sb->len + l + 1 > sb->cap)
            sb->cap = sb->cap ? sb->cap * 2 : 256;
        sb->s = realloc(sb->s, sb->cap);
        if (!sb->s)
            fatal("out of memory");
    }
    memcpy(sb->s + sb->len, txt, l + 1);
    sb->len += l;
}

/*
** One square of the vision cone.  Players come first, then the resources
** in canonical order, each repeated as many times as it is present.
** "self" is never listed: a player cannot see himself.
*/
static void describe_tile(strbuf_t *sb, player_t *self, int x, int y)
{
    tile_t *tl = tile_at(&g_srv.world, x, y);
    int first = 1;

    for (player_t *p = g_srv.players; p; p = p->next) {
        if (p == self || p->x != wrap_x(&g_srv.world, x)
            || p->y != wrap_y(&g_srv.world, y))
            continue;
        if (!first)
            sb_add(sb, " ");
        sb_add(sb, "player");
        first = 0;
    }
    for (int r = 0; r < RES_COUNT; r++) {
        for (int n = 0; n < tl->r[r]; n++) {
            if (!first)
                sb_add(sb, " ");
            sb_add(sb, res_names[r]);
            first = 0;
        }
    }
}

/*
** Level L sees L+1 rows.  Row k holds 2k+1 squares, listed from the
** player's left to his right, row 0 being the square he stands on.
*/
char *vision_string(player_t *pl)
{
    strbuf_t sb = {NULL, 0, 0};
    int fx, fy, rx, ry;

    dir_vector(pl->dir, &fx, &fy);
    right_vector(pl->dir, &rx, &ry);
    sb_add(&sb, "{");
    for (int k = 0; k <= pl->level; k++) {
        for (int i = -k; i <= k; i++) {
            int x = pl->x + fx * k + rx * i;
            int y = pl->y + fy * k + ry * i;

            if (k || i)
                sb_add(&sb, ", ");
            describe_tile(&sb, pl, x, y);
        }
    }
    sb_add(&sb, "}");
    return sb.s;
}
