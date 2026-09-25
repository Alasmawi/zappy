/*
 * Zappy graphic client -- rendering.
 *
 * Everything is drawn by hand on a 2D canvas: no game engine is involved.
 * The page only ever listens; it never sends anything to the server.
 *
 * The map is two layers.  The ground (field, rulers, resources) is painted
 * once into an offscreen canvas and only the squares that change are
 * repainted; the living things (players, eggs, rituals, sounds) are drawn
 * over it on every frame.  That keeps a 1000 x 1000 world smooth.
 */

'use strict';

const RESOURCES = ['food', 'jade', 'peridot', 'amber', 'amethyst', 'garnet',
                   'ammolite'];

const css = (name) => getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim();

const INK = css('--ink');
const PAL = {
    field: css('--field'), fieldAlt: css('--field-alt'), paper: css('--paper'),
    paperDeep: css('--paper-deep'), ink: INK, inkSoft: css('--ink-soft'),
    rule: css('--rule'), sound: css('--sound'), ritual: css('--ritual'),
    kick: css('--kick'),
};
const MONO = css('--mono');

/* Families are told apart by strong, inky colours that no stone uses. */
const TEAM_COLOURS = ['#33408f', '#b8452b', '#6d2e6b', '#9c6b12', '#44617f',
                      '#b04a78', '#2a2a2a', '#4f7a28'];

const FACING = { 1: '↑ north', 2: '→ east', 3: '↓ south', 4: '← west' };
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

// ------------------------------------------------------------------ icons

/*
 * Each stone has its own cut, so the kinds can be told apart by shape as
 * well as by colour.  `s` is the half-size of the icon.
 */
