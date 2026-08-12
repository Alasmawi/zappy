/*
 * Zappy graphic client -- rendering.
 *
 * Everything is drawn by hand on a 2D canvas: no game engine is involved.
 * The page only ever listens; it never sends anything to the server.
 */

'use strict';

const RESOURCES = ['food', 'jade', 'peridot', 'amber', 'amethyst', 'garnet',
                   'ammolite'];

const COLOURS = {
    food:     '#7ddb9a',
    jade:     '#2fbf71',
    peridot:  '#c3d94c',
    amber:    '#ffb648',
    amethyst: '#b072e8',
    garnet:   '#e05263',
    ammolite: '#43c6d9'
};

const TEAM_COLOURS = ['#6fd3e0', '#ffb648', '#c58cf0', '#7ddb9a', '#e8737f',
                      '#f0d264', '#8fa2ff', '#f09ad2'];

// ------------------------------------------------------------------ state

const world = { w: 0, h: 0, t: 0, tiles: [] };
const players = new Map();      // id -> {x, y, dir, level, team, food, inv}
const eggs = new Map();         // id -> {x, y}
const teams = new Map();        // name -> colour
const ripples = [];             // sound and kick animations
const incantations = new Map(); // "x,y" -> {level, until}
let selected = null;
let winner = null;

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const statusEl = document.getElementById('status');
let cell = 0;
let originX = 0;
let originY = 0;

// ------------------------------------------------------------- connection

function connect() {
    const ws = new WebSocket(`ws://${location.host}/`);
    ws.onopen = () => setStatus('live', 'connected');
    ws.onclose = () => {
        setStatus('down', 'disconnected — retrying');
        setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
        for (const line of ev.data.split('\n')) {
            if (line) handle(line);
        }
    };
}

function setStatus(cls, text) {
    if (winner) return;
    statusEl.className = `status ${cls}`;
    statusEl.textContent = text;
}

// --------------------------------------------------------------- protocol

function tileIndex(x, y) { return y * world.w + x; }

function handle(line) {
    const f = line.split(' ');
    const id = f[1] ? parseInt(f[1].replace('#', ''), 10) : null;

    switch (f[0]) {
    case 'msz':
        world.w = +f[1];
        world.h = +f[2];
        world.tiles = new Array(world.w * world.h).fill(null)
            .map(() => RESOURCES.map(() => 0));
        document.getElementById('w-size').textContent = `${world.w} × ${world.h}`;
        resize();
        break;

    case 'sgt':
        world.t = +f[1];
        document.getElementById('w-time').textContent = `1/${world.t} s`;
        break;

    case 'bct': {
        const x = +f[1], y = +f[2];
        if (world.tiles.length) {
            world.tiles[tileIndex(x, y)] = f.slice(3, 10).map(Number);
        }
        break;
    }

    case 'tna':
        if (!teams.has(f[1])) {
            teams.set(f[1], TEAM_COLOURS[teams.size % TEAM_COLOURS.length]);
            drawTeams();
        }
        break;

    case 'pnw':
        if (!teams.has(f[6])) {
            teams.set(f[6], TEAM_COLOURS[teams.size % TEAM_COLOURS.length]);
        }
        players.set(id, { x: +f[2], y: +f[3], dir: +f[4], level: +f[5],
                          team: f[6], food: 0, inv: [0, 0, 0, 0, 0, 0] });
        log(`<span class="who">#${id}</span> joined ${f[6]}`);
        drawTeams();
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
            log(`<span class="who">#${id}</span> <span class="up">reached level ${p.level}</span>`);
        }
        drawTeams();
        break;
    }

    case 'pin': {
        const p = players.get(id);
        if (p) {
            p.x = +f[2]; p.y = +f[3];
            p.food = +f[4];
            p.inv = f.slice(5, 11).map(Number);
        }
        break;
    }

    case 'pbc': {
        const p = players.get(id);
        const text = f.slice(2).join(' ');
        if (p) ripples.push({ x: p.x, y: p.y, born: performance.now(), kind: 'sound' });
        log(`<span class="who">#${id}</span> <span class="say">broadcast “${escapeHtml(text)}”</span>`);
        break;
    }

    case 'pex': {
        const p = players.get(id);
        if (p) ripples.push({ x: p.x, y: p.y, born: performance.now(), kind: 'kick' });
        log(`<span class="who">#${id}</span> was kicked`);
        break;
    }

    case 'pic': {
        const x = +f[1], y = +f[2];
        incantations.set(`${x},${y}`, { level: +f[3] });
        log(`ritual at (${x}, ${y}) — level ${f[3]} → ${+f[3] + 1}`);
        break;
    }

    case 'pie': {
        const x = +f[1], y = +f[2];
        incantations.delete(`${x},${y}`);
        log(+f[3] ? `ritual at (${x}, ${y}) <span class="up">succeeded</span>`
                  : `ritual at (${x}, ${y}) <span class="bad">failed</span>`);
        break;
    }

    case 'pfk':
        log(`<span class="who">#${id}</span> called a ship`);
        break;

    case 'pdi':
        players.delete(id);
        log(`<span class="who">#${id}</span> <span class="bad">died</span>`);
        drawTeams();
        break;

    case 'enw':
        eggs.set(id, { x: +f[3], y: +f[4] });
        break;

    case 'eht':
        log(`egg #${id} hatched`);
        break;

    case 'ebo':
    case 'edi':
        eggs.delete(id);
        break;

    case 'seg':
        winner = f[1];
        statusEl.className = 'status won';
        statusEl.textContent = `${f[1]} wins!`;
        log(`<span class="up">${escapeHtml(f[1])} wins the game</span>`);
        break;

    case 'smg':
        log(escapeHtml(f.slice(1).join(' ')));
        break;

    case 'sdn':
        setStatus('down', 'server down');
        break;

    default:
        break;
    }

    document.getElementById('w-players').textContent = players.size;
    document.getElementById('w-eggs').textContent = eggs.size;
    if (selected) showTooltip();
}

