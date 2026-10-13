'use strict';
(() => {
  // ===== 상수 =====
  const W = 1600, H = 800, WATER_Y = H - 30;
  const GRAV = 0.2, R = 7, MAX_HP = 100, WORMS_PER_TEAM = 2;
  const TURN_TICKS = 30 * 60, RETREAT_TICKS = 4 * 60, MAX_CHARGE = 60;
  const COLORS = ['#ff5d5d', '#3e8ef7', '#3ccf7a', '#f5b524'];
  const WEAPONS = [
    { key: 'bazooka', name: '바주카', r: 30, dmg: 50 },
    { key: 'grenade', name: '수류탄', r: 34, dmg: 55, fuse: 180 },
    { key: 'shotgun', name: '샷건', r: 14, dmg: 25, range: 500 },
  ];
  // 네트워크·보안
  const NET_VER = 1, ID_PREFIX = 'wormsweb-v1-';
  const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', CODE_LEN = 6;
  const MAX_PLAYERS = 4;
  const MAX_CLIENT_MSG = 512;     // 참가자 → 방장 메시지 최대 크기
  const MAX_HOST_MSG = 20000;     // 방장 → 참가자 메시지 최대 크기
  const RATE_PER_SEC = 60;        // 참가자 1명당 초당 메시지 한도
  const HANDSHAKE_MS = 5000;
  const SNAP_EVERY = 3;           // 3틱(20Hz)마다 상태 전송

  // ===== 유틸 =====
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v)) ? clamp(v, a, b) : d;
  const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
  const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
  function mulberry32(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const randU32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
  function makeCode() {
    const b = crypto.getRandomValues(new Uint8Array(CODE_LEN));
    return Array.from(b, x => CODE_ABC[x % CODE_ABC.length]).join('');
  }
  // 이름: 문자열만, 제어문자 제거, 12자 제한 (화면에는 textContent/fillText로만 출력)
  function cleanName(s, fallback = '플레이어') {
    if (typeof s !== 'string') return fallback;
    const t = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').trim().slice(0, 12);
    return t || fallback;
  }
  function checkMsg(raw, maxLen) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    let len;
    try { len = JSON.stringify(raw).length; } catch { return null; }
    if (len > maxLen || typeof raw.t !== 'string') return null;
    return raw;
  }
  function makeLimiter(perSec) {
    let tokens = perSec, last = performance.now();
    return () => {
      const now = performance.now();
      tokens = Math.min(perSec, tokens + (now - last) / 1000 * perSec);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1; return true;
    };
  }
  const blankInp = () => ({ l: false, r: false, u: false, d: false, j: false, f: false });
  function cleanInp(k) {
    const o = blankInp();
    if (typeof k === 'object' && k !== null) for (const key in o) o[key] = k[key] === true;
    return o;
  }

  // ===== 지형 =====
  const terrain = new Uint8Array(W * H);
  const tCan = document.createElement('canvas'); tCan.width = W; tCan.height = H;
  const tCtx = tCan.getContext('2d');
  let tImg = null;
  const solidAt = (x, y) => {
    x |= 0; y |= 0;
    return x >= 0 && x < W && y >= 0 && y < H && terrain[y * W + x] === 1;
  };
  function carveRaw(cx, cy, r) {
    const x0 = Math.max(0, cx - r | 0), x1 = Math.min(W - 1, cx + r | 0);
    const y0 = Math.max(0, cy - r | 0), y1 = Math.min(H - 1, cy + r | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) terrain[y * W + x] = 0;
    }
  }
  function paint(x0, y0, x1, y1) {
    x0 = clamp(x0 | 0, 0, W); x1 = clamp(x1 | 0, 0, W); y0 = clamp(y0 | 0, 0, H); y1 = clamp(y1 | 0, 0, H);
    if (x1 <= x0 || y1 <= y0) return;
    const d = tImg.data;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x, p = i * 4;
      if (!terrain[i]) { d[p + 3] = 0; continue; }
      const n = ((x * 73856093 ^ y * 19349663) >>> 0) % 22 - 11;
      if (!solidAt(x, y - 4)) { d[p] = 70 + n; d[p + 1] = 170 + n; d[p + 2] = 60; }
      else { d[p] = 120 + n; d[p + 1] = 80 + n; d[p + 2] = 48 + (n >> 1); }
      d[p + 3] = 255;
    }
    tCtx.putImageData(tImg, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
  function carve(cx, cy, r) { carveRaw(cx, cy, r); paint(cx - r - 6, cy - r - 6, cx + r + 6, cy + r + 6); }
  function genTerrain(seed) {
    const rnd = mulberry32(seed);
    terrain.fill(0);
    const waves = [0, 1, 2, 3].map(i => ({ a: (40 + rnd() * 60) / (i + 1), f: (0.002 + rnd() * 0.003) * (i + 1) * 1.7, p: rnd() * Math.PI * 2 }));
    for (let x = 0; x < W; x++) {
      let h = H * 0.55;
      for (const w of waves) h += Math.sin(x * w.f + w.p) * w.a;
      const edge = Math.min(x, W - 1 - x);
      if (edge < 80) h += (80 - edge) * 1.5;
      h = clamp(h, 180, WATER_Y - 15);
      for (let y = h | 0; y < H; y++) terrain[y * W + x] = 1;
    }
    const caves = 6 + (rnd() * 5 | 0);
    for (let i = 0; i < caves; i++) carveRaw(100 + rnd() * (W - 200), H * 0.62 + rnd() * H * 0.22, 18 + rnd() * 30);
    for (let i = 0; i < 3; i++) {
      const cx = 200 + rnd() * (W - 400), cy = 140 + rnd() * 170, rw = 60 + rnd() * 80, rh = 14 + rnd() * 14;
      for (let y = cy - rh | 0; y < cy + rh; y++) for (let x = cx - rw | 0; x < cx + rw; x++) {
        const dx = (x - cx) / rw, dy = (y - cy) / rh;
        if (dx * dx + dy * dy < 1 && x >= 0 && x < W && y >= 0) terrain[y * W + x] = 1;
      }
    }
    tImg = tCtx.createImageData(W, H);
    paint(0, 0, W, H);
  }

  // ===== 게임 상태 (로컬·AI·방장만 시뮬레이션) =====
  let G = null;
  const OFFS = Array.from({ length: 12 }, (_, i) => [Math.cos(i * Math.PI / 6) * R, Math.sin(i * Math.PI / 6) * R]);
  const wormCollide = (x, y) => OFFS.some(([ox, oy]) => solidAt(x + ox, y + oy));
  const curWorm = () => G && G.worms[G.curW];

  // teams: [{name, ai, level, owner}]
  function newGame(teams, seed) {
    genTerrain(seed);
    const rnd = mulberry32(seed ^ 0x9e3779b9);
    const n = teams.length, total = n * WORMS_PER_TEAM;
    const order = [];
    for (let k = 0; k < WORMS_PER_TEAM; k++) for (let t = 0; t < n; t++) order.push(t);
    for (let i = order.length - 1; i > 0; i--) { const j = rnd() * (i + 1) | 0; [order[i], order[j]] = [order[j], order[i]]; }
    const worms = [];
    for (let i = 0; i < total; i++) {
      let x = 80 + (W - 160) * (i + 0.5) / total + (rnd() - 0.5) * 40, y = -1;
      for (let tries = 0; tries < 20 && y < 0; tries++, x = clamp(x + 23, 30, W - 30)) {
        for (let yy = R + 2; yy < WATER_Y - R; yy++) if (wormCollide(x, yy + 1)) { y = yy; break; }
      }
      if (y < 0) y = 100;
      worms.push({ team: order[i], x, y, vx: 0, vy: 0, hp: MAX_HP, alive: true, facing: x < W / 2 ? 1 : -1, aim: 0.4, air: true });
    }
    G = {
      teams, worms, proj: [], ev: [], cur: n - 1, curW: 0, wormPtr: teams.map(() => -1),
      wind: 0, timer: 0, fired: false, charge: 0, weapon: 0, prevF: true, prevJ: true,
      settle: 0, tick: 0, over: false, winner: -1, ai: null,
    };
    nextTurn();
  }
  const teamAlive = t => G.worms.some(w => w.team === t && w.alive);

  function nextTurn() {
    const alive = G.teams.map((_, i) => i).filter(teamAlive);
    if (alive.length <= 1) { G.over = true; G.winner = alive.length ? alive[0] : -1; G.timer = 0; return; }
    let t = G.cur;
    do { t = (t + 1) % G.teams.length; } while (!teamAlive(t));
    G.cur = t;
    const tw = G.worms.filter(w => w.team === t && w.alive);
    G.wormPtr[t] = (G.wormPtr[t] + 1) % tw.length;
    G.curW = G.worms.indexOf(tw[G.wormPtr[t]]);
    G.timer = TURN_TICKS; G.fired = false; G.charge = 0; G.settle = 0;
    G.prevF = true; G.prevJ = true;
    G.wind = r2(Math.random() * 2 - 1);
    G.ai = G.teams[t].ai ? { plan: null, wait: 50 } : null;
  }

  function damage(w, d) { if (!w.alive || d <= 0) return; w.hp = Math.max(0, w.hp - d); if (w.hp === 0) kill(w); }
  function kill(w) { w.alive = false; w.hp = 0; if (w === curWorm()) G.timer = 0; }

  function walk(w, d) {
    const nx = w.x + d;
    if (nx < R || nx > W - R) return;
    for (let up = 0; up <= 4; up++) {
      if (wormCollide(nx, w.y - up)) continue;
      w.x = nx; w.y -= up;
      for (let dn = 0; dn < 4 && !wormCollide(w.x, w.y + 1); dn++) w.y++;
      if (!wormCollide(w.x, w.y + 1)) w.air = true;
      return;
    }
  }
  function physWorm(w) {
    if (!w.air) { if (wormCollide(w.x, w.y + 1)) return; w.air = true; }
    w.vy = Math.min(w.vy + GRAV, 10);
    const n = Math.ceil(Math.max(Math.abs(w.vx), Math.abs(w.vy))) || 1;
    const sx = w.vx / n, sy = w.vy / n;
    for (let i = 0; i < n; i++) {
      if (sx && !wormCollide(w.x + sx, w.y)) w.x += sx; else if (sx) { w.vx *= -0.3; break; }
      if (!wormCollide(w.x, w.y + sy)) w.y += sy;
      else if (sy > 0) {
        if (w.vy > 6) damage(w, Math.round((w.vy - 6) * 6));
        w.vx = 0; w.vy = 0; w.air = false; break;
      } else { w.vy = 0; break; }
    }
    if (w.y > WATER_Y + 4) kill(w);
  }

  function aimDir(w) { return [Math.cos(w.aim) * w.facing, -Math.sin(w.aim)]; }
  function fire(cw, power) {
    G.fired = true; G.charge = 0; G.timer = Math.min(G.timer, RETREAT_TICKS);
    const wp = WEAPONS[G.weapon];
    const [dx, dy] = aimDir(cw);
    const sx = cw.x + dx * (R + 4), sy = cw.y + dy * (R + 4);
    if (wp.key === 'shotgun') {
      let ex = sx, ey = sy;
      for (let d = 0; d < wp.range; d += 2) {
        ex = sx + dx * d; ey = sy + dy * d;
        if (solidAt(ex, ey) || G.worms.some(w => w.alive && w !== cw && Math.hypot(w.x - ex, w.y - ey) < R + 1)) { explode(ex, ey, wp); break; }
      }
      G.ev.push(['f', r1(sx), r1(sy), r1(ex), r1(ey)]);
      return;
    }
    const sp = 2 + power * 10;
    G.proj.push({ w: G.weapon, x: sx, y: sy, vx: dx * sp, vy: dy * sp, fuse: wp.fuse || 0, owner: cw, age: 0, dead: false });
  }
  function hitWorm(x, y, p) {
    return G.worms.some(w => w.alive && !(w === p.owner && p.age < 15) && Math.hypot(w.x - x, w.y - y) < R + 2);
  }
  function stepProj(p) {
    const wp = WEAPONS[p.w];
    p.age++;
    p.vy += GRAV;
    if (wp.key === 'bazooka') p.vx += G.wind * 0.04;
    const n = Math.ceil(Math.max(Math.abs(p.vx), Math.abs(p.vy))) || 1;
    for (let i = 0; i < n; i++) {
      const nx = p.x + p.vx / n, ny = p.y + p.vy / n;
      if (wp.key === 'bazooka') {
        if (solidAt(nx, ny) || hitWorm(nx, ny, p)) { explode(nx, ny, wp); p.dead = true; return; }
      } else if (solidAt(nx, ny)) {
        const hx = solidAt(nx, p.y), hy = solidAt(p.x, ny);
        if (hx) p.vx *= -0.45;
        if (hy) p.vy *= -0.45;
        if (!hx && !hy) { p.vx *= -0.45; p.vy *= -0.45; }
        p.vx *= 0.9;
        break;
      }
      p.x = nx; p.y = ny;
    }
    if (wp.fuse && --p.fuse <= 0) { explode(p.x, p.y, wp); p.dead = true; }
    if (p.y > WATER_Y || p.x < -300 || p.x > W + 300) p.dead = true;
  }
  function explode(x, y, wp) {
    carve(x, y, wp.r);
    G.ev.push(['b', r1(x), r1(y), wp.r]);
    boomFx(x, y, wp.r);
    const reach = wp.r * 1.5;
    for (const w of G.worms) {
      if (!w.alive) continue;
      const d = Math.hypot(w.x - x, w.y - y);
      if (d >= reach) continue;
      const f = 1 - d / reach, k = f * 6;
      w.vx += (w.x - x) / (d || 1) * k;
      w.vy += (w.y - y) / (d || 1) * k - k * 0.5;
      w.air = true;
      damage(w, Math.round(wp.dmg * f));
    }
  }
  const settled = () => G.proj.length === 0 && G.worms.every(w => !w.alive || !w.air);

  function selectWeapon(team, i) {
    if (!G || G.over || G.cur !== team || G.fired || !int(i, 0, WEAPONS.length - 1)) return;
    G.weapon = i; G.charge = 0;
  }

  function step(inp) {
    if (G.over) return;
    const cw = curWorm();
    const control = G.timer > 0 && cw && cw.alive;
    if (G.timer > 0) G.timer--;
    if (control && G.ai) inp = aiInput(cw);
    if (control) {
      if (!cw.air) {
        if (inp.l !== inp.r) { const d = inp.l ? -1 : 1; cw.facing = d; walk(cw, d); }
        if (inp.j && !G.prevJ) { cw.vy = -3.6; cw.vx = cw.facing * 1.7; cw.air = true; }
      }
      if (inp.u) cw.aim = Math.min(1.5, cw.aim + 0.03);
      if (inp.d) cw.aim = Math.max(-1.5, cw.aim - 0.03);
      if (!G.fired) {
        if (WEAPONS[G.weapon].key === 'shotgun') { if (inp.f && !G.prevF) fire(cw, 1); }
        else if (inp.f && !(G.prevF && G.charge === 0)) { if (++G.charge >= MAX_CHARGE) fire(cw, 1); }
        else if (!inp.f && G.charge > 0) fire(cw, G.charge / MAX_CHARGE);
      }
    }
    G.prevJ = !!inp.j; G.prevF = !!inp.f;
    for (const w of G.worms) if (w.alive) physWorm(w);
    for (const p of G.proj) stepProj(p);
    G.proj = G.proj.filter(p => !p.dead);
    if (G.timer <= 0 && settled()) { if (++G.settle > 40) nextTurn(); } else G.settle = 0;
    G.tick++;
  }

  // ===== AI: 궤적을 미리 계산해서 적에게 가장 가까이 떨어지는 각도·힘 선택 =====
  const AI_ERR = [0.12, 0.05, 0.015];   // 난이도별 조준 오차(rad)
  function simShot(cw, facing, aim, power, wind) {
    const dx = Math.cos(aim) * facing, dy = -Math.sin(aim);
    let x = cw.x + dx * (R + 4), y = cw.y + dy * (R + 4);
    const sp = 2 + power * 10;
    let vx = dx * sp, vy = dy * sp;
    for (let t = 0; t < 500; t++) {
      vy += GRAV; vx += wind * 0.04;
      const n = Math.ceil(Math.max(Math.abs(vx), Math.abs(vy))) || 1;
      for (let i = 0; i < n; i++) {
        x += vx / n; y += vy / n;
        if (solidAt(x, y)) return [x, y];
        if (t > 3 && G.worms.some(w => w.alive && w !== cw && Math.hypot(w.x - x, w.y - y) < R + 2)) return [x, y];
      }
      if (y > WATER_Y || x < -300 || x > W + 300) return null;
    }
    return null;
  }
  function scoreHit(cw, hx, hy, reach) {
    let s = 0;
    for (const w of G.worms) {
      if (!w.alive) continue;
      const d = Math.hypot(w.x - hx, w.y - hy);
      if (w.team === cw.team) { if (d < reach) s -= 400 * (1 - d / reach); }
      else s += d < reach ? 300 * (1 - d / reach) + (w.hp <= 40 ? 80 : 0) : -d * 0.3;
    }
    return s;
  }
  function aiPlan(cw) {
    const level = G.teams[cw.team].level;
    let best = { s: -Infinity, w: 0, facing: cw.facing, aim: 0.6, power: 0.7 };
    for (const facing of [-1, 1]) {
      for (let aim = -0.5; aim <= 1.45; aim += 0.05) {
        // 샷건: 직선 거리 안의 적
        const [dx, dy] = [Math.cos(aim) * facing, -Math.sin(aim)];
        for (let d = 0; d < WEAPONS[2].range; d += 3) {
          const x = cw.x + dx * (R + 4 + d), y = cw.y + dy * (R + 4 + d);
          if (solidAt(x, y)) break;
          const hit = G.worms.find(w => w.alive && w !== cw && Math.hypot(w.x - x, w.y - y) < R + 1);
          if (hit) { if (hit.team !== cw.team) { const s = 120 + (hit.hp <= 25 ? 200 : 0); if (s > best.s) best = { s, w: 2, facing, aim, power: 1 }; } break; }
        }
        for (let power = 0.25; power <= 1.001; power += 0.05) {
          const hit = simShot(cw, facing, aim, power, G.wind);
          if (!hit) continue;
          const s = scoreHit(cw, hit[0], hit[1], WEAPONS[0].r * 1.5);
          if (s > best.s) best = { s, w: 0, facing, aim, power };
        }
      }
    }
    const err = AI_ERR[level] || AI_ERR[1];
    best.aim = clamp(best.aim + (Math.random() * 2 - 1) * err, -1.5, 1.5);
    best.power = clamp(best.power + (Math.random() * 2 - 1) * err * 0.8, 0.1, 1);
    return best;
  }
  function aiInput(cw) {
    const inp = blankInp(), ai = G.ai;
    if (G.fired) return inp;
    if (ai.wait > 0) { ai.wait--; return inp; }
    if (!ai.plan) { ai.plan = aiPlan(cw); G.weapon = ai.plan.w; return inp; }
    const p = ai.plan;
    if (cw.facing !== p.facing) { cw.facing = p.facing; return inp; }
    if (Math.abs(cw.aim - p.aim) > 0.031) { if (cw.aim < p.aim) inp.u = true; else inp.d = true; return inp; }
    cw.aim = p.aim;
    if (p.w === 2) { inp.f = !G.prevF; return inp; }
    // 목표 충전량까지 누른 뒤 떼기
    const target = Math.max(1, Math.round(p.power * MAX_CHARGE));
    inp.f = G.charge < target;
    if (G.charge === 0 && G.prevF) inp.f = false;
    return inp;
  }

  // ===== 네트워크 상태 =====
  // mode: 'menu' | 'local' | 'ai' | 'host' | 'client'
  const net = { mode: 'menu', peer: null, code: '', players: [], hostConn: null, myTeam: 0, err: '' };
  let view = null, names = [];

  function makeSnap() {
    return {
      t: 's',
      w: G.worms.map(w => [r1(w.x), r1(w.y), w.hp, w.alive ? 1 : 0, w.facing, r2(w.aim), w.team]),
      p: G.proj.map(p => [p.w, r1(p.x), r1(p.y)]),
      c: G.curW, ct: G.cur, wd: G.wind, tm: G.timer, wp: G.weapon, ch: G.charge,
      f: G.fired ? 1 : 0, o: G.over ? 1 : 0, wn: G.winner,
    };
  }
  // 방장이 보낸 상태도 그대로 믿지 않고 형식·범위 검증
  function parseSnap(d) {
    if (!Array.isArray(d.w) || d.w.length > 16 || !Array.isArray(d.p) || d.p.length > 32) return null;
    const nt = Math.max(1, names.length) - 1;
    const worms = [];
    for (const a of d.w) {
      if (!Array.isArray(a) || a.length !== 7) return null;
      worms.push({ x: num(a[0], -400, W + 400, 0), y: num(a[1], -400, H + 400, 0), hp: num(a[2], 0, MAX_HP, 0) | 0,
        alive: a[3] === 1, facing: a[4] === -1 ? -1 : 1, aim: num(a[5], -2, 2, 0), team: num(a[6], 0, nt, 0) | 0 });
    }
    const proj = [];
    for (const a of d.p) {
      if (!Array.isArray(a) || a.length !== 3 || !int(a[0], 0, WEAPONS.length - 1)) return null;
      proj.push({ w: a[0], x: num(a[1], -400, W + 400, 0), y: num(a[2], -400, H + 400, 0) });
    }
    return {
      worms, proj, curW: int(d.c, 0, worms.length - 1) ? d.c : -1, cur: int(d.ct, 0, nt) ? d.ct : 0,
      wind: num(d.wd, -1, 1, 0), timer: num(d.tm, 0, TURN_TICKS, 0), weapon: int(d.wp, 0, WEAPONS.length - 1) ? d.wp : 0,
      charge: num(d.ch, 0, MAX_CHARGE, 0), fired: d.f === 1, over: d.o === 1, winner: int(d.wn, -1, nt) ? d.wn : -1,
    };
  }
  function applyEvent(e, doCarve) {
    if (!Array.isArray(e)) return;
    if (e[0] === 'b' && e.length === 4) {
      const x = num(e[1], -100, W + 100, NaN), y = num(e[2], -100, H + 100, NaN), r = num(e[3], 1, 60, NaN);
      if ([x, y, r].some(Number.isNaN)) return;
      if (doCarve) carve(x, y, r);
      boomFx(x, y, r);
    } else if (e[0] === 'f' && e.length === 5) {
      const v = e.slice(1).map(z => num(z, -100, W + 100, NaN));
      if (!v.some(Number.isNaN)) tracers.push({ v, life: 12 });
    }
  }

  // ----- 방장 -----
  function hostRoom(myName) {
    net.mode = 'host'; net.code = makeCode(); net.myTeam = 0;
    net.players = [{ id: 'host', name: myName, conn: null, inp: blankInp() }];
    const peer = new Peer(ID_PREFIX + net.code, { debug: 0 });
    net.peer = peer;
    show('lobby'); $('roomCode').textContent = '…'; setLobbyMsg('방 만드는 중…');
    peer.on('open', () => { $('roomCode').textContent = net.code; setLobbyMsg(''); renderLobby(); });
    peer.on('error', e => {
      if (e.type === 'unavailable-id') { peer.destroy(); hostRoom(myName); return; }
      setLobbyMsg('연결 오류: ' + (e.type || '알 수 없음'));
    });
    peer.on('connection', conn => onHostConn(conn));
  }
  function onHostConn(conn) {
    // json 직렬화만 허용 (binary 직렬화로 임의 객체 주입 차단)
    if (conn.serialization !== 'json' || G || net.players.length >= MAX_PLAYERS) {
      conn.on('open', () => { try { conn.send({ t: 'rej', r: G ? 'started' : 'full' }); } catch {} setTimeout(() => conn.close(), 300); });
      return;
    }
    const allow = makeLimiter(RATE_PER_SEC);
    let player = null, strikes = 0;
    const timer = setTimeout(() => { if (!player) conn.close(); }, HANDSHAKE_MS);
    conn.on('data', raw => {
      if (!allow()) { if (++strikes > 200) conn.close(); return; }
      const d = checkMsg(raw, MAX_CLIENT_MSG);
      if (!d) { if (++strikes > 20) conn.close(); return; }
      if (!player) {
        if (d.t !== 'hi' || d.v !== NET_VER) { conn.close(); return; }
        if (G || net.players.length >= MAX_PLAYERS) { conn.send({ t: 'rej', r: G ? 'started' : 'full' }); setTimeout(() => conn.close(), 300); return; }
        clearTimeout(timer);
        player = { id: conn.peer, name: cleanName(d.n), conn, inp: blankInp() };
        net.players.push(player);
        conn.send({ t: 'wel' });
        renderLobby(); broadcastLobby();
        return;
      }
      if (d.t === 'i') player.inp = cleanInp(d.k);
      else if (d.t === 'w') selectWeapon(teamOf(player.id), d.i);
    });
    const leave = () => {
      clearTimeout(timer);
      if (!player || player.left) return;
      player.left = true;
      net.players = net.players.filter(p => p !== player);
      if (G) {
        const t = teamOf(player.id);
        if (t >= 0) { G.teams[t].left = true; G.worms.forEach(w => { if (w.team === t) kill(w); }); }
      } else { renderLobby(); broadcastLobby(); }
    };
    conn.on('close', leave);
    conn.on('error', leave);
  }
  const teamOf = id => G ? G.teams.findIndex(t => t.owner === id) : -1;
  function sendAll(msg) { for (const p of net.players) if (p.conn && p.conn.open) { try { p.conn.send(msg); } catch {} } }
  function broadcastLobby() { sendAll({ t: 'lob', p: net.players.map(p => p.name) }); }
  function hostStart() {
    if (net.players.length < 2) { setLobbyMsg('2명 이상이어야 시작할 수 있습니다'); return; }
    const seed = randU32();
    names = net.players.map(p => p.name);
    newGame(net.players.map(p => ({ name: p.name, owner: p.id, ai: false })), seed);
    net.players.forEach((p, i) => { if (p.conn && p.conn.open) p.conn.send({ t: 'go', seed, n: names, you: i }); });
    startPlay();
  }

  // ----- 참가자 -----
  function joinRoom(code, myName) {
    net.mode = 'client';
    const peer = new Peer({ debug: 0 });
    net.peer = peer;
    show('lobby'); $('roomCode').textContent = code; setLobbyMsg('접속 중…');
    peer.on('open', () => {
      const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
      net.hostConn = conn;
      conn.on('open', () => conn.send({ t: 'hi', v: NET_VER, n: myName }));
      conn.on('data', onHostMsg);
      conn.on('close', () => { net.err = '방장과 연결이 끊겼습니다'; if (!view) setLobbyMsg(net.err); });
    });
    peer.on('error', e => setLobbyMsg(e.type === 'peer-unavailable' ? '방을 찾을 수 없습니다. 코드를 확인하세요' : '연결 오류: ' + (e.type || '알 수 없음')));
  }
  function onHostMsg(raw) {
    const d = checkMsg(raw, MAX_HOST_MSG);
    if (!d) return;
    switch (d.t) {
      case 'wel': setLobbyMsg('방장이 시작하기를 기다리는 중…'); break;
      case 'rej': setLobbyMsg(d.r === 'started' ? '이미 시작된 방입니다' : '방이 가득 찼습니다 (최대 4명)'); break;
      case 'lob':
        if (Array.isArray(d.p) && d.p.length <= MAX_PLAYERS) { net.players = d.p.map(n => ({ name: cleanName(n) })); renderLobby(); }
        break;
      case 'go':
        if (view || !int(d.seed, 0, 0xffffffff) || !Array.isArray(d.n) || d.n.length < 2 || d.n.length > MAX_PLAYERS || !int(d.you, 0, d.n.length - 1)) return;
        names = d.n.map(n => cleanName(n)); net.myTeam = d.you;
        genTerrain(d.seed);
        startPlay();
        break;
      case 's': { if (net.mode !== 'client' || !tImg) return; const v = parseSnap(d); if (v) view = v; break; }
      case 'e': if (tImg && Array.isArray(d.l) && d.l.length <= 64) d.l.forEach(e => applyEvent(e, true)); break;
    }
  }

  // ===== 입력 =====
  const kb = blankInp();
  const KEYMAP = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd', Enter: 'j', Space: 'f' };
  function sendKb() { if (net.mode === 'client' && net.hostConn && net.hostConn.open) net.hostConn.send({ t: 'i', k: kb }); }
  window.addEventListener('keydown', e => {
    if (!playing) return;
    if ((view && view.over || net.err) && e.code === 'KeyR') { location.reload(); return; }
    const k = KEYMAP[e.code];
    if (k) { e.preventDefault(); if (!kb[k]) { kb[k] = true; sendKb(); } return; }
    const m = /^Digit([1-3])$/.exec(e.code);
    if (m) {
      const i = +m[1] - 1;
      if (net.mode === 'client') { if (net.hostConn && net.hostConn.open) net.hostConn.send({ t: 'w', i }); }
      else selectWeapon(net.mode === 'local' ? G.cur : 0, i);
    }
  });
  window.addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k && kb[k]) { kb[k] = false; sendKb(); } });
  window.addEventListener('blur', () => { Object.keys(kb).forEach(k => { kb[k] = false; }); sendKb(); });

  function inputForCurrent() {
    if (net.mode !== 'host') return G.teams[G.cur].ai ? blankInp() : kb;
    const owner = G.teams[G.cur].owner;
    if (owner === 'host') return kb;
    const p = net.players.find(q => q.id === owner);
    return p ? p.inp : blankInp();
  }

  // ===== 효과 =====
  let parts = [], tracers = [];
  function boomFx(x, y, r) {
    for (let i = 0; i < r; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * 4;
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, life: 30 + Math.random() * 20, c: i % 3 ? '#ffb347' : '#fff3c4' });
    }
    parts.push({ x, y, vx: 0, vy: 0, life: 10, ring: r });
  }

  // ===== 렌더 =====
  const cv = $('cv'), ctx = cv.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1b2a4a'); sky.addColorStop(1, '#4a6a8f');
  const teamName = i => names[i] || `팀 ${i + 1}`;

  function render(v) {
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(tCan, 0, 0);
    if (!v) return;
    const cw = v.worms[v.curW];
    // 웜
    v.worms.forEach(w => {
      if (!w.alive) {
        if (w.y < WATER_Y) { ctx.fillStyle = '#8c94a6'; ctx.fillRect(w.x - 4, w.y - 8, 8, 14); ctx.fillRect(w.x - 7, w.y - 4, 14, 4); }
        return;
      }
      ctx.fillStyle = COLORS[w.team];
      ctx.beginPath(); ctx.ellipse(w.x, w.y, R, R + 1, 0, 0, Math.PI * 2); ctx.fill();
      if (w === cw) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(w.x + w.facing * 3, w.y - 3, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(w.x + w.facing * 3.8, w.y - 3, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = COLORS[w.team]; ctx.fillText(String(w.hp), w.x, w.y - 14);
    });
    // 현재 웜 표시·조준
    if (cw && cw.alive && !v.over) {
      const bob = Math.sin(performance.now() / 150) * 3;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.moveTo(cw.x - 6, cw.y - 34 + bob); ctx.lineTo(cw.x + 6, cw.y - 34 + bob); ctx.lineTo(cw.x, cw.y - 26 + bob); ctx.fill();
      if (!v.fired && v.timer > 0) {
        const dx = Math.cos(cw.aim) * cw.facing, dy = -Math.sin(cw.aim);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cw.x + dx * 40, cw.y + dy * 40, 5, 0, Math.PI * 2); ctx.stroke();
        if (v.charge > 0) {
          const L = 12 + v.charge / MAX_CHARGE * 60;
          ctx.strokeStyle = `hsl(${60 - v.charge}, 100%, 55%)`; ctx.lineWidth = 5;
          ctx.beginPath(); ctx.moveTo(cw.x + dx * 12, cw.y + dy * 12); ctx.lineTo(cw.x + dx * L, cw.y + dy * L); ctx.stroke();
        }
      }
    }
    // 포탄
    v.proj.forEach(p => {
      ctx.fillStyle = p.w === 1 ? '#2d7a2d' : '#222';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.w === 1 ? 4 : 3.5, 0, Math.PI * 2); ctx.fill();
    });
    // 효과
    tracers = tracers.filter(t => t.life-- > 0);
    tracers.forEach(t => { ctx.strokeStyle = `rgba(255,240,180,${t.life / 12})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(t.v[0], t.v[1]); ctx.lineTo(t.v[2], t.v[3]); ctx.stroke(); });
    parts = parts.filter(p => p.life-- > 0);
    parts.forEach(p => {
      if (p.ring) { ctx.strokeStyle = `rgba(255,220,150,${p.life / 10})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, p.ring * (1.6 - p.life / 16), 0, Math.PI * 2); ctx.stroke(); return; }
      p.x += p.vx; p.y += p.vy; p.vy += 0.12;
      ctx.fillStyle = p.c; ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    });
    // 물
    const t = performance.now() / 400;
    ctx.fillStyle = 'rgba(40,110,200,0.85)';
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 20) ctx.lineTo(x, WATER_Y + Math.sin(x / 40 + t) * 3);
    ctx.lineTo(W, H); ctx.fill();
    drawHud(v);
  }
  function drawHud(v) {
    ctx.textAlign = 'left'; ctx.font = 'bold 18px sans-serif';
    // 차례·시간
    const myTurn = (net.mode === 'host' || net.mode === 'client') && v.cur === net.myTeam;
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(W / 2 - 170, 8, 340, 58);
    ctx.textAlign = 'center'; ctx.fillStyle = COLORS[v.cur];
    ctx.fillText(myTurn ? '내 차례!' : `${teamName(v.cur)} 차례`, W / 2, 32);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`${Math.ceil(v.timer / 60)}초`, W / 2 - 110, 56);
    // 바람
    ctx.fillText('바람', W / 2 + 10, 56);
    ctx.fillStyle = '#9fd3ff'; const bw = v.wind * 60;
    ctx.fillRect(W / 2 + 90 + Math.min(0, bw), 47, Math.abs(bw), 8);
    ctx.fillStyle = '#fff'; ctx.fillRect(W / 2 + 89, 44, 2, 14);
    // 무기
    ctx.textAlign = 'right'; ctx.font = 'bold 15px sans-serif';
    WEAPONS.forEach((wp, i) => {
      ctx.fillStyle = i === v.weapon ? '#ff7a1a' : 'rgba(255,255,255,0.6)';
      ctx.fillText(`${i + 1} ${wp.name}`, W - 16, 28 + i * 20);
    });
    // 팀 체력
    ctx.textAlign = 'left'; ctx.font = 'bold 14px sans-serif';
    const n = Math.max(names.length, ...v.worms.map(w => w.team + 1));
    for (let i = 0; i < n; i++) {
      const hp = v.worms.filter(w => w.team === i).reduce((s, w) => s + w.hp, 0);
      const y = 20 + i * 22;
      ctx.fillStyle = '#fff'; ctx.fillText(teamName(i), 12, y + 11);
      ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(120, y, 120, 12);
      ctx.fillStyle = COLORS[i]; ctx.fillRect(120, y, 120 * hp / (MAX_HP * WORMS_PER_TEAM), 12);
    }
    // 종료·오류
    const msg = v.over ? (v.winner >= 0 ? `${teamName(v.winner)} 승리!` : '무승부') : net.err;
    if (msg) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, H / 2 - 60, W, 120);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif';
      ctx.fillText(msg, W / 2, H / 2 + 5);
      ctx.font = '18px sans-serif'; ctx.fillText('R 키를 누르면 메뉴로 돌아갑니다', W / 2, H / 2 + 40);
    }
  }

  // ===== 루프 =====
  let playing = false, acc = 0, last = 0;
  function startPlay() {
    playing = true; show('cv');
    last = performance.now();
    requestAnimationFrame(loop);
  }
  function loop(now) {
    acc = Math.min(acc + now - last, 250); last = now;
    if (net.mode !== 'client') {
      while (acc >= 1000 / 60) {
        acc -= 1000 / 60;
        step(inputForCurrent());
        if (net.mode === 'host') {
          if (G.ev.length) sendAll({ t: 'e', l: G.ev });
          if (G.tick % SNAP_EVERY === 0) sendAll(makeSnap());
        }
        G.ev = [];
      }
      view = parseSnap(makeSnap());
    }
    render(view);
    requestAnimationFrame(loop);
  }

  // ===== 화면 =====
  function show(id) { ['menu', 'lobby', 'cv'].forEach(s => $(s).classList.toggle('hidden', s !== id)); }
  const setMsg = s => { $('msg').textContent = s; };
  const setLobbyMsg = s => { $('lobbyMsg').textContent = s; };
  function renderLobby() {
    const ul = $('players');
    ul.replaceChildren(...net.players.map((p, i) => {
      const li = document.createElement('li');
      li.style.borderLeftColor = COLORS[i];
      li.textContent = p.name + (i === 0 ? ' (방장)' : '');
      return li;
    }));
    $('btnStart').classList.toggle('hidden', net.mode !== 'host');
    $('btnStart').disabled = net.players.length < 2;
  }
  const myName = () => {
    const n = cleanName($('name').value, '');
    try { if (n) localStorage.setItem('worms.name', n); } catch {}
    return n || '플레이어';
  };
  try { $('name').value = localStorage.getItem('worms.name') || ''; } catch {}
  const hasPeer = () => { if (typeof Peer === 'function') return true; setMsg('통신 라이브러리를 불러오지 못했습니다'); return false; };

  $('btnAi').onclick = () => {
    const n = +$('aiCount').value, level = +$('aiLevel').value;
    names = [myName(), ...Array.from({ length: n }, (_, i) => `AI ${i + 1}`)];
    net.mode = 'ai'; net.myTeam = 0;
    newGame(names.map((nm, i) => ({ name: nm, ai: i > 0, level })), randU32());
    startPlay();
  };
  $('btnLocal').onclick = () => {
    const n = +$('localTeams').value;
    names = Array.from({ length: n }, (_, i) => `팀 ${i + 1}`);
    net.mode = 'local';
    newGame(names.map(nm => ({ name: nm, ai: false })), randU32());
    startPlay();
  };
  $('btnHost').onclick = () => { if (hasPeer()) hostRoom(myName()); };
  $('btnJoin').onclick = () => {
    const code = $('code').value.trim().toUpperCase();
    if (!new RegExp(`^[${CODE_ABC}]{${CODE_LEN}}$`).test(code)) { setMsg('방 코드 6자리를 정확히 입력하세요'); return; }
    if (hasPeer()) joinRoom(code, myName());
  };
  $('btnStart').onclick = hostStart;
  $('btnCopy').onclick = () => { navigator.clipboard?.writeText(net.code).catch(() => {}); };
  $('btnLeave').onclick = () => location.reload();
  window.addEventListener('beforeunload', () => { if (net.peer) net.peer.destroy(); });

})();
