#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void usage(const char *prog)
{
    printf("Usage: %s -p <port> -x <width> -y <height> -n <team> [<team>] ... "
           "-c <nb> [-t <t>]\n", prog);
    printf("    -p  is the port number\n");
    printf("    -x  is the width of the world\n");
    printf("    -y  is the height of the world\n");
    printf("    -n  is the name of the teams\n");
    printf("    -c  is the number of authorized clients per team\n");
    printf("    -t  is the time unit divider (the greater t is, the faster "
           "the game will go)\n");
    printf("\n  Bonus options:\n");
    printf("    --log            verbose event log on stderr\n");
    printf("    --seed <n>       reproducible world generation\n");
    printf("    --density <f>    resource density multiplier (default 1.0)\n");
    printf("    --help           this message\n");
}

static int parse_int(const char *s, int *out)
{
    char *end = NULL;
    long v;

    if (!s || !*s)
        return -1;
    v = strtol(s, &end, 10);
    if (!end || *end)
        return -1;
    *out = (int)v;
    return 0;
}

static void add_team(options_t *opt, const char *name)
{
    opt->teams = realloc(opt->teams, sizeof(char *) * (size_t)(opt->nb_teams + 1));
    if (!opt->teams)
        fatal("out of memory");
    opt->teams[opt->nb_teams++] = strdup(name);
}

int parse_args(int ac, char **av, options_t *opt)
{
    int i = 1;

    memset(opt, 0, sizeof(*opt));
    opt->t = 100;
    opt->density_scale = 1.0;
    opt->port = -1;
    opt->width = -1;
    opt->height = -1;
    opt->clients_per_team = -1;
    while (i < ac) {
        const char *a = av[i];

        if (!strcmp(a, "--help") || !strcmp(a, "-h")) {
            usage(av[0]);
            exit(0);
        } else if (!strcmp(a, "--log")) {
            opt->log = 1;
            i++;
        } else if (!strcmp(a, "-p") && i + 1 < ac) {
            if (parse_int(av[++i], &opt->port))
                return fprintf(stderr, "Error: -p expects a number\n"), -1;
            i++;
        } else if (!strcmp(a, "-x") && i + 1 < ac) {
            if (parse_int(av[++i], &opt->width))
                return fprintf(stderr, "Error: -x expects a number\n"), -1;
            i++;
        } else if (!strcmp(a, "-y") && i + 1 < ac) {
            if (parse_int(av[++i], &opt->height))
                return fprintf(stderr, "Error: -y expects a number\n"), -1;
            i++;
        } else if (!strcmp(a, "-c") && i + 1 < ac) {
            if (parse_int(av[++i], &opt->clients_per_team))
                return fprintf(stderr, "Error: -c expects a number\n"), -1;
            i++;
        } else if (!strcmp(a, "-t") && i + 1 < ac) {
            if (parse_int(av[++i], &opt->t))
                return fprintf(stderr, "Error: -t expects a number\n"), -1;
            i++;
        } else if (!strcmp(a, "--seed") && i + 1 < ac) {
            int s;

            if (parse_int(av[++i], &s))
                return fprintf(stderr, "Error: --seed expects a number\n"), -1;
            opt->seed = (unsigned int)s;
            opt->seeded = 1;
            i++;
        } else if (!strcmp(a, "--density") && i + 1 < ac) {
            opt->density_scale = strtod(av[++i], NULL);
            if (opt->density_scale <= 0.0)
                return fprintf(stderr, "Error: --density must be > 0\n"), -1;
            i++;
        } else if (!strcmp(a, "-n")) {
            i++;
            /* -n takes every following argument until the next option */
            while (i < ac && av[i][0] != '-')
                add_team(opt, av[i++]);
            if (opt->nb_teams == 0)
                return fprintf(stderr, "Error: -n expects at least one team\n"), -1;
        } else {
            fprintf(stderr, "Error: unknown argument '%s'\n", a);
            return -1;
        }
    }
    if (opt->port < 1 || opt->port > 65535)
        return fprintf(stderr, "Error: a valid port (-p) is required\n"), -1;
    if (opt->width < 1 || opt->height < 1)
        return fprintf(stderr, "Error: world size (-x, -y) must be >= 1\n"), -1;
    if (opt->width > 1000 || opt->height > 1000)
        return fprintf(stderr, "Error: world size is limited to 1000x1000\n"), -1;
    if (opt->nb_teams < 1)
        return fprintf(stderr, "Error: at least one team (-n) is required\n"), -1;
    if (opt->clients_per_team < 1)
        return fprintf(stderr, "Error: -c must be >= 1\n"), -1;
    if (opt->t < 1 || opt->t > 10000)
        return fprintf(stderr, "Error: -t must be between 1 and 10000\n"), -1;
    for (int a = 0; a < opt->nb_teams; a++) {
        if (!strcmp(opt->teams[a], GUI_TEAM_NAME))
            return fprintf(stderr, "Error: '%s' is reserved for the graphic "
                           "client\n", GUI_TEAM_NAME), -1;
        for (int b = a + 1; b < opt->nb_teams; b++)
            if (!strcmp(opt->teams[a], opt->teams[b]))
                return fprintf(stderr, "Error: duplicate team '%s'\n",
                               opt->teams[a]), -1;
    }
    return 0;
}
