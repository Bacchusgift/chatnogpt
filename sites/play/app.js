'use strict';

/* 微光旷野 GLIMMER VALE —— three.js 开放世界（3A 向）。
 *  - 程序化起伏地形（顶点色草地/土路/池塘洼地）
 *  - 手工建模的骨骼小人：走路 / 疾跑 / 跳跃 / 待机呼吸 全套程序动画
 *  - 村庄、路灯、池塘水面、摇曳森林、实例化草丛与花丛、体积云
 *  - 第三人称轨道相机：拖拽旋转 / 滚轮缩放 / 平滑跟随，阴影实时跟随玩家
 *  - NPC = 其他用户：走近按 E 交谈，对方台词打字机输出
 */

const $ = s => document.querySelector(s);

const state = {
  token: localStorage.getItem('gv_token') || '',
  me: null,
  npcs: {},
  nearNpc: null,
  dialogNpc: null,
  keys: {},
  pending: new Set(),
};

const FANTASY = ['艾尔文', '塞拉斯', '莉安娜', '索恩', '米娅', '加雷斯', '奥兰多', '薇拉', '杜兰', '菲奥娜', '卡尔文', '诺拉', '伊桑', '赛琳', '洛基', '艾达'];
const NPC_COLORS = [0x58d6a0, 0x5aa7e6, 0xe6a15a, 0xd977c8, 0xe6d15a, 0x9b8cf0];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

function hashN(s, mod) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % mod;
}

function fantasyName(id) { return FANTASY[hashN(id, FANTASY.length)]; }

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { doLogout(); throw new Error('登出状态失效'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('request failed ' + res.status));
  return data;
}

function doLogout() {
  localStorage.removeItem('gv_token');
  state.token = '';
  location.reload();
}

/* ---------- 开始画面 ---------- */
let regMode = false;
$('#btnRegister').onclick = () => {
  regMode = !regMode;
  $('#btnRegister').textContent = regMode ? '返回登入' : '创建新冒险者';
  $('#btnEnter').textContent = regMode ? '踏入旷野' : '进入旷野';
};

$('#startForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('#startName').value.trim();
  const pass = $('#startPass').value;
  const err = $('#startErr');
  err.textContent = '';
  try {
    const d = regMode
      ? await api('/api/register', { body: { name, password: pass } })
      : await api('/api/login', { body: { name, password: pass } });
    state.token = d.token;
    localStorage.setItem('gv_token', d.token);
    state.me = d.user;
    enterWorld();
  } catch (ex) { err.textContent = ex.message; }
};

/* ============================================================
   地形与名字工具
============================================================ */
const POND = { x: -34, z: 30, r: 12 };
const waterY = -0.9;

function terrainH(x, z) {
  let h = 0;
  h += Math.sin(x * 0.043) * Math.cos(z * 0.05) * 1.5;
  h += Math.sin(x * 0.11 + 1.7) * Math.cos(z * 0.087 + 2.1) * 0.7;
  h += Math.sin((x + z) * 0.021 + 4.2) * 1.9;
  const d = Math.hypot(x, z);
  h *= 0.18 + 0.82 * smoothstep(8, 30, d);           // 村庄附近平坦
  const pd = Math.hypot(x - POND.x, z - POND.z);      // 池塘洼地
  h -= (1 - smoothstep(POND.r * 0.35, POND.r, pd)) * 2.4;
  return h;
}

function groundY(x, z) {
  const pd = Math.hypot(x - POND.x, z - POND.z);
  const t = terrainH(x, z);
  if (pd < POND.r) return Math.max(t, waterY - 0.18); // 涉水不没顶
  return t;
}

// 距离折线（小径）的距离
const PATH = [[0, 6], [0, 14], [-10, 20], [-24, 26], [POND.x, POND.z]];
function distToPath(x, z) {
  let best = 1e9;
  for (let i = 0; i < PATH.length - 1; i++) {
    const [ax, az] = PATH[i], [bx, bz] = PATH[i + 1];
    const vx = bx - ax, vz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
    best = Math.min(best, Math.hypot(x - (ax + vx * t), z - (az + vz * t)));
  }
  return best;
}

/* ============================================================
   three.js 世界
============================================================ */
let scene, camera, renderer, sun, playerRig, water, worldGroup;
const clouds = [], trees = [], lanternLights = [];
const cam = { theta: Math.PI * 0.2, pitch: 0.42, radius: 10.5 };
const vel = { y: 0 };
const playerAnim = { phase: 0, speedBlend: 0 };
let gameReady = false;

const clock = new THREE.Clock();

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.9, metalness: 0 }, opts));
}