const ICONS = {
    food(c, s) {                                   // a scored loaf
        c.fillStyle = '#c98a45';
        c.beginPath();
        c.ellipse(0, s * 0.12, s * 0.95, s * 0.68, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#e2ac68';
        c.beginPath();
        c.ellipse(0, -s * 0.05, s * 0.72, s * 0.42, 0, Math.PI, Math.PI * 2);
        c.fill();
        outline(c, () => c.ellipse(0, s * 0.12, s * 0.95, s * 0.68, 0, 0, Math.PI * 2), s);
        c.strokeStyle = 'rgba(80, 45, 15, .55)';
        c.lineWidth = Math.max(0.8, s * 0.1);
        for (const dx of [-0.4, 0, 0.4]) {
            c.beginPath();
            c.moveTo(dx * s - s * 0.12, -s * 0.2);
            c.lineTo(dx * s + s * 0.12, s * 0.2);
            c.stroke();
        }
    },
    jade(c, s) {                                   // a cabochon
        const g = c.createRadialGradient(-s * 0.3, -s * 0.35, s * 0.1, 0, 0, s);
        g.addColorStop(0, '#8fe0b4');
        g.addColorStop(1, '#23835a');
        c.fillStyle = g;
        c.beginPath();
        c.ellipse(0, 0, s * 0.95, s * 0.78, 0, 0, Math.PI * 2);
        c.fill();
        outline(c, () => c.ellipse(0, 0, s * 0.95, s * 0.78, 0, 0, Math.PI * 2), s);
    },
    peridot(c, s) {                                // a step-cut octagon
        const pts = octagon(s * 0.95, s * 0.75, 0.32);
        c.fillStyle = '#9dc42a';
        poly(c, pts);
        c.fill();
        c.fillStyle = '#c9e46a';
        poly(c, octagon(s * 0.5, s * 0.36, 0.32));
        c.fill();
        outline(c, () => poly(c, pts), s);
    },
    amber(c, s) {                                  // a drop
        const path = () => {
            c.moveTo(0, -s);
            c.bezierCurveTo(s * 0.55, -s * 0.35, s * 0.85, s * 0.1, s * 0.78, s * 0.42);
            c.arc(0, s * 0.35, s * 0.78, 0.09, Math.PI - 0.09);
            c.bezierCurveTo(-s * 0.85, s * 0.1, -s * 0.55, -s * 0.35, 0, -s);
        };
        const g = c.createLinearGradient(0, -s, 0, s);
        g.addColorStop(0, '#f6c35c');
        g.addColorStop(1, '#d4801c');
        c.fillStyle = g;
        c.beginPath();
        path();
        c.fill();
        outline(c, path, s);
    },
    amethyst(c, s) {                               // a crystal point
        const pts = [[0, -s], [s * 0.55, -s * 0.45], [s * 0.55, s],
                     [-s * 0.55, s], [-s * 0.55, -s * 0.45]];
        c.fillStyle = '#8b5bc6';
        poly(c, pts);
        c.fill();
        c.fillStyle = '#b48be3';
        poly(c, [[0, -s], [s * 0.55, -s * 0.45], [0, -s * 0.2], [-s * 0.55, -s * 0.45]]);
        c.fill();
        c.strokeStyle = 'rgba(40, 20, 70, .45)';
        c.lineWidth = Math.max(0.8, s * 0.08);
        c.beginPath();
        c.moveTo(0, -s * 0.2);
        c.lineTo(0, s);
        c.stroke();
        outline(c, () => poly(c, pts), s);
    },
    garnet(c, s) {                                 // a kite-cut brilliant
        const pts = [[0, -s], [s * 0.9, -s * 0.25], [0, s], [-s * 0.9, -s * 0.25]];
        c.fillStyle = '#b3263a';
        poly(c, pts);
        c.fill();
        c.fillStyle = '#e0566a';
        poly(c, [[0, -s], [s * 0.9, -s * 0.25], [0, -s * 0.05], [-s * 0.9, -s * 0.25]]);
        c.fill();
        outline(c, () => poly(c, pts), s);
    },
    ammolite(c, s) {                               // an iridescent spiral shell
        const g = c.createLinearGradient(-s, -s, s, s);
        g.addColorStop(0, '#1fa3a8');
        g.addColorStop(0.5, '#d9b43a');
        g.addColorStop(1, '#c0479a');
        c.fillStyle = g;
        c.beginPath();
        c.arc(0, 0, s * 0.92, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = 'rgba(30, 30, 40, .6)';
        c.lineWidth = Math.max(0.8, s * 0.1);
        c.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.2) {
            const r = s * 0.08 + (a / (Math.PI * 5)) * s * 0.78;
            const x = Math.cos(a) * r;
            const y = Math.sin(a) * r;
            if (a === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
        outline(c, () => c.arc(0, 0, s * 0.92, 0, Math.PI * 2), s);
    },
};

/* The flat colour used when a square is too small to hold an icon. */
const DOT_COLOURS = {
    food: '#c98a45', jade: '#2f9e6a', peridot: '#9dc42a', amber: '#e39a2d',
    amethyst: '#8b5bc6', garnet: '#b3263a', ammolite: '#1fa3a8',
};

function outline(c, trace, s) {
    c.strokeStyle = INK;
    c.globalAlpha = 0.7;
    c.lineWidth = Math.max(0.7, s * 0.09);
    c.beginPath();
    trace();
    c.closePath();
    c.stroke();
    c.globalAlpha = 1;
}

function poly(c, pts) {
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
}

function octagon(w, h, cut) {
    const cx = w * cut;
    const cy = h * cut;
    return [[-w + cx, -h], [w - cx, -h], [w, -h + cy], [w, h - cy],
            [w - cx, h], [-w + cx, h], [-w, h - cy], [-w, -h + cy]];
}

function drawIcon(c, name, x, y, s) {
    c.save();
    c.translate(x, y);
    ICONS[name](c, s);
    c.restore();
}

/* The same icons as images, for the legend and the specimen card. */
const ICON_URLS = {};
for (const name of RESOURCES) {
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    drawIcon(cv.getContext('2d'), name, size / 2, size / 2, size * 0.4);
    ICON_URLS[name] = cv.toDataURL();
}

// ------------------------------------------------------------------ state

const world = { w: 0, h: 0, t: 0, tiles: [] };
const players = new Map();      // id -> {x, y, dir, level, team, life, lifeAt, inv}
const eggs = new Map();         // id -> {x, y, team}
const teams = new Map();        // name -> colour
const rituals = new Map();      // "x,y" -> {level, players}
const effects = [];             // sounds and kicks, drawn while they fade
let selected = null;            // {x, y}
let winner = null;
let replaying = false;          // lines replayed by the bridge are history
const startedAt = performance.now();

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const card = document.getElementById('card');
const banner = document.getElementById('banner');
const statusEl = document.getElementById('status');

const ground = document.createElement('canvas');   // the offscreen layer
const gctx = ground.getContext('2d');
const dirtyTiles = new Set();
let groundDirty = true;

const view = { cell: 0, ox: 0, oy: 0, cssW: 0, cssH: 0, dpr: 1, ruler: 0 };

// ------------------------------------------------------------- connection

function connect() {
    const ws = new WebSocket(`ws://${location.host}/`);
    ws.onopen = () => setStatus('live', 'Watching live');
    ws.onclose = () => {
        setStatus('down', 'Lost the graphic bridge. Reconnecting…');
        setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
        for (const line of ev.data.split('\n')) {
            if (line) handle(line);
        }
    };
}

function setStatus(cls, text) {
    if (winner && cls !== 'won') return;
    statusEl.className = `status ${cls}`;
    statusEl.textContent = text;
}

// --------------------------------------------------------------- protocol

const tileIndex = (x, y) => y * world.w + x;
const num = (s) => parseInt(String(s).replace('#', ''), 10);

/* A family named after a colour wears it; the others take the next free one. */
const NAMED_COLOURS = {
    blue: '#33408f', red: '#b8452b', purple: '#6d2e6b', violet: '#6d2e6b',
    orange: '#9c6b12', yellow: '#9c6b12', gold: '#9c6b12', grey: '#44617f',
    gray: '#44617f', pink: '#b04a78', black: '#2a2a2a', green: '#4f7a28',
};

function teamColour(name) {
    if (!teams.has(name)) {
        const taken = new Set(teams.values());
        const wanted = NAMED_COLOURS[String(name).toLowerCase()];
        const colour = (wanted && !taken.has(wanted) && wanted)
            || TEAM_COLOURS.find((c) => !taken.has(c))
            || TEAM_COLOURS[teams.size % TEAM_COLOURS.length];
        teams.set(name, colour);
    }
    return teams.get(name);
}

function resetWorld() {
    players.clear();
    eggs.clear();
    rituals.clear();
    effects.length = 0;
    teams.clear();
    winner = null;
    banner.hidden = true;
}

function handle(line) {
    const f = line.split(' ');
    const id = f[1] !== undefined ? num(f[1]) : null;

    switch (f[0]) {
    case 'replay':                 // sent by our own bridge, not the server
        replaying = f[1] === 'begin';
        if (!replaying && world.w) {
            log(`joined a game in progress: ${players.size} player${players.size === 1 ? '' : 's'}, `
                + `${teams.size} famil${teams.size === 1 ? 'y' : 'ies'}`);
        }
        return;

    case 'msz':
        resetWorld();
        world.w = +f[1];
        world.h = +f[2];
        world.tiles = Array.from({ length: world.w * world.h },
                                 () => new Array(RESOURCES.length).fill(0));
        text('w-size', `${world.w} × ${world.h}`);
        layout();
        break;

    case 'sgt':
        world.t = +f[1];
        text('w-time', `1/${world.t} s`);
        break;

    case 'bct': {
        const x = +f[1];
        const y = +f[2];
        if (x < world.w && y < world.h) {
            world.tiles[tileIndex(x, y)] = f.slice(3, 10).map(Number);
            dirtyTiles.add(tileIndex(x, y));
            legendDirty = true;
        }
        break;
    }

    case 'tna':
        teamColour(f[1]);
        teamsDirty = true;
        break;

    case 'pnw':
        teamColour(f[6]);
        players.set(id, { x: +f[2], y: +f[3], dir: +f[4], level: +f[5],
                          team: f[6], life: null, lifeAt: null, inv: null });
        if (!replaying) log(`${who(id)} joined ${esc(f[6])}`);
        teamsDirty = true;
        break;

    case 'ppo': {
        const p = players.get(id);
        if (p) { p.x = +f[2]; p.y = +f[3]; p.dir = +f[4]; }
        break;
    }

    case 'plv': {
        const p = players.get(id);
        if (p) {
            p.level = +f[2];
            if (!replaying) log(`${who(id)} <span class="up">reached level ${p.level}</span>`);
        }
        teamsDirty = true;
        break;
    }

    case 'pin': {
        const p = players.get(id);
        if (p) {
            p.x = +f[2];
            p.y = +f[3];
            p.life = +f[4];
            // a replayed snapshot is old: its age is unknown, so no estimate
            p.lifeAt = replaying ? null : performance.now();
            p.inv = f.slice(5, 11).map(Number);
        }
        break;
    }

    case 'pbc': {
        const p = players.get(id);
        const said = f.slice(2).join(' ');
        if (p) addEffect({ kind: 'sound', x: p.x, y: p.y, text: said });
        log(`${who(id)} <span class="said">“${esc(said)}”</span>`);
        break;
    }

    case 'pex': {
        const p = players.get(id);
        if (p) addEffect({ kind: 'kick', x: p.x, y: p.y, dir: p.dir });
        log(`${who(id)} kicked the others off its square`);
        break;
    }

    case 'pic': {
        const x = +f[1];
        const y = +f[2];
        rituals.set(`${x},${y}`, { level: +f[3], players: f.slice(4).map(num) });
        log(`ritual at ${x}·${y}, level ${f[3]} → ${+f[3] + 1}`);
        break;
    }

    case 'pie': {
        const x = +f[1];
        const y = +f[2];
        rituals.delete(`${x},${y}`);
        log(+f[3] ? `ritual at ${x}·${y} <span class="up">succeeded</span>`
                  : `ritual at ${x}·${y} <span class="bad">failed</span>`);
        break;
    }

    case 'pfk':
        log(`${who(id)} called a ship`);
        break;

    case 'pdi':
        players.delete(id);
        if (!replaying) log(`${who(id)} <span class="bad">died</span>`);
        teamsDirty = true;
        break;

    case 'enw': {
        const parent = players.get(num(f[2]));
        eggs.set(id, { x: +f[3], y: +f[4], team: parent ? parent.team : null });
        break;
    }

    case 'eht':
        log(`the ship for egg ${id} arrived`);
        break;

    case 'ebo':
    case 'edi':
        eggs.delete(id);
        break;

    case 'seg':
        winner = f.slice(1).join(' ');
        banner.innerHTML = `<strong>${esc(winner)} wins</strong>`
            + '<span>Six members of the family reached level 8.</span>';
        banner.hidden = false;
        setStatus('won', `${winner} won the game`);
        log(`<span class="up">${esc(winner)} won the game</span>`);
        break;

    case 'sdn':
        setStatus('down', 'The game server is down. Waiting for it to come back…');
        break;

    default:
        break;
    }

    text('w-players', players.size);
    text('w-eggs', eggs.size);
    cardDirty = true;
}

// ------------------------------------------------------------------ panels

let teamsDirty = true;
let legendDirty = true;
let cardDirty = false;

function text(idName, value) {
    document.getElementById(idName).textContent = value;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function who(id) {
    const p = players.get(id);
    const colour = p ? teamColour(p.team) : PAL.inkSoft;
    return `<span class="who" style="color:${colour}">#${id}</span>`;
}

const logEl = document.getElementById('log');

function log(html) {
    const secs = Math.floor((performance.now() - startedAt) / 1000);
    const li = document.createElement('li');
    const stamp = `${String(Math.floor(secs / 60)).padStart(2, '0')}:`
        + `${String(secs % 60).padStart(2, '0')}`;
    li.innerHTML = `<time>${stamp}</time><span>${html}</span>`;
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    logEl.appendChild(li);
    while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function drawTeams() {
    const el = document.getElementById('teams');
    if (!teams.size) {
        el.innerHTML = '<li class="empty">No family has joined yet.</li>';
        return;
    }
    let html = '';
    for (const [name, colour] of teams) {
        const mine = [...players.values()].filter((p) => p.team === name);
        const hist = new Array(8).fill(0);
        for (const p of mine) hist[Math.min(8, Math.max(1, p.level)) - 1]++;
        const peak = Math.max(1, ...hist);
        const eggCount = [...eggs.values()].filter((e) => e.team === name).length;
        const top = hist[7];
        const cols = hist.map((n, i) => {
            const cls = ['col', n ? '' : 'zero', i === 7 ? 'top' : ''].join(' ');
            return `<div class="${cls}" title="level ${i + 1}: ${n}">`
                + `<div class="bar-fill" style="height:${(n / peak) * 100}%"></div></div>`;
        }).join('');
        html += `<li>
            <div class="team-head">
              <span class="team-swatch" style="background:${colour}"></span>
              <span class="team-name">${esc(name)}</span>
              <span class="team-count">${mine.length} alive${eggCount ? ` · ${eggCount} egg${eggCount > 1 ? 's' : ''}` : ''}</span>
            </div>
            <div class="levels" aria-label="members per level">${cols}</div>
            <div class="levels-axis">${hist.map((_, i) => `<span>${i + 1}</span>`).join('')}</div>
            <div class="goal"><span>level 8</span>
              <div class="goal-track"><div class="goal-fill" style="width:${Math.min(100, (top / 6) * 100)}%"></div></div>
              <span>${top}/6</span></div>
          </li>`;
    }
    el.innerHTML = html;
}

function drawLegend() {
    const totals = new Array(RESOURCES.length).fill(0);
    for (const t of world.tiles) for (let i = 0; i < totals.length; i++) totals[i] += t[i];
    document.getElementById('legend').innerHTML = RESOURCES.map((r, i) =>
        `<li><img src="${ICON_URLS[r]}" alt="">${r}<span class="total">${totals[i]}</span></li>`
    ).join('');
}

// --------------------------------------------------------------- geometry

const NARROW = window.matchMedia('(max-width: 860px)');

function layout() {
    const plate = canvas.parentElement;
    // on a phone the map area takes the world's own proportions
    if (NARROW.matches && world.w) {
        const wide = plate.getBoundingClientRect().width;
        const tall = wide * (world.h / world.w) + 58;
        plate.style.height = `${Math.round(Math.min(window.innerHeight * 0.75, Math.max(200, tall)))}px`;
    } else {
        plate.style.height = '';
    }
    const box = plate.getBoundingClientRect();
    view.dpr = window.devicePixelRatio || 1;
    view.cssW = Math.max(1, Math.floor(box.width));
    view.cssH = Math.max(1, Math.floor(box.height));
    for (const cv of [canvas, ground]) {
        cv.width = Math.floor(view.cssW * view.dpr);
        cv.height = Math.floor(view.cssH * view.dpr);
    }
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    gctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (world.w) {
        const pad = 16;
        const cellGuess = Math.min((view.cssW - pad * 2) / world.w,
                                   (view.cssH - pad * 2) / world.h);
        view.ruler = cellGuess >= 6 ? 26 : 0;     // coordinates along the edges
        view.cell = Math.max(0.5, Math.min((view.cssW - pad * 2 - view.ruler) / world.w,
                                           (view.cssH - pad * 2 - view.ruler) / world.h));
        if (view.cell >= 4) view.cell = Math.floor(view.cell);
        const mapW = view.cell * world.w;
        const mapH = view.cell * world.h;
        view.ox = Math.round(view.ruler + (view.cssW - view.ruler - mapW) / 2);
        view.oy = Math.round(view.ruler + (view.cssH - view.ruler - mapH) / 2);
    }
    groundDirty = true;
    cardDirty = true;
}

window.addEventListener('resize', layout);

const cellX = (x) => view.ox + x * view.cell;
const cellY = (y) => view.oy + y * view.cell;

// ----------------------------------------------------------------- ground

/* Resources sit on a fixed grid inside the square: the same kind is always
   in the same corner, so the eye learns where to look. */
const SLOTS = [[0.5, 0.52], [0.22, 0.24], [0.5, 0.2], [0.78, 0.24],
               [0.22, 0.78], [0.5, 0.84], [0.78, 0.78]];

function paintTile(x, y) {
    const c = gctx;
    const px = cellX(x);
    const py = cellY(y);
    const s = view.cell;
    c.fillStyle = (x + y) % 2 ? PAL.fieldAlt : PAL.field;
    c.fillRect(px, py, s, s);
    if (s >= 8) {
        c.fillStyle = 'rgba(37, 50, 43, .09)';
        c.fillRect(px + s - 1, py, 1, s);
        c.fillRect(px, py + s - 1, s, 1);
    }
    const counts = world.tiles[tileIndex(x, y)];
    if (!counts) return;
    if (s < 14) {
        // too small for icons: one dot of the rarest thing lying here
        for (let i = RESOURCES.length - 1; i >= 0; i--) {
            if (!counts[i]) continue;
            c.fillStyle = DOT_COLOURS[RESOURCES[i]];
            const d = Math.max(1, s * 0.45);
            c.fillRect(px + (s - d) / 2, py + (s - d) / 2, d, d);
            break;
        }
        return;
    }
    const r = s * (s >= 48 ? 0.12 : 0.145);
    for (let i = 0; i < RESOURCES.length; i++) {
        if (!counts[i]) continue;
        const ix = px + SLOTS[i][0] * s;
        const iy = py + SLOTS[i][1] * s;
        drawIcon(c, RESOURCES[i], ix, iy, r);
        if (counts[i] > 1 && s >= 34) {
            const bx = ix + r * 0.9;
            const by = iy - r * 0.9;
            c.fillStyle = PAL.ink;
            c.beginPath();
            c.arc(bx, by, Math.max(5, s * 0.08), 0, Math.PI * 2);
            c.fill();
            c.fillStyle = PAL.paper;
            c.font = `600 ${Math.max(7, Math.round(s * 0.09))}px ${MONO}`;
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(counts[i] > 9 ? '9+' : String(counts[i]), bx, by + 0.5);
        }
    }
}

function paintRulers() {
    const c = gctx;
    if (!view.ruler) return;
    const step = Math.max(1, Math.ceil(28 / view.cell));
    const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((n) => n >= step) || step;
    c.fillStyle = PAL.inkSoft;
    c.font = `400 10px ${MONO}`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    for (let x = 0; x < world.w; x += nice) {
        c.fillText(String(x), cellX(x) + view.cell / 2, view.oy - 12);
    }
    c.textAlign = 'right';
    for (let y = 0; y < world.h; y += nice) {
        c.fillText(String(y), view.ox - 7, cellY(y) + view.cell / 2);
    }
}

function paintGround() {
    gctx.fillStyle = PAL.paperDeep;
    gctx.fillRect(0, 0, view.cssW, view.cssH);
    if (!world.w) return;
    for (let y = 0; y < world.h; y++) {
        for (let x = 0; x < world.w; x++) paintTile(x, y);
    }
    gctx.strokeStyle = PAL.ink;
    gctx.lineWidth = 1.5;
    gctx.strokeRect(view.ox - 0.75, view.oy - 0.75,
                    world.w * view.cell + 1.5, world.h * view.cell + 1.5);
    paintRulers();
}

// ------------------------------------------------------------------ frame

function addEffect(e) {
    e.born = performance.now();
    effects.push(e);
    if (effects.length > 200) effects.shift();
}

function drawRituals(now) {
    const dash = REDUCED_MOTION.matches ? 0 : (now / 60) % 12;
    for (const [key, r] of rituals) {
        const [x, y] = key.split(',').map(Number);
        const px = cellX(x);
        const py = cellY(y);
        const s = view.cell;
        ctx.fillStyle = 'rgba(200, 146, 15, .16)';
        ctx.fillRect(px, py, s, s);
        ctx.strokeStyle = PAL.ritual;
        ctx.lineWidth = Math.max(1.5, s * 0.06);
        ctx.setLineDash([Math.max(3, s * 0.12), Math.max(3, s * 0.1)]);
        ctx.lineDashOffset = -dash;
        ctx.strokeRect(px + 1.5, py + 1.5, s - 3, s - 3);
        ctx.setLineDash([]);
        if (s >= 30) {
            label(ctx, `${r.level}→${r.level + 1}`, px + s / 2, py - 2, PAL.ritual, 'bottom');
        }
    }
}

function drawEggs() {
    const s = view.cell;
    for (const e of eggs.values()) {
        const px = cellX(e.x) + s * 0.82;
        const py = cellY(e.y) + s * 0.5;
        const r = Math.max(2, s * 0.09);
        ctx.fillStyle = '#fbf6e6';
        ctx.strokeStyle = PAL.ink;
        ctx.lineWidth = Math.max(1, r * 0.25);
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * 1.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (e.team && s >= 20) {
            ctx.fillStyle = teamColour(e.team);
            ctx.beginPath();
            ctx.arc(px, py + r * 0.2, r * 0.35, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

/* Several players may share a square: fan them out around its centre. */
function drawPlayers() {
    const byTile = new Map();
    for (const [id, p] of players) {
        const key = p.y * world.w + p.x;
        if (!byTile.has(key)) byTile.set(key, []);
        byTile.get(key).push([id, p]);
    }
    const s = view.cell;
    for (const group of byTile.values()) {
        const n = group.length;
        group.forEach(([, p], i) => {
            const spread = n > 1 ? s * 0.2 : 0;
            const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
            const px = cellX(p.x) + s / 2 + Math.cos(angle) * spread;
            const py = cellY(p.y) + s / 2 + Math.sin(angle) * spread;
            drawPlayer(px, py, p, n);
        });
    }
}

/* A token in the family colour, with a notch pointing where it looks. */
function drawPlayer(px, py, p, crowd) {
    const s = view.cell;
    // never smaller than a readable dot, however large the world
    const r = Math.max(3.5, s * (crowd > 3 ? 0.13 : 0.17) * (0.9 + p.level * 0.025));
    const rot = { 1: -Math.PI / 2, 2: 0, 3: Math.PI / 2, 4: Math.PI }[p.dir] || 0;
    const colour = teamColour(p.team);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(r * 1.75, 0);
    ctx.lineTo(r * 0.55, r * 0.8);
    ctx.lineTo(r * 0.55, -r * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = colour;
    ctx.strokeStyle = PAL.paper;
    ctx.lineWidth = Math.max(1, r * 0.22);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (r >= 6) {
        ctx.fillStyle = PAL.paper;
        ctx.font = `600 ${Math.round(r * 1.05)}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.level), px, py + 0.5);
    }
}

function label(c, str, x, y, colour, baseline) {
    c.font = `600 10px ${MONO}`;
    c.textAlign = 'center';
    c.textBaseline = baseline || 'middle';
    c.fillStyle = colour;
    c.fillText(str, x, y);
}

/*
 * A broadcast is a wave on a round world: the ring keeps going past an edge
 * and comes back in on the other side -- the very path the server uses to
 * work out which direction each listener hears it from.
 */
function drawEffects(now) {
    const mapW = world.w * view.cell;
    const mapH = world.h * view.cell;
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.ox, view.oy, mapW, mapH);
    ctx.clip();
    for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        const life = e.kind === 'sound' ? 1800 : 900;
        const age = (now - e.born) / life;
        if (age >= 1) { effects.splice(i, 1); continue; }
        const cx = cellX(e.x) + view.cell / 2;
        const cy = cellY(e.y) + view.cell / 2;
        const still = REDUCED_MOTION.matches;
        if (e.kind === 'sound') {
            const reach = Math.max(mapW, mapH) * 0.6;
            ctx.strokeStyle = PAL.sound;
            ctx.lineWidth = 2;
            for (const lag of [0, 0.18, 0.36]) {
                const a = still ? 0.5 : Math.max(0, age - lag) / (1 - lag);
                if (!still && age < lag) continue;
                ctx.globalAlpha = (1 - age) * (lag ? 0.35 : 0.7);
                const radius = Math.max(view.cell * 0.4, a * reach);
                for (const dx of [-mapW, 0, mapW]) {
                    for (const dy of [-mapH, 0, mapH]) {
                        ctx.beginPath();
                        ctx.arc(cx + dx, cy + dy, radius, 0, Math.PI * 2);
                        ctx.stroke();
                    }
                }
            }
            ctx.globalAlpha = 1;
        } else {
            ctx.strokeStyle = PAL.kick;
            ctx.lineWidth = 3;
            ctx.globalAlpha = 1 - age;
            ctx.beginPath();
            ctx.arc(cx, cy, view.cell * (0.3 + (still ? 0.3 : age * 0.7)), 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }
    ctx.restore();

    // what was said, in a tag next to the one who said it
    for (const e of effects) {
        if (e.kind !== 'sound' || !e.text) continue;
        const age = (now - e.born) / 1800;
        const cx = cellX(e.x) + view.cell / 2;
        const cy = cellY(e.y);
        const str = e.text.length > 28 ? `${e.text.slice(0, 27)}…` : e.text;
        ctx.font = `400 11px ${MONO}`;
        const w = ctx.measureText(str).width + 12;
        const tx = Math.min(Math.max(cx - w / 2, 4), view.cssW - w - 4);
        const ty = Math.max(4, cy - 24);
        ctx.globalAlpha = Math.min(1, (1 - age) * 2.2);
        ctx.fillStyle = PAL.sound;
        roundRect(ctx, tx, ty, w, 18, 3);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(str, tx + 6, ty + 9.5);
        ctx.globalAlpha = 1;
    }
}

function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

function drawSelection() {
    if (!selected) return;
    const s = view.cell;
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(cellX(selected.x) - 1, cellY(selected.y) - 1, s + 2, s + 2);
    ctx.strokeStyle = PAL.paper;
    ctx.lineWidth = 1;
    ctx.strokeRect(cellX(selected.x) + 1, cellY(selected.y) + 1, s - 2, s - 2);
}

let lastCard = 0;

function frame(now) {
    if (groundDirty) {
        paintGround();
        groundDirty = false;
        dirtyTiles.clear();
    } else if (dirtyTiles.size) {
        for (const i of dirtyTiles) paintTile(i % world.w, Math.floor(i / world.w));
        dirtyTiles.clear();
    }
    ctx.clearRect(0, 0, view.cssW, view.cssH);
    ctx.drawImage(ground, 0, 0, view.cssW, view.cssH);
    if (world.w) {
        drawRituals(now);
        drawEggs();
        drawPlayers();
        drawEffects(now);
        drawSelection();
    }
    if (teamsDirty) { drawTeams(); teamsDirty = false; }
    if (legendDirty) { drawLegend(); legendDirty = false; }
    // life drains continuously, so an open card is refreshed a few times a second
    if (selected && (cardDirty || now - lastCard > 400)) {
        showCard();
        lastCard = now;
        cardDirty = false;
    }
    requestAnimationFrame(frame);
}

// ------------------------------------------------------------- inspection

function select(x, y) {
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) {
        selected = null;
        card.hidden = true;
        return;
    }
    selected = { x, y };
    showCard();
}

canvas.addEventListener('click', (ev) => {
    if (!world.w) return;
    const box = canvas.getBoundingClientRect();
    select(Math.floor((ev.clientX - box.left - view.ox) / view.cell),
           Math.floor((ev.clientY - box.top - view.oy) / view.cell));
    canvas.focus({ preventScroll: true });
});

canvas.addEventListener('keydown', (ev) => {
    if (!world.w) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0],
                    ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (ev.key === 'Escape') {
        select(-1, -1);
    } else if (moves[ev.key]) {
        const [dx, dy] = moves[ev.key];
        const from = selected || { x: Math.floor(world.w / 2) - dx, y: Math.floor(world.h / 2) - dy };
        // the world is round, and so is the keyboard walk
        select((from.x + dx + world.w) % world.w, (from.y + dy + world.h) % world.h);
    } else {
        return;
    }
    ev.preventDefault();
});

function lifeLeft(p) {
    if (p.life === null) return null;
    if (p.lifeAt === null || !world.t) return { value: p.life, exact: false };
    const spent = ((performance.now() - p.lifeAt) / 1000) * world.t;
    return { value: Math.max(0, Math.round(p.life - spent)), exact: true };
}

function showCard() {
    if (!selected) return;
    const { x, y } = selected;
    const counts = world.tiles[tileIndex(x, y)] || [];
    const here = [...players.entries()].filter(([, p]) => p.x === x && p.y === y);
    const eggsHere = [...eggs.values()].filter((e) => e.x === x && e.y === y).length;
    const ritual = rituals.get(`${x},${y}`);

    let res = '';
    RESOURCES.forEach((name, i) => {
        if (!counts[i]) return;
        res += `<li><img src="${ICON_URLS[name]}" alt="">${name}<span class="n">${counts[i]}</span></li>`;
    });
    if (!res) res = '<li class="none">Nothing lies here.</li>';

    let people = '';
    for (const [id, p] of here) {
        const life = lifeLeft(p);
        const lifeText = life === null ? 'life unknown'
            : `${life.exact ? '' : '≥ '}${life.value} tu to live`;
        const stones = p.inv
            ? RESOURCES.slice(1).map((r, i) => (p.inv[i] ? `${r} ${p.inv[i]}` : null))
                .filter(Boolean).join(' · ')
            : '';
        people += `<li>
            <div class="who-line"><span class="team-swatch" style="background:${teamColour(p.team)}"></span>
              <strong>#${id}</strong> ${esc(p.team)}<span class="chip">L${p.level}</span></div>
            <div class="who-meta">${FACING[p.dir] || ''} · ${lifeText}</div>
            ${stones ? `<div class="who-meta">carries ${stones}</div>` : ''}
          </li>`;
    }
    if (eggsHere) {
        people += `<li class="who-meta">${eggsHere} egg${eggsHere > 1 ? 's' : ''} waiting for a player</li>`;
    }

    card.innerHTML = `<div class="card-head"><h3>Square</h3><span class="coords">x ${x} · y ${y}</span></div>
        <h4>Resources</h4><ul class="res">${res}</ul>
        ${people ? `<h4>Standing here</h4><ul class="who">${people}</ul>` : ''}
        ${ritual ? `<p class="ritual-line">Ritual under way, level ${ritual.level} → ${ritual.level + 1}</p>` : ''}`;
    card.hidden = false;

    // beside the square, flipped to the other side when there is no room
    const s = view.cell;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let left = cellX(x) + s + 12;
    if (left + w > view.cssW - 8) left = cellX(x) - w - 12;
    if (left < 8) left = Math.max(8, Math.min(view.cssW - w - 8, cellX(x) + s / 2 - w / 2));
    let top = cellY(y) + s / 2 - h / 2;
    top = Math.max(8, Math.min(view.cssH - h - 8, top));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

// ------------------------------------------------------------------- boot

layout();
drawTeams();
drawLegend();
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { groundDirty = true; });
}
requestAnimationFrame(frame);
connect();
