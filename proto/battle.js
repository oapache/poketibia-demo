// Teste de combate idle: jogador anda SOZINHO atras do Pokemon selvagem, seu
// Charmander fica grudado ao lado e ataca quando o jogador chega perto.
// Movimento e interpolado (grid logico + posicao visual suavizada) pra ficar
// fluido a 60fps em vez de teleporte tile-a-tile. Formula de dano e propria
// (simplificada), so pra validar o LOOP (andar -> perseguir -> atacar -> HP -> capturar).

const TILE = 32;
// caminhos relativos ao diretorio da propria pagina (funciona tanto local
// quanto num subpath do GitHub Pages, ex: usuario.github.io/repo/proto/...)
const BASE = new URL('..', location.href).pathname.replace(/\/$/, '');
const SPRITES = `${BASE}/sprites-test`;
const DATA = `${BASE}/downloaded`;
const MAP_SLUG = 'oddish'; // mapa que ja tem hunt-config com spawn de Oddish
const PLAYER_MOVE_DUR = 500; // ms por passo do jogador (mais devagar)
const CREATURE_MOVE_DUR = 480; // ms por passo de Pokemon (Charmander/selvagens)
const ZOOM = 1.3; // camera parecida com o client real (1.8 deixava personagem/Pokemon grande demais)

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const info = document.getElementById('info');
const logEl = document.getElementById('log');

// canvas em resolucao nativa da tela (devicePixelRatio) pra nao ficar borrado
// em monitor HiDPI/4K, com nearest-neighbor (sem smoothing) pra manter o
// pixel art nitido mesmo ampliado pelo ZOOM.
let viewW = window.innerWidth, viewH = window.innerHeight;
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.style.width = viewW + 'px';
  canvas.style.height = viewH + 'px';
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const floatingTexts = []; // {x,y,text,color,born}
function popupText(worldX, worldY, text, color) {
  floatingTexts.push({ x: worldX, y: worldY, text, color, born: performance.now() });
}

function log(msg) {
  const d = document.createElement('div');
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(d);
  while (logEl.children.length > 30) logEl.removeChild(logEl.lastChild);
}

let mapData, tilesByKey = new Map(), collisionSet = new Set(), offsets = { disp: {} };
let mapItemsIndex = {};
let flatSet = new Set(), topSet = new Set();
function layerOf(id) {
  if (flatSet.has(id)) return 'flat';
  if (topSet.has(id)) return 'top';
  return 'sorted';
}
const imageCache = new Map();

function key(x, y) { return x + ',' + y; }
function loadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const img = new Image();
  img.src = url;
  imageCache.set(url, img);
  return img;
}
function terrainSprite(tileId) {
  const e = mapItemsIndex[String(tileId)];
  if (!e?.files?.length) return null;
  return loadImage(`${SPRITES}/map-items/${e.files[0]}`);
}
function isBlocked(x, y) {
  const t = tilesByKey.get(key(x, y));
  if (!t) return true;
  return [t.ground, ...t.extras].some(id => collisionSet.has(id));
}

// sprite de criatura: outfit id = creature.looktype, arquivo "{frame}_1_1_{dir}.png"
async function loadCreatureIndex(outfitId) {
  const r = await fetch(`${SPRITES}/outfits/male/${outfitId}/_index.json`);
  if (!r.ok) throw new Error(`sprite do outfit ${outfitId} nao decodificado ainda (roda decode-atlas.js --only="outfits/male/${outfitId}")`);
  return r.json();
}
function creatureSprite(idx, outfitId, frame = 1, dir = 1) {
  const virtualKey = `/assets/outfits/male/${outfitId}/${frame}_1_1_${dir}.png`;
  const e = idx[virtualKey];
  if (!e?.files?.length) return null;
  return loadImage(`${SPRITES}/outfits/male/${outfitId}/${e.files[0]}`);
}

function dmgOf(attack, attacker, defender) {
  const base = attack.power * (attacker.baseAtk / 50);
  const mitigated = base - defender.baseDef / 4;
  return Math.max(1, Math.round(mitigated));
}

function dist(a, b) { return Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy)); }