function buildSky() {
  const geo = new THREE.SphereGeometry(220, 24, 16);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      top: { value: new THREE.Color(0x4a9fe8) },
      mid: { value: new THREE.Color(0x9fd4e8) },
      bot: { value: new THREE.Color(0xdfeee2) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
      void main(){ float h = normalize(vP).y; vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.72, h)) : mix(bot, mid, smoothstep(-0.18, 0.12, h));
      gl_FragColor = vec4(c, 1.0); }`,
  });
  scene.add(new THREE.Mesh(geo, m));

  // 太阳光晕
  const glow = makeGlowSprite('#fff4d6', 90);
  glow.position.set(80, 95, -110);
  scene.add(glow);

  // 云（多层柔和小精灵）
  for (let i = 0; i < 14; i++) {
    const c = makeGlowSprite('#ffffff', 26 + Math.random() * 30, 0.5 + Math.random() * 0.3);
    c.position.set((Math.random() - 0.5) * 180, 42 + Math.random() * 30, (Math.random() - 0.5) * 180);
    scene.add(c);
    clouds.push({ sp: c, vx: 0.5 + Math.random() });
  }
}

function makeGlowSprite(color, size, alpha = 0.85) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.globalAlpha = alpha;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(size, size, 1);
  return sp;
}

function buildTerrain() {
  const size = 260, seg = 120;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = [];
  const cGrass = new THREE.Color(0x67a552);
  const cGrass2 = new THREE.Color(0x578f47);
  const cDirt = new THREE.Color(0xc4a468);
  const cSand = new THREE.Color(0xd9c893);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainH(x, z);
    pos.setY(i, h);
    const n = Math.sin(x * 0.3) * Math.cos(z * 0.27);
    tmp.copy(n > 0 ? cGrass : cGrass2);
    const pd = distToPath(x, z);
    if (pd < 2.2) tmp.lerp(cDirt, smoothstep(2.2, 0.9, pd) * 0.9);
    const pw = Math.hypot(x - POND.x, z - POND.z);
    if (pw < POND.r + 3) tmp.lerp(cSand, (1 - smoothstep(POND.r, POND.r + 3, pw)) * 0.85);
    colors.push(tmp.r, tmp.g, tmp.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  // 池塘水面
  water = new THREE.Mesh(
    new THREE.CircleGeometry(POND.r, 40),
    new THREE.MeshStandardMaterial({ color: 0x3f8fce, transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0.1 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(POND.x, waterY, POND.z);
  scene.add(water);
  const shore = new THREE.Mesh(new THREE.RingGeometry(POND.r + 0.2, POND.r + 2.4, 40),
    new THREE.MeshStandardMaterial({ color: 0xd9c893, roughness: 1 }));
  shore.rotation.x = -Math.PI / 2;
  shore.position.set(POND.x, waterY - 0.35, POND.z);
  scene.add(shore);
}

function buildVillage() {
  const wallM = mat(0xd9c9a3);
  const roofM = mat(0x9c4a3c);
  const doorM = mat(0x6e4f2f);
  const winM = new THREE.MeshStandardMaterial({ color: 0xbfe3f2, roughness: 0.3, metalness: 0.4 });
  const spots = [[-9, -12, 0.5], [10, -14, -0.6], [-13, 6, 1.1], [12, 9, 2.4], [-6, 16, -1.8]];
  for (const [x, z, rot] of spots) {
    const g = new THREE.Group();
    const y = terrainH(x, z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.6, 3.8), wallM);
    body.position.y = 1.3;
    body.castShadow = true; body.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.0, 4), roofM);
    roof.position.y = 3.6; roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.5, 0.08), doorM);
    door.position.set(0.9, 0.75, 1.93);
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.06), winM);
    win.position.set(-1.2, 1.5, 1.93);
    const chim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.2, 0.5), mat(0x8f8578));
    chim.position.set(-1.4, 3.6, -0.8);
    g.add(body, roof, door, win, chim);
    g.position.set(x, y, z);
    g.rotation.y = rot;
    scene.add(g);
  }
  // 广场石台
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.8, 0.35, 24), mat(0xcfc5b0));
  plaza.position.set(0, terrainH(0, 0) + 0.12, 0);
  plaza.receiveShadow = true;
  scene.add(plaza);
  const obelisk = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3.2, 6), mat(0x58d6a0, { emissive: 0x1d5c3f, emissiveIntensity: .6 }));
  obelisk.position.set(0, terrainH(0, 0) + 1.9, 0);
  scene.add(obelisk);
}

function buildLanterns() {
  for (let i = 0; i < PATH.length - 1; i++) {
    const [ax, az] = PATH[i], [bx, bz] = PATH[i + 1];
    const steps = 2;
    for (let s = 1; s <= steps; s++) {
      const x = ax + (bx - ax) * (s / (steps + 1)) + 1.6;
      const z = az + (bz - az) * (s / (steps + 1)) + 1.2;
      const g = new THREE.Group();
      const y = terrainH(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 2.4, 6), mat(0x4a3b2a));
      pole.position.y = 1.2; pole.castShadow = true;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xffd98a, emissive: 0xffb347, emissiveIntensity: 1.2 }));
      lamp.position.y = 2.45;
      g.add(pole, lamp);
      g.position.set(x, y, z);
      scene.add(g);
      if (i === 0 && s === 1) {
        const pl = new THREE.PointLight(0xffb347, 0.9, 20);
        pl.position.set(x, y + 2.6, z);
        scene.add(pl);
        lanternLights.push(pl);
      }
    }
  }
}

function buildForest() {
  const trunkM = mat(0x6e4f2f);
  const rockM = mat(0x8d9094, { roughness: 1 });
  for (let i = 0; i < 64; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 15 + Math.random() * 85;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (distToPath(x, z) < 3.5 || Math.hypot(x - POND.x, z - POND.z) < POND.r + 2.5) continue;
    const s = 0.9 + Math.random() * 0.9;
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2 * s, 0.32 * s, 1.6 * s, 6), trunkM);
    trunk.position.y = 0.8 * s; trunk.castShadow = true;
    g.add(trunk);
    const leafM = mat(new THREE.Color().setHSL(0.34 + Math.random() * 0.05, 0.42, 0.3 + Math.random() * 0.1));
    for (let k = 0; k < 3; k++) {
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry((0.95 - k * 0.18) * s, 0), leafM);
      blob.position.set((Math.random() - 0.5) * 0.8 * s, (2.6 + k * 0.75) * s, (Math.random() - 0.5) * 0.8 * s);
      blob.castShadow = true;
      g.add(blob);
    }
    g.position.set(x, terrainH(x, z) - 0.05, z);
    g.rotation.y = Math.random() * 6.28;
    g.userData.sway = Math.random() * 6.28;
    scene.add(g);
    trees.push(g);
  }
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 12 + Math.random() * 70;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (distToPath(x, z) < 3) continue;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + Math.random() * 0.9, 0), rockM);
    rock.position.set(x, terrainH(x, z) + 0.25, z);
    rock.rotation.set(Math.random(), Math.random(), Math.random());
    rock.castShadow = true;
    scene.add(rock);
  }
}

function buildGrass() {
  const geo = new THREE.ConeGeometry(0.055, 0.46, 4);
  geo.translate(0, 0.23, 0);
  const count = 1100;
  const m1 = new THREE.MeshStandardMaterial({ color: 0x4f9440, roughness: 1 });
  const m2 = new THREE.MeshStandardMaterial({ color: 0x43813a, roughness: 1 });
  const inst = [new THREE.InstancedMesh(geo, m1, count >> 1), new THREE.InstancedMesh(geo, m2, count >> 1)];
  const dummy = new THREE.Object3D();
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  let placed = [0, 0];
  let guard = 0;
  while ((placed[0] < count / 2 || placed[1] < count / 2) && guard++ < 6000) {
    const a = Math.random() * Math.PI * 2;
    const r = 10 + Math.random() * 95;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (distToPath(x, z) < 2.6) continue;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.5) continue;
    const which = rnd() > 0.5 ? 0 : 1;
    if (placed[which] >= count / 2) continue;
    dummy.position.set(x, terrainH(x, z), z);
    dummy.rotation.y = rnd() * 6.28;
    const sc = 0.7 + rnd() * 0.9;
    dummy.scale.set(sc, sc * (0.8 + rnd() * 0.6), sc);
    dummy.updateMatrix();
    inst[which].setMatrixAt(placed[which]++, dummy.matrix);
  }
  inst.forEach(m => { m.instanceMatrix.needsUpdate = true; scene.add(m); });

  // 花丛：白/黄花心
  const flowerGeo = new THREE.SphereGeometry(0.075, 6, 5);
  flowerGeo.translate(0, 0.24, 0);
  const fcolors = [0xffffff, 0xffd166, 0xe98fa0, 0x9bb4f0];
  const fcount = 130;
  for (let c = 0; c < fcolors.length; c++) {
    const fm = new THREE.MeshStandardMaterial({ color: fcolors[c], roughness: 0.7 });
    const instF = new THREE.InstancedMesh(flowerGeo, fm, Math.ceil(fcount / fcolors.length));
    let n = 0;
    let g2 = 0;
    while (n < Math.ceil(fcount / fcolors.length) && g2++ < 900) {
      const a = Math.random() * Math.PI * 2;
      const r = 10 + Math.random() * 80;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (distToPath(x, z) < 2.6 || Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.5) continue;
      dummy.position.set(x, terrainH(x, z), z);
      dummy.rotation.y = 0; dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      instF.setMatrixAt(n++, dummy.matrix);
    }
    instF.instanceMatrix.needsUpdate = true;
    scene.add(instF);
  }
}

/* ---------- 程序化骨骼小人 ---------- */
function makeHumanoid(opt) {
  const M = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.88 });
  const g = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.98;
  g.add(hips);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.3), M(opt.shirt));
  torso.position.y = 0.3;
  torso.castShadow = true;
  hips.add(torso);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.1, 0.34), M(opt.belt));
  belt.position.y = 0.02;
  hips.add(belt);

  const head = new THREE.Group();
  head.position.y = 0.62;
  hips.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.21, 18, 14), M(opt.skin));
  skull.position.y = 0.18; skull.castShadow = true;
  head.add(skull);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), M(opt.hair));
  hair.position.y = 0.21;
  head.add(hair);
  const eyeM = M(0x20242b);
  [-0.07, 0.07].forEach(x => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), eyeM);
    e.position.set(x, 0.19, 0.185);
    head.add(e);
  });
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 6), M(opt.skin));
  nose.position.set(0, 0.15, 0.21); nose.rotation.x = Math.PI / 2;
  head.add(nose);

  function makeArm(side) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.32, 0.52, 0);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.34, 0.15), M(opt.shirt));
    upper.position.y = -0.17; upper.castShadow = true;
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.3, 0.13), M(opt.skin));
    fore.position.y = -0.46; fore.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), M(opt.skin));
    hand.position.y = -0.62;
    arm.add(upper, fore, hand);
    hips.add(arm);
    return arm;
  }
  function makeLeg(side) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.15, 0.0, 0);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.5, 0.19), M(opt.pants));
    thigh.position.y = -0.25; thigh.castShadow = true;
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.42, 0.17), M(opt.pants));
    shin.position.y = -0.7; shin.castShadow = true;
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.13, 0.27), M(opt.boots));
    boot.position.set(0, -0.94, 0.04); boot.castShadow = true;
    leg.add(thigh, shin, boot);
    hips.add(leg);
    return leg;
  }
  const rig = {
    g, hips, head,
    armL: makeArm(-1), armR: makeArm(1),
    legL: makeLeg(-1), legR: makeLeg(1),
    phase: Math.random() * 6,
  };
  return rig;
}

const IDLE_TILT = 0.035;
function animHumanoid(rig, dt, moveAmt, running, t) {
  if (moveAmt > 0.02) {
    rig.phase += dt * (6 + (running ? 5 : 0)) * (0.6 + moveAmt);
  }
  const amp = 0.62 * moveAmt;
  const s = Math.sin(rig.phase);
  rig.legL.rotation.x = s * amp;
  rig.legR.rotation.x = -s * amp;
  rig.armL.rotation.x = -s * amp * 0.85;
  rig.armR.rotation.x = s * amp * 0.85;
  rig.armL.rotation.z = -0.07 - Math.abs(s) * 0.04;
  rig.armR.rotation.z = 0.07 + Math.abs(s) * 0.04;
  rig.hips.position.y = 0.98 + Math.abs(Math.sin(rig.phase)) * 0.045 * moveAmt
    + Math.sin(t * 1.7) * 0.012 * (1 - moveAmt);           // 待机呼吸
  rig.hips.rotation.y = Math.sin(rig.phase * 0.5) * 0.06 * moveAmt;
  rig.head.rotation.z = Math.sin(t * 0.9 + rig.phase) * IDLE_TILT * (1 - moveAmt);
}

/* ---------- 玩家 / NPC ---------- */
function makePlayer() {
  playerRig = makeHumanoid({
    skin: 0xf2d6b3, hair: 0x4a3120, shirt: 0x2e6ea8,
    pants: 0x39414f, boots: 0x5a4632, belt: 0x8a6a3a,
  });
  playerRig.g.position.set(0, terrainH(0, 6), 6);
  playerRig.g.castShadow = true;
  scene.add(playerRig.g);
}

function makeLabel(text) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = '600 26px "KaiTi", "Kaiti SC", serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.strokeText(text, 256, 42);
  ctx.fillStyle = '#f0ead8';
  ctx.fillText(text, 256, 42);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set(4.6, 0.58, 1);
  return sp;
}

function makeMarker() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = '700 52px Georgia';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd166';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 8;
  ctx.fillText('!', 32, 52);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set(0.9, 0.9, 1);
  sp.visible = false;
  return sp;
}

function spawnNPCs(models) {
  models.forEach((m, i) => {
    if (state.npcs[m.id]) return;
    const fantasy = fantasyName(m.id);
    const a = (hashN(m.id, 628) / 628) * Math.PI * 2;
    const r = 16 + (hashN(m.name, 30) + 8);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rig = makeHumanoid({
      skin: 0xf2d6b3,
      hair: [0x4a3120, 0x2b2b2b, 0x7a4a2a, 0xb08050][i % 4],
      shirt: NPC_COLORS[i % NPC_COLORS.length],
      pants: [0x39414f, 0x4a3b2a, 0x33513f][i % 3],
      boots: 0x5a4632,
      belt: 0x3a3f4a,
    });
    rig.g.position.set(x, terrainH(x, z), z);
    rig.g.rotation.y = a + Math.PI;
    scene.add(rig.g);
    const label = makeLabel(fantasy + ' · ' + m.name);
    label.position.y = 2.45;
    rig.g.add(label);
    const marker = makeMarker();
    marker.position.y = 2.85;
    rig.g.add(marker);
    state.npcs[m.id] = {
      peer: m, rig, marker, fantasy, x, z,
      convId: null, ws: null, seen: new Set(), lastTS: 0, knownTS: -1, pendingSend: null,
      idleT: Math.random() * 10,
    };
  });
}

/* ---------- 主循环 ---------- */
const velY = { v: 0 };
let grounded = true;

function tick() {
  requestAnimationFrame(tick);
  if (!gameReady) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const talking = !!state.dialogNpc;

  // 移动
  let mx = 0, mz = 0;
  if (!talking) {
    if (state.keys['w'] || state.keys['arrowup']) mz += 1;
    if (state.keys['s'] || state.keys['arrowdown']) mz -= 1;
    if (state.keys['a'] || state.keys['arrowleft']) mx -= 1;
    if (state.keys['d'] || state.keys['arrowright']) mx += 1;
  }
  const running = !!(state.keys['shift']);
  const moving = (mx || mz) ? 1 : 0;
  if (moving) {
    const fwd = new THREE.Vector3(-Math.sin(cam.theta), 0, -Math.cos(cam.theta));
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3()
      .addScaledVector(fwd, mz)
      .addScaledVector(right, mx)
      .normalize();
    const spd = (running ? 9.2 : 4.6) * dt;
    playerRig.g.position.x += move.x * spd;
    playerRig.g.position.z += move.z * spd;
    const lim = 118;
    playerRig.g.position.x = Math.max(-lim, Math.min(lim, playerRig.g.position.x));
    playerRig.g.position.z = Math.max(-lim, Math.min(lim, playerRig.g.position.z));
    const face = Math.atan2(move.x, move.z);
    let diff = face - playerRig.g.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    playerRig.g.rotation.y += diff * Math.min(1, dt * 10);
  }
  const blend = moving ? (running ? 1 : 0.55) : 0;
  playerAnim.speedBlend += (blend - playerAnim.speedBlend) * Math.min(1, dt * 8);

  // 跳跃 / 贴地
  const gy = groundY(playerRig.g.position.x, playerRig.g.position.z);
  let py = playerRig.g.position.y;
  if (!grounded || velY.v !== 0) {
    velY.v -= 15.5 * dt;
    py += velY.v * dt;
    if (py <= gy) { py = gy; velY.v = 0; grounded = true; }
    playerRig.g.position.y = py;
  } else {
    playerRig.g.position.y = gy;
  }
  animHumanoid(playerRig, dt, grounded ? playerAnim.speedBlend : 0.25, running && moving > 0, t);
  // 空中姿态：收腿
  if (!grounded) {
    playerRig.legL.rotation.x = 0.5; playerRig.legR.rotation.x = -0.3;
    playerRig.armL.rotation.x = -0.9; playerRig.armR.rotation.x = -0.9;
  }

  // NPC 动画 + 注视
  for (const id in state.npcs) {
    const n = state.npcs[id];
    const dist = n.rig.g.position.distanceTo(playerRig.g.position);
    animHumanoid(n.rig, dt, 0, false, t + n.idleT);
    if (dist < 7) {
      const face = Math.atan2(
        playerRig.g.position.x - n.rig.g.position.x,
        playerRig.g.position.z - n.rig.g.position.z
      );
      let d = face - n.rig.g.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      n.rig.g.rotation.y += d * Math.min(1, dt * 3);
    }
    n.marker.material.opacity = 0.75 + Math.sin(t * 3) * 0.25;
  }
  // 最近 NPC
  let near = null;
  if (!talking) {
    let best = 5.2;
    for (const id in state.npcs) {
      const n = state.npcs[id];
      const dd = n.rig.g.position.distanceTo(playerRig.g.position);
      if (dd < best) { best = dd; near = n; }
    }
  }
  state.nearNpc = near;

  // 相机
  const px = playerRig.g.position.x, pz = playerRig.g.position.z, py2 = playerRig.g.position.y;
  const cp = new THREE.Vector3(
    px + Math.sin(cam.theta) * Math.cos(cam.pitch) * cam.radius,
    py2 + 1.6 + Math.sin(cam.pitch) * cam.radius,
    pz + Math.cos(cam.theta) * Math.cos(cam.pitch) * cam.radius
  );
  const cy = groundY(cp.x, cp.z) + 1.2;
  if (cp.y < cy) cp.y = cy;
  camera.position.lerp(cp, Math.min(1, dt * 7));
  camera.lookAt(px, py2 + 1.35, pz);

  // 阴影灯随玩家
  sun.position.set(px + 20, py2 + 34, pz + 12);
  sun.target.position.set(px, py2, pz);
  sun.target.updateMatrixWorld();

  // 水面波动
  if (water) water.position.y = waterY + Math.sin(t * 0.9) * 0.03;
  // 云漂移
  for (const c of clouds) {
    c.sp.position.x += c.vx * dt;
    if (c.sp.position.x > 130) c.sp.position.x = -130;
  }
  // 树摇曳
  for (const tr of trees) {
    tr.rotation.z = Math.sin(t * 1.4 + tr.userData.sway) * 0.015;
  }

  updatePrompt();
  drawMinimap();
  renderer.render(scene, camera);
}

/* ---------- 交互提示 / 小地图 ---------- */
const nearPrompt = $('#nearPrompt');
const mmCtx = $('#minimap').getContext('2d');

function updatePrompt() {
  const n = state.nearNpc;
  if (!n || state.dialogNpc) { nearPrompt.classList.add('hidden'); return; }
  const v = new THREE.Vector3().copy(n.rig.g.position);
  v.y += 2.6;
  v.project(camera);
  if (v.z > 1) { nearPrompt.classList.add('hidden'); return; }
  nearPrompt.innerHTML = `按 <b>E</b> 与 <b>${n.fantasy}</b> 交谈`;
  nearPrompt.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
  nearPrompt.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
  nearPrompt.classList.remove('hidden');
}

function drawMinimap() {
  const ctx = mmCtx;
  const S = 150, range = 75;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#123524';
  ctx.fillRect(0, 0, S, S);
  const px = playerRig.g.position.x, pz = playerRig.g.position.z;
  const toMap = (wx, wz) => [
    S / 2 + (wx - px) / range * S,
    S / 2 + (wz - pz) / range * S,
  ];
  // 池塘
  const [pdx, pdy] = toMap(POND.x, POND.z);
  ctx.fillStyle = 'rgba(63,143,206,.85)';
  ctx.beginPath(); ctx.arc(pdx, pdy, POND.r / range * S, 0, 7); ctx.fill();
  // 村庄房子（静态）
  ctx.fillStyle = 'rgba(220,200,160,.7)';
  for (const [hx, hz] of [[-9, -12], [10, -14], [-13, 6], [12, 9], [-6, 16]]) {
    const [sx, sy] = toMap(hx, hz);
    ctx.fillRect(sx - 3, sy - 3, 6, 6);
  }
  // NPC
  for (const id in state.npcs) {
    const n = state.npcs[id];
    const [nx, ny] = toMap(n.rig.g.position.x, n.rig.g.position.z);
    ctx.fillStyle = n.marker.visible ? '#ffd166' : '#58d6a0';
    ctx.beginPath(); ctx.arc(nx, ny, 3.2, 0, 7); ctx.fill();
  }
  // 玩家（朝向箭头）
  const [cx, cy2] = toMap(px, pz);
  ctx.save();
  ctx.translate(cx, cy2);
  ctx.rotate(-playerRig.g.rotation.y);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -6); ctx.lineTo(4.5, 5); ctx.lineTo(-4.5, 5); ctx.closePath(); ctx.fill();
  ctx.restore();
  // 边框圈
  ctx.strokeStyle = 'rgba(88,214,160,.4)';
  ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
}

/* ---------- 输入 ---------- */
addEventListener('keydown', e => {
  if (!state.me) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape' && state.dialogNpc) closeDialog();
    return;
  }
  const k = e.key.toLowerCase();
  state.keys[k] = true;
  if (k === 'shift') state.keys['shift'] = true;
  if ((k === ' ' || e.code === 'Space') && grounded) { velY.v = 5.6; grounded = false; e.preventDefault(); }
  if (k === 'e' && state.nearNpc && !state.dialogNpc) openDialog(state.nearNpc);
  if (e.key === 'Escape' && state.dialogNpc) closeDialog();
});
addEventListener('keyup', e => { state.keys[e.key.toLowerCase()] = false; });

let dragging = false, lastX = 0, lastY = 0;
const glc = $('#gl');
glc.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('mousemove', e => {
  if (!dragging) return;
  cam.theta -= (e.clientX - lastX) * 0.007;
  cam.pitch = Math.max(0.08, Math.min(1.15, cam.pitch + (e.clientY - lastY) * 0.005));
  lastX = e.clientX; lastY = e.clientY;
});
addEventListener('mouseup', () => { dragging = false; });
glc.addEventListener('wheel', e => {
  e.preventDefault();
  cam.radius = Math.max(4.5, Math.min(19, cam.radius + e.deltaY * 0.012));
}, { passive: false });

function resize() {
  if (!renderer) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);

/* ---------- 对话（聊天逻辑，与全后端互通） ---------- */
const dlgLines = $('#dlgLines');

function scrollDlg() { dlgLines.scrollTop = dlgLines.scrollHeight; }

function addDlgLine(kind, text, instant = false) {
  const div = document.createElement('div');
  div.className = 'dlg-line ' + kind;
  dlgLines.appendChild(div);
  scrollDlg();
  if (instant) { div.textContent = text; div.classList.add('done'); return Promise.resolve(); }
  return new Promise(resolve => {
    let i = 0;
    const chunk = Math.max(1, Math.round(text.length / 90));
    const step = () => {
      i = Math.min(text.length, i + chunk);
      div.textContent = text.slice(0, i);
      scrollDlg();
      if (i < text.length) setTimeout(step, 24);
      else { div.classList.add('done'); resolve(); }
    };
    setTimeout(step, 180);
  });
}

let dlgTyping = null;
function showDlgTyping() {
  if (!state.dialogNpc || dlgTyping) return;
  hideDlgTyping();
  const div = document.createElement('div');
  div.className = 'dlg-line typing';
  div.textContent = '（旅人正在思忖……）';
  dlgLines.appendChild(div);
  scrollDlg();
  dlgTyping = div;
}
function hideDlgTyping() {
  if (dlgTyping instanceof HTMLElement) { dlgTyping.remove(); }
  dlgTyping = null;
}

async function openDialog(npc) {
  state.dialogNpc = npc;
  npc.marker.visible = false;
  $('#dlgName').textContent = npc.fantasy;
  $('#dlgSub').textContent = '旅人 · ' + npc.peer.name;
  $('#dlgAva').textContent = npc.fantasy[0];
  dlgLines.innerHTML = '';
  $('#dialog').classList.remove('hidden');
  $('#dlgInput').focus();
  addDlgLine('npc', `（${npc.fantasy} 抬起头，向你点了点头）`, true);
  try {
    const d = await api('/api/conversations/with', { body: { peer_id: npc.peer.id } });
    npc.convId = d.conversation.id;
    npc.seen = new Set();
    npc.lastTS = 0;
    const h = await api(`/api/conversations/${npc.convId}/messages`);
    for (const m of h.messages || []) {
      npc.seen.add(m.id);
      if (m.ts > npc.lastTS) npc.lastTS = m.ts;
      if (m.sender_id === state.me.id) await addDlgLine('you', m.content, true);
      else await addDlgLine('npc', m.content, true);
    }
    if (!h.messages || !h.messages.length) {
      await addDlgLine('npc', `${state.me.nickname}，很久没有旅人走到这里了……你想聊点什么？`, false);
    }
    connectNpcWS(npc);
  } catch (e) { toast(e.message); }
}

function closeDialog() {
  state.dialogNpc = null;
  $('#dialog').classList.add('hidden');
  hideDlgTyping();
}

$('#dlgClose').onclick = closeDialog;

function npcSend() {
  const npc = state.dialogNpc;
  const input = $('#dlgInput');
  const text = input.value.trim();
  if (!text || !npc || !npc.convId) return;
  const cmid = Date.now() + '-' + Math.random().toString(36).slice(2);
  state.pending.add(cmid);
  const send = () => npc.ws.send(JSON.stringify({ type: 'msg', content: text, client_msg_id: cmid }));
  if (npc.ws && npc.ws.readyState === 1) send(); else npc.pendingSend = send;
  addDlgLine('you', text);
  input.value = '';
}

$('#dlgSend').onclick = npcSend;
$('#dlgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) npcSend();
});

function connectNpcWS(npc) {
  if (npc.ws) { try { npc.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?conv=${encodeURIComponent(npc.convId)}&token=${encodeURIComponent(state.token)}`
  );
  npc.ws = ws;
  ws.onmessage = e => { try { handleNpcEvent(npc, JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (npc.convId && npc.ws === ws) setTimeout(() => { if (npc.convId) connectNpcWS(npc); }, 3000);
  };
  ws.onopen = () => {
    if (npc.pendingSend) { const f = npc.pendingSend; npc.pendingSend = null; f(); }
  };
}

function handleNpcEvent(npc, ev) {
  if (ev.conv_id && npc.convId && ev.conv_id !== npc.convId) return;
  if (ev.type === 'typing') {
    if (ev.sender_id !== state.me.id) {
      if (state.dialogNpc === npc) showDlgTyping();
    }
  } else if (ev.type === 'msg') {
    if (npc.seen.has(ev.id)) return;
    npc.seen.add(ev.id);
    if (ev.ts > npc.lastTS) npc.lastTS = ev.ts;
    if (ev.sender_id === state.me.id) {
      if (ev.client_msg_id && state.pending.has(ev.client_msg_id)) { state.pending.delete(ev.client_msg_id); return; }
      addDlgLine('you', ev.content, true);
    } else if (state.dialogNpc === npc) {
      hideDlgTyping();
      addDlgLine('npc', ev.content);
    } else {
      npc.marker.visible = true;
      addQuest(`<b>${npc.fantasy}</b>（${npc.peer.name}）有话想说，去旷野找 ${npc.fantasy} 聊聊吧。`);
      toast(`${npc.fantasy} 有话想说`);
    }
  }
}

/* ---------- 冒险日志 ---------- */
function addQuest(html) {
  const body = $('#qlBody');
  const empty = body.querySelector('.ql-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'ql-item';
  div.innerHTML = '✦ ' + html;
  body.prepend(div);
  while (body.children.length > 12) body.lastChild.remove();
}

/* ---------- 轮询：新旅人 / 新消息 ---------- */
setInterval(async () => {
  if (!state.token || !state.me || document.hidden || !gameReady) return;
  try {
    const d = await api('/api/models');
    spawnNPCs(d.models || []);
    const cd = await api('/api/conversations');
    for (const c of cd.conversations || []) {
      for (const id in state.npcs) {
        const n = state.npcs[id];
        if (n.peer.id === c.peer_id) {
          if (n.knownTS === -1) { n.knownTS = c.last_ts || 0; continue; }
          if (c.last_ts > n.knownTS) {
            n.knownTS = c.last_ts;
            if (state.dialogNpc !== n) {
              n.marker.visible = true;
              addQuest(`<b>${n.fantasy}</b>（${n.peer.name}）有话想说。`);
            }
          }
        }
      }
    }
  } catch {}
}, 5000);

/* ---------- 进入世界（带加载进度） ---------- */
const LOAD_STEPS = [
  ['正在唤醒大地……', () => { buildTerrain(); }],
  ['铺开天空与云……', () => { buildSky(); }],
  ['搭建村庄与小径……', () => { buildVillage(); buildLanterns(); }],
  ['种下森林与草丛……', () => { buildForest(); buildGrass(); }],
  ['点亮灯与水……', () => { /* 水面已在地形内 */ }],
  ['召唤冒险者……', () => { makePlayer(); }],
];

async function enterWorld() {
  $('#startView').classList.add('hidden');
  $('#loadView').classList.remove('hidden');

  if (!scene) {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x9fd4e8, 45, 170);
    camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);
    renderer = new THREE.WebGLRenderer({ canvas: $('#gl'), antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.88;
    sun = new THREE.DirectionalLight(0xfff2d8, 1.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -38; sun.shadow.camera.right = 38;
    sun.shadow.camera.top = 38; sun.shadow.camera.bottom = -38;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
    sun.shadow.bias = -0.0006;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0xdfeaff, 0x4a7a58, 0.55));
  }

  for (let i = 0; i < LOAD_STEPS.length; i++) {
    $('#loadTip').textContent = LOAD_STEPS[i][0];
    $('#loadFill').style.width = Math.round((i / LOAD_STEPS.length) * 100) + '%';
    await new Promise(r => setTimeout(r, 60));
    try {
      LOAD_STEPS[i][1]();
    } catch (err) {
      $('#loadTip').textContent = '加载出错：' + err.message;
      console.error(err);
      return;
    }
  }
  $('#loadFill').style.width = '100%';

  $('#loadView').classList.add('hidden');
  $('#gameView').classList.remove('hidden');
  $('#hudName').textContent = state.me.nickname;
  $('#hudAva').textContent = (state.me.nickname[0] || '?').toUpperCase();
  gameReady = true;
  clock.start();
  tick();
  resize();
  addQuest('欢迎来到微光旷野，<b>' + state.me.nickname + '</b>。');
  try {
    const d = await api('/api/models');
    spawnNPCs(d.models || []);
    addQuest('旷野里有 <b>' + (d.models || []).length + '</b> 位旅人，去找找他们吧。');
  } catch {}
}

/* ---------- 已登录则直接进入 ---------- */
(async function initPlay() {
  if (!state.token) return;
  try {
    const d = await api('/api/me');
    state.me = d.user;
    enterWorld();
  } catch {
    localStorage.removeItem('gv_token');
    state.token = '';
  }
})();
