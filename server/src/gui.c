#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
** The subject only specifies the AI protocol, so the graphic protocol is an
** extension of ours -- it is documented in docs/PROTOCOL.md.  A client that
** announces itself as team "GRAPHIC" is switched to it and becomes a
** read-only observer of the world.
*/

void gui_broadcast(const char *fmt, ...)
{
    char buf[2048];
    va_list ap;

    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    for (client_t *cl = g_srv.clients; cl; cl = cl->next)
        if (cl->state == CL_GUI && !cl->closing)
            client_send(cl, "%s", buf);
}

static void tile_line(char *buf, size_t sz, int x, int y)
{
    tile_t *tl = tile_at(&g_srv.world, x, y);
    int n = snprintf(buf, sz, "bct %d %d", x, y);

    for (int r = 0; r < RES_COUNT; r++)
        n += snprintf(buf + n, sz - (size_t)n, " %d", tl->r[r]);
}

void gui_tile(int x, int y)
{
    char buf[256];

    if (!g_srv.clients)
        return;
    tile_line(buf, sizeof(buf), x, y);
    gui_broadcast("%s", buf);
}

void gui_player_new(player_t *pl)
{
    gui_broadcast("pnw #%d %d %d %d %d %s", pl->id, pl->x, pl->y, pl->dir,
                  pl->level, pl->team->name);
}

void gui_player_pos(player_t *pl)
{
    gui_broadcast("ppo #%d %d %d %d", pl->id, pl->x, pl->y, pl->dir);
}

void gui_player_level(player_t *pl)
{
    gui_broadcast("plv #%d %d", pl->id, pl->level);
}

void gui_player_inv(player_t *pl)
{
    char buf[256];
    int n = snprintf(buf, sizeof(buf), "pin #%d %d %d %d", pl->id, pl->x, pl->y,
                     life_units(pl, now_sec()));

    for (int r = RES_JADE; r < RES_COUNT; r++)
        n += snprintf(buf + n, sizeof(buf) - (size_t)n, " %d", pl->inv[r]);
    gui_broadcast("%s", buf);
}

static void send_map(client_t *cl)
{
    char buf[256];

    for (int y = 0; y < g_srv.world.h; y++) {
        for (int x = 0; x < g_srv.world.w; x++) {
            tile_line(buf, sizeof(buf), x, y);
            client_send(cl, "%s", buf);
        }
    }
}

void gui_hello(client_t *cl)
{
    client_send(cl, "msz %d %d", g_srv.world.w, g_srv.world.h);
    client_send(cl, "sgt %d", g_srv.opt.t);
    for (team_t *t = g_srv.teams; t; t = t->next)
        client_send(cl, "tna %s", t->name);
    send_map(cl);
    for (player_t *p = g_srv.players; p; p = p->next) {
        client_send(cl, "pnw #%d %d %d %d %d %s", p->id, p->x, p->y, p->dir,
                    p->level, p->team->name);
    }
    for (egg_t *e = g_srv.eggs; e; e = e->next)
        client_send(cl, "enw #%d #%d %d %d", e->id, e->laid_by, e->x, e->y);
}

void gui_command(client_t *cl, char *line)
{
    char *arg = strchr(line, ' ');
    int id;
    int x;
    int y;

    if (arg)
        *arg++ = '\0';
    if (!strcmp(line, "msz"))
        return client_send(cl, "msz %d %d", g_srv.world.w, g_srv.world.h);
    if (!strcmp(line, "sgt"))
        return client_send(cl, "sgt %d", g_srv.opt.t);
    if (!strcmp(line, "mct"))
        return send_map(cl);
    if (!strcmp(line, "tna")) {
        for (team_t *t = g_srv.teams; t; t = t->next)
            client_send(cl, "tna %s", t->name);
        return;
    }
    if (!strcmp(line, "bct") && arg && sscanf(arg, "%d %d", &x, &y) == 2) {
        char buf[256];

        if (x < 0 || y < 0 || x >= g_srv.world.w || y >= g_srv.world.h)
            return client_send(cl, "sbp");
        tile_line(buf, sizeof(buf), x, y);
        return client_send(cl, "%s", buf);
    }
    if (arg && sscanf(arg, "#%d", &id) == 1) {
        player_t *pl = player_by_id(id);

        if (!pl)
            return client_send(cl, "sbp");
        if (!strcmp(line, "ppo"))
            return gui_player_pos(pl);
        if (!strcmp(line, "plv"))
            return gui_player_level(pl);
        if (!strcmp(line, "pin"))
            return gui_player_inv(pl);
    }
    client_send(cl, "suc");
}
