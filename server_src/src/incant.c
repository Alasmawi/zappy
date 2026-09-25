#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
** Requirements to leave level N behind, indexed by N (1..7).
**              players jade peridot amber amethyst garnet ammolite
*/
static const int ritual[MAX_LEVEL][1 + RES_COUNT] = {
    {0}, /* unused, levels start at 1 */
    {1,  0, 1, 0, 0, 0, 0, 0},
    {2,  0, 1, 1, 1, 0, 0, 0},
    {2,  0, 2, 0, 1, 0, 2, 0},
    {4,  0, 1, 1, 2, 0, 1, 0},
    {4,  0, 1, 2, 1, 3, 0, 0},
    {6,  0, 1, 2, 3, 0, 1, 0},
    {6,  0, 2, 2, 2, 2, 2, 1}
};

incant_t *incant_on_tile(int x, int y)
{
    for (incant_t *ic = g_srv.incants; ic; ic = ic->next)
        if (ic->x == x && ic->y == y && !ic->aborted)
            return ic;
    return NULL;
}

static int tile_has_stones(int level, int x, int y)
{
    tile_t *tl = tile_at(&g_srv.world, x, y);

    for (int r = RES_JADE; r < RES_COUNT; r++)
        if (tl->r[r] < ritual[level][1 + r])
            return 0;
    return 1;
}

static void tile_consume_stones(int level, int x, int y)
{
    for (int r = RES_JADE; r < RES_COUNT; r++)
        if (ritual[level][1 + r] > 0)
            tile_take(&g_srv.world, x, y, r, ritual[level][1 + r]);
    gui_tile(x, y);
}

static void check_victory(team_t *team)
{
    int n = 0;

    for (player_t *p = g_srv.players; p; p = p->next)
        if (p->team == team && p->level >= MAX_LEVEL)
            n++;
    if (n < WINNER_COUNT)
        return;
    g_srv.winner = team;
    gui_broadcast("seg %s", team->name);
    printf("Team %s wins: %d players reached level %d.\n",
           team->name, n, MAX_LEVEL);
    fflush(stdout);
}

/*
** Starts a ritual on the caller's square.  Every player of the same level
** standing there and not busy with another action takes part in it.
*/
int incant_start(player_t *pl)
{
    incant_t *ic;
    player_t *on_tile[64];
    int nb = players_on_tile(pl->x, pl->y, on_tile, 64);
    int need = ritual[pl->level][0];

    if (pl->level >= MAX_LEVEL || incant_on_tile(pl->x, pl->y))
        return 0;
    if (!tile_has_stones(pl->level, pl->x, pl->y))
        return 0;
    ic = xcalloc(1, sizeof(incant_t));
    ic->level = pl->level;
    ic->x = pl->x;
    ic->y = pl->y;
    ic->due = now_sec() + (double)TU_ENCHANT / (double)g_srv.opt.t;
    ic->starter = pl->id;
    ic->players[ic->nb_players++] = pl->id;
    /* everybody of the right level standing here takes part */
    for (int i = 0; i < nb && ic->nb_players < 16; i++) {
        player_t *o = on_tile[i];

        if (o == pl || o->level != pl->level || o->incant)
            continue;
        ic->players[ic->nb_players++] = o->id;
    }
    if (ic->nb_players < need) {
        free(ic);
        return 0;
    }
    /*
    ** The stones are used up the moment the ritual begins, not when it
    ** ends.  Leaving them on the ground for 300 time units would let any
    ** passer-by pick them off the square and break a ritual that everybody
    ** had already gathered for -- and the participants, held for the whole
    ** ritual, could do nothing about it.
    */
    tile_consume_stones(pl->level, pl->x, pl->y);
    ic->next = g_srv.incants;
    g_srv.incants = ic;
    /*
    ** Only the player who called the ritual is held for its 300 time units
    ** -- that is simply how long his `enchantment` command takes.  The
    ** others keep their freedom: holding a bystander still because somebody
    ** else started chanting would stop him eating, and anyone could starve
    ** a rival just by performing rituals next to him.  Whoever is still on
    ** the square, at the right level, when it ends goes up a level.
    */
    for (int i = 0; i < ic->nb_players; i++) {
        player_t *p = player_by_id(ic->players[i]);

        p->incant = ic;
        client_send(p->cl, "evolution in progress");
    }
    pl->busy = 1;
    pl->busy_until = ic->due;
    {
        char buf[512];
        int n = snprintf(buf, sizeof(buf), "pic %d %d %d", ic->x, ic->y, ic->level);

        for (int i = 0; i < ic->nb_players && n > 0 && n < (int)sizeof(buf); i++)
            n += snprintf(buf + n, sizeof(buf) - (size_t)n, " #%d", ic->players[i]);
        gui_broadcast("%s", buf);
    }
    log_msg("incantation level %d at (%d,%d) with %d players",
            ic->level, ic->x, ic->y, ic->nb_players);
    return 1;
}