// ------------------------------------------------------------------- side

function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const logEl = document.getElementById('log');

function log(html) {
    const li = document.createElement('li');
    li.innerHTML = html;
    logEl.appendChild(li);
    while (logEl.children.length > 120) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
}

function drawTeams() {
    const el = document.getElementById('teams');
    el.innerHTML = '';
    for (const [name, colour] of teams) {
        const mine = [...players.values()].filter((p) => p.team === name);
        const levels = mine.map((p) => p.level).sort((a, b) => b - a);
        const li = document.createElement('li');
        li.innerHTML = `<span class="dot" style="background:${colour}"></span>`
            + `<span class="name">${escapeHtml(name)}</span>`
            + `<span class="levels">${mine.length} · lvl ${levels.join(',') || '–'}</span>`;
        el.appendChild(li);
    }
}

(function buildLegend() {
    const el = document.getElementById('legend');
    for (const r of RESOURCES) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="swatch" style="background:${COLOURS[r]}"></span>${r}`;
        el.appendChild(li);
    }
})();

// ---------------------------------------------------------------- drawing

function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor((box.width - 28) * dpr));
    canvas.height = Math.max(1, Math.floor((box.height - 28) * dpr));
    canvas.style.width = `${box.width - 28}px`;
    canvas.style.height = `${box.height - 28}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!world.w) return;
    cell = Math.floor(Math.min((box.width - 28) / world.w,
                               (box.height - 28) / world.h));
    originX = ((box.width - 28) - cell * world.w) / 2;
    originY = ((box.height - 28) - cell * world.h) / 2;
}

window.addEventListener('resize', resize);

function drawGrid() {
    for (let y = 0; y < world.h; y++) {
        for (let x = 0; x < world.w; x++) {
            const px = originX + x * cell;
            const py = originY + y * cell;
            ctx.fillStyle = (x + y) % 2 ? '#171d27' : '#141a23';
            ctx.fillRect(px, py, cell, cell);
        }
    }
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= world.w; x++) {
        ctx.moveTo(originX + x * cell, originY);
        ctx.lineTo(originX + x * cell, originY + world.h * cell);
    }
    for (let y = 0; y <= world.h; y++) {
        ctx.moveTo(originX, originY + y * cell);
        ctx.lineTo(originX + world.w * cell, originY + y * cell);
    }
    ctx.stroke();
}