// move suave: gx/gy = posicao logica (grid) atual; fromX/fromY = de onde veio;
// moveStart = timestamp do passo. visualPos() interpola entre os dois.
// moveDur e por-entidade pra jogador e Pokemon terem velocidades diferentes.
function makeEntity(gx, gy, moveDur = CREATURE_MOVE_DUR) {
  return { gx, gy, fromX: gx, fromY: gy, moveStart: -Infinity, moveDur, dir: 3 };
}
function isMoving(e, now) { return now - e.moveStart < e.moveDur; }
function startMove(e, nx, ny, now) {
  e.dir = dirFromDelta(nx - e.gx, ny - e.gy);
  e.fromX = e.gx; e.fromY = e.gy;
  e.gx = nx; e.gy = ny;
  e.moveStart = now;
}
function visualPos(e, now) {
  const t = Math.min(1, Math.max(0, (now - e.moveStart) / e.moveDur));
  return { x: e.fromX + (e.gx - e.fromX) * t, y: e.fromY + (e.gy - e.fromY) * t };
}
// frame de animacao: 1-2-3 ciclando enquanto anda, parado em 1 quando idle
function walkFrame(e, now) {
  if (!isMoving(e, now)) return 1;
  const t = (now - e.moveStart) / e.moveDur;
  return 1 + Math.floor(t * 3) % 3;
}
// BFS de verdade: contorna qualquer obstaculo (parede em U, etc), nao so o
// caso de 1 pedra isolada. Delimitado a uma caixa em torno de origem/destino
// pra nao varrer o mapa inteiro a cada passo.
function bfsPath(fromGx, fromGy, toGx, toGy) {
  const margin = 20;
  const minX = Math.min(fromGx, toGx) - margin, maxX = Math.max(fromGx, toGx) + margin;
  const minY = Math.min(fromGy, toGy) - margin, maxY = Math.max(fromGy, toGy) + margin;
  const startKey = fromGx + ',' + fromGy, goalKey = toGx + ',' + toGy;
  if (startKey === goalKey) return [];
  const queue = [[fromGx, fromGy]];
  let qi = 0;
  const cameFrom = new Map([[startKey, null]]);
  const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (qi < queue.length) {
    const [cx, cy] = queue[qi++];
    if (cx === toGx && cy === toGy) break;
    for (const [dx, dy] of dirs4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const k = nx + ',' + ny;
      if (cameFrom.has(k)) continue;
      const isGoal = nx === toGx && ny === toGy;
      if (!isGoal && isBlocked(nx, ny)) continue;
      cameFrom.set(k, cx + ',' + cy);
      queue.push([nx, ny]);
    }
  }
  if (!cameFrom.has(goalKey)) return null;
  const path = [];
  let curKey = goalKey;
  while (curKey !== startKey) {
    const [x, y] = curKey.split(',').map(Number);
    path.push({ x, y });
    curKey = cameFrom.get(curKey);
  }
  path.reverse();
  return path;
}
// recalcula o caminho (barato o bastante pra rodar a cada passo, o terreno
// e estatico) e devolve so o proximo passo; para quando ja fica adjacente.
function stepToward(from, to) {
  if (Math.max(Math.abs(to.gx - from.gx), Math.abs(to.gy - from.gy)) <= 1) return null;
  const path = bfsPath(from.gx, from.gy, to.gx, to.gy);
  if (!path || path.length === 0) return null;
  return { nx: path[0].x, ny: path[0].y };
}
function dirFromDelta(dx, dy) {
  if (dx > 0) return 2; // direita - confirmado certo
  if (dx < 0) return 4; // esquerda
  if (dy > 0) return 3; // baixo
  if (dy < 0) return 1; // cima - estava errado com dir 3, trocado
  return 3;
}

