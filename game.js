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
  const NET_VER = 2, ID_PREFIX = 'wormsweb-v2-';
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
  function hash01(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const gx = x / s, gy = y / s, ix = Math.floor(gx), iy = Math.floor(gy);
    let fx = gx - ix, fy = gy - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash01(ix, iy), b = hash01(ix + 1, iy), c = hash01(ix, iy + 1), d = hash01(ix + 1, iy + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }
  // 지형 픽셀 색: 표면에서의 깊이에 따라 풀 → 흙 경계 → 흙(깊을수록 어둡게) + 바위 무늬 + 동굴 벽 음영
  function paint(x0, y0, x1, y1) {
    x0 = clamp(x0 | 0, 0, W); x1 = clamp(x1 | 0, 0, W); y0 = clamp(y0 | 0, 0, H); y1 = clamp(y1 | 0, 0, H);
    if (x1 <= x0 || y1 <= y0) return;
    const d = tImg.data;
    for (let x = x0; x < x1; x++) {
      const bladeH = hash01(x, 3) > 0.3 ? 2 + (hash01(x, 7) * 5 | 0) : 0;
      const grassD = 5 + (hash01(x, 11) * 3 | 0);
      let depth = 0;
      for (let y = Math.max(0, y0 - 60); y < y0; y++) depth = terrain[y * W + x] ? depth + 1 : 0;
      for (let y = y0; y < y1; y++) {
        const i = y * W + x, p = i * 4;
        if (!terrain[i]) {
          depth = 0;
          let k = 1;
          while (k <= bladeH && y + k < H && !terrain[(y + k) * W + x]) k++;
          if (k <= bladeH && y + k < H) {
            const t = k / bladeH;
            d[p] = 70 + t * 40; d[p + 1] = 150 + t * 60; d[p + 2] = 50; d[p + 3] = 200 + t * 55;
          } else d[p + 3] = 0;
          continue;
        }
        depth++;
        const n = hash01(x, y);
        let r, g, b;
        if (depth <= grassD) {
          const t = depth / grassD;
          r = 96 - t * 40 + n * 18; g = 196 - t * 60 + n * 22; b = 64 - t * 20;
          if (depth === 1) { r += 40; g += 40; b += 30; }
        } else if (depth <= grassD + 2) { r = 62; g = 40; b = 22; }
        else {
          const rock = vnoise(x, y, 22) * 0.7 + vnoise(x, y, 9) * 0.3, fine = vnoise(x, y, 4);
          const dark = 1 - Math.min(depth, 180) / 180 * 0.45;
          const strata = Math.sin(y * 0.18 + vnoise(x, y, 40) * 8) * 7;
          if (rock > 0.74) {
            const e = (rock - 0.74) * 4;
            r = 120 + fine * 30 - e * 30; g = 112 + fine * 28 - e * 30; b = 108 + fine * 26 - e * 26;
          } else {
            r = 132 + strata + fine * 24; g = 88 + strata * 0.7 + fine * 16; b = 54 + fine * 10;
            if (n > 0.985) { r += 50; g += 40; b += 30; }
          }
          r = r * dark + n * 10; g = g * dark + n * 8; b = b * dark + n * 6;
        }
        // 옆·아래가 비어 있으면(동굴 벽·절벽) 테두리를 어둡게
        if (!solidAt(x - 1, y) || !solidAt(x + 1, y) || !solidAt(x, y + 1)) { r *= 0.55; g *= 0.55; b *= 0.55; }
        else if (depth > grassD && (!solidAt(x - 3, y) || !solidAt(x + 3, y) || !solidAt(x, y + 3))) { r *= 0.78; g *= 0.78; b *= 0.78; }
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
    }
    tCtx.putImageData(tImg, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
  function carve(cx, cy, r) { carveRaw(cx, cy, r); paint(cx - r - 6, cy - r - 8, cx + r + 6, cy + r + 14); }
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
    genBackground(seed);
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
      p: G.proj.map(p => [p.w, r1(p.x), r1(p.y), r1(p.vx), r1(p.vy)]),
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
      if (!Array.isArray(a) || a.length !== 5 || !int(a[0], 0, WEAPONS.length - 1)) return null;
      proj.push({ w: a[0], x: num(a[1], -400, W + 400, 0), y: num(a[2], -400, H + 400, 0), vx: num(a[3], -30, 30, 0), vy: num(a[4], -30, 30, 0) });
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
  let parts = [], tracers = [], shake = 0, flashA = 0;
  const rand = (a, b) => a + Math.random() * (b - a);
  function boomFx(x, y, r) {
    shake = Math.min(16, shake + r * 0.35);
    flashA = Math.min(0.45, flashA + r / 140);
    parts.push({ k: 'flash', x, y, r: r * 2.4, life: 10, max: 10 });
    parts.push({ k: 'ring', x, y, r, life: 16, max: 16 });
    for (let i = 0; i < r * 0.9; i++) {
      const a = rand(0, 6.283), s = rand(0.4, 3.2), o = rand(0, r * 0.45);
      parts.push({ k: 'fire', x: x + Math.cos(a) * o, y: y + Math.sin(a) * o, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.7, size: rand(r * 0.22, r * 0.5), life: rand(18, 34), max: 34 });
    }
    for (let i = 0; i < r * 0.5; i++) parts.push({ k: 'smoke', x: x + rand(-r / 2, r / 2), y: y + rand(-r / 2, r / 3), vx: rand(-0.6, 0.6), vy: rand(-1.1, -0.3), size: rand(r * 0.3, r * 0.6), life: rand(50, 95), max: 95 });
    for (let i = 0; i < r * 0.8; i++) {
      const a = rand(Math.PI * 1.05, Math.PI * 1.95), s = rand(2, 6.5);
      parts.push({ k: 'debris', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: rand(1.5, 3.8), rot: rand(0, 6), life: rand(40, 75), max: 75, c: ['#5c3a20', '#8a5a34', '#6f8f3a', '#77706a'][i % 4] });
    }
    for (let i = 0; i < 16; i++) { const a = rand(0, 6.283), s = rand(3, 9); parts.push({ k: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(10, 24), max: 24 }); }
  }
  function splashFx(x) {
    for (let i = 0; i < 26; i++) parts.push({ k: 'drop', x: x + rand(-8, 8), y: WATER_Y, vx: rand(-2, 2), vy: rand(-6, -2), size: rand(1.5, 3), life: rand(30, 50), max: 50 });
  }
  function textFx(x, y, s, c) { parts.push({ k: 'text', x, y, s, c, vy: -0.6, life: 80, max: 80 }); }
  function fireColor(t) { return t > 0.75 ? '#fff4c4' : t > 0.5 ? '#ffc743' : t > 0.3 ? '#ff7a1f' : '#b4321a'; }

  function updateDrawParts() {
    parts = parts.filter(p => p.life-- > 0);
    for (const p of parts) {
      const t = p.life / p.max;
      switch (p.k) {
        case 'flash': {
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          g.addColorStop(0, `rgba(255,240,200,${0.9 * t})`); g.addColorStop(0.4, `rgba(255,160,60,${0.5 * t})`); g.addColorStop(1, 'rgba(255,100,0,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
          ctx.globalCompositeOperation = 'source-over'; break;
        }
        case 'ring':
          ctx.strokeStyle = `rgba(255,235,190,${t * 0.8})`; ctx.lineWidth = 4 * t + 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.9 - t), 0, 6.283); ctx.stroke(); break;
        case 'fire':
          p.x += p.vx; p.y += p.vy; p.vx *= 0.92; p.vy = p.vy * 0.92 - 0.05;
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = fireColor(t); ctx.globalAlpha = Math.min(1, t * 1.6);
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + t * 0.6), 0, 6.283); ctx.fill();
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; break;
        case 'smoke':
          p.x += p.vx + (view ? view.wind * 0.3 : 0); p.y += p.vy; p.vy *= 0.985;
          ctx.fillStyle = `rgba(60,58,64,${0.38 * t})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - t * 0.6), 0, 6.283); ctx.fill(); break;
        case 'trail':
          p.x += p.vx; p.y += p.vy; p.size += 0.12;
          ctx.fillStyle = `rgba(210,210,215,${0.35 * t})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.283); ctx.fill(); break;
        case 'debris':
          p.vy += 0.22; p.x += p.vx; p.y += p.vy; p.rot += p.vx * 0.1;
          if (solidAt(p.x, p.y + 1)) { p.vx *= 0.5; p.vy = -p.vy * 0.3; }
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, t * 2);
          ctx.fillStyle = p.c; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
          ctx.restore(); break;
        case 'spark':
          p.vy += 0.15; p.x += p.vx; p.y += p.vy; p.vx *= 0.95;
          ctx.strokeStyle = `rgba(255,220,120,${t})`; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 1.8, p.y - p.vy * 1.8); ctx.stroke(); break;
        case 'drop':
          p.vy += 0.25; p.x += p.vx; p.y += p.vy;
          ctx.fillStyle = `rgba(170,215,255,${t})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.283); ctx.fill(); break;
        case 'text':
          p.y += p.vy; p.vy *= 0.98;
          ctx.globalAlpha = Math.min(1, t * 2.5);
          ctx.font = `900 22px ${FONT}`; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.strokeText(p.s, p.x, p.y); ctx.fillStyle = p.c; ctx.fillText(p.s, p.x, p.y);
          ctx.globalAlpha = 1; break;
      }
    }
  }

  // ===== 배경 (게임마다 seed로 한 번 그려 둠) =====
  const FONT = '"Pretendard","Malgun Gothic",system-ui,sans-serif';
  const bgCan = document.createElement('canvas'); bgCan.width = W; bgCan.height = H;
  let clouds = [];
  function genBackground(seed) {
    const g = bgCan.getContext('2d'), rnd = mulberry32(seed ^ 0x51ed27);
    const sk = g.createLinearGradient(0, 0, 0, H);
    sk.addColorStop(0, '#0b1433'); sk.addColorStop(0.38, '#2d3f7a'); sk.addColorStop(0.68, '#b06a7a'); sk.addColorStop(0.85, '#f09a6a'); sk.addColorStop(1, '#ffd08a');
    g.fillStyle = sk; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 160; i++) {
      const y = rnd() * H * 0.45;
      g.fillStyle = `rgba(255,255,255,${(1 - y / (H * 0.45)) * rnd() * 0.9})`;
      const s = rnd() < 0.1 ? 2 : 1.2; g.fillRect(rnd() * W, y, s, s);
    }
    const sx = W * (0.2 + rnd() * 0.6), sy = H * 0.6;
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 320);
    glow.addColorStop(0, 'rgba(255,230,170,0.9)'); glow.addColorStop(0.18, 'rgba(255,190,120,0.45)'); glow.addColorStop(1, 'rgba(255,150,100,0)');
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff1c9'; g.beginPath(); g.arc(sx, sy, 46, 0, 6.283); g.fill();
    const layers = [
      { base: 0.5, amp: 130, f: 0.004, top: '#6a5a8f', bot: '#8a6a8a' },
      { base: 0.6, amp: 100, f: 0.006, top: '#47406e', bot: '#6a4f72' },
      { base: 0.7, amp: 70, f: 0.009, top: '#2c2a4e', bot: '#40365a' },
    ];
    for (const L of layers) {
      const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
      const grad = g.createLinearGradient(0, H * L.base - L.amp, 0, H);
      grad.addColorStop(0, L.top); grad.addColorStop(1, L.bot);
      g.fillStyle = grad; g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W; x += 6) {
        const y = H * L.base - Math.abs(Math.sin(x * L.f + ph[0])) * L.amp * 0.7 - Math.sin(x * L.f * 2.7 + ph[1]) * L.amp * 0.2 - Math.sin(x * L.f * 7 + ph[2]) * L.amp * 0.06;
        g.lineTo(x, y);
      }
      g.lineTo(W, H); g.fill();
    }
    const haze = g.createLinearGradient(0, H * 0.55, 0, H);
    haze.addColorStop(0, 'rgba(255,190,150,0)'); haze.addColorStop(1, 'rgba(255,190,150,0.25)');
    g.fillStyle = haze; g.fillRect(0, 0, W, H);
    clouds = Array.from({ length: 7 }, () => makeCloud(rnd));
  }
  function makeCloud(rnd) {
    const c = document.createElement('canvas'), w = 220 + rnd() * 160, h = 90;
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    for (let i = 0; i < 9; i++) {
      const x = 40 + rnd() * (w - 80), y = 40 + rnd() * 25, r = 20 + rnd() * 26;
      const gr = g.createRadialGradient(x, y - r * 0.3, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,240,235,0.55)'); gr.addColorStop(1, 'rgba(255,220,220,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    return { img: c, x: rnd() * W, y: 30 + rnd() * 260, sp: 0.05 + rnd() * 0.15, a: 0.5 + rnd() * 0.5 };
  }

  // ===== 렌더 =====
  // 고해상도 화면에서도 선명하게 (내부 좌표는 W×H 유지)
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const cv = $('cv'), ctx = cv.getContext('2d');
  cv.width = W * DPR; cv.height = H * DPR;
  const teamName = i => names[i] || `팀 ${i + 1}`;
  let anim = [], prevW = null;
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function panel(x, y, w, h, r = 12) {
    rr(x, y, w, h, r);
    ctx.fillStyle = 'rgba(10,14,30,0.62)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1; ctx.stroke();
  }

  // 무기 그림 (원점 = 손, +x 방향 = 총구)
  function drawWeapon(kind) {
    ctx.lineJoin = 'round';
    if (kind === 0) {           // 바주카
      const g = ctx.createLinearGradient(0, -4, 0, 4);
      g.addColorStop(0, '#9aae5a'); g.addColorStop(0.5, '#5f7330'); g.addColorStop(1, '#3a4a1c');
      ctx.fillStyle = g; ctx.strokeStyle = '#1e2610'; ctx.lineWidth = 1.2;
      rr(-12, -3.8, 30, 7.6, 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#2b3416'; ctx.fillRect(-6, -4.2, 2.2, 8.4); ctx.fillRect(9, -4.2, 2.2, 8.4);
      ctx.fillStyle = '#1a1f10'; ctx.beginPath(); ctx.ellipse(18, 0, 1.6, 3.8, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#3a4a1c'; ctx.beginPath(); ctx.moveTo(-12, -3.8); ctx.lineTo(-16, -5.5); ctx.lineTo(-16, 5.5); ctx.lineTo(-12, 3.8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#333'; ctx.fillRect(1, 3.5, 2.5, 4.5);
    } else if (kind === 1) {    // 수류탄
      drawGrenade(6, 0, 0, 1);
    } else {                    // 샷건
      ctx.fillStyle = '#7a4a24'; ctx.strokeStyle = '#2a1608'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-10, -1); ctx.lineTo(-1, -2.5); ctx.lineTo(1, 2.5); ctx.lineTo(-9, 5); ctx.closePath(); ctx.fill(); ctx.stroke();
      const g = ctx.createLinearGradient(0, -3, 0, 2);
      g.addColorStop(0, '#9aa0aa'); g.addColorStop(1, '#3a3e46');
      ctx.fillStyle = g; rr(-1, -3, 22, 3.2, 1); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#5a3418'; rr(3, 0, 9, 3, 1.2); ctx.fill();
    }
  }
  function drawGrenade(x, y, rot, s) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
    const g = ctx.createRadialGradient(-1.5, -1.5, 0.5, 0, 0, 6);
    g.addColorStop(0, '#9fd27a'); g.addColorStop(0.6, '#3d7a2a'); g.addColorStop(1, '#1d3f12');
    ctx.fillStyle = g; ctx.strokeStyle = '#0f2208'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 1, 4.6, 5.4, 0, 0, 6.283); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.moveTo(-4.4, 1); ctx.lineTo(4.4, 1); ctx.moveTo(0, -4.2); ctx.lineTo(0, 6.2); ctx.stroke();
    ctx.fillStyle = '#9aa0a8'; ctx.fillRect(-2, -6.2, 4, 2.4);
    ctx.strokeStyle = '#c8ccd2'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(3.5, -6, 2, 0, 6.283); ctx.stroke();
    ctx.restore();
  }
  function drawRocket(p) {
    const ang = Math.atan2(p.vy, p.vx);
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(ang);
    ctx.globalCompositeOperation = 'lighter';
    const fl = 8 + Math.random() * 6;
    const fg = ctx.createLinearGradient(-6 - fl, 0, -6, 0);
    fg.addColorStop(0, 'rgba(255,80,0,0)'); fg.addColorStop(1, 'rgba(255,230,140,0.95)');
    ctx.fillStyle = fg; ctx.beginPath(); ctx.moveTo(-6, -2.5); ctx.lineTo(-6 - fl, 0); ctx.lineTo(-6, 2.5); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createLinearGradient(0, -3, 0, 3);
    g.addColorStop(0, '#e8e8ec'); g.addColorStop(1, '#7c8090');
    ctx.fillStyle = g; ctx.strokeStyle = '#2a2c34'; ctx.lineWidth = 0.8;
    rr(-6, -2.6, 11, 5.2, 1.5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d93a2a'; ctx.beginPath(); ctx.moveTo(5, -2.6); ctx.quadraticCurveTo(10, 0, 5, 2.6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d93a2a'; ctx.beginPath(); ctx.moveTo(-6, -2.6); ctx.lineTo(-9, -5); ctx.lineTo(-3, -2.6); ctx.moveTo(-6, 2.6); ctx.lineTo(-9, 5); ctx.lineTo(-3, 2.6); ctx.fill();
    ctx.restore();
    parts.push({ k: 'trail', x: p.x - Math.cos(ang) * 8, y: p.y - Math.sin(ang) * 8, vx: rand(-0.2, 0.2), vy: rand(-0.4, 0), size: rand(1.5, 3), life: 40, max: 40 });
  }

  // 지렁이 (원점 = 몸 중심, 오른쪽을 보는 기준으로 그리고 facing으로 뒤집음)
  function drawWorm(w, i, isCur, v, now) {
    const a = anim[i] || (anim[i] = { px: w.x, walk: 0, blink: rand(60, 260), shut: 0, ph: rand(0, 6) });
    const moved = Math.abs(w.x - a.px); a.px = w.x;
    if (moved > 0.15 && moved < 6) a.walk += moved * 0.45;
    if (--a.blink < 0) { a.shut = 7; a.blink = rand(90, 300); }
    if (a.shut > 0) a.shut--;
    const breathe = Math.sin(now / 320 + a.ph) * 0.7, wig = Math.sin(a.walk) * 1.8;
    const team = COLORS[w.team];
    ctx.save(); ctx.translate(w.x, w.y + 1); ctx.scale(w.facing, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(-1, 7.2, 10, 2.2, 0, 0, 6.283); ctx.fill();
    // 몸통
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const body = () => { ctx.beginPath(); ctx.moveTo(-10 + wig * 0.4, 5.5); ctx.quadraticCurveTo(-3 + wig, 6.5, 1, -1.5 - breathe); };
    body(); ctx.strokeStyle = '#5a2232'; ctx.lineWidth = 12; ctx.stroke();
    body(); ctx.strokeStyle = '#ee8ea2'; ctx.lineWidth = 9.6; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-9 + wig * 0.4, 3.4); ctx.quadraticCurveTo(-3 + wig, 3.8, -0.5, -3 - breathe);
    ctx.strokeStyle = 'rgba(255,220,228,0.55)'; ctx.lineWidth = 2.6; ctx.stroke();
    ctx.strokeStyle = 'rgba(150,60,80,0.45)'; ctx.lineWidth = 1;
    for (const s of [-6.5, -3.5]) { ctx.beginPath(); ctx.moveTo(s + wig * 0.6, 1.5); ctx.lineTo(s + 1 + wig * 0.6, 8.5); ctx.stroke(); }
    // 머리
    const hx = 2.5, hy = -7 - breathe;
    const hg = ctx.createRadialGradient(hx + 1.5, hy - 2.5, 1, hx, hy, 7.5);
    hg.addColorStop(0, '#ffd3dc'); hg.addColorStop(0.55, '#f095a8'); hg.addColorStop(1, '#c86078');
    ctx.fillStyle = hg; ctx.strokeStyle = '#5a2232'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(hx, hy, 7, 0, 6.283); ctx.fill(); ctx.stroke();
    // 팀 머리띠
    ctx.strokeStyle = team; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(hx, hy, 6.4, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(hx - 6, hy - 3); ctx.quadraticCurveTo(hx - 11, hy - 6 + wig * 0.5, hx - 13, hy - 2);
    ctx.moveTo(hx - 6, hy - 3); ctx.quadraticCurveTo(hx - 10, hy - 1, hx - 12, hy + 2 + wig * 0.4);
    ctx.stroke();
    // 눈 (조준 방향을 봄)
    const look = isCur && !v.over ? [Math.cos(w.aim) * 1.3, -Math.sin(w.aim) * 1.3] : [1, 0.2];
    for (const ex of [hx + 1.4, hx + 5]) {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#5a2232'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.ellipse(ex, hy - 1.2, 2.3, a.shut ? 0.5 : 3, 0, 0, 6.283); ctx.fill(); ctx.stroke();
      if (!a.shut) { ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(ex + look[0], hy - 1.2 + look[1], 1.25, 0, 6.283); ctx.fill(); }
    }
    ctx.strokeStyle = '#5a2232'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(hx + 4.2, hy + 2.8, 1.8, 0.2, Math.PI - 0.6); ctx.stroke();
    // 들고 있는 무기
    if (isCur && !v.fired && v.timer > 0 && !v.over) {
      ctx.save(); ctx.translate(hx + 1, hy + 7.5); ctx.rotate(-w.aim); drawWeapon(v.weapon); ctx.restore();
    }
    ctx.restore();
    // 체력 배지
    const label = String(w.hp);
    ctx.font = `800 11px ${FONT}`; ctx.textAlign = 'center';
    const bw = ctx.measureText(label).width + 10, by = w.y - 30;
    rr(w.x - bw / 2, by - 10, bw, 14, 4);
    ctx.fillStyle = 'rgba(10,12,24,0.7)'; ctx.fill(); ctx.strokeStyle = team; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillText(label, w.x, by + 1);
  }
  function drawGrave(w) {
    ctx.save(); ctx.translate(w.x, w.y + 2);
    const g = ctx.createLinearGradient(-7, 0, 7, 0);
    g.addColorStop(0, '#c9cfdb'); g.addColorStop(1, '#7c8496');
    ctx.fillStyle = g; ctx.strokeStyle = '#3a3f4c'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-7, 6); ctx.lineTo(-7, -5); ctx.arc(0, -5, 7, Math.PI, 0); ctx.lineTo(7, 6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#4a5060'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(0, 1); ctx.moveTo(-3.5, -5.5); ctx.lineTo(3.5, -5.5); ctx.stroke();
    ctx.fillStyle = COLORS[w.team]; ctx.fillRect(-7, 4, 14, 2);
    ctx.restore();
  }
  function drawWater(now, front) {
    const t = now / 700;
    if (!front) {
      ctx.fillStyle = 'rgba(28,70,140,0.9)'; ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 16) ctx.lineTo(x, WATER_Y - 6 + Math.sin(x / 55 - t * 1.3) * 4);
      ctx.lineTo(W, H); ctx.fill(); return;
    }
    const g = ctx.createLinearGradient(0, WATER_Y - 6, 0, H);
    g.addColorStop(0, 'rgba(80,170,240,0.78)'); g.addColorStop(1, 'rgba(10,40,100,0.96)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, H);
    const pts = [];
    for (let x = 0; x <= W; x += 12) { const y = WATER_Y + Math.sin(x / 40 + t) * 3 + Math.sin(x / 17 - t * 2) * 1.2; pts.push([x, y]); ctx.lineTo(x, y); }
    ctx.lineTo(W, H); ctx.fill();
    ctx.strokeStyle = 'rgba(230,248,255,0.65)'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
  }

  function render(v) {
    const now = performance.now();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.drawImage(bgCan, 0, 0);
    for (const c of clouds) {
      c.x += c.sp + (v ? v.wind * 0.25 : 0);
      if (c.x > W + 20) c.x = -c.img.width; if (c.x < -c.img.width - 20) c.x = W;
      ctx.globalAlpha = c.a; ctx.drawImage(c.img, c.x, c.y); ctx.globalAlpha = 1;
    }
    if (shake > 0.3) { ctx.translate(rand(-shake, shake), rand(-shake, shake)); shake *= 0.86; } else shake = 0;
    drawWater(now, false);
    ctx.drawImage(tCan, 0, 0);
    if (!v) return;
    // 피해 숫자·물보라 (이전 상태와 비교)
    if (prevW && prevW.length === v.worms.length) {
      v.worms.forEach((w, i) => {
        const p = prevW[i];
        if (w.hp < p.hp) textFx(w.x, w.y - 40, `-${p.hp - w.hp}`, COLORS[w.team]);
        if (p.alive && !w.alive && w.y >= WATER_Y - 12) splashFx(w.x);
      });
    }
    prevW = v.worms.map(w => ({ hp: w.hp, alive: w.alive }));
    const cw = v.worms[v.curW];
    v.worms.forEach((w, i) => { if (!w.alive && w.y < WATER_Y - 5) drawGrave(w); });
    v.worms.forEach((w, i) => { if (w.alive) drawWorm(w, i, w === cw, v, now); });
    // 현재 웜 화살표·조준
    if (cw && cw.alive && !v.over) {
      const bob = Math.sin(now / 160) * 4, ay = cw.y - 66 + bob;
      ctx.fillStyle = COLORS[v.cur]; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cw.x - 8, ay); ctx.lineTo(cw.x + 8, ay); ctx.lineTo(cw.x + 8, ay + 4); ctx.lineTo(cw.x + 13, ay + 4); ctx.lineTo(cw.x, ay + 14); ctx.lineTo(cw.x - 13, ay + 4); ctx.lineTo(cw.x - 8, ay + 4); ctx.closePath();
      ctx.fill(); ctx.stroke();
      if (!v.fired && v.timer > 0) {
        const dx = Math.cos(cw.aim) * cw.facing, dy = -Math.sin(cw.aim);
        const cx = cw.x + dx * 48, cy = cw.y + dy * 48, sp = now / 400;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(sp);
        ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 7, 0, 6.283); ctx.stroke();
        ctx.beginPath(); for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4); ctx.lineTo(Math.cos(a) * 11, Math.sin(a) * 11); } ctx.stroke();
        ctx.restore();
        if (v.charge > 0) {
          const n = Math.ceil(v.charge / MAX_CHARGE * 12);
          for (let k = 0; k < n; k++) {
            const d = 16 + k * 6;
            ctx.fillStyle = `hsl(${55 - k * 5},100%,${60 - k}%)`;
            ctx.beginPath(); ctx.arc(cw.x + dx * d, cw.y + dy * d, 2 + k * 0.35, 0, 6.283); ctx.fill();
          }
        }
      }
    }
    // 포탄
    v.proj.forEach(p => {
      if (p.w === 1) drawGrenade(p.x, p.y, p.x * 0.12, 0.9);
      else drawRocket(p);
    });
    tracers = tracers.filter(t => t.life-- > 0);
    tracers.forEach(t => {
      ctx.strokeStyle = `rgba(255,240,170,${t.life / 12})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(t.v[0], t.v[1]); ctx.lineTo(t.v[2], t.v[3]); ctx.stroke();
      if (t.life === 11) for (let k = 0; k < 6; k++) parts.push({ k: 'spark', x: t.v[0], y: t.v[1], vx: (t.v[2] - t.v[0]) / 60 + rand(-1, 1), vy: (t.v[3] - t.v[1]) / 60 + rand(-1, 1), life: 10, max: 10 });
    });
    updateDrawParts();
    drawWater(now, true);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (flashA > 0.01) { ctx.fillStyle = `rgba(255,240,220,${flashA})`; ctx.fillRect(0, 0, W, H); flashA *= 0.82; }
    drawHud(v, now);
  }

  function drawHud(v, now) {
    const myTurn = (net.mode === 'host' || net.mode === 'client' || net.mode === 'ai') && v.cur === net.myTeam;
    const tc = COLORS[v.cur];
    // 가운데: 타이머·차례·바람
    const px = W / 2 - 210, py = 12;
    panel(px, py, 420, 66, 14);
    const secs = Math.ceil(v.timer / 60), tx = px + 38, ty = py + 33;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(tx, ty, 22, 0, 6.283); ctx.stroke();
    ctx.strokeStyle = secs <= 5 ? '#ff4d4d' : tc; ctx.beginPath(); ctx.arc(tx, ty, 22, -Math.PI / 2, -Math.PI / 2 + 6.283 * v.timer / TURN_TICKS); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `800 18px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(String(secs), tx, ty + 6);
    ctx.textAlign = 'left'; ctx.font = `800 20px ${FONT}`; ctx.fillStyle = tc;
    const label = myTurn ? '내 차례!' : `${teamName(v.cur)} 차례`;
    if (myTurn) { ctx.shadowColor = tc; ctx.shadowBlur = 10 + Math.sin(now / 200) * 6; }
    ctx.fillText(label, px + 74, py + 30); ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.font = `600 13px ${FONT}`;
    ctx.fillText(v.fired ? '발사 완료 · 피하세요!' : `${WEAPONS[v.weapon].name} 준비`, px + 74, py + 52);
    // 바람 게이지
    const wx = px + 300, wy = py + 40;
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('바람', wx, py + 22);
    rr(wx - 60, wy - 5, 120, 10, 5); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
    const bw = v.wind * 58;
    rr(wx + Math.min(0, bw), wy - 5, Math.abs(bw), 10, 5);
    const wg = ctx.createLinearGradient(wx, 0, wx + bw, 0); wg.addColorStop(0, '#7fd0ff'); wg.addColorStop(1, '#e8f7ff');
    ctx.fillStyle = wg; ctx.fill();
    if (Math.abs(v.wind) > 0.05) {
      const dir = Math.sign(v.wind), off = (now / 25) % 12;
      ctx.save(); rr(wx + Math.min(0, bw), wy - 5, Math.abs(bw), 10, 5); ctx.clip();
      ctx.strokeStyle = 'rgba(20,60,110,0.55)'; ctx.lineWidth = 2;
      for (let k = -2; k < 12; k++) { const x = wx + dir * (k * 12 + off); ctx.beginPath(); ctx.moveTo(x - dir * 3, wy - 3); ctx.lineTo(x + dir * 1, wy); ctx.lineTo(x - dir * 3, wy + 3); ctx.stroke(); }
      ctx.restore();
    }
    ctx.fillStyle = '#fff'; ctx.fillRect(wx - 1, wy - 8, 2, 16);
    // 오른쪽: 무기 슬롯
    WEAPONS.forEach((wp, i) => {
      const sx = W - 16 - (WEAPONS.length - i) * 70, sy = 12, sel = i === v.weapon;
      panel(sx, sy, 62, 62, 10);
      if (sel) { rr(sx, sy, 62, 62, 10); ctx.strokeStyle = '#ff8a2a'; ctx.lineWidth = 2.5; ctx.shadowColor = '#ff8a2a'; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0; }
      ctx.save(); ctx.translate(sx + 31, sy + 26); ctx.scale(1.25, 1.25); ctx.rotate(-0.35); drawWeapon(i); ctx.restore();
      ctx.fillStyle = sel ? '#ffb070' : 'rgba(255,255,255,0.7)'; ctx.font = `700 11px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText(`${i + 1} ${wp.name}`, sx + 31, sy + 55);
    });
    // 왼쪽: 팀 체력
    const n = Math.max(names.length, ...v.worms.map(w => w.team + 1));
    panel(12, 12, 260, 16 + n * 26, 12);
    for (let i = 0; i < n; i++) {
      const hp = v.worms.filter(w => w.team === i).reduce((s, w) => s + w.hp, 0);
      const y = 22 + i * 26, out = hp === 0;
      ctx.globalAlpha = out ? 0.4 : 1;
      ctx.fillStyle = COLORS[i]; ctx.beginPath(); ctx.arc(30, y + 8, 6, 0, 6.283); ctx.fill();
      if (i === v.cur && !v.over) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = '#fff'; ctx.font = `700 13px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(teamName(i), 44, y + 13);
      rr(140, y + 2, 92, 12, 6); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
      if (hp > 0) {
        rr(140, y + 2, 92 * hp / (MAX_HP * WORMS_PER_TEAM), 12, 6);
        const g = ctx.createLinearGradient(0, y + 2, 0, y + 14); g.addColorStop(0, '#fff'); g.addColorStop(0.25, COLORS[i]); g.addColorStop(1, COLORS[i]);
        ctx.fillStyle = g; ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `700 11px ${FONT}`; ctx.textAlign = 'right';
      ctx.fillText(String(hp), 262, y + 13);
      ctx.globalAlpha = 1;
    }
    // 종료·오류
    const msg = v.over ? (v.winner >= 0 ? `${teamName(v.winner)} 승리!` : '무승부') : net.err;
    if (msg) {
      const g = ctx.createLinearGradient(0, H / 2 - 80, 0, H / 2 + 80);
      g.addColorStop(0, 'rgba(5,8,20,0)'); g.addColorStop(0.5, 'rgba(5,8,20,0.8)'); g.addColorStop(1, 'rgba(5,8,20,0)');
      ctx.fillStyle = g; ctx.fillRect(0, H / 2 - 80, W, 160);
      const c = v.over && v.winner >= 0 ? COLORS[v.winner] : '#fff';
      ctx.textAlign = 'center'; ctx.font = `900 52px ${FONT}`;
      ctx.shadowColor = c; ctx.shadowBlur = 24; ctx.fillStyle = c; ctx.fillText(msg, W / 2, H / 2 + 8); ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `600 17px ${FONT}`; ctx.fillText('R 키를 누르면 메뉴로 돌아갑니다', W / 2, H / 2 + 44);
    }
  }

  // ===== 루프 =====
  let playing = false, acc = 0, last = 0;
  function startPlay() {
    playing = true; show('cv'); anim = []; prevW = null; parts = [];
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
