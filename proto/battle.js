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
const PLAYER_MOVE_DUR = 750; // ms por passo do jogador (mais devagar - velocidade anterior cansava de assistir)
const CREATURE_MOVE_DUR = 700; // ms por passo de Pokemon (Charmander/selvagens)
const ZOOM_DEFAULT = 1.3; // camera parecida com o client real (1.8 deixava personagem/Pokemon grande demais)
let ZOOM = Number(localStorage.getItem('settings:zoom')) || ZOOM_DEFAULT;

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

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

// log e info ficam so no console (F12) - nao poluir a tela do jogo com texto
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

let mapData, tilesByKey = new Map(), collisionSet = new Set(), offsets = { disp: {} };
let mapItemsIndex = {};
let fallbackGroundId; // grama base repetida fora da area carregada (ver init())
// limites da zona da hunt (bounding box dos spawns originais + margem) -
// wander/fuga tem que respeitar isso, senao Oddish foge sem parar e some do
// mapa pra sempre com o Charmander perseguindo atras ("mete o pe e nunca
// mais aparece").
let huntBounds = { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
let flatSet = new Set(), topSet = new Set();
function layerOf(id) {
  // objeto ALTO (>1 tile) nunca pode ser "flat" (sempre embaixo, sem sort) -
  // fisicamente nao faz sentido pra uma arvore inteira, so pra decal rente ao
  // chao. 70 arvores grandes no mapa oddish estao classificadas onbottom/
  // borders no draworder.json (categoria do JOGO, nao nossa) e isso fazia o
  // personagem andar por cima delas sempre, direto a causa do bug reportado.
  const entry = mapItemsIndex[String(id)];
  const isTall = (entry?.height || TILE) > TILE;
  if (isTall) return 'sorted';
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
function typeIcon(type) {
  return loadImage(`${DATA}/assets/types/${type.toLowerCase()}.png`);
}
// "elev" = mecanismo classico de escada/plataforma: um item elevado empurra
// pra cima (na tela) tudo que fica em cima dele na mesma tile - inclusive
// quem esta em pe ali. Sem isso, andar por cima de uma "escada" no dado do
// jogo nao muda nada visualmente (achatado), só clareado sem sensacao de altura.
function tileElevation(x, y) {
  const t = tilesByKey.get(key(x, y));
  if (!t) return 0;
  let total = 0;
  for (const id of [t.ground, ...t.extras]) total += (offsets.elev?.[String(id)] || 0);
  return total;
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
function bfsPath(fromGx, fromGy, toGx, toGy, avoidKey) {
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
      if (!isGoal && (isBlocked(nx, ny) || k === avoidKey)) continue;
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
function stepToward(from, to, avoidKey) {
  if (Math.max(Math.abs(to.gx - from.gx), Math.abs(to.gy - from.gy)) <= 1) return null;
  const path = bfsPath(from.gx, from.gy, to.gx, to.gy, avoidKey);
  if (!path || path.length === 0) return null;
  return { nx: path[0].x, ny: path[0].y };
}
// passo pra LONGE de um perseguidor (foge) - mesma ideia do stepToward, so
// que maximiza distancia em vez de minimizar. Evita voltar pra tile de onde
// acabou de vir (senao entra num ping-pong A<->B infinito - o "dando ole").
function inHuntBounds(x, y) {
  return x >= huntBounds.minX && x <= huntBounds.maxX && y >= huntBounds.minY && y <= huntBounds.maxY;
}
function fleeStep(from, from_threat) {
  let best = null, bestDist = -Infinity;
  for (const [dx, dy] of NEIGHBORS8) {
    const nx = from.gx + dx, ny = from.gy + dy;
    if (nx === from.fromX && ny === from.fromY) continue;
    if (isBlocked(nx, ny) || !inHuntBounds(nx, ny)) continue;
    const d = Math.abs(from_threat.gx - nx) + Math.abs(from_threat.gy - ny);
    if (d > bestDist) { bestDist = d; best = { nx, ny }; }
  }
  if (!best) { // sem opcao alem de voltar - melhor voltar que travar parado
    for (const [dx, dy] of NEIGHBORS8) {
      const nx = from.gx + dx, ny = from.gy + dy;
      if (isBlocked(nx, ny) || !inHuntBounds(nx, ny)) continue;
      const d = Math.abs(from_threat.gx - nx) + Math.abs(from_threat.gy - ny);
      if (d > bestDist) { bestDist = d; best = { nx, ny }; }
    }
  }
  return best;
}
function randomStep(from) {
  const opts = NEIGHBORS8.filter(([dx, dy]) => !isBlocked(from.gx + dx, from.gy + dy) && inHuntBounds(from.gx + dx, from.gy + dy));
  if (!opts.length) return null;
  const [dx, dy] = opts[Math.floor(Math.random() * opts.length)];
  return { nx: from.gx + dx, ny: from.gy + dy };
}
const NEIGHBORS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
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
// IA de farm: nao escolhe so o mais perto, escolhe onde da mais XP por
// esforco. Pontua cada selvagem vivo por XP*(1+quantos outros vivos tem por
// perto) dividido pela distancia - premia ir pra um AGLOMERADO denso de
// bichos (mais mortes em sequencia sem precisar viajar de novo) em vez de
// so pegar o vizinho mais proximo isolado. Junto com o alvo TRAVADO
// (lockedTarget), o efeito e: limpa um aglomerado inteiro, so ai escolhe o
// proximo aglomerado - "sucessivamente" como pedido.
const CLUSTER_RADIUS = 6;
function bestHuntTarget(from) {
  let best = null, bestScore = -Infinity;
  for (const w of state.wilds) {
    if (!w.alive) continue;
    const d = dist(from, w);
    let nearby = 0;
    for (const o of state.wilds) {
      if (o !== w && o.alive && dist(w, o) <= CLUSTER_RADIUS) nearby++;
    }
    const xp = w.data.experience || 1;
    const score = (xp * (1 + nearby)) / (d + 1);
    if (score > bestScore) { bestScore = score; best = w; }
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
  const groundCount = new Map();
  for (const [x, y, z, tileId, extras] of map.tiles) {
    if (z !== groundZ) continue;
    tilesByKey.set(key(x, y), { ground: tileId, extras: (extras || []).map(e => e[0]) });
    groundCount.set(tileId, (groundCount.get(tileId) || 0) + 1);
  }
  // ground tile mais comum do mapa (geralmente grama base) - usado como
  // "preenchimento infinito" fora da area carregada, pra nunca aparecer
  // vazio preto na borda (ver fallbackGroundId em draw()).
  fallbackGroundId = [...groundCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  // lista de tiles andaveis pra sortear spawn aleatorio (calculado 1x, reusado).
  // restrito a uma caixa em torno dos spawns ORIGINAIS do hunt-config (+
  // margem), nao o mapa inteiro - senao o sorteio manda bicho/jogador pra
  // beirada do mapa carregado, onde da pra ver o "fim do mundo" (vazio preto
  // além da area de tiles que a hunt realmente usa).
  const HUNT_MARGIN = 12;
  if (huntConfig?.spawns?.length) {
    const xs = huntConfig.spawns.map(s => s.x), ys = huntConfig.spawns.map(s => s.y);
    huntBounds = {
      minX: Math.min(...xs) - HUNT_MARGIN, maxX: Math.max(...xs) + HUNT_MARGIN,
      minY: Math.min(...ys) - HUNT_MARGIN, maxY: Math.max(...ys) + HUNT_MARGIN,
    };
  }
  const walkableTiles = [];
  for (const [k] of tilesByKey) {
    const [x, y] = k.split(',').map(Number);
    if (x < huntBounds.minX || x > huntBounds.maxX || y < huntBounds.minY || y > huntBounds.maxY) continue;
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
    hp: charmData.baseHp, maxHp: charmData.baseHp, data: charmData, level: 1,
    spriteIdx: await loadCreatureIndex(charmData.looktype), lastAttack: 0, cooldownMs: 1200,
  });
  // icones de tipo elemental (fire.png, normal.png...) pra hotbar de poderes
  const attackTypes = [...new Set(charmData.attacks.map(a => a.type.toLowerCase()))];
  for (const t of attackTypes) typeIcon(t);

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
  if (!state.huntTarget) state.huntTarget = bestHuntTarget(state.charmander);
  return state.huntTarget;
}

function tick(ts) {
  const target = lockedTarget();

  // charmander vai DIRETO pro alvo assim que existe um (nao espera o jogador
  // chegar - o Pokemon corre na frente, que e o pedido: ele deve chegar
  // primeiro que o treinador). Sem alvo, fica parado esperando o jogador.
  if (!isMoving(state.charmander, ts)) {
    if (target && dist(state.charmander, target) > 1) {
      const step = stepToward(state.charmander, target, key(state.player.gx, state.player.gy));
      if (step) startMove(state.charmander, step.nx, step.ny, ts);
    }
  }

  // quem esta CACANDO e o Charmander, entao o treinador segue O CHARMANDER
  // (nao o alvo direto) - antes o jogador calculava rota propria pro
  // selvagem, o que fazia ele e o Charmander seguirem caminhos diferentes
  // e as vezes competirem pela mesma tile.
  if (!isMoving(state.player, ts)) {
    if (dist(state.player, state.charmander) > 1) {
      const step = stepToward(state.player, state.charmander, key(state.charmander.gx, state.charmander.gy));
      if (step) startMove(state.player, step.nx, step.ny, ts);
    }
  }

  // Oddish selvagem NAO fica parado: o alvo TRAVADO (o que o Charmander esta
  // perseguindo) e agressivo e avanca pra brigar; todos os OUTROS (nao-alvo)
  // fogem quando o Charmander chega perto - um de cada vez apanha, o resto
  // se espalha. Longe de tudo, vagueia a esmo.
  //
  // HISTERESE (limiar de entrada != limiar de saida): e assim que jogo idle
  // de verdade evita "ping-pong" - se entra e sai de "fugindo" no MESMO
  // limiar de distancia (ex: sempre <=4), qualquer oscilacao natural da
  // distancia (o proprio perseguidor tambem anda) faz o bicho trocar de
  // decisao toda hora, ziguezagueando. Com banda de histerese (entra <=3,
  // so sai >=6) o estado fica estavel enquanto a distancia oscila no meio.
  const FLEE_ENTER = 3, FLEE_EXIT = 6;
  for (const w of state.wilds) {
    if (!w.alive) continue;
    const dToCharm = dist(w, state.charmander);
    if (w !== target) {
      if (w.fleeing && dToCharm >= FLEE_EXIT) w.fleeing = false;
      else if (!w.fleeing && dToCharm <= FLEE_ENTER) w.fleeing = true;
    } else {
      w.fleeing = false;
    }
    if (isMoving(w, ts)) continue;
    if (w === target) {
      if (dToCharm > 1) {
        const step = stepToward(w, state.charmander);
        if (step) startMove(w, step.nx, step.ny, ts);
      }
    } else if (w.fleeing) {
      const step = fleeStep(w, state.charmander);
      if (step) startMove(w, step.nx, step.ny, ts);
    } else if (Math.random() < 0.15) {
      const step = randomStep(w);
      if (step) startMove(w, step.nx, step.ny, ts);
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
  state.debugInfo = `jogador (${state.player.gx},${state.player.gy}) | Charmander HP ${state.charmander.hp}/${state.charmander.maxHp} | Oddish vivos: ${aliveCount}/${state.wilds.length}`;
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

// hotbar de poderes do Charmander, estilo barra de skill (icone de tipo +
// numero + cooldown). Fica em coordenada de TELA fixa (fora do ctx.scale do
// ZOOM), centralizada embaixo. So o slot 0 (Fire Fang) e o que a IA de
// combate realmente usa agora - os outros mostram "bloqueado" ate o nivel
// de aprendizado (learnLevel), preparado pra quando tiver progressao de verdade.
const SLOT = 30, GAP = 4;
function drawHotbar(now) {
  const charm = state.charmander;
  if (!charm?.data) return;
  const attacks = charm.data.attacks;
  const totalW = attacks.length * SLOT + (attacks.length - 1) * GAP;
  const startX = Math.round((viewW - totalW) / 2);
  const y = viewH - SLOT - 18;

  attacks.forEach((atk, i) => {
    const x = startX + i * (SLOT + GAP);
    const locked = atk.learnLevel > (charm.level || 1);

    ctx.fillStyle = locked ? 'rgba(20,20,20,0.85)' : 'rgba(20,20,20,0.65)';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, SLOT, SLOT, 6);
    ctx.fill(); ctx.stroke();

    const icon = typeIcon(atk.type);
    if (icon?.complete && icon.naturalWidth) {
      ctx.globalAlpha = locked ? 0.35 : 1;
      ctx.drawImage(icon, x + 5, y + 5, SLOT - 10, SLOT - 10);
      ctx.globalAlpha = 1;
    }

    if (locked) {
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 2; ctx.strokeStyle = '#000';
      ctx.strokeText(`Lv${atk.learnLevel}`, x + SLOT / 2, y + SLOT / 2 + 3);
      ctx.fillText(`Lv${atk.learnLevel}`, x + SLOT / 2, y + SLOT / 2 + 3);
      ctx.textAlign = 'left';
    } else if (i === 0) {
      // unico poder realmente disparado pela IA de combate agora - mostra
      // cooldown de verdade
      const remain = Math.max(0, atk.cooldownMs - (now - charm.lastAttack));
      if (remain > 0) {
        const frac = remain / atk.cooldownMs;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x, y + SLOT * (1 - frac), SLOT, SLOT * frac);
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.lineWidth = 2; ctx.strokeStyle = '#000';
        const secs = (remain / 1000).toFixed(1);
        ctx.strokeText(secs, x + SLOT / 2, y + SLOT / 2 + 3);
        ctx.fillText(secs, x + SLOT / 2, y + SLOT / 2 + 3);
        ctx.textAlign = 'left';
      }
    }

    // numero do slot (estilo hotbar classico)
    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = '#ccc';
    ctx.fillText(String(i + 1), x + 3, y + SLOT - 3);
  });
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

    // fora da area carregada preenche com grama generica (fallbackGroundId)
    // em vez de deixar vazio - nunca mostra o "fim do mapa" (vazio preto),
    // da impressao de mapa infinito continuando alem do que foi baixado.
    const visible = [];
    for (let y = startY; y <= startY + tilesY; y++)
      for (let x = startX; x <= startX + tilesX; x++) {
        const t = tilesByKey.get(key(x, y)) || (fallbackGroundId != null ? { ground: fallbackGroundId, extras: [] } : null);
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
    // chao usa "overdraw" (1px a mais em cada tile) pra esconder costura
    // entre tiles vizinhas - aparece como listras finas por causa do ZOOM
    // fracionario (1.3x) com nearest-neighbor, onde a escala do canvas nao
    // cai certinho em pixel inteiro na tela. So o chao precisa disso (fecha
    // lado a lado sem espaco); decoracao tem borda transparente, nao precisa.
    function drawGround(id, px, py) {
      const img = terrainSprite(id);
      if (img?.complete && img.naturalWidth) {
        const [dx, dy] = offsets.disp?.[String(id)] || [0, 0];
        ctx.drawImage(img, px + dx, py + dy, img.naturalWidth + 1, img.naturalHeight + 1);
      }
    }
    function rowSpanOf(id) {
      const entry = mapItemsIndex[String(id)];
      return Math.max(1, Math.round((entry?.height || TILE) / TILE));
    }
    // chave de profundidade = linha da BASE visual do sprite, considerando
    // altura (rowSpanOf) E deslocamento vertical (offsets.disp.y). 159 tiles
    // usam disp.y grande (ate -32px, 1 tile inteira) pra empurrar o sprite
    // pra cima na tela sem mudar sua linha nos dados - ignorar isso deixava
    // decoracao "flutuando" fora do lugar no sort, causando personagem
    // aparecendo na frente de arvore que devia estar atras.
    function depthKeyOf(id, y) {
      const dispY = offsets.disp?.[String(id)]?.[1] || 0;
      return y + dispY / TILE + rowSpanOf(id) - 1;
    }
    // a maioria do chao e 32x32 (ordem entre eles nao importa), mas ~28
    // tiles de agua/borda sao 64x64 - se desenhados em qualquer ordem podem
    // cortar o chao vizinho. Ordena pela linha da BASE (mesmo truque usado
    // pra decoracao grande) so quando ha sprite >1 tile de altura por perto.
    const groundItems = visible.map(([x, y, t]) => ({
      y: depthKeyOf(t.ground, y),
      draw: () => drawGround(t.ground, Math.round(originX + x * TILE), Math.round(originY + y * TILE)),
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
    // "top"/"toppers" do draworder.json foram removidos do tratamento
    // especial "sempre por cima" - pra arvore/objeto GRANDE isso fazia o
    // personagem aparecer na frente de arvore que devia estar ocluindo ele.
    // Agora TUDO que nao e "flat" entra no mesmo sort por linha-base, sem
    // excecao - previsivel: na frente da arvore = arvore atras, atras da
    // arvore = arvore na frente.
    const depthItems = [];
    for (const [x, y, t] of visible) {
      const px = Math.round(originX + x * TILE), py = Math.round(originY + y * TILE);
      for (const id of t.extras) {
        if (layerOf(id) === 'flat') continue; // ja desenhado acima
        // arvore grande = 1 sprite so ocupando varias linhas (ex: 64x64 = 2
        // tiles de altura), ancorado no topo-esquerda. Se ordenar so pela
        // linha da ancora, uma entidade na linha de baixo (onde a arvore
        // "termina" visualmente) fica errada. Usa a linha da BASE do sprite.
        depthItems.push({ y: depthKeyOf(id, y), draw: () => drawExtra(id, px, py) });
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
      const wElev = tileElevation(w.gx, w.gy);
      depthItems.push({
        y: vis.y, draw: () => {
          const img = creatureSprite(w.spriteIdx, w.data.looktype, walkFrame(w, now), w.dir);
          const px = Math.round(originX + vis.x * TILE), py = Math.round(originY + vis.y * TILE) - wElev;
          if (img?.complete && img.naturalWidth) ctx.drawImage(img, px, py);
          drawHpBar(px, py, w.hp, w.maxHp);
          drawNameTag(px, py, 'Oddish', '#ff8a8a');
        }
      });
    }
    {
      const vis = visualPos(state.charmander, now);
      const cElev = tileElevation(state.charmander.gx, state.charmander.gy);
      depthItems.push({
        y: vis.y, draw: () => {
          const img = creatureSprite(state.charmander.spriteIdx, state.charmander.data.looktype, walkFrame(state.charmander, now), state.charmander.dir);
          const px = Math.round(originX + vis.x * TILE), py = Math.round(originY + vis.y * TILE) - cElev;
          if (img?.complete && img.naturalWidth) ctx.drawImage(img, px, py);
          drawHpBar(px, py, state.charmander.hp, state.charmander.maxHp);
          drawNameTag(px, py, 'Charmander', '#6f6', 12);
        }
      });
    }
    const pElev = tileElevation(state.player.gx, state.player.gy);
    depthItems.push({
      y: playerVis.y, draw: () => {
        const apx = Math.round(originX + playerVis.x * TILE), apy = Math.round(originY + playerVis.y * TILE) - pElev;
        const pImg = creatureSprite(state.player.spriteIdx, state.player.outfitId, walkFrame(state.player, now), state.player.dir);
        if (pImg?.complete && pImg.naturalWidth) ctx.drawImage(pImg, apx, apy);
        drawNameTag(apx, apy, state.player.name, '#fff');
      }
    });
    depthItems.sort((a, b) => a.y - b.y);
    for (const item of depthItems) item.draw();

    drawFloatingTexts(originX, originY, now);
    ctx.restore();
    drawHotbar(now); // coordenada de tela fixa, fora do zoom do mapa
  }
  requestAnimationFrame(draw);
}

init().catch(e => { log('ERRO: ' + e.message); console.error(e); });

// ---- paineis modulares (arrastaveis, posicao salva) ----
// base reusavel: qualquer .panel com um filho [data-drag-handle] vira
// arrastavel e lembra onde o usuario deixou (localStorage), sobrevive a
// reload. Primeiro painel: minimapa; inventario/pokebag entram depois
// reusando a mesma funcao.
function makeDraggable(panel) {
  const handle = panel.querySelector('[data-drag-handle]');
  const storeKey = 'panelPos:' + panel.id;
  const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
  if (saved) {
    panel.style.left = saved.left; panel.style.top = saved.top;
    panel.style.right = ''; panel.style.bottom = '';
  }
  let dragging = false, offX = 0, offY = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offX = e.clientX - rect.left; offY = e.clientY - rect.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const maxLeft = window.innerWidth - panel.offsetWidth;
    const maxTop = window.innerHeight - panel.offsetHeight;
    const x = Math.max(0, Math.min(maxLeft, e.clientX - offX));
    const y = Math.max(0, Math.min(maxTop, e.clientY - offY));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
    panel.style.right = ''; panel.style.bottom = '';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    localStorage.setItem(storeKey, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
  });
}
document.querySelectorAll('.panel:not(.fixed-in-stack)').forEach(makeDraggable);

// botao de minimizar: colapsa o panel-body, estado tambem persistido
function setupMinimize(panel) {
  const btn = panel.querySelector('[data-minimize-btn]');
  if (!btn) return;
  const storeKey = 'panelMin:' + panel.id;
  if (localStorage.getItem(storeKey) === '1') panel.classList.add('minimized');
  btn.addEventListener('mousedown', e => e.stopPropagation()); // nao inicia o drag
  btn.addEventListener('click', () => {
    const min = panel.classList.toggle('minimized');
    localStorage.setItem(storeKey, min ? '1' : '0');
    btn.textContent = min ? '+' : '-';
  });
  if (panel.classList.contains('minimized')) btn.textContent = '+';
}
document.querySelectorAll('.panel').forEach(setupMinimize);

// ---- painel de time (trocavel) ----
// cada entrada guarda os proprios dados/sprite; trocar de ativo so troca o
// que o state.charmander representa (posicao/IA continuam as mesmas, so a
// "casca" - especie, hp, sprite - muda pro Pokemon selecionado).
let partyRoster = [];
async function setupParty() {
  const creatures = await fetch(`${DATA}/game/creatures.json`).then(r => r.json());
  const names = ['Umbreon', 'Dragonite', 'Charmander'];
  partyRoster = [];
  for (const name of names) {
    const data = creatures.creatures.find(c => c.name === name);
    if (!data) continue;
    const spriteIdx = await loadCreatureIndex(data.looktype);
    partyRoster.push({ name, data, spriteIdx, hp: data.baseHp, maxHp: data.baseHp });
  }
  partyActiveIdx = partyRoster.findIndex(p => p.name === 'Charmander');
  if (partyActiveIdx < 0) partyActiveIdx = 0;
  renderParty(partyActiveIdx);
  setInterval(() => renderParty(partyActiveIdx), 300); // mantem HP do card ativo atualizado
}
let partyActiveIdx = 0;
// portado de landing-page/src/features/fidelize/FidelizePanel.jsx - mesma
// estrutura/CSS (prefixo fz-), so trocando PokeAPI/React por DOM puro e
// sprites locais ja recortados. Treinador usa a mini-arte 100% CSS do
// FidelizePanel (nao a sprite do outfit 159, que so tem pose de arremesso).
function renderParty(activeIdx) {
  const listEl = document.getElementById('party-list');
  listEl.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'party-box';
  listEl.appendChild(el);

  const locationName = MAP_SLUG.charAt(0).toUpperCase() + MAP_SLUG.slice(1);
  const playerCard = document.createElement('section');
  playerCard.className = 'fz-player-card';
  playerCard.innerHTML = `
    <div class="fz-portrait">
      <span class="fz-trainer" aria-hidden="true">
        <span class="fz-trainer-cap"></span>
        <span class="fz-trainer-hair"></span>
        <span class="fz-trainer-face"></span>
        <span class="fz-trainer-shirt"></span>
        <span class="fz-trainer-shadow"></span>
      </span>
    </div>
    <div>
      <strong class="fz-player-name">${(state.player?.name || 'JOGADOR').toUpperCase()}</strong>
      <div class="fz-player-meta">
        <span class="fz-level-badge"><b>LV</b><span>1</span></span>
        <span>${locationName}</span>
      </div>
      <div class="fz-stat-line"><span>XP</span><b>0%</b></div>
      <span class="fz-progress"><span style="width:0%"></span></span>
    </div>`;
  el.appendChild(playerCard);

  const active = partyRoster[activeIdx];
  if (active && state.charmander) {
    active.hp = state.charmander.hp; active.maxHp = state.charmander.maxHp;
    const aImg = creatureSprite(active.spriteIdx, active.data.looktype, 1, 3);
    const pokemonCard = document.createElement('section');
    pokemonCard.className = 'fz-pokemon-card';
    const hpPct = Math.max(0, active.hp / active.maxHp * 100);
    pokemonCard.innerHTML = `
      <div class="fz-pokemon-portrait"><img class="fz-sprite" src="${aImg.src}"></div>
      <div>
        <div class="fz-pokemon-title"><strong>${active.name}</strong><span>Lv.1</span></div>
        <div class="fz-stat-line fz-hp-line"><span>HP</span><b>${Math.max(0, Math.round(active.hp))} <i>/</i> ${active.maxHp}</b></div>
        <span class="fz-progress fz-progress-hp"><span style="width:${hpPct}%"></span></span>
        <div class="fz-stat-line fz-xp-line"><span>XP</span><b>0%</b></div>
        <span class="fz-progress"><span style="width:0%"></span></span>
      </div>`;
    el.appendChild(pokemonCard);
  }

  const partyRow = document.createElement('section');
  partyRow.className = 'fz-party';
  partyRoster.forEach((p, i) => {
    const img = creatureSprite(p.spriteIdx, p.data.looktype, 1, 3);
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'fz-party-slot' + (i === activeIdx ? ' active' : '');
    slot.title = p.name;
    slot.innerHTML = `<img class="fz-sprite" src="${img.src}"><span>${i + 1}</span>`;
    slot.addEventListener('click', () => switchActivePokemon(i));
    partyRow.appendChild(slot);
  });
  for (let i = partyRoster.length; i < 6; i++) {
    const empty = document.createElement('span');
    empty.className = 'fz-party-empty';
    partyRow.appendChild(empty);
  }
  el.appendChild(partyRow);
}
function switchActivePokemon(idx) {
  const p = partyRoster[idx];
  if (!p || !state.charmander) return;
  // guarda o HP atual do que estava ativo antes de trocar
  const prevActive = partyRoster.find(x => x.data === state.charmander.data);
  if (prevActive) { prevActive.hp = state.charmander.hp; prevActive.maxHp = state.charmander.maxHp; }
  Object.assign(state.charmander, {
    data: p.data, spriteIdx: p.spriteIdx, hp: p.hp, maxHp: p.maxHp, level: 1, lastAttack: 0,
  });
  partyActiveIdx = idx;
  renderParty(idx);
}
setupParty();

// ---- Mochila (itens comuns) e PokeBag (pokebolas - estoque infinito) ----
// dados de exemplo (ainda nao ha economia/drop real implementado) so pra
// validar o layout de grade de itens com contador empilhado.
function renderItemGrid(elId, entries) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  for (const { icon, count } of entries) {
    const slot = document.createElement('div');
    slot.className = 'item-slot';
    slot.innerHTML = `<img src="${icon}"><span class="item-count">${count}</span>`;
    el.appendChild(slot);
  }
}
renderItemGrid('mochila-grid', [
  { icon: `${DATA}/assets/items/seed.png`, count: 373 },
  { icon: `${DATA}/assets/items/bottles_of_poison.png`, count: 45 },
  { icon: `${DATA}/assets/items/bag_of_pollen.png`, count: 135 },
  { icon: `${DATA}/assets/items/strange_flower.png`, count: 40 },
  { icon: `${DATA}/assets/items/strange_pheromone.png`, count: 13 },
]);
// pokebola empilha infinito - mostra "inf" em vez de um numero, deixa
// explicito que nao ha limite de estoque (diferente da mochila normal)
renderItemGrid('pokebag-grid', [
  { icon: `${DATA}/assets/topmenu/pokemon.png`, count: '∞' },
  { icon: `${DATA}/assets/topmenu/pokemon.png`, count: '∞' },
  { icon: `${DATA}/assets/topmenu/pokemon.png`, count: '∞' },
]);

// ---- engrenagem de configuracoes ----
const gearBtn = document.getElementById('settings-gear');
const settingsPanel = document.getElementById('panel-settings');
gearBtn.addEventListener('click', () => {
  settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('settings-close').addEventListener('click', e => {
  e.stopPropagation();
  settingsPanel.style.display = 'none';
});

const ZOOM_PRESETS = [
  { label: '1.0x', value: 1.0 },
  { label: '1.3x', value: 1.3 },
  { label: '1.8x', value: 1.8 },
];
function renderZoomPresets() {
  const el = document.getElementById('zoom-presets');
  el.innerHTML = '';
  for (const preset of ZOOM_PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = preset.label;
    const active = Math.abs(ZOOM - preset.value) < 0.001;
    btn.style.cssText = `flex:1; padding:5px 0; font:bold 11px monospace; border-radius:4px; cursor:pointer; border:1px solid #555; background:${active ? '#e0a83a' : '#2a2a2a'}; color:${active ? '#000' : '#eee'};`;
    btn.addEventListener('click', () => {
      ZOOM = preset.value;
      localStorage.setItem('settings:zoom', String(ZOOM));
      renderZoomPresets();
    });
    el.appendChild(btn);
  }
}
renderZoomPresets();

// minimapa: escala a area da hunt (huntBounds) pro tamanho do canvas do
// painel, plota jogador/Charmander/selvagens como pontinhos.
function drawMinimap() {
  const canvas = document.getElementById('minimap-canvas');
  if (!canvas || !state.player || !state.charmander || !isFinite(huntBounds.minX)) return;
  const mctx = canvas.getContext('2d');
  mctx.fillStyle = '#0a2410';
  mctx.fillRect(0, 0, canvas.width, canvas.height);
  const w = huntBounds.maxX - huntBounds.minX, h = huntBounds.maxY - huntBounds.minY;
  const scale = Math.min(canvas.width / w, canvas.height / h);
  const toPx = (gx, gy) => [(gx - huntBounds.minX) * scale, (gy - huntBounds.minY) * scale];

  for (const w2 of state.wilds) {
    if (!w2.alive) continue;
    const [x, y] = toPx(w2.gx, w2.gy);
    mctx.fillStyle = w2 === state.huntTarget ? '#ffe14d' : '#ff8a8a';
    mctx.fillRect(x - 1, y - 1, 3, 3);
  }
  {
    const [x, y] = toPx(state.charmander.gx, state.charmander.gy);
    mctx.fillStyle = '#ff7a1f';
    mctx.fillRect(x - 1, y - 1, 3, 3);
  }
  {
    const [x, y] = toPx(state.player.gx, state.player.gy);
    mctx.fillStyle = '#4fc3ff';
    mctx.beginPath(); mctx.arc(x, y, 2, 0, Math.PI * 2); mctx.fill();
  }
}
setInterval(drawMinimap, 200);
