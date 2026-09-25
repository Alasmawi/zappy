#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static unsigned long long g_rnd_state = 88172645463325252ULL;

double now_sec(void)
{
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

void log_msg(const char *fmt, ...)
{
    va_list ap;

    if (!g_srv.opt.log)
        return;
    fprintf(stderr, "[%8.3f] ", now_sec() - g_srv.start_time);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

void fatal(const char *fmt, ...)
{
    va_list ap;

    fputs("Error: ", stderr);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    exit(84);
}

void *xmalloc(size_t n)
{
    void *p = malloc(n);

    if (!p)
        fatal("out of memory");
    return p;
}

void *xcalloc(size_t n, size_t sz)
{
    void *p = calloc(n, sz);

    if (!p)
        fatal("out of memory");
    return p;
}

/*
** xorshift64*: small, fast and -- most importantly -- reproducible across
** platforms, which is what the --seed bonus needs.
*/
static unsigned long long next_rand(void)
{
    g_rnd_state ^= g_rnd_state << 13;
    g_rnd_state ^= g_rnd_state >> 7;
    g_rnd_state ^= g_rnd_state << 17;
    return g_rnd_state;
}

void rnd_seed(unsigned int seed)
{
    g_rnd_state = seed ? (unsigned long long)seed * 2685821657736338717ULL : 88172645463325252ULL;
    next_rand();
    next_rand();
}

int rnd_int(int max)
{
    if (max <= 0)
        return 0;
    return (int)(next_rand() % (unsigned long long)max);
}

double rnd_double(void)
{
    return (double)(next_rand() >> 11) / 9007199254740992.0;
}