/* Resources sit on a small fixed grid inside the square, so that the same
   object is always in the same corner and the eye can follow it. */
const SLOTS = [[0.22, 0.24], [0.5, 0.2], [0.78, 0.24],
               [0.2, 0.52], [0.8, 0.52], [0.3, 0.8], [0.7, 0.8]];

function drawResources() {
    const r = Math.max(1.6, cell * 0.075);
    for (let y = 0; y < world.h; y++) {
        for (let x = 0; x < world.w; x++) {
            const counts = world.tiles[tileIndex(x, y)];
            if (!counts) continue;
            for (let i = 0; i < RESOURCES.length; i++) {
                if (!counts[i]) continue;
                const px = originX + (x + SLOTS[i][0]) * cell;
                const py = originY + (y + SLOTS[i][1]) * cell;
                ctx.fillStyle = COLOURS[RESOURCES[i]];
                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.fill();
                if (counts[i] > 1 && cell > 26) {
                    ctx.fillStyle = '#0b0e14';
                    ctx.font = `bold ${Math.round(cell * 0.16)}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(counts[i]), px, py + 0.5);
                }
            }
        }
    }
}

function drawEggs() {
    for (const egg of eggs.values()) {
        const px = originX + (egg.x + 0.5) * cell;
        const py = originY + (egg.y + 0.5) * cell;
        ctx.strokeStyle = 'rgba(255,255,255,.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(px, py, cell * 0.13, cell * 0.17, 0, 0, Math.PI * 2);
        ctx.stroke();
    }
}

/* Several players may share a square: fan them out around its centre. */
function drawPlayers() {
    const byTile = new Map();
    for (const [id, p] of players) {
        const key = `${p.x},${p.y}`;
        if (!byTile.has(key)) byTile.set(key, []);
        byTile.get(key).push([id, p]);
    }
    for (const group of byTile.values()) {
        group.forEach(([, p], i) => {
            const spread = group.length > 1 ? cell * 0.16 : 0;
            const angle = (i / group.length) * Math.PI * 2;
            const px = originX + (p.x + 0.5) * cell + Math.cos(angle) * spread;
            const py = originY + (p.y + 0.5) * cell + Math.sin(angle) * spread;
            drawPlayer(px, py, p);
        });
    }
}

/* An arrow pointing where the player looks, growing slightly with level. */
function drawPlayer(px, py, p) {
    const size = Math.max(4, cell * (0.2 + Math.min(p.level, 8) * 0.012));
    const rot = { 1: -Math.PI / 2, 2: 0, 3: Math.PI / 2, 4: Math.PI }[p.dir] || 0;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.fillStyle = teams.get(p.team) || '#fff';
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, size * 0.68);
    ctx.lineTo(-size * 0.35, 0);
    ctx.lineTo(-size * 0.7, -size * 0.68);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (cell > 22) {
        ctx.fillStyle = '#0b0e14';
        ctx.font = `bold ${Math.round(cell * 0.2)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.level), px, py);
    }
}

function drawIncantations(now) {
    for (const key of incantations.keys()) {
        const [x, y] = key.split(',').map(Number);
        const pulse = 0.5 + 0.5 * Math.sin(now / 160);
        ctx.strokeStyle = `rgba(255, 209, 102, ${0.35 + pulse * 0.5})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(originX + x * cell + 1.5, originY + y * cell + 1.5,
                       cell - 3, cell - 3);
        ctx.fillStyle = `rgba(255, 209, 102, ${0.06 + pulse * 0.09})`;
        ctx.fillRect(originX + x * cell, originY + y * cell, cell, cell);
    }
}

/*
 * Sound is a wave on a round world: the ring keeps going and comes back in
 * on the other side, which is exactly how the server computes directions.
 */
function drawRipples(now) {
    const LIFE = 1600;
    for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        const age = (now - rp.born) / LIFE;
        if (age >= 1) { ripples.splice(i, 1); continue; }
        const px = originX + (rp.x + 0.5) * cell;
        const py = originY + (rp.y + 0.5) * cell;
        const kick = rp.kind === 'kick';
        const radius = age * cell * (kick ? 2.2 : 6);
        const alpha = (1 - age) * (kick ? 0.7 : 0.55);
        ctx.strokeStyle = kick ? `rgba(232, 115, 127, ${alpha})`
                               : `rgba(111, 211, 224, ${alpha})`;
        ctx.lineWidth = kick ? 3 : 2;
        for (const dx of [-1, 0, 1]) {
            for (const dy of [-1, 0, 1]) {
                ctx.beginPath();
                ctx.arc(px + dx * world.w * cell, py + dy * world.h * cell,
                        radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        if (!kick) {
            ctx.fillStyle = `rgba(111, 211, 224, ${alpha * 0.5})`;
            ctx.beginPath();
            ctx.arc(px, py, cell * 0.12, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function drawSelection() {
    if (!selected) return;
    ctx.strokeStyle = '#6fd3e0';
    ctx.lineWidth = 2;
    ctx.strokeRect(originX + selected.x * cell + 1, originY + selected.y * cell + 1,
                   cell - 2, cell - 2);
}

function frame(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (world.w) {
        drawGrid();
        drawIncantations(now);
        drawResources();
        drawEggs();
        drawPlayers();
        drawRipples(now);
        drawSelection();
    }
    requestAnimationFrame(frame);
}

// ------------------------------------------------------------- inspection

canvas.addEventListener('click', (ev) => {
    if (!world.w) return;
    const box = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - box.left - originX) / cell);
    const y = Math.floor((ev.clientY - box.top - originY) / cell);
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) {
        selected = null;
        tooltip.classList.add('hidden');
        return;
    }
    selected = { x, y, px: ev.clientX - box.left, py: ev.clientY - box.top };
    showTooltip();
});

function showTooltip() {
    const counts = world.tiles[tileIndex(selected.x, selected.y)] || [];
    const here = [...players.entries()].filter(([, p]) =>
        p.x === selected.x && p.y === selected.y);
    const eggsHere = [...eggs.values()].filter((e) =>
        e.x === selected.x && e.y === selected.y).length;

    let rows = '';
    RESOURCES.forEach((name, i) => {
        if (!counts[i]) return;
        rows += `<tr><td><span class="sw" style="background:${COLOURS[name]}"></span>`
            + `${name}</td><td class="n">${counts[i]}</td></tr>`;
    });
    if (!rows) rows = '<tr><td class="none" colspan="2">no resources</td></tr>';

    let who = '';
    for (const [id, p] of here) {
        who += `<tr><td><span class="sw" style="background:${teams.get(p.team) || '#fff'}"></span>`
            + `#${id} ${escapeHtml(p.team)}</td><td class="n">lvl ${p.level}</td></tr>`;
    }
    if (eggsHere) {
        who += `<tr><td class="none">eggs waiting</td><td class="n">${eggsHere}</td></tr>`;
    }

    tooltip.innerHTML = `<h3>square (${selected.x}, ${selected.y})</h3>`
        + `<table>${rows}</table>`
        + (who ? `<h3 style="margin-top:8px">standing here</h3><table>${who}</table>`
               : '');
    tooltip.classList.remove('hidden');

    const box = canvas.parentElement.getBoundingClientRect();
    const wide = tooltip.offsetWidth;
    let left = selected.px + 18;
    if (left + wide > box.width - 10) left = selected.px - wide - 12;
    tooltip.style.left = `${Math.max(6, left)}px`;
    tooltip.style.top = `${Math.min(selected.py + 12, box.height - tooltip.offsetHeight - 10)}px`;
}

resize();
requestAnimationFrame(frame);
connect();