/*
** How many participants must still be standing on the square at the end.
** The subject: "if one of the members dies, the others will continue the
** enchantment, unless the player is left alone".  So each member lost to
** death lowers the bar by one -- but a ritual that needed company never
** ends with a single player in it.
*/
static int still_needed(incant_t *ic)
{
    int need = ritual[ic->level][0] - ic->dead;
    int floor = ritual[ic->level][0] > 1 ? 2 : 1;

    return need < floor ? floor : need;
}

static void incant_finish(incant_t *ic)
{
    int need = still_needed(ic);
    int alive = 0;
    int ok;

    for (int i = 0; i < ic->nb_players; i++) {
        player_t *p = player_by_id(ic->players[i]);

        if (p && p->x == ic->x && p->y == ic->y && p->level == ic->level)
            alive++;
    }
    /* the stones were already used up at the start; only the family matters */
    ok = !ic->aborted && alive >= need;
    gui_broadcast("pie %d %d %d", ic->x, ic->y, ok ? 1 : 0);
    for (int i = 0; i < ic->nb_players; i++) {
        player_t *p = player_by_id(ic->players[i]);

        if (!p)
            continue;
        p->incant = NULL;
        if (!ok || p->x != ic->x || p->y != ic->y || p->level != ic->level) {
            /*
            ** Only the player who asked for the ritual is owed an answer.
            ** Sending a bare "ko" to the others would be indistinguishable
            ** from the answer to whatever they had queued, and would shift
            ** every later reply onto the wrong command.  They simply never
            ** get their "current level".
            */
            if (p->id == ic->starter)
                client_send(p->cl, "ko");
            continue;
        }
        p->level++;
        client_send(p->cl, "current level : %d", p->level);
        gui_player_level(p);
    }
    if (ok) {
        for (int i = 0; i < ic->nb_players; i++) {
            player_t *p = player_by_id(ic->players[i]);

            if (p && p->level >= MAX_LEVEL)
                check_victory(p->team);
        }
    }
    log_msg("incantation at (%d,%d) %s", ic->x, ic->y, ok ? "succeeded" : "failed");
}

void incant_check(double now)
{
    incant_t **pp = &g_srv.incants;

    while (*pp) {
        incant_t *ic = *pp;

        if (ic->aborted || now >= ic->due) {
            *pp = ic->next;
            incant_finish(ic);
            free(ic);
            continue;
        }
        pp = &ic->next;
    }
}

/*
** Called when a participant dies or disconnects.  The others carry on,
** unless the last one is left on his own -- then the ritual is broken.
*/
void incant_drop_player(player_t *pl)
{
    incant_t *ic = pl->incant;
    int left = 0;

    if (!ic)
        return;
    pl->incant = NULL;
    ic->dead++;
    for (int i = 0; i < ic->nb_players; i++) {
        if (ic->players[i] == pl->id)
            ic->players[i] = -1;
        else if (player_by_id(ic->players[i]))
            left++;
    }
    if (left <= 1 && ritual[ic->level][0] > 1)
        ic->aborted = 1;
}