const state = {
  player: null,
  charmander: null,
  wilds: [], // varios Oddish selvagens
  cam: { x: 0, y: 0 },
};
function nearestAliveWild(from) {
  let best = null, bestD = Infinity;
  for (const w of state.wilds) {
    if (!w.alive) continue;
    const d = dist(from, w);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

async function init() {
  const [map, collision, off, drawOrder, mItemsIdx, creatures, huntConfig] = await Promise.all([
    fetch(`${DATA}/game/maps/${MAP_SLUG}.json`).then(r => r.json()),
    fetch(`${DATA}/game/collision.json`).then(r => r.json()),
    fetch(`${DATA}/game/offsets.json`).then(r => r.json()),
    fetch(`${DATA}/game/draworder.json`).then(r => r.json()),
    fetch(`${SPRITES}/map-items/_index.json`).then(r => r.json()),
    fetch(`${DATA}/game/creatures.json`).then(r => r.json()),
    fetch(`${DATA}/api/game/hunt-config/${MAP_SLUG}.json`).then(r => r.ok ? r.json() : null),
  ]);

  mapData = map;
  collisionSet = new Set(collision.blocking);
  offsets = off;
  mapItemsIndex = mItemsIdx;
  // categorias reais do jogo (draworder.json), pra decidir ONDE cada extra
  // entra na pilha de desenho em vez de tudo competir no mesmo y-sort:
  // - "onbottom"/"borders": grudado no chao, sempre abaixo de qualquer criatura
  // - "bottom" (a maioria dos itens/decoracao normal): participa do y-sort com as entidades
  // - "top"/"toppers": sempre por cima de tudo (copa de arvore, teto) - nunca ocluido por criatura
  flatSet = new Set([...drawOrder.onbottom, ...drawOrder.borders]);
  topSet = new Set([...drawOrder.top, ...drawOrder.toppers]);

  const groundZ = map._meta.groundZ;
  for (const [x, y, z, tileId, extras] of map.tiles) {
    if (z !== groundZ) continue;
    tilesByKey.set(key(x, y), { ground: tileId, extras: (extras || []).map(e => e[0]) });
  }
  // lista de tiles andaveis pra sortear spawn aleatorio (calculado 1x, reusado).
  // restrito a uma caixa em torno dos spawns ORIGINAIS do hunt-config (+
  // margem), nao o mapa inteiro - senao o sorteio manda bicho/jogador pra
  // beirada do mapa carregado, onde da pra ver o "fim do mundo" (vazio preto
  // além da area de tiles que a hunt realmente usa).
  const HUNT_MARGIN = 12;
  let boundsMinX = -Infinity, boundsMaxX = Infinity, boundsMinY = -Infinity, boundsMaxY = Infinity;
  if (huntConfig?.spawns?.length) {
    const xs = huntConfig.spawns.map(s => s.x), ys = huntConfig.spawns.map(s => s.y);
    boundsMinX = Math.min(...xs) - HUNT_MARGIN; boundsMaxX = Math.max(...xs) + HUNT_MARGIN;
    boundsMinY = Math.min(...ys) - HUNT_MARGIN; boundsMaxY = Math.max(...ys) + HUNT_MARGIN;
  }
  const walkableTiles = [];
  for (const [k] of tilesByKey) {
    const [x, y] = k.split(',').map(Number);
    if (x < boundsMinX || x > boundsMaxX || y < boundsMinY || y > boundsMaxY) continue;
    if (!isBlocked(x, y)) walkableTiles.push({ x, y });
  }
  function randomWalkableTile() {
    return walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
  }

  const charmData = creatures.creatures.find(c => c.name === 'Charmander');
  const oddData = creatures.creatures.find(c => c.name === 'Oddish');
  const oddSpriteIdx = await loadCreatureIndex(oddData.looktype);

  const PLAYER_OUTFIT_ID = 159; // "Trainer" (outfits-index.json, kind:"trainer")
  const start = huntConfig?.start || { x: 0, y: 0 };
  state.player = Object.assign(makeEntity(start.x, start.y - 1, PLAYER_MOVE_DUR), {
    name: 'Numzei', outfitId: PLAYER_OUTFIT_ID, spriteIdx: await loadCreatureIndex(PLAYER_OUTFIT_ID),
  });

  state.charmander = Object.assign(makeEntity(start.x, start.y), {
    hp: charmData.baseHp, maxHp: charmData.baseHp, data: charmData,
    spriteIdx: await loadCreatureIndex(charmData.looktype), lastAttack: 0, cooldownMs: 1200,
  });

  // posicoes aleatorias em tile livre (nao usa mais huntConfig.spawns fixo)
  const WILD_COUNT = Math.min(15, huntConfig?.spawns?.length || 15);
  state.wilds = Array.from({ length: WILD_COUNT }, (_, i) => {
    const spawn = randomWalkableTile();
    return Object.assign(makeEntity(spawn.x, spawn.y), {
      id: i, hp: oddData.baseHp, maxHp: oddData.baseHp, data: oddData,
      spriteIdx: oddSpriteIdx, alive: true,
    });
  });
  state.randomWalkableTile = randomWalkableTile;

  state.cam = { x: state.player.gx, y: state.player.gy };

  log(`Charmander (HP ${state.charmander.hp}) pronto. ${state.wilds.length} Oddish selvagens espalhados no mapa.`);
  log(`Ataque real do Charmander: ${charmData.attacks[0].name} recarrega em ${charmData.attacks[0].cooldownMs}ms — demo usa ritmo acelerado (${state.charmander.cooldownMs}ms) pra visualizar o loop mais rapido. Jogador anda sozinho ate o alvo mais proximo.`);

  requestAnimationFrame(draw);
  // setInterval em vez de requestAnimationFrame pra logica de IA: rAF
  // trota/para quando a aba fica em background, o que quebrava o teste.
  setInterval(() => tick(performance.now()), 50);
  window.__debug = state;
}

// alvo TRAVADO: so troca quando o atual morre/some, senao fica trocando de
// Oddish no meio do caminho toda vez que a distancia relativa muda (o "correu
// que nem cachorro doido" era isso zigzagueando entre alvos).
function lockedTarget() {
  if (state.huntTarget && !state.huntTarget.alive) state.huntTarget = null;
  if (!state.huntTarget) state.huntTarget = nearestAliveWild(state.player);
  return state.huntTarget;
}

function tick(ts) {
  const target = lockedTarget();

  // jogador anda sozinho ate ficar adjacente ao Oddish selvagem travado
  if (!isMoving(state.player, ts)) {
    if (target && dist(state.player, target) > 1) {
      const step = stepToward(state.player, target);
      if (step) startMove(state.player, step.nx, step.ny, ts);
    }
  }

  // charmander vai DIRETO pro alvo assim que existe um (nao espera o jogador
  // chegar - o Pokemon corre na frente, que e o pedido: ele deve chegar
  // primeiro que o treinador). Sem alvo, fica grudado ao lado do jogador.
  if (!isMoving(state.charmander, ts)) {
    if (target && dist(state.charmander, target) > 1) {
      const step = stepToward(state.charmander, target);
      if (step) startMove(state.charmander, step.nx, step.ny, ts);
    } else if (!target && dist(state.charmander, state.player) > 1) {
      const step = stepToward(state.charmander, state.player);
      if (step && !(step.nx === state.player.gx && step.ny === state.player.gy)) {
        startMove(state.charmander, step.nx, step.ny, ts);
      }
    }
  }

  // combate: charmander ataca qualquer selvagem adjacente e vivo
  const adjacentWild = state.wilds.find(w => w.alive && dist(state.charmander, w) <= 1);
  if (adjacentWild && ts - state.charmander.lastAttack > state.charmander.cooldownMs) {
    const atk = state.charmander.data.attacks[0];
    const dmg = dmgOf(atk, state.charmander.data, adjacentWild.data);
    adjacentWild.hp = Math.max(0, adjacentWild.hp - dmg);
    log(`Charmander usa ${atk.name}! Oddish #${adjacentWild.id} leva ${dmg} de dano (HP ${adjacentWild.hp}/${adjacentWild.maxHp})`);
    popupText(adjacentWild.gx, adjacentWild.gy, `${atk.name} ${dmg}`, '#ffb020');
    state.charmander.lastAttack = ts;
    if (adjacentWild.hp <= 0) {
      adjacentWild.alive = false;
      adjacentWild.faintedAt = ts;
      adjacentWild.faintedX = adjacentWild.gx;
      adjacentWild.faintedY = adjacentWild.gy;
      log(`Oddish #${adjacentWild.id} foi derrotado! (respawn em outro lugar em 5s)`);
      setTimeout(() => {
        const spot = state.randomWalkableTile();
        adjacentWild.gx = adjacentWild.fromX = spot.x;
        adjacentWild.gy = adjacentWild.fromY = spot.y;
        adjacentWild.hp = adjacentWild.maxHp;
        adjacentWild.alive = true;
      }, 5000);
    }
  }

  const aliveCount = state.wilds.filter(w => w.alive).length;
  info.textContent = `jogador (${state.player.gx},${state.player.gy}) | Charmander HP ${state.charmander.hp}/${state.charmander.maxHp} | Oddish vivos: ${aliveCount}/${state.wilds.length}`;
}

function drawNameTag(px, py, name, color, extraLift = 0) {
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = color;
  const x = px + TILE / 2, y = py - 8 - extraLift;
  ctx.strokeText(name, x, y);
  ctx.fillText(name, x, y);
  ctx.textAlign = 'left';
}

function drawFloatingTexts(originX, originY, now) {
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const f = floatingTexts[i];
    const age = now - f.born;
    if (age > 1000) { floatingTexts.splice(i, 1); continue; }
    const px = Math.round(originX + f.x * TILE + TILE / 2);
    const py = Math.round(originY + f.y * TILE - 12 - age / 1000 * 26);
    ctx.globalAlpha = 1 - age / 1000;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.strokeText(f.text, px, py);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, px, py);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

function drawHpBar(px, py, hp, maxHp) {
  const w = TILE - 6, h = 4;
  const x = px + 3, y = py - 7;
  ctx.fillStyle = '#000';
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = '#400';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = hp / maxHp > 0.5 ? '#3c3' : hp / maxHp > 0.2 ? '#cc3' : '#c33';
  ctx.fillRect(x, y, w * Math.max(0, hp / maxHp), h);
}

function draw() {
  const now = performance.now();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, viewW, viewH);
  if (mapData) {
    const playerVis = visualPos(state.player, now);
    // camera sempre centrada no jogador (com um lerp leve pra suavizar)
    state.cam.x += (playerVis.x - state.cam.x) * 0.15;
    state.cam.y += (playerVis.y - state.cam.y) * 0.15;

    ctx.save();
    ctx.scale(ZOOM, ZOOM);
    const scaledW = viewW / ZOOM, scaledH = viewH / ZOOM;

    // margem generosa: alguns "objetos" (arvores/pedras grandes) sao sprites
    // largos ancorados numa unica tile - se a tile ancora fica fora da janela
    // visivel o sprite inteiro some, cortando a decoracao. Buffer maior evita isso.
    const tilesX = Math.ceil(scaledW / TILE) + 12;
    const tilesY = Math.ceil(scaledH / TILE) + 12;
    const startX = Math.floor(state.cam.x - tilesX / 2);
    const startY = Math.floor(state.cam.y - tilesY / 2);
    const originX = scaledW / 2 - state.cam.x * TILE;
    const originY = scaledH / 2 - state.cam.y * TILE;

    const visible = [];
    for (let y = startY; y <= startY + tilesY; y++)
      for (let x = startX; x <= startX + tilesX; x++) {
        const t = tilesByKey.get(key(x, y));
        if (t) visible.push([x, y, t]);
      }
    visible.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    // camadas na ordem real do jogo (draworder.json), nao so "chao vs resto":
    // 1) chao (fullground) - sempre 32x32, nunca invade celula vizinha
    // 2) "flat" (onbottom/borders) - grudado no chao, sempre abaixo de criatura
    // 3) "sorted" (bottom normal) + entidades - competem no MESMO y-sort
    // 4) "top"/"toppers" - sempre por cima de tudo (copa de arvore, teto),
    //    nunca ocluido por criatura passando por baixo
    function drawExtra(id, px, py) {
      const img = terrainSprite(id);
      if (img?.complete && img.naturalWidth) {
        const [dx, dy] = offsets.disp?.[String(id)] || [0, 0];
        ctx.drawImage(img, px + dx, py + dy);
      }
    }
    function rowSpanOf(id) {
      const entry = mapItemsIndex[String(id)];
      return Math.max(1, Math.round((entry?.height || TILE) / TILE));
    }
    // a maioria do chao e 32x32 (ordem entre eles nao importa), mas ~28
    // tiles de agua/borda sao 64x64 - se desenhados em qualquer ordem podem
    // cortar o chao vizinho. Ordena pela linha da BASE (mesmo truque usado
    // pra decoracao grande) so quando ha sprite >1 tile de altura por perto.
    const groundItems = visible.map(([x, y, t]) => ({
      y: y + rowSpanOf(t.ground) - 1,
      draw: () => drawExtra(t.ground, Math.round(originX + x * TILE), Math.round(originY + y * TILE)),
    }));
    groundItems.sort((a, b) => a.y - b.y);
    for (const g of groundItems) g.draw();
    for (const [x, y, t] of visible) {
      const px = Math.round(originX + x * TILE), py = Math.round(originY + y * TILE);
      for (const id of t.extras) if (layerOf(id) === 'flat') drawExtra(id, px, py);
    }
    // decoracao "sorted" e entidades (jogador/Pokemon) entram no MESMO
    // ordenamento por Y - senao entidade sempre desenha por cima de toda
    // decoracao, mesmo quando deveria passar "por tras" de uma arvore/arbusto
    // cuja linha esta mais a frente (y maior).
    const depthItems = [];
    const topItems = [];
    for (const [x, y, t] of visible) {
      const px = Math.round(originX + x * TILE), py = Math.round(originY + y * TILE);
      for (const id of t.extras) {
        const layer = layerOf(id);
        if (layer === 'flat') continue; // ja desenhado acima
        if (layer === 'top') { topItems.push(() => drawExtra(id, px, py)); continue; }
        // arvore grande = 1 sprite so ocupando varias linhas (ex: 64x64 = 2
        // tiles de altura), ancorado no topo-esquerda. Se ordenar so pela
        // linha da ancora, uma entidade na linha de baixo (onde a arvore
        // "termina" visualmente) fica errada. Usa a linha da BASE do sprite.
        depthItems.push({ y: y + rowSpanOf(id) - 1, draw: () => drawExtra(id, px, py) });
      }
    }
    const FAINT_DUR = 5000; // combina com o setTimeout do respawn
    for (const w of state.wilds) {
      if (!w.alive) {
        // "cadaver" temporario: sem dado real de corpse por especie
        // confirmado, entao usa o proprio sprite deitado/desbotado no lugar
        // onde morreu ate o respawn (em vez de so sumir).
        if (w.faintedAt && now - w.faintedAt < FAINT_DUR) {
          const fx = w.faintedX, fy = w.faintedY;
          depthItems.push({
            y: fy, draw: () => {
              const img = creatureSprite(w.spriteIdx, w.data.looktype, 1, 3);
              if (!img?.complete || !img.naturalWidth) return;
              const px = originX + fx * TILE, py = originY + fy * TILE;
              ctx.save();
              ctx.globalAlpha = 0.65;
              ctx.translate(px + TILE / 2, py + TILE * 0.7);
              ctx.rotate(Math.PI / 2);
              ctx.drawImage(img, -TILE / 2, -TILE / 2);
              ctx.restore();
            }
          });
        }
        continue;
      }
      const vis = visualPos(w, now);
      depthItems.push({
        y: vis.y, draw: () => {
          const img = creatureSprite(w.spriteIdx, w.data.looktype, walkFrame(w, now), w.dir);
          const px = Math.round(originX + vis.x * TILE), py = Math.round(originY + vis.y * TILE);
          if (img?.complete && img.naturalWidth) ctx.drawImage(img, px, py);
          drawHpBar(px, py, w.hp, w.maxHp);
          drawNameTag(px, py, 'Oddish', '#ff8a8a');
        }
      });
    }
    {
      const vis = visualPos(state.charmander, now);
      depthItems.push({
        y: vis.y, draw: () => {
          const img = creatureSprite(state.charmander.spriteIdx, state.charmander.data.looktype, walkFrame(state.charmander, now), state.charmander.dir);
          const px = Math.round(originX + vis.x * TILE), py = Math.round(originY + vis.y * TILE);
          if (img?.complete && img.naturalWidth) ctx.drawImage(img, px, py);
          drawHpBar(px, py, state.charmander.hp, state.charmander.maxHp);
          drawNameTag(px, py, 'Charmander', '#6f6', 12);
        }
      });
    }
    depthItems.push({
      y: playerVis.y, draw: () => {
        const apx = Math.round(originX + playerVis.x * TILE), apy = Math.round(originY + playerVis.y * TILE);
        const pImg = creatureSprite(state.player.spriteIdx, state.player.outfitId, walkFrame(state.player, now), state.player.dir);
        if (pImg?.complete && pImg.naturalWidth) ctx.drawImage(pImg, apx, apy);
        drawNameTag(apx, apy, state.player.name, '#fff');
      }
    });
    depthItems.sort((a, b) => a.y - b.y);
    for (const item of depthItems) item.draw();
    for (const draw of topItems) draw(); // sempre por cima, nunca ocluido

    drawFloatingTexts(originX, originY, now);
    ctx.restore();
  }
  requestAnimationFrame(draw);
}

init().catch(e => { log('ERRO: ' + e.message); console.error(e); });
