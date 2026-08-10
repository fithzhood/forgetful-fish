// Forgetful Fish — Dandân format vs AI
// Engine: shared 80-card library + shared graveyard, full stack & priority.
'use strict';

const H = 'human', A = 'ai';
const $ = id => document.getElementById(id);
const other = p => (p === H ? A : H);
const BASIC_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
const SAVE_KEY = 'forgetful-fish:save';
const SET_KEY = 'forgetful-fish:settings';

let G = null;           // full game state
let uiMode = 'idle';    // idle | main | respond | attack | block | target
let uiCtx = {};         // context for current ui mode
let prevZoneIds = new Set(); // for enter-animations

// ---------- tiny utils ----------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function aiDelay() { return 400 + Math.random() * 500; }
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.add('hidden'), 2000);
}

// ---------- card helpers ----------
const cdb = key => CARD_DB[key];
function inst(iid) { return G.cards[iid]; }
function keyOf(iid) { return G.cards[iid].key; }
function isLandKey(k) { return cdb(k).type.includes('Land'); }
function isCreatureKey(k) { return cdb(k).type.includes('Creature'); }
function isInstantKey(k) { return cdb(k).type === 'Instant'; }
function isSorceryKey(k) { return cdb(k).type === 'Sorcery'; }
function isSpellKey(k) { return !isLandKey(k); }

// parse '{2}{U}{U}' -> {generic:2, U:2, R:0}
function parseCost(str) {
  const c = { generic: 0, U: 0, R: 0 };
  (str.match(/\{[^}]+\}/g) || []).forEach(sym => {
    const s = sym.slice(1, -1);
    if (s === 'U') c.U++;
    else if (s === 'R') c.R++;
    else if (/^\d+$/.test(s)) c.generic += parseInt(s, 10);
  });
  return c;
}

// ---------- permanents ----------
let permSeq = 0;
function newPerm(p, opts) {
  const pid = 'p' + (++permSeq);
  const perm = Object.assign({
    pid, iid: null, key: null, controller: p, tapped: false,
    enteredTurn: G.turn.n, isToken: false, mods: [], damage: 0,
  }, opts);
  G.perms[pid] = perm;
  G.players[p].field.push(pid);
  return perm;
}
function permOf(pid) { return G.perms[pid]; }
function fieldOf(p) { return G.players[p].field.map(permOf); }
function removePerm(pid) {
  const perm = G.perms[pid];
  if (!perm) return;
  const f = G.players[perm.controller].field;
  const i = f.indexOf(pid);
  if (i >= 0) f.splice(i, 1);
  delete G.perms[pid];
}

// Dance of the Skywise: becomes 4/4 Dragon Illusion, loses abilities
function danceMod(perm) { return perm.mods.find(m => m.kind === 'dance'); }
function abilitiesActive(perm) { return !danceMod(perm); }

function getPT(perm) {
  if (danceMod(perm)) return [4, 4];
  const d = cdb(perm.key);
  return [parseInt(d.power || 0, 10), parseInt(d.toughness || 0, 10)];
}
function hasFlying(perm) { return !!danceMod(perm); }

// land types, read through text-change modifiers and global Vision Charm effects
function landTypesOf(perm) {
  if (!isLandKey(perm.key)) return [];
  let types = [];
  const t = cdb(perm.key).type;
  BASIC_TYPES.forEach(bt => { if (t.includes(bt)) types.push(bt); });
  perm.mods.forEach(m => {
    if (m.kind === 'textWord') types = types.map(x => (x === m.from ? m.to : x));
  });
  (G.globalMods || []).forEach(m => {
    if (m.kind === 'landTypeAll') types = types.map(x => (x === m.from ? m.to : x));
  });
  return types;
}
function controlsLandType(p, type) {
  return fieldOf(p).some(perm => landTypesOf(perm).includes(type));
}
// the land type word printed on a Dandân ("Island" unless Mind Bend changed it)
function dandanIslandWord(perm) {
  let w = 'Island';
  perm.mods.forEach(m => { if (m.kind === 'textWord' && m.from === w) w = m.to; });
  return w;
}
const TYPE_IT = { Plains: 'Pianura', Island: 'Isola', Swamp: 'Palude', Mountain: 'Montagna', Forest: 'Foresta' };

// ---------- mana ----------
// production by card identity (kept simple on purpose; type-changed lands still
// produce their printed mana — the format's tricks target Dandân checks, not mana)
function landProduction(perm) {
  if (perm.key === 'Izzet Boilerworks') return { U: 1, R: 1, both: true };
  if (perm.key === 'Temple of Epiphany') return { U: 1, R: 1, both: false }; // U or R
  return { U: 1, R: 0, both: false };
}
function untappedLands(p) { return fieldOf(p).filter(x => isLandKey(x.key) && !x.tapped); }

// can p pay cost? floating mana pool counts too
function canPay(p, cost) {
  const pool = G.players[p].pool;
  let needU = Math.max(0, cost.U - pool.U);
  let needR = Math.max(0, cost.R - pool.R);
  let needG = Math.max(0, cost.generic - Math.max(0, pool.U - cost.U) - Math.max(0, pool.R - cost.R));
  const lands = untappedLands(p);
  // greedy: R from temples/boilerworks, U from anything, generic from the rest
  let avail = lands.map(l => ({ l, prod: landProduction(l), used: false }));
  for (const a of avail) {
    if (needR <= 0) break;
    if (a.prod.R) { a.used = true; needR--; if (a.prod.both && needU > 0) needU--; else if (a.prod.both) needG--; }
  }
  if (needR > 0) return false;
  for (const a of avail) {
    if (needU <= 0) break;
    if (!a.used && a.prod.U) { a.used = true; needU--; if (a.prod.both && needG > 0) needG--; }
  }
  if (needU > 0) return false;
  for (const a of avail) {
    if (needG <= 0) break;
    if (!a.used) { a.used = true; needG -= a.prod.both ? 2 : 1; }
  }
  return needG <= 0;
}

// actually tap lands / drain pool for cost (assumes canPay)
function payCost(p, cost) {
  const pool = G.players[p].pool;
  let needU = cost.U, needR = cost.R, needG = cost.generic;
  // pool first
  const useU = Math.min(pool.U, needU); pool.U -= useU; needU -= useU;
  const useR = Math.min(pool.R, needR); pool.R -= useR; needR -= useR;
  let spare = pool.U + pool.R;
  const useG = Math.min(spare, needG);
  for (let i = 0; i < useG; i++) { if (pool.U > 0) pool.U--; else pool.R--; }
  needG -= useG;
  const lands = untappedLands(p);
  const tapped = [];
  const tapIt = l => { l.tapped = true; tapped.push(l); };
  // R first (temple/boilerworks)
  for (const l of lands) {
    if (needR <= 0) break;
    const pr = landProduction(l);
    if (pr.R && !l.tapped) {
      tapIt(l); needR--;
      if (pr.both) { if (needU > 0) needU--; else if (needG > 0) needG--; else pool.U++; }
    }
  }
  // U from plain islands first, keep flexible lands for later
  const plain = lands.filter(l => !l.tapped && !landProduction(l).R);
  const flex = lands.filter(l => !l.tapped && landProduction(l).R);
  for (const l of plain.concat(flex)) {
    if (needU <= 0) break;
    const pr = landProduction(l);
    tapIt(l); needU--;
    if (pr.both) { if (needG > 0) needG--; else pool.R++; }
  }
  for (const l of plain.concat(flex)) {
    if (needG <= 0) break;
    if (l.tapped) continue;
    const pr = landProduction(l);
    tapIt(l); needG -= pr.both ? 2 : 1;
  }
  if (needG < 0) pool.U += -needG; // overpaid with a boilerworks: float the rest
  return tapped;
}
function clearPools() { G.players[H].pool = { U: 0, R: 0 }; G.players[A].pool = { U: 0, R: 0 }; }

// The human pays only from mana already in their pool (they tap lands manually);
// the AI still auto-taps its lands (canPay / payCost) since it has no UI.
function poolCovers(p, cost) {
  const pool = G.players[p].pool;
  if (pool.U < cost.U || pool.R < cost.R) return false;
  return (pool.U - cost.U) + (pool.R - cost.R) >= cost.generic;
}
function payFromPool(p, cost) {
  const pool = G.players[p].pool;
  pool.U -= cost.U; pool.R -= cost.R;
  let g = cost.generic;
  while (g-- > 0) { if (pool.U >= pool.R) pool.U--; else pool.R--; } // spend the surplus color
}
function affordable(p, cost) { return p === A ? canPay(p, cost) : poolCovers(p, cost); }
function payFor(p, cost) { return p === A ? payCost(p, cost) : payFromPool(p, cost); }

// Does the human have any instant-speed play available IF they tapped their lands?
// Used to decide whether to stop and offer them priority (they haven't pooled yet).
function hasPotentialResponse() {
  return handOf(H).some(iid => {
    const k = keyOf(iid);
    if (isInstantKey(k)) return canPay(H, parseCost(cdb(k).cost)) && effectHasLegalUse(k, H);
    const cc = cyclingCost(k);
    return cc && canPay(H, cc);
  });
}
// Can the human tap lands for mana right now?
function canTapForMana() {
  if (!G || G.over || G.pending) return false;
  return uiMode === 'main' || uiMode === 'respond';
}

// ---------- zones ----------
function zoneRemove(iid) {
  [G.library, G.graveyard, G.exile, G.players[H].hand, G.players[A].hand].forEach(z => {
    const i = z.indexOf(iid);
    if (i >= 0) z.splice(i, 1);
  });
}
function toGraveyard(iid) { zoneRemove(iid); G.graveyard.push(iid); }
function toExile(iid) { zoneRemove(iid); G.exile.push(iid); }
function toLibraryTop(iid) { zoneRemove(iid); G.library.unshift(iid); }
function toLibraryBottom(iid) { zoneRemove(iid); G.library.push(iid); }
function toHand(iid, p) { zoneRemove(iid); G.cards[iid].owner = p; G.players[p].hand.push(iid); }
function handOf(p) { return G.players[p].hand; }

// ---------- log ----------
function log(msg, cls) {
  G.log.push({ msg, cls: cls || '' });
  const el = $('log-list');
  if (el) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }
}
const nameIt = p => (p === H ? 'Tu' : 'IA');

// ============================================================
// GAME SETUP
// ============================================================
function freshGame() {
  permSeq = 0;
  const cards = {};
  const lib = [];
  let n = 0;
  Object.keys(CARD_DB).forEach(key => {
    for (let i = 0; i < CARD_DB[key].qty; i++) {
      const iid = 'c' + (++n);
      cards[iid] = { key, owner: null };
      lib.push(iid);
    }
  });
  shuffle(lib);
  return {
    cards, library: lib, graveyard: [], exile: [],
    stack: [], globalMods: [],
    players: {
      [H]: { life: 20, hand: [], field: [], pool: { U: 0, R: 0 }, landPlayed: false, freeMull: true, mulls: 0 },
      [A]: { life: 20, hand: [], field: [], pool: { U: 0, R: 0 }, landPlayed: false, freeMull: true, mulls: 0 },
    },
    perms: {},
    turn: { n: 1, active: H, phase: 'setup' },
    prio: null,
    pending: null,
    resume: null,
    combat: { attackers: [], blockers: {} },
    holdPriority: false,
    log: [],
    stats: { turns: 1, dmgByHuman: 0, dmgByAI: 0, countered: 0 },
    settings: loadSettings(),
    over: null,
  };
}

// ============================================================
// CHOICE SYSTEM
// ask(spec): spec = { player, kind, ...data, cb }
// human choices render UI; AI choices go through aiChoose after a delay.
// ============================================================
function ask(spec) {
  G.pending = spec;
  renderAll();
  if (spec.player === A) {
    setTimeout(() => { if (G.pending === spec) safeAI(() => aiChoose(spec)); }, aiDelay());
  } else {
    showHumanChoice(spec);
  }
}
function answer(result) {
  const spec = G.pending;
  if (!spec) return;
  G.pending = null;
  hidePrompt();
  spec.cb(result);
  renderAll();
}

// ============================================================
// TURN MACHINE
// ============================================================
const PHASE_IT = {
  untap: 'Stap', draw: 'Pesca', main1: 'Principale 1', attack: 'Attacco',
  block: 'Blocco', damage: 'Danno', main2: 'Principale 2', end: 'Fine turno', cleanup: 'Fine',
};
function phaseLabel() {
  const t = G.turn;
  return 'Turno ' + t.n + ' — ' + (t.active === H ? 'tuo' : 'IA') + ' — ' + (PHASE_IT[t.phase] || t.phase);
}

function beginTurn(p) {
  G.turn.active = p;
  G.turn.n++;
  G.stats.turns = G.turn.n;
  G.players[p].landPlayed = false;
  log('— Turno ' + G.turn.n + ': ' + (p === H ? 'tuo' : "dell'IA") + ' —', 'log-turn');
  if (p === H) toast('Tocca a te');
  setPhase('untap');
}

function setPhase(ph) {
  G.turn.phase = ph;
  clearPools();
  renderAll();
  saveGame();
  const p = G.turn.active;
  switch (ph) {
    case 'untap':
      fieldOf(p).forEach(perm => { perm.tapped = false; });
      setPhase('draw');
      break;
    case 'draw':
      if (G.turn.n === 1) { setPhase('main1'); break; } // starting player skips first draw
      drawCards(p, 1, () => { if (!G.over) setPhase('main1'); });
      break;
    case 'main1': case 'main2':
      if (p === A) aiMainPhase(ph);
      else setUiMode('main');
      break;
    case 'attack': startAttackStep(); break;
    case 'block': startBlockStep(); break;
    case 'damage': combatDamage(); break;
    case 'end': endStep(); break;
    case 'cleanup': cleanupStep(); break;
  }
}

// ---------- draw / deck-out ----------
function drawCards(p, nCards, cb) {
  let i = 0;
  const one = () => {
    if (G.over) { if (cb) cb(); return; }
    if (i++ >= nCards) { if (cb) cb(); return; }
    if (G.library.length === 0) {
      if (G.settings.reshuffle && G.graveyard.length > 0) {
        log('Libreria esaurita: il cimitero viene rimescolato nella libreria (house rule).');
        G.library = shuffle(G.graveyard.slice());
        G.graveyard = [];
      } else {
        gameOver(other(p), p === H ? 'Hai dovuto pescare da una libreria vuota.' : "L'IA ha dovuto pescare da una libreria vuota.");
        if (cb) cb();
        return;
      }
    }
    const iid = G.library.shift();
    toHand(iid, p);
    if (p === H) log('Peschi ' + cdb(keyOf(iid)).name + '.', 'log-me');
    else log("L'IA pesca una carta.", 'log-ai');
    renderAll();
    one();
  };
  one();
}

// ---------- casting legality ----------
function legalSorcerySpeed(p) {
  return G.turn.active === p && (G.turn.phase === 'main1' || G.turn.phase === 'main2') &&
    G.stack.length === 0 && !G.pending && G.prio === null;
}
function castableFromHand(p, iid) {
  const k = keyOf(iid);
  const d = cdb(k);
  if (isLandKey(k)) return legalSorcerySpeed(p) && !G.players[p].landPlayed;
  const cost = parseCost(d.cost);
  if (!affordable(p, cost)) return false;
  if (isSorceryKey(k)) return legalSorcerySpeed(p) && effectHasLegalUse(k, p);
  // instant
  if (legalSorcerySpeed(p)) return effectHasLegalUse(k, p);
  if (uiModeAllowsInstant(p)) return effectHasLegalUse(k, p);
  return false;
}
function uiModeAllowsInstant(p) {
  return G.prio !== null || (uiCtx.window && uiCtx.windowPlayer === p);
}
function effectHasLegalUse(k, p) {
  const eff = cardEffects[k];
  if (!eff) return true;
  if (eff.legal && !eff.legal(p)) return false;
  /* Una carta A PIU' MODI si guarda modo per modo: le basta UN modo legale.
     Chiedendo i bersagli senza dire quale modo — `targets(p, null)` — una
     carta come Vision Charm risponde "nessuno", perche' i suoi bersagli
     dipendono dal modo scelto; e "nessun bersaglio" voleva dire "non
     lanciabile". Risultato: Vision Charm non si poteva giocare MAI, pur
     funzionando benissimo quando il motore la risolveva. */
  if (eff.modes) return eff.modes(p).some(m => m.legal);
  if (!eff.targets) return true;
  return eff.targets(p, null).length > 0;
}
function cyclingCost(k) {
  const m = cdb(k).text.match(/Cycling \{(\w)\}/i);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? { generic: parseInt(m[1], 10), U: 0, R: 0 } : { generic: 0, U: 1, R: 0 };
}
function canCycle(p, iid) {
  const cc = cyclingCost(keyOf(iid));
  if (!cc) return false;
  if (!affordable(p, cc)) return false;
  return legalSorcerySpeed(p) || uiModeAllowsInstant(p);
}
function doCycle(p, iid) {
  payFor(p, cyclingCost(keyOf(iid)));
  log(nameIt(p) + ': cicla ' + cdb(keyOf(iid)).name + '.', p === H ? 'log-me' : 'log-ai');
  toGraveyard(iid);
  drawCards(p, 1, () => {
    if (G.prio) { G.prio.passed[H] = false; G.prio.passed[A] = false; priorityTo(other(p)); }
    else if (uiCtx.window) { const w = uiCtx.windowNext; uiCtx = {}; if (w) w(); }
    else afterAction(p);
  });
}

// play a land (no stack)
/* Una terra che ENTRA sul campo, da qualunque strada arrivi: giocata per il
   turno, oppure messa li' da un effetto (Metamorphose). Le due cose che
   devono succedere sempre sono qui dentro, in un posto solo, perche' prima
   una delle due strade se le perdeva entrambe.

   "This land enters tapped" vale per OGNI terra che lo dice, anche per quelle
   che non hanno nessun effetto d'entrata: prima la riga che tappava era
   dentro un `if (etb && ...)`, e Lonely Sandbar, Remote Isle e Svyelunite
   Temple — che dicono tutte e tre di entrare tappate ma non hanno un ETB —
   entravano stappate, cioe' regalavano un mana di tempo.
   Mystic Sanctuary e' l'eccezione vera: la sua non e' una regola ma una
   CONDIZIONE ("unless you control three or more other Islands"), e se la
   calcola da sola nel proprio effetto d'entrata. */
function entraInCampo(p, opts, done) {
  const perm = newPerm(p, opts);
  if (perm.key !== 'Mystic Sanctuary' && (cdb(perm.key).text || '').includes('enters tapped')) {
    perm.tapped = true;
  }
  renderAll();          // la terra si vede PRIMA della domanda che la riguarda
  const etb = landETB[perm.key];
  if (etb) etb(perm, () => done(perm));
  else done(perm);
  return perm;
}
function playLand(p, iid) {
  zoneRemove(iid);
  G.players[p].landPlayed = true;
  const key = keyOf(iid);
  log(nameIt(p) + ': gioca ' + cdb(key).name + '.', p === H ? 'log-me' : 'log-ai');
  entraInCampo(p, { iid, key }, () => afterAction(p));
}

// cast a spell: modes -> targets -> pay -> stack -> priority
function castSpell(p, iid, done, modo) {
  const k = keyOf(iid);
  const eff = cardEffects[k];
  const item = {
    id: 's' + Math.random().toString(36).slice(2, 8),
    iid, key: k, controller: p, targets: [], mode: null, chosen: {}, isCopy: false, countered: false,
  };
  const finish = () => {
    payFor(p, parseCost(cdb(k).cost));
    zoneRemove(iid);
    const wasPrio = G.prio !== null;
    const wasWindow = uiCtx.window ? { next: uiCtx.windowNext } : null;
    G.stack.push(item);
    log(nameIt(p) + ': lancia ' + cdb(k).name + describeTargets(item) + '.', p === H ? 'log-me' : 'log-ai');
    renderAll();
    if (wasWindow) { G.resume = wasWindow.next; uiCtx = {}; }
    if (wasPrio) stackReset(p);
    else openPriority(other(p));
    if (done) done(true);
  };
  const pickTargets = () => {
    if (!eff || !eff.targets) return finish();
    const legal = eff.targets(p, item);
    if (legal.length === 0) return finish();
    ask({
      player: p, kind: 'target', options: legal, item, cancellable: true,
      title: eff.targetHint ? eff.targetHint(item) : 'Scegli il bersaglio per ' + cdb(k).name,
      cb: t => { if (t === null) { if (done) done(false); return; } item.targets = [t]; finish(); },
    });
  };
  if (eff && eff.modes) {
    const modi = eff.modes(p);
    /* Il modo NON si chiede piu' a ogni lancio. Giocando una carta — con un
       tocco o portandola sul tavolo — si usa il PRIMO MODO LEGALE, che e'
       quello che si vuole nove volte su dieci; i modi alternativi si scelgono
       apposta, dalla pressione lunga sulla carta, che li passa qui in `modo`.
       Chiedere sempre voleva dire un foglio da leggere prima di ogni Vision
       Charm, anche quando di modi legali ce n'era uno solo.
       All'IA la domanda resta: e' lei a valutare quale modo le conviene. */
    if (modo !== undefined && modo !== null) {
      item.mode = modo;
      pickTargets();
    } else if (p === H) {
      const primo = modi.findIndex(m => m.legal);
      if (primo < 0) { if (done) done(false); return; }
      item.mode = primo;
      pickTargets();
    } else {
      ask({
        player: p, kind: 'option', item, cancellable: true,
        title: cdb(k).name + ' — scegli un modo',
        options: modi.map((m, i) => ({ label: m.label, value: i, disabled: !m.legal })),
        cb: mi => {
          if (mi === null) { if (done) done(false); return; }
          item.mode = mi;
          pickTargets();
        },
      });
    }
  } else pickTargets();
}
function describeTargets(item) {
  if (!item.targets.length) return '';
  return ' su ' + item.targets.map(t => targetName(t)).join(', ');
}
function targetName(t) {
  if (t.type === 'perm') { const pm = permOf(t.pid); return pm ? cdb(pm.key).name : '(svanito)'; }
  if (t.type === 'stack') { const it = G.stack.find(s => s.id === t.sid); return it ? cdb(it.key).name : '(risolto)'; }
  if (t.type === 'player') return t.p === H ? 'te' : "l'IA";
  if (t.type === 'gycard') return cdb(keyOf(t.iid)).name;
  return '?';
}

// ============================================================
// PRIORITY / STACK
// ============================================================
function openPriority(firstTo) {
  G.prio = { passed: { [H]: false, [A]: false } };
  renderAll();
  priorityTo(firstTo);
}
function priorityTo(p) {
  if (G.over) return;
  if (p === A) {
    setTimeout(() => { if (G.prio && !G.over && !G.pending) safeAI(aiRespond); }, aiDelay());
  } else {
    // Smart auto-pass: only stop for the human when there is an AI object on the
    // stack they could actually respond to (or they've toggled Hold). Their own
    // spell resolves without pestering them for a pass.
    const oppOnStack = G.stack.some(s => s.controller === A);
    if (!G.holdPriority && (!oppOnStack || !hasPotentialResponse())) { passPriority(H); return; }
    setUiMode('respond');
  }
}
// Never let an AI exception hard-hang the game: recover to a safe default.
function safeAI(fn) {
  try { fn(); }
  catch (e) {
    console.error('AI error, recovering:', e);
    try {
      if (G.pending && G.pending.player === A) { answer(null); return; }
      if (G.prio) passPriority(A);
    } catch (_) {}
  }
}
function passPriority(p) {
  if (!G.prio) return;
  G.prio.passed[p] = true;
  if (G.prio.passed[H] && G.prio.passed[A]) resolveTop();
  else priorityTo(other(p));
}
function stackReset(casterOfNew) {
  G.prio = { passed: { [H]: false, [A]: false } };
  renderAll();
  priorityTo(other(casterOfNew));
}
function resolveTop() {
  const item = G.stack.pop();
  G.prio = null;
  if (!item) { afterStackEmpty(); return; }
  renderAll();
  const eff = cardEffects[item.key];
  const finish = (skipGrave) => {
    if (!item.isCopy && !skipGrave && G.cards[item.iid] && !inAnyZone(item.iid)) toGraveyard(item.iid);
    checkState(() => {
      if (G.over) return;
      if (G.stack.length > 0) openPriority(other(G.stack[G.stack.length - 1].controller));
      else afterStackEmpty();
    });
  };
  if (item.countered) { finish(item.counterMode === 'lapse'); return; }
  if (item.targets.length > 0 && item.targets.every(t => !targetStillValid(t))) {
    log(cdb(item.key).name + ' svanisce: nessun bersaglio valido.');
    finish();
    return;
  }
  // Safety net: nothing without an effect should ever reach the stack (lands go
  // through playLand). If one does, it must still leave the stack, or the whole
  // turn machine stops here and the game freezes.
  if (!eff) {
    console.warn('resolveTop: nessun effetto per', item.key, item);
    log(cdb(item.key).name + ' non ha effetto: si risolve senza conseguenze.');
    finish();
    return;
  }
  log('Si risolve ' + cdb(item.key).name + '.');
  eff.resolve(item, finish);
}
function inAnyZone(iid) {
  return G.library.includes(iid) || G.graveyard.includes(iid) || G.exile.includes(iid) ||
    G.players[H].hand.includes(iid) || G.players[A].hand.includes(iid) ||
    Object.values(G.perms).some(pm => pm.iid === iid);
}
function targetStillValid(t) {
  if (t.type === 'perm') return !!permOf(t.pid);
  if (t.type === 'stack') return G.stack.some(s => s.id === t.sid);
  if (t.type === 'player') return true;
  if (t.type === 'gycard') return G.graveyard.includes(t.iid);
  return false;
}
function afterStackEmpty() {
  clearPools();
  const r = G.resume;
  G.resume = null;
  if (r) { r(); renderAll(); return; }
  if (G.turn.phase === 'main1' || G.turn.phase === 'main2') {
    if (G.turn.active === A) aiMainPhase(G.turn.phase);
    else setUiMode('main');
  }
  renderAll();
}
// after a main-phase action that used no stack (land drop etc.)
function afterAction(p) {
  checkState(() => {
    if (G.over) return;
    if (G.stack.length > 0) return;
    if (G.turn.phase === 'main1' || G.turn.phase === 'main2') {
      if (G.turn.active === A) aiMainPhase(G.turn.phase);
      else setUiMode('main');
    }
    renderAll();
  });
}

// ============================================================
// INSTANT-SPEED WINDOWS (combat steps, end step)
// ============================================================
function instantWindow(p, next, hint) {
  if (G.over) return;
  const proceed = () => { uiCtx = {}; next(); };
  if (p === A) {
    setTimeout(() => {
      safeAI(() => aiWindowAction(
        () => instantWindow(p, next, hint),  // resume after AI's spell resolves
        proceed                               // AI passes
      ));
    }, aiDelay() * 0.7);
    return;
  }
  const hasPlay = handOf(H).some(iid => {
    const k = keyOf(iid);
    if (isLandKey(k)) { const cc = cyclingCost(k); return cc && canPay(H, cc); }
    return isInstantKey(k) && canPay(H, parseCost(cdb(k).cost)) && effectHasLegalUse(k, H);
  });
  if (!hasPlay && !G.holdPriority) { proceed(); return; }
  uiCtx = { window: true, windowPlayer: H, windowNext: () => instantWindow(p, next, hint), windowPass: proceed, hint: hint };
  setUiMode('respond');
}

// ============================================================
// COMBAT
// ============================================================
function creatureCanAttack(perm) {
  if (perm.tapped) return false;
  if (!isCreatureOnField(perm)) return false;
  if (perm.enteredTurn === G.turn.n && !perm.mods.some(m => m.kind === 'haste')) return false;
  if (perm.key === 'Dandan' && abilitiesActive(perm)) {
    const w = dandanIslandWord(perm);
    if (!controlsLandType(other(perm.controller), w)) return false;
  }
  return true;
}
function isCreatureOnField(perm) {
  return isCreatureKey(perm.key) || danceMod(perm);
}
function creaturesOf(p) { return fieldOf(p).filter(isCreatureOnField); }

function startAttackStep() {
  const p = G.turn.active;
  /* Il combattimento precedente si azzera QUI, prima di chiedere: finche' la
     domanda "con chi attacchi?" e' aperta la fase e' gia' `attack`, e il
     centro mostrerebbe ancora "2 attaccanti · 8 danni" — quelli dell'IA, del
     turno prima. Si azzerava solo nella risposta, cioe' troppo tardi. */
  G.combat.attackers = [];
  G.combat.blockers = {};
  const eligible = creaturesOf(p).filter(creatureCanAttack);
  if (eligible.length === 0) { setPhase('main2'); return; }
  ask({
    player: p, kind: 'attackers', options: eligible.map(x => x.pid),
    title: 'Dichiara gli attaccanti',
    cb: pids => {
      G.combat.attackers = pids || [];
      G.combat.blockers = {};
      if (G.combat.attackers.length === 0) { setPhase('main2'); return; }
      G.combat.attackers.forEach(pid => { const pm = permOf(pid); if (pm) pm.tapped = true; });
      log(nameIt(p) + ': attacca con ' + G.combat.attackers.length + ' creatura/e.', p === H ? 'log-me' : 'log-ai');
      renderAll();
      // defender gets an instant window, then the attacker
      instantWindow(other(p), () => instantWindow(p, () => setPhase('block'),
        'Attaccanti dichiarati'), 'Attaccanti dichiarati: puoi rispondere');
    },
  });
}
function startBlockStep() {
  const defender = other(G.turn.active);
  // some attackers may have left the battlefield in response
  G.combat.attackers = G.combat.attackers.filter(pid => permOf(pid) && permOf(pid).controller === G.turn.active);
  if (G.combat.attackers.length === 0) { setPhase('main2'); return; }
  const canBlock = creaturesOf(defender).filter(x => !x.tapped);
  if (canBlock.length === 0) {
    G.combat.blockers = {};
    afterBlocks();
    return;
  }
  ask({
    player: defender, kind: 'blockers',
    attackers: G.combat.attackers.slice(), blockersAvail: canBlock.map(x => x.pid),
    title: 'Dichiara i bloccanti',
    cb: map => { G.combat.blockers = map || {}; afterBlocks(); },
  });
}
function afterBlocks() {
  const nb = Object.values(G.combat.blockers).reduce((s, a) => s + a.length, 0);
  if (nb > 0) log(nameIt(other(G.turn.active)) + ': blocca con ' + nb + ' creatura/e.', other(G.turn.active) === H ? 'log-me' : 'log-ai');
  renderAll();
  instantWindow(other(G.turn.active), () => instantWindow(G.turn.active, () => setPhase('damage'),
    'Bloccanti dichiarati'), 'Bloccanti dichiarati: puoi rispondere');
}
function combatDamage() {
  const atkP = G.turn.active, defP = other(atkP);
  let total = 0;
  G.combat.attackers.forEach(pid => {
    const atk = permOf(pid);
    if (!atk || atk.controller !== atkP) return; // stolen or gone
    const [pow] = getPT(atk);
    const declared = G.combat.blockers[pid] || [];
    const blockers = declared.map(permOf).filter(Boolean);
    if (declared.length > 0 && blockers.length === 0) {
      // was blocked but the blockers left the battlefield: no damage anywhere
      log(cdb(atk.key).name + ' era bloccato: nessun danno.');
      return;
    }
    if (blockers.length === 0) {
      G.players[defP].life -= pow;
      total += pow;
      if (atkP === H) G.stats.dmgByHuman += pow; else G.stats.dmgByAI += pow;
      log(cdb(atk.key).name + ' colpisce ' + (defP === H ? 'te' : "l'IA") + ' per ' + pow + '.', atkP === H ? 'log-me' : 'log-ai');
    } else {
      // attacker spreads its power across blockers in order; blockers hit back
      let rem = pow;
      blockers.forEach(b => {
        const [, btou] = getPT(b);
        const take = Math.min(rem, Math.max(0, btou - b.damage));
        b.damage += take;
        rem -= take;
        atk.damage += getPT(b)[0];
      });
      log(cdb(atk.key).name + ' viene bloccato.');
    }
  });
  renderAll();
  checkState(() => { if (!G.over) setPhase('main2'); });
}

// ============================================================
// STATE-BASED ACTIONS
// ============================================================
function checkState(cb) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of [H, A]) {
      if (G.players[p].life <= 0 && !G.over) {
        gameOver(other(p), p === H ? 'Sei sceso a 0 vite.' : "L'IA è scesa a 0 vite.");
        if (cb) cb();
        return;
      }
    }
    for (const perm of Object.values(G.perms)) {
      if (isCreatureOnField(perm)) {
        const [, tou] = getPT(perm);
        if (perm.damage >= tou && tou > 0) { destroyPerm(perm.pid, 'danni letali'); changed = true; break; }
      }
      if (perm.key === 'Dandan' && abilitiesActive(perm)) {
        const w = dandanIslandWord(perm);
        if (!controlsLandType(perm.controller, w)) {
          log(cdb(perm.key).name + ' viene sacrificato: ' + (perm.controller === H ? 'non controlli' : "l'IA non controlla") + ' terre di tipo ' + (TYPE_IT[w] || w) + '.');
          destroyPerm(perm.pid, 'sacrificio', true);
          changed = true; break;
        }
      }
    }
  }
  renderAll();
  if (cb) cb();
}
function destroyPerm(pid, cause, silent) {
  const perm = permOf(pid);
  if (!perm) return;
  if (!silent) log(cdb(perm.key).name + (perm.controller === H ? ' (tuo)' : " (IA)") + ' muore.');
  removePerm(pid);
  if (!perm.isToken && perm.iid) toGraveyard(perm.iid);
}

// ============================================================
// END STEP / CLEANUP
// ============================================================
function endStep() {
  instantWindow(other(G.turn.active), () => instantWindow(G.turn.active, () => setPhase('cleanup'),
    'Fine del turno'), 'Fine del turno: ultima occasione per gli istantanei');
}
function cleanupStep() {
  // expire end-of-turn modifiers
  for (const perm of Object.values(G.perms)) {
    const rayMods = perm.mods.filter(m => m.kind === 'control' && m.expires === 'eot');
    rayMods.forEach(m => {
      // return control
      const f = G.players[perm.controller].field;
      const i = f.indexOf(perm.pid);
      if (i >= 0) f.splice(i, 1);
      perm.controller = m.back;
      G.players[m.back].field.push(perm.pid);
      perm.tapped = true; // Ray of Command: tap when control is lost
      log(cdb(perm.key).name + ' torna sotto il controllo di ' + (m.back === H ? 'te' : "dell'IA") + ' (tappato).');
    });
    perm.mods = perm.mods.filter(m => m.expires !== 'eot');
    perm.damage = 0;
  }
  G.globalMods = (G.globalMods || []).filter(m => m.expires !== 'eot');
  const p = G.turn.active;
  const hand = handOf(p);
  const finish = () => {
    checkState(() => { if (!G.over) beginTurn(other(p)); });
  };
  if (hand.length > 7) {
    ask({
      player: p, kind: 'cards', zone: hand.slice(), min: hand.length - 7, max: hand.length - 7,
      title: 'Scarta fino ad avere 7 carte in mano',
      cb: iids => {
        (iids || []).forEach(iid => { toGraveyard(iid); });
        log(nameIt(p) + ': scarta ' + (iids || []).length + ' carta/e.', p === H ? 'log-me' : 'log-ai');
        finish();
      },
    });
  } else finish();
}

// ============================================================
// GAME OVER
// ============================================================
function gameOver(winner, reason) {
  if (G.over) return;
  G.over = { winner, reason };
  localStorage.removeItem(SAVE_KEY);
  log(winner === H ? 'VITTORIA! ' + reason : 'Sconfitta. ' + reason, 'log-turn');
  renderAll();
  setTimeout(showGameOver, 700);
}

// ============================================================
// LAND ETB EFFECTS
// ============================================================
const landETB = {
  'Halimar Depths': (perm, done) => {
    perm.tapped = true;
    const top3 = G.library.slice(0, 3);
    if (top3.length === 0) return done();
    ask({
      player: perm.controller, kind: 'order', cards: top3,
      title: 'Halimar Depths: riordina le prime 3 carte (la prima scelta resta in cima)',
      cb: order => {
        G.library.splice(0, top3.length, ...order);
        log(nameIt(perm.controller) + ': guarda e riordina le prime carte della libreria.', perm.controller === H ? 'log-me' : 'log-ai');
        done();
      },
    });
  },
  'Izzet Boilerworks': (perm, done) => {
    perm.tapped = true;
    const lands = fieldOf(perm.controller).filter(x => isLandKey(x.key) && x.pid !== perm.pid);
    if (lands.length === 0) {
      // must return itself
      removePerm(perm.pid);
      toHand(perm.iid, perm.controller);
      log('Izzet Boilerworks torna in mano: nessun altra terra da far rientrare.');
      return done();
    }
    ask({
      player: perm.controller, kind: 'target',
      options: lands.map(x => ({ type: 'perm', pid: x.pid })),
      title: 'Izzet Boilerworks: fai tornare una terra in mano',
      cb: t => {
        const l = permOf(t.pid);
        removePerm(l.pid);
        toHand(l.iid, perm.controller);
        log(nameIt(perm.controller) + ': riprende in mano ' + cdb(l.key).name + '.', perm.controller === H ? 'log-me' : 'log-ai');
        done();
      },
    });
  },
  'Mystic Sanctuary': (perm, done) => {
    const others = fieldOf(perm.controller).filter(x => x.pid !== perm.pid && landTypesOf(x).includes('Island')).length;
    if (others >= 3) {
      perm.tapped = false;
      const targets = G.graveyard.filter(iid => isInstantKey(keyOf(iid)) || isSorceryKey(keyOf(iid)));
      if (targets.length === 0) return done();
      ask({
        player: perm.controller, kind: 'yesno',
        title: 'Mystic Sanctuary: metti un istantaneo o stregoneria dal cimitero in cima alla libreria?',
        cb: yes => {
          if (!yes) return done();
          ask({
            player: perm.controller, kind: 'browse', cards: targets, pick: 1,
            title: 'Scegli la carta da mettere in cima alla libreria condivisa',
            cb: iids => {
              if (iids && iids[0]) {
                toLibraryTop(iids[0]);
                log(nameIt(perm.controller) + ': mette ' + cdb(keyOf(iids[0])).name + ' in cima alla libreria.', perm.controller === H ? 'log-me' : 'log-ai');
              }
              done();
            },
          });
        },
      });
    } else { perm.tapped = true; done(); }
  },
  'Temple of Epiphany': (perm, done) => {
    perm.tapped = true;
    if (G.library.length === 0) return done();
    const top = G.library[0];
    ask({
      player: perm.controller, kind: 'scry', card: top,
      title: 'Profetizza 1: lasci questa carta in cima o la metti in fondo?',
      cb: bottom => {
        if (bottom) { toLibraryBottom(top); log(nameIt(perm.controller) + ': profetizza 1 e mette in fondo.', perm.controller === H ? 'log-me' : 'log-ai'); }
        else log(nameIt(perm.controller) + ': profetizza 1 e lascia in cima.', perm.controller === H ? 'log-me' : 'log-ai');
        done();
      },
    });
  },
};

// Svyelunite Temple activated ability: T + sacrifice -> UU
function canSacTemple(perm) {
  return perm.key === 'Svyelunite Temple' && !perm.tapped;
}
function sacTempleForMana(perm) {
  const p = perm.controller;
  removePerm(perm.pid);
  toGraveyard(perm.iid);
  G.players[p].pool.U += 2;
  log(nameIt(p) + ': sacrifica Svyelunite Temple per {U}{U}.', p === H ? 'log-me' : 'log-ai');
  renderAll();
}

// ============================================================
// SPELL EFFECTS REGISTRY — one scripted entry per distinct card
// ============================================================
function spellsOnStack() { return G.stack.map(s => ({ type: 'stack', sid: s.id })); }
function allCreatures() { return [...creaturesOf(H), ...creaturesOf(A)].map(x => ({ type: 'perm', pid: x.pid })); }
function creatureTargets(p) { return creaturesOf(p).map(x => ({ type: 'perm', pid: x.pid })); }
function allPermanents() { return [...fieldOf(H), ...fieldOf(A)].map(x => ({ type: 'perm', pid: x.pid })); }

// counter a spell on the stack. mode: 'grave' | 'lapse'
function counterSpell(sid, mode) {
  const idx = G.stack.findIndex(s => s.id === sid);
  if (idx < 0) return;
  const it = G.stack.splice(idx, 1)[0];
  G.stats.countered++;
  if (it.isCopy) { log('La copia di ' + cdb(it.key).name + ' viene neutralizzata.'); return; }
  if (mode === 'lapse') {
    toLibraryTop(it.iid);
    log(cdb(it.key).name + ' viene neutralizzata e messa IN CIMA alla libreria condivisa: la prossima pesca se la prende...', 'log-turn');
  } else {
    toGraveyard(it.iid);
    log(cdb(it.key).name + ' viene neutralizzata.');
  }
}
function bounceSpell(sid) {
  const idx = G.stack.findIndex(s => s.id === sid);
  if (idx < 0) return;
  const it = G.stack.splice(idx, 1)[0];
  if (it.isCopy) { log('La copia di ' + cdb(it.key).name + ' svanisce.'); return; }
  const owner = inst(it.iid).owner || it.controller;
  toHand(it.iid, owner);
  log(cdb(it.key).name + ' torna in mano a ' + (owner === H ? 'te' : "l'IA") + '.');
}
function bounceCreature(pid) {
  const perm = permOf(pid);
  if (!perm) return;
  removePerm(pid);
  if (perm.isToken) { log('La pedina ' + cdb(perm.key).name + ' svanisce.'); return; }
  const owner = inst(perm.iid).owner || perm.controller;
  toHand(perm.iid, owner);
  log(cdb(perm.key).name + ' torna in mano a ' + (owner === H ? 'te' : "l'IA") + '.');
}
function wordChangeChoices(perm) {
  const words = new Set();
  if (perm.key === 'Dandan' && abilitiesActive(perm)) words.add(dandanIslandWord(perm));
  landTypesOf(perm).forEach(t => words.add(t));
  return [...words];
}
function applyWordChange(item, perm, expires, done) {
  const p = item.controller;
  const words = wordChangeChoices(perm);
  /* Un permanente che non ha nessuna parola da cambiare e' un bersaglio
     LEGALE (lo dice Magic): la magia si risolve e non fa niente. Prima qui si
     apriva una domanda con zero risposte possibili, e la partita si piantava.
     Meglio dirlo e andare avanti. */
  if (words.length === 0) {
    log('Su ' + cdb(perm.key).name + ' non c\'è nessun tipo di terra da cambiare: niente effetto.', 'log-turn');
    return done();
  }
  const pickTo = from => {
    ask({
      player: p, kind: 'option',
      title: '"' + (TYPE_IT[from] || from) + '" diventa...',
      options: BASIC_TYPES.filter(t => t !== from).map(t => ({ label: TYPE_IT[t], value: t })),
      cb: to => {
        perm.mods.push({ kind: 'textWord', from, to, expires });
        log('Il testo di ' + cdb(perm.key).name + ' cambia: ' + (TYPE_IT[from] || from) + ' → ' + (TYPE_IT[to] || to) + (expires === 'eot' ? ' (fino a fine turno)' : '') + '.');
        done();
      },
    });
  };
  if (words.length === 1) pickTo(words[0]);
  else ask({
    player: p, kind: 'option', title: 'Quale parola sostituisci?',
    options: words.map(w => ({ label: TYPE_IT[w] || w, value: w })),
    cb: pickTo,
  });
}

const cardEffects = {
  'Dandan': {
    resolve: (item, done) => {
      newPerm(item.controller, { iid: item.iid, key: item.key });
      log(item.controller === H ? 'Il tuo Dandân entra nel campo di battaglia.' : "Il Dandân dell'IA entra nel campo di battaglia.");
      done();
    },
  },

  'Memory Lapse': {
    legal: () => G.stack.length > 0,
    targets: () => spellsOnStack(),
    targetHint: () => 'Neutralizza quale magia? (andrà in cima alla libreria condivisa)',
    resolve: (item, done) => { counterSpell(item.targets[0].sid, 'lapse'); done(); },
  },

  'Accumulated Knowledge': {
    resolve: (item, done) => {
      const n = 1 + G.graveyard.filter(iid => keyOf(iid) === 'Accumulated Knowledge').length;
      log(nameIt(item.controller) + ': pesca ' + n + ' carta/e con Accumulated Knowledge.', item.controller === H ? 'log-me' : 'log-ai');
      // the spell itself goes to the graveyard AFTER counting (rules: counts on resolution, itself not yet there)
      drawCards(item.controller, n, done);
    },
  },

  'Brainstorm': {
    resolve: (item, done) => {
      drawCards(item.controller, 3, () => {
        if (G.over) return done();
        const hand = handOf(item.controller);
        const nBack = Math.min(2, hand.length);
        if (nBack === 0) return done();
        ask({
          player: item.controller, kind: 'cards', zone: hand.slice(), min: nBack, max: nBack, ordered: true,
          title: 'Rimetti 2 carte in cima alla libreria (la prima scelta sarà la prima pescata)',
          cb: iids => {
            // first chosen ends on top
            iids.slice().reverse().forEach(iid => toLibraryTop(iid));
            log(nameIt(item.controller) + ': rimette 2 carte in cima alla libreria.', item.controller === H ? 'log-me' : 'log-ai');
            done();
          },
        });
      });
    },
  },

  'Predict': {
    resolve: (item, done) => {
      ask({
        player: item.controller, kind: 'option', searchable: true,
        title: 'Predict: nomina una carta',
        options: Object.keys(CARD_DB).map(k => ({ label: cdb(k).name, value: k })),
        cb: named => {
          if (G.library.length === 0) { drawCards(item.controller, 1, done); return; }
          const milled = G.library.shift();
          toGraveyard(milled);
          const hit = keyOf(milled) === named;
          log(nameIt(item.controller) + ': nomina ' + cdb(named).name + ' — macinata ' + cdb(keyOf(milled)).name + (hit ? ' — indovinato! Pesca 2.' : '. Pesca 1.'), item.controller === H ? 'log-me' : 'log-ai');
          drawCards(item.controller, hit ? 2 : 1, done);
        },
      });
    },
  },

  'Mystical Tutor': {
    legal: () => G.library.some(iid => isInstantKey(keyOf(iid)) || isSorceryKey(keyOf(iid))),
    resolve: (item, done) => {
      const opts = G.library.filter(iid => isInstantKey(keyOf(iid)) || isSorceryKey(keyOf(iid)));
      if (opts.length === 0) { shuffle(G.library); return done(); }
      ask({
        player: item.controller, kind: 'browse', cards: opts, pick: 1, sortByName: true,
        title: 'Cerca un istantaneo o stregoneria: andrà in cima alla libreria',
        cb: iids => {
          const iid = iids[0];
          zoneRemove(iid);
          shuffle(G.library);
          G.library.unshift(iid);
          log(nameIt(item.controller) + ': tutora ' + cdb(keyOf(iid)).name + ' in cima alla libreria (rivelata).', 'log-turn');
          done();
        },
      });
    },
  },

  'Insidious Will': {
    modes: p => [
      { label: 'Neutralizza una magia bersaglio', legal: G.stack.length > 0 },
      { label: 'Cambia i bersagli di una magia', legal: G.stack.some(s => s.targets.length > 0) },
      { label: 'Copia un istantaneo o stregoneria', legal: G.stack.length > 0 },
    ],
    targets: (p, item) => {
      if (!item) return spellsOnStack();
      if (item.mode === 1) return G.stack.filter(s => s.targets.length > 0).map(s => ({ type: 'stack', sid: s.id }));
      if (item.mode === 2) return G.stack.filter(s => isInstantKey(s.key) || isSorceryKey(s.key)).map(s => ({ type: 'stack', sid: s.id }));
      return spellsOnStack();
    },
    resolve: (item, done) => {
      const sid = item.targets[0].sid;
      const target = G.stack.find(s => s.id === sid);
      if (!target) return done();
      if (item.mode === 0) { counterSpell(sid, 'grave'); return done(); }
      if (item.mode === 1) {
        const eff = cardEffects[target.key];
        const legal = eff.targets ? eff.targets(target.controller, target) : [];
        if (legal.length === 0) return done();
        ask({
          player: item.controller, kind: 'target', options: legal,
          title: 'Nuovo bersaglio per ' + cdb(target.key).name,
          cb: t => { target.targets = [t]; log('I bersagli di ' + cdb(target.key).name + ' cambiano.'); done(); },
        });
        return;
      }
      // copy
      const copy = Object.assign({}, target, { id: 's' + Math.random().toString(36).slice(2, 8), isCopy: true, controller: item.controller, targets: target.targets.slice() });
      const finishCopy = () => { G.stack.push(copy); log(nameIt(item.controller) + ': copia ' + cdb(target.key).name + '.', 'log-turn'); done(); };
      const eff = cardEffects[target.key];
      const legal = eff.targets ? eff.targets(item.controller, copy) : [];
      if (legal.length > 1) {
        ask({
          player: item.controller, kind: 'target', options: legal,
          title: 'Bersaglio per la copia di ' + cdb(target.key).name + '?',
          cb: t => { copy.targets = [t]; finishCopy(); },
        });
      } else finishCopy();
    },
  },

  'Metamorphose': {
    targets: (p) => fieldOf(other(p)).map(x => ({ type: 'perm', pid: x.pid })),
    targetHint: () => 'Metti un permanente avversario in cima alla libreria condivisa',
    resolve: (item, done) => {
      const perm = permOf(item.targets[0].pid);
      if (!perm) return done();
      const owner = perm.controller;
      removePerm(perm.pid);
      if (!perm.isToken) {
        toLibraryTop(perm.iid);
        log(cdb(perm.key).name + ' finisce in cima alla libreria condivisa.', 'log-turn');
      }
      const deployable = handOf(owner).filter(iid => isLandKey(keyOf(iid)) || isCreatureKey(keyOf(iid)));
      if (deployable.length === 0) return done();
      ask({
        player: owner, kind: 'yesno',
        title: 'Metamorphose: vuoi mettere sul campo una carta permanente dalla tua mano?',
        cb: yes => {
          if (!yes) return done();
          ask({
            player: owner, kind: 'browse', cards: deployable, pick: 1,
            title: 'Scegli la carta da mettere sul campo',
            cb: iids => {
              const iid = iids[0];
              zoneRemove(iid);
              log(nameIt(owner) + ': mette sul campo ' + cdb(keyOf(iid)).name + '.', owner === H ? 'log-me' : 'log-ai');
              // dalla stessa porta di una terra giocata: tappata se lo dice, e
              // col suo effetto d'entrata, che prima qui si perdevano
              entraInCampo(owner, { iid, key: keyOf(iid) }, () => done());
            },
          });
        },
      });
    },
  },

  'Mind Bend': {
    /* QUALUNQUE permanente, come sulla carta vera. Prima erano ammessi solo i
       permanenti con una parola da cambiare, e bastava una partita senza
       Isole in campo — sei terre senza tipo, nessun Dandan — perche' Mind Bend
       diventasse ingiocabile: il gioco la rifiutava e basta. In Magic la
       giochi lo stesso, e se non c'e' niente da cambiare non succede niente. */
    targets: () => allPermanents(),
    targetHint: () => 'Cambia il testo di quale permanente?',
    resolve: (item, done) => {
      const perm = permOf(item.targets[0].pid);
      if (!perm) return done();
      applyWordChange(item, perm, null, done);
    },
  },

  'Crystal Spray': {
    targets: () => allPermanents(),
    targetHint: () => 'Cambia il testo di quale permanente? (fino a fine turno)',
    resolve: (item, done) => {
      const perm = permOf(item.targets[0].pid);
      const after = () => drawCards(item.controller, 1, done);
      if (!perm) return after();
      applyWordChange(item, perm, 'eot', after);
    },
  },

  'Dance of the Skywise': {
    targets: p => creatureTargets(p),
    targetHint: () => 'Quale tua creatura diventa un Drago Illusione 4/4 volante?',
    resolve: (item, done) => {
      const perm = permOf(item.targets[0].pid);
      if (!perm) return done();
      perm.mods.push({ kind: 'dance', expires: 'eot' });
      log(cdb(perm.key).name + ' diventa un Drago Illusione 4/4 volante e perde tutte le abilità fino a fine turno.');
      done();
    },
  },

  'Ray of Command': {
    targets: p => creatureTargets(other(p)),
    targetHint: () => 'Prendi il controllo di quale creatura avversaria?',
    resolve: (item, done) => {
      const perm = permOf(item.targets[0].pid);
      if (!perm) return done();
      const from = perm.controller;
      if (from === item.controller) return done();
      const f = G.players[from].field;
      const i = f.indexOf(perm.pid);
      if (i >= 0) f.splice(i, 1);
      perm.controller = item.controller;
      G.players[item.controller].field.push(perm.pid);
      perm.tapped = false;
      perm.mods.push({ kind: 'control', back: from, expires: 'eot' });
      perm.mods.push({ kind: 'haste', expires: 'eot' });
      log(nameIt(item.controller) + ': prende il controllo di ' + cdb(perm.key).name + ' fino a fine turno (stappata, rapidità).', 'log-turn');
      done();
    },
  },

  'Supplant Form': {
    targets: () => allCreatures(),
    targetHint: () => 'Rimbalza quale creatura? (ne otterrai una copia pedina)',
    resolve: (item, done) => {
      const perm = permOf(item.targets[0].pid);
      if (!perm) return done();
      const key = perm.key;
      bounceCreature(perm.pid);
      newPerm(item.controller, { key, isToken: true });
      log(nameIt(item.controller) + ': crea una pedina copia di ' + cdb(key).name + '.', item.controller === H ? 'log-me' : 'log-ai');
      done();
    },
  },

  'Unsubstantiate': {
    legal: p => G.stack.length > 0 || allCreatures().length > 0,
    targets: () => [...spellsOnStack(), ...allCreatures()],
    targetHint: () => 'Fai tornare in mano quale magia o creatura?',
    resolve: (item, done) => {
      const t = item.targets[0];
      if (t.type === 'stack') bounceSpell(t.sid);
      else bounceCreature(t.pid);
      done();
    },
  },

  'Vision Charm': {
    modes: () => [
      { label: 'Un giocatore macina 4 carte', legal: true },
      { label: 'Cambia un tipo di terra fino a fine turno', legal: true },
    ],
    targets: (p, item) => (item && item.mode === 0 ? [{ type: 'player', p: H }, { type: 'player', p: A }] : null) || [],
    resolve: (item, done) => {
      if (item.mode === 0) {
        for (let i = 0; i < 4 && G.library.length > 0; i++) toGraveyard(G.library.shift());
        log('Vengono macinate 4 carte dalla libreria condivisa.');
        return done();
      }
      // land type change, global until EOT
      const present = new Set();
      [...fieldOf(H), ...fieldOf(A)].forEach(x => landTypesOf(x).forEach(t => present.add(t)));
      if (present.size === 0) return done();
      ask({
        player: item.controller, kind: 'option', title: 'Quale tipo di terra cambia?',
        options: [...present].map(t => ({ label: TYPE_IT[t] || t, value: t })),
        cb: from => {
          ask({
            player: item.controller, kind: 'option', title: '...e diventa?',
            options: BASIC_TYPES.filter(t => t !== from).map(t => ({ label: TYPE_IT[t], value: t })),
            cb: to => {
              G.globalMods.push({ kind: 'landTypeAll', from, to, expires: 'eot' });
              log('Fino a fine turno ogni ' + (TYPE_IT[from] || from) + ' è una ' + (TYPE_IT[to] || to) + '!', 'log-turn');
              done();
            },
          });
        },
      });
    },
  },

  'Diminishing Returns': {
    resolve: (item, done) => {
      // adapted to shared zones: both hands + shared graveyard shuffle into the library
      handOf(H).slice().forEach(zoneRemove2Lib);
      handOf(A).slice().forEach(zoneRemove2Lib);
      G.graveyard.slice().forEach(zoneRemove2Lib);
      // the spell itself is exiled with the ten (it never hits the graveyard: exile it now)
      if (!item.isCopy) { zoneRemove(item.iid); G.exile.push(item.iid); }
      shuffle(G.library);
      const ex = Math.min(10, G.library.length);
      for (let i = 0; i < ex; i++) toExile(G.library.shift());
      log('Diminishing Returns: mani e cimitero rimescolati nella libreria, 10 carte esiliate. Ognuno pesca 7.', 'log-turn');
      drawCards(item.controller, 7, () => drawCards(other(item.controller), 7, () => done(true)));
    },
  },

  'Mystic Retrieval': {
    legal: () => G.graveyard.some(iid => isInstantKey(keyOf(iid)) || isSorceryKey(keyOf(iid))),
    targets: () => G.graveyard.filter(iid => isInstantKey(keyOf(iid)) || isSorceryKey(keyOf(iid))).map(iid => ({ type: 'gycard', iid })),
    targetHint: () => 'Riprendi in mano quale istantaneo o stregoneria dal cimitero?',
    resolve: (item, done) => {
      const iid = item.targets[0].iid;
      if (G.graveyard.includes(iid)) {
        toHand(iid, item.controller);
        log(nameIt(item.controller) + ': riprende in mano ' + cdb(keyOf(iid)).name + '.', item.controller === H ? 'log-me' : 'log-ai');
      }
      if (item.flashback) { zoneRemove(item.iid); G.exile.push(item.iid); return done(true); }
      done();
    },
  },
};
function zoneRemove2Lib(iid) { zoneRemove(iid); G.library.push(iid); }

// flashback: cast Mystic Retrieval from the shared graveyard for {2}{R}
function canFlashback(p, iid) {
  if (keyOf(iid) !== 'Mystic Retrieval') return false;
  if (!G.graveyard.includes(iid)) return false;
  if (!legalSorcerySpeed(p)) return false;
  if (!affordable(p, { generic: 2, U: 0, R: 1 })) return false;
  return cardEffects['Mystic Retrieval'].legal(p);
}
function castFlashback(p, iid) {
  const item = {
    id: 's' + Math.random().toString(36).slice(2, 8),
    iid, key: 'Mystic Retrieval', controller: p, targets: [], mode: null, chosen: {}, isCopy: false, countered: false, flashback: true,
  };
  const eff = cardEffects['Mystic Retrieval'];
  const legal = eff.targets(p, item).filter(t => t.iid !== iid);
  if (legal.length === 0) return;
  ask({
    player: p, kind: 'target', options: legal, cancellable: true,
    title: 'Flashback — riprendi in mano quale carta?',
    cb: t => {
      if (t === null) return;
      item.targets = [t];
      payFor(p, { generic: 2, U: 0, R: 1 });
      zoneRemove(iid);
      G.stack.push(item);
      log(nameIt(p) + ': lancia Mystic Retrieval dal cimitero (flashback).', p === H ? 'log-me' : 'log-ai');
      renderAll();
      openPriority(other(p));
    },
  });
}

// ============================================================
// AI OPPONENT — heuristic policy. Reads only public state + its own hand.
// ============================================================
function cardValueForAI(key) {
  const v = {
    'Dandan': 5, 'Memory Lapse': 4, 'Accumulated Knowledge': 3, 'Supplant Form': 3,
    'Ray of Command': 3, 'Insidious Will': 3, 'Diminishing Returns': 2, 'Mystical Tutor': 3,
    'Brainstorm': 2, 'Predict': 2, 'Unsubstantiate': 3, 'Metamorphose': 2,
    'Mystic Retrieval': 2, 'Mind Bend': 2, 'Crystal Spray': 2, 'Vision Charm': 2,
    'Dance of the Skywise': 2, 'Mystic Sanctuary': 2, 'Halimar Depths': 1.5,
  };
  if (isLandKey(key)) {
    const lands = handOf(A).filter(x => isLandKey(keyOf(x))).length;
    const fieldLands = fieldOf(A).filter(x => isLandKey(x.key)).length;
    return fieldLands < 4 ? 4 : (lands > 2 ? 0.5 : 1.5);
  }
  return v[key] || 2;
}
function aiCounters() {
  return handOf(A).filter(iid => {
    const k = keyOf(iid);
    if (k !== 'Memory Lapse' && k !== 'Insidious Will' && k !== 'Unsubstantiate') return false;
    return canPay(A, parseCost(cdb(k).cost));
  });
}
function threatOf(item) {
  const base = {
    'Dandan': 3, 'Supplant Form': 3, 'Ray of Command': 3, 'Diminishing Returns': 2,
    'Accumulated Knowledge': 2, 'Memory Lapse': 3, 'Insidious Will': 3,
    'Mystical Tutor': 2, 'Metamorphose': 3, 'Mind Bend': 2, 'Unsubstantiate': 2,
  }[item.key] || 1;
  let t = base;
  if (item.key === 'Dandan' && creaturesOf(A).length === 0 && creaturesOf(H).length >= 1) t += 1;
  if (item.key === 'Accumulated Knowledge') t = 1 + Math.min(3, G.graveyard.filter(i => keyOf(i) === 'Accumulated Knowledge').length);
  if (G.players[A].life <= 8) t += 1;
  return t;
}

// AI holds priority on the stack: counter or pass
function aiRespond() {
  if (!G.prio || G.over || G.pending) return;
  const top = G.stack[G.stack.length - 1];
  if (!top || top.controller === A) { passPriority(A); return; }
  const counters = aiCounters();
  if (counters.length === 0) { passPriority(A); return; }
  const threat = threatOf(top);
  let prob = threat >= 4 ? 0.95 : threat === 3 ? 0.85 : threat === 2 ? (counters.length >= 2 ? 0.6 : 0.35) : 0.12;
  if (G.settings.bluff === 'normal' && Math.random() < 0.12) prob *= 0.4; // sometimes sandbag to bluff later
  if (Math.random() > prob) { passPriority(A); return; }
  // pick which counter: Memory Lapse is extra juicy on the human's turn (the AI draws the spell)
  const humanTurn = G.turn.active === H;
  const pref = humanTurn ? ['Memory Lapse', 'Insidious Will', 'Unsubstantiate'] : ['Insidious Will', 'Unsubstantiate', 'Memory Lapse'];
  counters.sort((a, b) => pref.indexOf(keyOf(a)) - pref.indexOf(keyOf(b)));
  const chosen = counters[0];
  castSpell(A, chosen, ok => { if (!ok) passPriority(A); });
}

// AI in a non-stack instant window (combat / end step). Either casts (and sets
// G.resume so the window re-opens after resolution) or passes.
function aiWindowAction(resume, pass) {
  if (G.over || G.pending) return;
  const mana = untappedLands(A).length + G.players[A].pool.U + G.players[A].pool.R;
  const attackedByHuman = G.turn.active === H && G.combat.attackers.length > 0 && G.turn.phase === 'attack';
  const humanEndStep = G.turn.active === H && G.turn.phase === 'end';
  const act = iid => { G.resume = resume; castSpell(A, iid, ok => { if (!ok) { G.resume = null; pass(); } }); };

  if (attackedByHuman) {
    const bigThreat = G.combat.attackers.map(permOf).filter(Boolean).reduce((s, x) => s + getPT(x)[0], 0);
    const blockers = creaturesOf(A).filter(x => !x.tapped).length;
    const incoming = Math.max(0, bigThreat - blockers * 4);
    if (incoming >= 4 && G.players[A].life <= incoming + 6) {
      const answer1 = handOf(A).find(iid => keyOf(iid) === 'Ray of Command' && canPay(A, parseCost(cdb(keyOf(iid)).cost)));
      const answer2 = handOf(A).find(iid => keyOf(iid) === 'Unsubstantiate' && canPay(A, parseCost(cdb(keyOf(iid)).cost)));
      if (answer1) return act(answer1);
      if (answer2) return act(answer2);
    }
  }
  if (humanEndStep && mana >= 2) {
    // end-of-turn value: Accumulated Knowledge, or cycle spare mana
    const ak = handOf(A).find(iid => keyOf(iid) === 'Accumulated Knowledge' && canPay(A, parseCost(cdb(keyOf(iid)).cost)));
    if (ak && (G.graveyard.some(i => keyOf(i) === 'Accumulated Knowledge') || mana >= 4) && Math.random() < 0.85) return act(ak);
    const cyc = handOf(A).find(iid => canCycle(A, iid) && cardValueForAI(keyOf(iid)) <= 1.5);
    if (cyc && mana >= 3) {
      G.resume = resume;
      doCycleAIWindow(cyc, pass);
      return;
    }
  }
  pass();
}
function doCycleAIWindow(iid, pass) {
  payCost(A, cyclingCost(keyOf(iid)));
  log("L'IA cicla " + cdb(keyOf(iid)).name + '.', 'log-ai');
  toGraveyard(iid);
  drawCards(A, 1, () => {
    const r = G.resume; G.resume = null;
    if (r) r(); else pass();
  });
}

// AI main phase: one action at a time; afterStackEmpty re-enters here.
function aiMainPhase(ph) {
  if (G.over || G.pending || G.stack.length > 0) return;
  setTimeout(() => safeAI(() => aiMainStep(ph)), aiDelay());
}
function aiMainStep(ph) {
  if (G.over || G.pending || G.stack.length > 0 || G.turn.active !== A) return;
  if (G.turn.phase !== ph) return;
  const hand = handOf(A);
  const mana = () => untappedLands(A).length + G.players[A].pool.U + G.players[A].pool.R;

  // 1. land drop
  if (!G.players[A].landPlayed) {
    const lands = hand.filter(iid => isLandKey(keyOf(iid)));
    if (lands.length > 0) {
      // prefer untapped basics; Sanctuary when it triggers; taplands early
      lands.sort((a, b) => aiLandScore(keyOf(b)) - aiLandScore(keyOf(a)));
      playLand(A, lands[0]);
      return;
    }
  }
  const counted = aiCounters().length;
  const wantHold = counted > 0 && G.turn.n >= 4 ? 2 : 0; // hold counter mana

  // 2. cast Dandan
  const fish = hand.find(iid => keyOf(iid) === 'Dandan' && canPay(A, parseCost(cdb('Dandan').cost)));
  if (fish && mana() - 2 >= wantHold * (Math.random() < 0.75 ? 1 : 0)) {
    castSpell(A, fish, () => {});
    return;
  }
  // 3. value spells with spare mana (keep counter mana open)
  const spare = mana() - wantHold;
  const tryCast = (key, minSpare) => {
    if (spare < minSpare) return null;
    if (isLandKey(key)) return null; // a land is never cast: it goes through the land drop above
    const iid = hand.find(x => keyOf(x) === key && canPay(A, parseCost(cdb(key).cost)) && effectHasLegalUse(key, A));
    return iid || null;
  };
  let iid =
    tryCast('Mystic Retrieval', 4) ||
    (hand.length <= 2 ? tryCast('Diminishing Returns', 4) : null) ||
    tryCast('Supplant Form', 6) ||
    (creaturesOf(H).some(x => x.key === 'Dandan') ? tryCast('Mind Bend', 1) : null) ||
    (creaturesOf(H).length > creaturesOf(A).length ? tryCast('Metamorphose', 2) : null) ||
    tryCast('Brainstorm', 1) ||
    tryCast('Predict', 2);
  if (iid) { castSpell(A, iid, () => {}); return; }
  // 3b. flashback
  const fb = G.graveyard.find(x => canFlashback(A, x));
  if (fb && spare >= 3) { castFlashback(A, fb); return; }
  // 4. cycle junk with truly spare mana in main2
  if (ph === 'main2' && spare >= 2) {
    const cyc = hand.find(x => canCycle(A, x) && isLandKey(keyOf(x)) && fieldOf(A).filter(y => isLandKey(y.key)).length >= 5);
    if (cyc) { doCycleAIMain(cyc, ph); return; }
  }
  // done with this main phase
  setPhase(ph === 'main1' ? 'attack' : 'end');
}
function doCycleAIMain(iid, ph) {
  payCost(A, cyclingCost(keyOf(iid)));
  log("L'IA cicla " + cdb(keyOf(iid)).name + '.', 'log-ai');
  toGraveyard(iid);
  drawCards(A, 1, () => aiMainPhase(ph));
}
function aiLandScore(key) {
  if (key === 'Island') return 5;
  if (key === 'Mystic Sanctuary') {
    const isl = fieldOf(A).filter(x => landTypesOf(x).includes('Island')).length;
    const gyOk = G.graveyard.some(iid => isInstantKey(keyOf(iid)) || isSorceryKey(keyOf(iid)));
    return isl >= 3 && gyOk ? 6 : 4.5;
  }
  if (key === 'Svyelunite Temple') return 3;
  return G.turn.n <= 6 ? 4 : 3; // taplands early are fine
}

// ---------- AI answers to ask() specs ----------
function aiChoose(spec) {
  const kind = spec.kind;
  if (kind === 'yesno') { answer(aiYesNo(spec)); return; }
  if (kind === 'scry') {
    const k = keyOf(spec.card);
    // next natural draw is usually the opponent's: bury good cards
    answer(cardValueForAI(k) >= 3);
    return;
  }
  if (kind === 'option') { answer(aiOption(spec)); return; }
  if (kind === 'cards') { answer(aiPickCards(spec)); return; }
  if (kind === 'order') { answer(aiOrder(spec)); return; }
  if (kind === 'browse') { answer(aiBrowse(spec)); return; }
  if (kind === 'target') { answer(aiTarget(spec)); return; }
  if (kind === 'attackers') { answer(aiAttackers(spec)); return; }
  if (kind === 'blockers') { answer(aiBlockers(spec)); return; }
  answer(null);
}
function aiYesNo(spec) {
  return true; // Sanctuary regrowth / Metamorphose deploy: value is almost always yes
}
function aiOption(spec) {
  const opts = spec.options.filter(o => !o.disabled);
  if (spec.title.includes('Predict')) {
    // name the card with most copies still unseen (counting is the format's skill)
    let best = null, bestN = -1;
    Object.keys(CARD_DB).forEach(k => {
      const seen = publicSeenCount(k) + handOf(A).filter(i => keyOf(i) === k).length;
      const left = cdb(k).qty - seen;
      if (left > bestN) { bestN = left; best = k; }
    });
    return best;
  }
  if (spec.title.includes('scegli un modo')) {
    // Insidious Will / Vision Charm: prefer counter / mill
    return opts[0].value;
  }
  if (spec.title.includes('diventa') || spec.title.includes('sostituisci')) {
    // word change: turn Islands into Plains
    const pl = opts.find(o => o.value === 'Plains');
    return pl ? pl.value : opts[0].value;
  }
  if (spec.title.includes('tipo di terra cambia')) {
    const isl = opts.find(o => o.value === 'Island');
    return isl ? isl.value : opts[0].value;
  }
  return opts[0].value;
}
function publicSeenCount(k) {
  let n = 0;
  G.graveyard.forEach(i => { if (keyOf(i) === k) n++; });
  G.exile.forEach(i => { if (keyOf(i) === k) n++; });
  Object.values(G.perms).forEach(pm => { if (!pm.isToken && pm.key === k) n++; });
  return n;
}
function aiPickCards(spec) {
  // discard / brainstorm putback: dump lowest value
  const scored = spec.zone.map(iid => ({ iid, v: cardValueForAI(keyOf(iid)) }));
  scored.sort((a, b) => a.v - b.v);
  return scored.slice(0, spec.min).map(x => x.iid);
}
function aiOrder(spec) {
  // Halimar: next natural draw usually belongs to the opponent — worst card first
  const scored = spec.cards.map(iid => ({ iid, v: cardValueForAI(keyOf(iid)) }));
  scored.sort((a, b) => a.v - b.v);
  return scored.map(x => x.iid);
}
function aiBrowse(spec) {
  const scored = spec.cards.map(iid => ({ iid, v: cardValueForAI(keyOf(iid)) }));
  scored.sort((a, b) => b.v - a.v);
  return scored.slice(0, spec.pick || 1).map(x => x.iid);
}
function aiTarget(spec) {
  const opts = spec.options;
  const key = spec.item ? spec.item.key : '';
  const score = t => {
    if (t.type === 'stack') {
      const it = G.stack.find(s => s.id === t.sid);
      if (!it) return -1;
      return (it.controller === H ? 10 : -5) + threatOf(it);
    }
    if (t.type === 'perm') {
      const pm = permOf(t.pid);
      if (!pm) return -1;
      let v = isCreatureOnField(pm) ? getPT(pm)[0] : 1;
      if (key === 'Mind Bend' || key === 'Crystal Spray') {
        // disable an enemy Dandân
        return pm.key === 'Dandan' && pm.controller === H ? 10 : 0;
      }
      if (key === 'Dance of the Skywise') return pm.controller === A ? v : -1;
      if (key === 'Izzet Boilerworks' || spec.title.includes('Boilerworks')) {
        return pm.key === 'Island' && pm.tapped ? 5 : pm.key === 'Island' ? 3 : 1;
      }
      return pm.controller === H ? 5 + v : -3;
    }
    if (t.type === 'player') return t.p === H ? 5 : 0;
    if (t.type === 'gycard') return cardValueForAI(keyOf(t.iid));
    return 0;
  };
  let best = opts[0], bv = -1e9;
  opts.forEach(o => { const s = score(o); if (s > bv) { bv = s; best = o; } });
  return best;
}
function aiAttackers(spec) {
  const eligible = spec.options;
  const humanBlockers = creaturesOf(H).filter(x => !x.tapped).length;
  const aiLife = G.players[A].life, huLife = G.players[H].life;
  if (eligible.length === 0) return [];
  // all-in if unblockable damage or racing favorably; trades are card-neutral here
  if (humanBlockers === 0) return eligible;
  if (eligible.length > humanBlockers) return eligible;
  if (aiLife > huLife || huLife <= 8) return eligible;
  if (Math.random() < 0.25) return eligible; // keep the human honest
  return [];
}
function aiBlockers(spec) {
  // trade with the biggest attackers: each Dandân block is a clean 1-for-1
  const map = {};
  const blockers = spec.blockersAvail.slice();
  const attackers = spec.attackers.map(permOf).filter(Boolean)
    .sort((a, b) => getPT(b)[0] - getPT(a)[0]);
  const incoming = attackers.reduce((s, x) => s + getPT(x)[0], 0);
  const mustBlock = G.players[A].life <= incoming + 4;
  for (const atk of attackers) {
    if (blockers.length === 0) break;
    const flyer = hasFlying(atk);
    if (flyer) continue; // nothing in the deck blocks a danced dragon
    if (mustBlock || G.players[A].life <= 14 || Math.random() < 0.6) {
      map[atk.pid] = [blockers.shift()];
    }
  }
  return map;
}

// ============================================================
// RENDERING
// ============================================================
const prevSets = {};
function markNew(container, ids) {
  const prev = prevSets[container] || new Set();
  prevSets[container] = new Set(ids);
  return id => !prev.has(id);
}
function manaSymbols(cost) {
  return (cost || '').replace(/\{(\w+)\}/g, '($1)');
}
// Su una carta di Magic il costo sta in alto a DESTRA. In mano non si
// ridisegna niente sopra la carta: e' il ventaglio a impilarsi al contrario
// (`scoperto: 'destra'`) perche' quell'angolo resti scoperto, come su un
// ventaglio di carte vere tenuto in mano.
function cardEl(key, opts) {
  opts = opts || {};
  const d = document.createElement('div');
  d.className = 'card';
  if (opts.facedown) { d.classList.add('facedown'); return d; }
  const data = cdb(key);
  const img = document.createElement('img');
  img.src = opts.small === false ? data.img : data.imgSmall;
  img.alt = data.name;
  img.loading = 'lazy';
  img.onerror = () => {
    img.remove();
    const tf = document.createElement('div');
    tf.className = 'tfall';
    tf.innerHTML = '<b>' + data.name + '</b><span class="tf-cost">' + manaSymbols(data.cost) + '</span>' +
      '<span>' + data.type + '</span><span>' + (data.text || '').slice(0, 110) + '</span>' +
      (data.power ? '<span class="tf-pt">' + data.power + '/' + data.toughness + '</span>' : '');
    d.appendChild(tf);
  };
  d.appendChild(img);
  return d;
}
// ---------- tessere del campo ----------
// Sul campo una carta non e' una carta intera (a quella taglia non si legge):
// e' un rettangolo quasi quadrato con nome, RITAGLIO dell'illustrazione e
// forza/costituzione su pastiglia chiara. Il testo si legge col tocco (zoom).
function tileFace(key) {
  const data = cdb(key);
  const face = document.createElement('div');
  face.className = 'tile-face';
  const img = document.createElement('img');
  img.className = 'tile-art';
  img.src = data.imgSmall;
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => { img.remove(); face.style.background = 'linear-gradient(160deg,#1b3a58,#122740)'; };
  face.appendChild(img);
  const nm = document.createElement('div');
  nm.className = 'tile-name';
  nm.textContent = data.name;
  face.appendChild(nm);
  return face;
}
function permEl(perm) {
  const d = document.createElement('div');
  d.className = 'tile';
  d.dataset.pid = perm.pid;
  d.appendChild(tileFace(perm.key));
  if (perm.tapped) d.classList.add('tapped');
  if (G.combat.attackers.includes(perm.pid) && (G.turn.phase === 'attack' || G.turn.phase === 'block' || G.turn.phase === 'damage')) d.classList.add('attacking');
  const blockingSomething = Object.values(G.combat.blockers).some(a => a.includes(perm.pid));
  if (blockingSomething && (G.turn.phase === 'block' || G.turn.phase === 'damage')) d.classList.add('blocking');
  let badges = 0;
  perm.mods.forEach(m => {
    if (m.kind === 'textWord') addBadge(d, (TYPE_IT[m.from] || m.from) + '→' + (TYPE_IT[m.to] || m.to), badges++);
    if (m.kind === 'dance') addBadge(d, '4/4 vol.', badges++);
    if (m.kind === 'control') addBadge(d, 'controllata', badges++);
  });
  if (perm.isToken) {
    const t = document.createElement('span');
    t.className = 'tokmark'; t.textContent = 'PEDINA';
    d.appendChild(t);
  }
  if (isCreatureOnField(perm)) {
    const pt = getPT(perm);
    const b = document.createElement('span');
    b.className = 'tile-pt';
    b.textContent = pt[0] + '/' + Math.max(0, pt[1] - perm.damage);
    d.appendChild(b);
  }
  return d;
}
/* Le carte in campo stanno IN PIEDI, come sul tavolo: altezza = larghezza x
   1.4 (la proporzione di una carta di Magic). E' cio' che rende evidente la
   rotazione di 90° di un permanente tappato — con le tessere quasi quadrate
   di prima, tappato e stappato si assomigliavano troppo. */
const CARTA_ALTA = 1.32;
// La taglia della tessera non e' fissa: si stringe quel tanto che basta perche'
// il numero di permanenti in campo stia nelle righe disponibili.
function fitTiles(el, n, wMax, wMin, ratio) {
  const W = (el.clientWidth || 344) - 8;
  /* Anche l'ALTEZZA e' un vincolo, adesso che le tessere stanno in piedi: una
     carta alta 87px dentro una fascia da 79 sporge, e la fascia sotto le
     taglia la testa. Prima non capitava perche' erano quasi quadrate.
     Il primo disegno puo' arrivare prima che il layout abbia dato un'altezza
     alle fasce: li' si tira a indovinare, e il disegno dopo aggiusta. */
  const Hdisp = Math.max(40, (el.clientHeight || 84) - 8);
  /* Si tiene il MIGLIORE fra i modi di disporle, non l'ultimo provato.
     Andare a capo aiuta in larghezza ma peggiora in altezza — ogni riga in
     piu' si divide la stessa fascia — quindi il numero di righe piu' alto non
     e' piu' automaticamente il piu' generoso, come era quando contava solo la
     larghezza. Preso l'ultimo, sei tessere di terre finivano a 26px. */
  let w = 26;
  for (let rows = 1; rows <= 3; rows++) {
    const per = Math.ceil(n / rows);
    const cand = Math.min(wMax,
      Math.floor((W - 4 * (per - 1)) / per),
      Math.floor((Hdisp - 4 * (rows - 1)) / rows / ratio));
    if (cand > w) w = cand;
    if (w >= wMin) break;
  }
  w = Math.max(26, w);
  el.style.setProperty('--tw', w + 'px');
  /* L'altezza segue la proporzione, ma non scende sotto il dito: con sette
     gruppi di terre la larghezza cala a 44 e 44x0,95 farebbe 42. La
     proporzione e' un desiderio, i 44px sono un vincolo. */
  const h = Math.max(44, Math.round(w * ratio));
  el.style.setProperty('--th', h + 'px');
  /* Quanto rimpicciolire un permanente TAPPATO perche', ruotato di 90°, stia
     ancora nella larghezza della sua casella. Il conto si fa qui e non nel
     CSS: `calc(var(--tw) / var(--th))` funziona su Chrome moderno ma dividere
     una lunghezza per una lunghezza e' roba recente, e questa app gira anche
     dentro la WebView di un APK. */
  el.style.setProperty('--tap-scale', (w / h).toFixed(3));
}
function addBadge(d, txt, idx) {
  const b = document.createElement('span');
  b.className = 'badge' + (idx > 0 ? ' b2' : '');
  b.textContent = txt;
  d.appendChild(b);
}

function renderAll() {
  if (!G || $('game-screen').classList.contains('hidden')) return;
  $('turn-ind').innerHTML = 'Turno ' + G.turn.n + ' <span class="ti-who">· ' + (G.turn.active === H ? 'tuo' : "dell'IA") + '</span>';
  $('lib-count').textContent = G.library.length;
  $('gy-count').textContent = G.graveyard.length;
  $('ai-life').textContent = G.players[A].life;
  $('my-life').textContent = G.players[H].life;
  $('ai-life').classList.toggle('low', G.players[A].life <= 6);
  $('my-life').classList.toggle('low', G.players[H].life <= 6);
  // di chi e' il tavolo si vede dal pod acceso, non si legge in una scritta
  $('game-screen').classList.toggle('turn-me', G.turn.active === H);
  $('game-screen').classList.toggle('turn-ai', G.turn.active === A);
  renderOppoHand();
  renderManaPool();
  renderField(A, 'ai-field', 'ai-lands');
  renderField(H, 'my-field', 'my-lands');
  renderHand();
  renderStack();
  renderMid();
  renderActionBar();
  renderCounts();
}

// ---------- la terra di nessuno ----------
// Il vuoto in mezzo al campo o lavora o non ci sta: qui vivono la fase, il
// combattimento, e lo stato della libreria CONDIVISA — che in Dandan e'
// l'informazione che decide la mossa. Quando il campo si riempie, si stringe.
const RAIL = [
  ['untap', 'Stap'], ['draw', 'Pesca'], ['main1', 'Prin.1'],
  ['attack', 'Att.'], ['block', 'Bloc.'], ['main2', 'Prin.2'], ['end', 'Fine'],
];
function renderMid() {
  const rail = $('phase-rail');
  const ph = G.turn.phase === 'damage' ? 'block' : (G.turn.phase === 'cleanup' ? 'end' : G.turn.phase);
  rail.className = G.turn.active === A ? 'ai' : '';
  rail.title = phaseLabel();
  rail.innerHTML = RAIL.map(([k, l]) => '<span class="ph' + (k === ph ? ' on' : '') + '">' + l + '</span>').join('');

  const cl = $('combat-line');
  const inCombat = G.combat.attackers.length > 0 && ['attack', 'block', 'damage'].includes(G.turn.phase);
  cl.classList.toggle('hidden', !inCombat);
  if (inCombat) {
    const atk = G.combat.attackers.map(permOf).filter(Boolean);
    const dmg = atk.reduce((s, x) => s + getPT(x)[0], 0);
    const blocked = Object.keys(G.combat.blockers).filter(k => (G.combat.blockers[k] || []).length).length;
    cl.textContent = '⚔ ' + atk.length + (atk.length === 1 ? ' attaccante' : ' attaccanti') +
      ' · ' + dmg + ' danni' + (blocked ? ' · ' + blocked + ' bloccati' : ' · nessun blocco');
  }

  $('pile-lib').classList.toggle('vuota', G.library.length === 0);
  $('pile-gy').classList.toggle('vuota', G.graveyard.length === 0);

  const trk = $('mid-track');
  const rows = Object.keys(CARD_DB).map(k => ({
    k, n: Math.max(0, cdb(k).qty - publicSeenCount(k) - handOf(H).filter(i => keyOf(i) === k).length),
    w: isCreatureKey(k) ? 2 : (isLandKey(k) ? 0 : 1),
    // le esaurite in fondo: su una riga sola lo spazio va a cio' che puo'
    // ancora uscire dalla libreria, non a un "0" sbarrato
  })).sort((a, b) => ((b.n > 0) - (a.n > 0)) || (b.w - a.w) || (b.n - a.n));
  trk.innerHTML = '<span class="trk lab">ignote</span>' + rows.map(r =>
    '<span class="trk' + (r.n <= 0 ? ' out' : (r.w === 2 ? ' hot' : '')) + '"><b>' +
    r.n + '</b> ' + cdb(r.k).name + '</span>').join('');
  /* Una riga sola. Il taglio si fa sull'ANDATA A CAPO, non su un conto di
     pixel: la prima pastiglia che si trova piu' in basso della prima di tutte
     e' finita sulla seconda riga, e da li' in poi si buttano. Cosi' non resta
     mai mezza pastiglia mozzata, e il numero di pastiglie che ci stanno lo
     decide il browser invece di una stima. */
  const kids = [].slice.call(trk.children);
  const riga = kids.length ? kids[0].offsetTop : 0;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].offsetTop > riga) {
      for (let j = i; j < kids.length; j++) kids[j].remove();
      break;
    }
  }
}
/* Le carte in mano all'avversario, coperte, come su Arena: si contano a
   colpo d'occhio invece di leggere una cifra. Oltre le dieci il ventaglietto
   non cresce piu' (non ci starebbe): li' parla il numero, che c'e' sempre. */
function renderOppoHand() {
  const el = $('ai-hand');
  const n = handOf(A).length;
  const mostra = Math.min(n, 10);
  el.innerHTML = '';
  el.classList.toggle('vuota', n === 0);
  for (let i = 0; i < mostra; i++) {
    const c = document.createElement('i');
    const t = mostra === 1 ? 0 : (i / (mostra - 1)) * 2 - 1;
    c.style.transform = 'rotate(' + (t * 7).toFixed(1) + 'deg)';
    el.appendChild(c);
  }
  const b = document.createElement('b');
  b.textContent = n;
  el.appendChild(b);
}
function renderManaPool() {
  const pool = G.players[H].pool;
  const untap = untappedLands(H).length;
  const pip = (n, cls) => '<span class="mp ' + cls + '">' + n + '</span>';
  /* Corto per forza: questa e' la colonna di destra del pod, e se cresce
     spinge il ritratto fuori dal centro. Una riserva vuota non si scrive
     ("riserva vuota" sono 90px per dire NIENTE): semplicemente non compare,
     come le gemme di Arena. Resta il numero che serve sempre — quante terre
     sono ancora stappate — e la frase intera va nel `title`. */
  let html = '';
  if (pool.U > 0) html += pip(pool.U, 'mpU');
  if (pool.R > 0) html += pip(pool.R, 'mpR');
  html += '<span class="landsleft">' + untap + (untap === 1 ? ' pronta' : ' pronte') + '</span>';
  const el = $('mana-ind');
  el.innerHTML = html;
  el.title = untap + (untap === 1 ? ' terra pronta' : ' terre pronte') +
    (pool.U + pool.R > 0 ? ' · riserva: ' + (pool.U ? pool.U + ' blu ' : '') + (pool.R ? pool.R + ' rosso' : '') : ' · riserva vuota');
}
// Le due regole del campo (CAMPO-MTG.md): TERRE all'esterno, CREATURE verso il
// centro. Due contenitori separati per giocatore, non piu' uno solo.
function renderField(p, cid, lid) {
  const cel = $(cid), lel = $(lid);
  const isNew = markNew(cid, G.players[p].field);
  cel.innerHTML = ''; lel.innerHTML = '';
  const perms = fieldOf(p);
  const creatures = perms.filter(isCreatureOnField);
  const lands = perms.filter(x => isLandKey(x.key) && !isCreatureOnField(x));
  const others = perms.filter(x => !isCreatureOnField(x) && !isLandKey(x.key));
  const front = creatures.concat(others);
  /* Le tessere si mettono PRIMA e si misurano DOPO. Una fascia vuota si
     stringe apposta (la regola `:empty` le toglie spazio per darlo al centro):
     misurandola appena svuotata si leggeva l'altezza della fascia vuota, e
     tutte le carte venivano dimensionate su quella — larghe 30px invece di 52.
     L'altezza della fascia non dipende dalle tessere (base flex 0), quindi
     misurarla a fascia piena e' esatto e non innesca nessun rincorrersi. */
  front.forEach(perm => appendPermCard(cel, perm, isNew));
  fitTiles(cel, front.length, 62, 38, CARTA_ALTA);

  // quando una terra precisa dev'essere bersagliata, le terre si spargono
  const targetingLand = uiMode === 'target' && G.pending && (G.pending.options || []).some(o => {
    const pm = o.type === 'perm' && permOf(o.pid);
    return pm && isLandKey(pm.key) && pm.controller === p;
  });
  if (targetingLand) {
    lands.forEach(perm => appendPermCard(lel, perm, isNew));
    fitTiles(lel, lands.length, 52, 44, CARTA_ALTA);
    return;
  }
  renderLandGroups(p, lands, lel);
}
function appendPermCard(el, perm, isNew) {
  const d = permEl(perm);
  if (isNew && isNew(perm.pid)) d.classList.add('anim-in');
  applySelectability(d, { type: 'perm', pid: perm.pid });
  d.onclick = () => onBoardCardTap(perm, d);
  el.appendChild(d);
}
// Quattro Isole non occupano quattro spazi: occupano UNA pila con "x4".
// E' il trucco che rende possibile un campo di Magic su uno schermo piccolo.
// Le creature invece non si impilano mai: ognuna ha statistiche e stato propri.
function renderLandGroups(p, lands, el) {
  const groups = {};
  const order = [];
  lands.forEach(perm => {
    const sig = perm.key + (perm.mods.length ? ':' + JSON.stringify(perm.mods.map(m => [m.kind, m.from, m.to])) : '');
    if (!groups[sig]) { groups[sig] = []; order.push(sig); }
    groups[sig].push(perm);
  });
  order.forEach(sig => {
    const group = groups[sig];
    const untapped = group.filter(x => !x.tapped);
    const card = document.createElement('div');
    card.className = 'tile landgroup';
    card.appendChild(tileFace(group[0].key));
    if (untapped.length === 0) card.classList.add('tapped');
    group[0].mods.forEach((m, i) => { if (m.kind === 'textWord') addBadge(card, (TYPE_IT[m.from] || m.from) + '→' + (TYPE_IT[m.to] || m.to), i); });
    if (group.length > 1) {
      const c = document.createElement('span');
      c.className = 'tile-n';
      c.textContent = '×' + group.length;
      card.appendChild(c);
      /* Quante terre della pila sono ancora stappate. In Magic "N/N" vuol dire
         forza/costituzione e nient'altro: scritto nella pastiglia chiara in
         basso a destra, a sessanta pixel da un Dandan che mostra 4/1, un
         giocatore legge una creatura 3/4. Quindi niente due numeri, niente
         barra, niente pastiglia della forza: una tacca per terra, accesa se e'
         stappata. Zero cifre, impossibile scambiarle per una creatura. */
      const ready = document.createElement('span');
      ready.className = 'tile-ready' + (untapped.length === 0 ? ' allt' : '');
      for (let i = 0; i < group.length; i++) {
        const seg = document.createElement('i');
        if (i >= untapped.length) seg.className = 'off';
        ready.appendChild(seg);
      }
      ready.title = untapped.length + ' di ' + group.length +
        (untapped.length === 1 ? ' pronta' : ' pronte');
      card.appendChild(ready);
    }
    if (p === H && untapped.length > 0 && canTapForMana()) card.classList.add('manaland');
    card.onclick = () => onLandGroupTap(p, group, untapped);
    el.appendChild(card);
  });
  /* Misurata DOPO, a fascia piena: vedi renderField. wMin = 44 perche'
     piuttosto che stringere sotto il dito le pile di terre vanno a capo. */
  fitTiles(el, order.length, 52, 44, CARTA_ALTA);
}
// ---------- la mano: ventaglio ----------
// La fascia alta che nessuna carta della fila di sotto puo' coprire, misurata
// in LARGHEZZE di carta (non in px: qui dentro non c'e' piu' niente di
// disegnato da noi, c'e' l'immagine della carta, e quella scala con la carta).
// 0.21 di larghezza = ~15% dell'altezza: tutta la fascia del titolo, cioe'
// nome a sinistra e costo a destra, piu' un filo dell'illustrazione.
const HAND_STRIP = 0.21;
let fan = null;
// Gli identificativi delle carte ripartono da c1 a ogni partita: il ventaglio
// riusa gli elementi per chiave, quindi va congedato o mostrerebbe le carte
// della partita precedente.
function resetBoardUI() {
  if (fan) { fan.distruggi(); fan = null; }
  Object.keys(prevSets).forEach(k => delete prevSets[k]);
}
function renderHand() {
  const el = $('my-hand');
  const items = handOf(H).map(iid => ({ iid, key: keyOf(iid) }));
  // il ventaglio apre una fila ogni ~7 carte: la mano chiede l'altezza che le
  // serve e non un pixel di piu', il resto resta al campo e al centro
  const perRow = Math.max(1, Math.floor(((el.clientWidth || 348) - 12) / 45));
  const rows = Math.max(1, Math.ceil(items.length / perRow));
  el.style.height = (150 + (rows - 1) * 46) + 'px';
  const opts = {
    elementi: items,
    chiave: d => d.iid,
    altezza: 0,               // usa l'altezza del contenitore: la mano respira col campo
    rapporto: 0.716,          // proporzione di una carta di Magic
    larghezzaMax: 118,
    larghezzaMin: 46,
    /* Le due meta' della garanzia. `scoperto: 'destra'` rovescia la pila
       dentro la fila: ogni carta copre la VICINA DI DESTRA, non quella di
       sinistra, e quindi di ognuna resta scoperto il bordo destro — dove sta
       stampato il costo. `striscia` tiene la fascia alta libera dalla fila di
       sotto. Incrociate, garantiscono l'angolo in alto a destra. */
    scoperto: 'destra',
    striscia: HAND_STRIP,
    salto: 0.26,
    padX: 12,
    /* Il ventaglio e' ancorato in basso, e una carta RUOTATA scende sotto il
       proprio bordo inferiore (~7px agli estremi dell'arco). Senza questa
       riga di riserva quegli angoli finiscono sotto la barra d'azione, che li
       copre: le carte sembrano tagliate di netto. */
    banda: 8,
    scelti: () => false,
    disegna: d => cardEl(d.key),
    sincronizza: (e, d, i, info) => {
      const castable = castableFromHand(H, d.iid) || canCycle(H, d.iid);
      e.classList.toggle('castable', castable);
      e.classList.toggle('dim', !castable && uiMode === 'respond');
      e.dataset.iid = d.iid;
    },
    /* I TRE GESTI DELLA MANO, uno per intenzione:
         tocco            → la carta si apre grande, con l'azione principale
         trascinamento    → la porti sul tavolo e la giochi, senza passare da
                            nessun foglio (il centro e' la zona di rilascio)
         pressione lunga  → il menu della carta: i modi alternativi, il ciclo
       Il riordino se ne va: era il trascinamento a rubarsi i tocchi, perche'
       un dito che tocca uno schermo si sposta sempre di qualche pixel, e il
       ventaglio interpretava quello spostamento come "sposta la carta". Da
       fuori sembrava che per scegliere una carta servisse premere a lungo. */
    riordino: false,
    estrai: true,
    soglia: 12,
    onTocco: d => openZoomHand(d.iid),
    onLungo: d => openMenuCarta(d.iid),
    onSopra: (d, info) => segnalaRilascio(info),
    onEstrai: (d, i, info) => giocaTrascinando(d.iid, info),
  };
  if (!fan) fan = Ventaglio.crea('#my-hand', opts);
  else fan.imposta(opts);
}
/* ---------- portare una carta sul tavolo ----------
   La zona di rilascio e' il centro: e' l'unico posto che appartiene a tutti e
   due i giocatori, ed e' dove finiscono le magie mentre si risolvono. */
function zonaRilascio() { return $('mid-strip'); }
function segnalaRilascio(info) {
  const z = zonaRilascio();
  if (!info) {                       // trascinamento finito
    z.classList.remove('drop-live', 'drop-on');
    return;
  }
  z.classList.add('drop-live');
  z.classList.toggle('drop-on', !!(info.sotto && z.contains(info.sotto)));
}
function giocaTrascinando(iid, info) {
  const z = zonaRilascio();
  z.classList.remove('drop-live', 'drop-on');
  if (!info || !info.sotto || !z.contains(info.sotto)) return false;
  const k = keyOf(iid);
  if (!castableFromHand(H, iid)) {
    // il perche' conta piu' del rifiuto: senza, sembra che il gioco si sia
    // solo mangiato il gesto
    toast(spiegaPerchéNo(iid));
    return false;
  }
  if (isLandKey(k)) { playLand(H, iid); return true; }
  castSpell(H, iid, ok => {
    if (!ok && uiMode === 'idle') setUiMode(G.prio || uiCtx.window ? 'respond' : 'main');
  });
  return true;
}
function spiegaPerchéNo(iid) {
  const k = keyOf(iid), d = cdb(k);
  if (isLandKey(k)) {
    if (G.players[H].landPlayed) return 'Una terra per turno: questa la giochi il prossimo turno.';
    if (!legalSorcerySpeed(H)) return 'Le terre si giocano nella tua fase principale, con la pila vuota.';
    return 'Non puoi giocarla adesso.';
  }
  const cost = parseCost(d.cost);
  if (!poolCovers(H, cost) && canPay(H, cost)) return 'Serve più mana: tappa le terre (' + manaSymbols(d.cost) + ') e riprova.';
  if (!canPay(H, cost)) return 'Non hai abbastanza mana per ' + d.name + ' (' + manaSymbols(d.cost) + ').';
  if (isSorceryKey(k) && !legalSorcerySpeed(H)) return 'Le stregonerie si lanciano nella tua fase principale, con la pila vuota.';
  if (!effectHasLegalUse(k, H)) return d.name + ' adesso non avrebbe nessun bersaglio.';
  return 'Non puoi lanciarla adesso.';
}

/* ---------- il menu della carta (pressione lunga) ----------
   Qui vivono le scelte che NON devono stare sulla strada di chi gioca in
   fretta: i modi alternativi delle carte a piu' modi, il ciclo, il testo. */
function openMenuCarta(iid) {
  // il foglio e' uno solo: se il gioco sta gia' chiedendo qualcosa, il menu
  // della carta glielo cancellerebbe da sotto
  if (G.pending) return;
  const k = keyOf(iid), d = cdb(k);
  const eff = cardEffects[k];
  const voci = [];
  const puoi = castableFromHand(H, iid);
  if (eff && eff.modes && puoi) {
    eff.modes(H).forEach((m, i) => {
      voci.push({ label: m.label, disabled: !m.legal, value: () => castSpell(H, iid, () => {}, i) });
    });
  } else if (puoi) {
    voci.push({
      label: isLandKey(k) ? 'Gioca ' + d.name : 'Lancia ' + d.name + ' ' + manaSymbols(d.cost),
      value: () => { if (isLandKey(k)) playLand(H, iid); else castSpell(H, iid, () => {}); },
    });
  }
  if (canCycle(H, iid)) voci.push({ label: 'Cicla (scarta e pesca 1)', value: () => doCycle(H, iid) });
  voci.push({ label: 'Guarda la carta', value: () => openZoomKey(k) });
  if (!puoi) voci.push({ label: '· ' + spiegaPerchéNo(iid), disabled: true, value: () => {} });
  showSheet(d.name, voci, fn => { hidePrompt(); if (typeof fn === 'function') fn(); }, true);
  // la carta si vede mentre scegli cosa farne: showSheet spegne l'anteprima,
  // quindi la si riaccende dopo
  mostraAnteprima($('prompt-zoom'), k);
  /* Solo QUESTO foglio ha bisogno della guardia contro il click fantasma: si
     apre mentre il dito e' ancora premuto sulla carta, e il click in ritardo
     — che arriva dopo che il dito si alza — cadrebbe dritto su una delle sue
     voci. Gli altri fogli li apre il gioco per fatti suoi, e li' la guardia
     mangerebbe anche i tocchi buoni. */
  foglioApertoA = Date.now();
}

function renderStack() {
  const area = $('stack-area');
  // quando c'e' qualcosa sulla pila, il centro e' della pila: il conteggio
  // delle carte ignote si fa da parte
  const busy = G.stack.length > 0;
  $('mid-strip').classList.toggle('has-stack', busy);
  $('mid-info').classList.toggle('hidden', busy);
  if (!busy) { area.classList.add('hidden'); return; }
  area.classList.remove('hidden');
  const el = $('stack-cards');
  el.innerHTML = '';
  G.stack.forEach(item => {
    const d = cardEl(item.key);
    if (item.isCopy) addBadge(d, 'COPIA', 0);
    applySelectability(d, { type: 'stack', sid: item.id });
    d.onclick = () => onStackTap(item, d);
    el.appendChild(d);
  });
}
function applySelectability(d, t) {
  if (uiMode !== 'target' || !G.pending) return;
  const match = (G.pending.options || []).some(o =>
    (o.type === 'perm' && t.type === 'perm' && o.pid === t.pid) ||
    (o.type === 'stack' && t.type === 'stack' && o.sid === t.sid));
  if (match) d.classList.add('selectable');
  else d.classList.add('dim');
}
// ---------- manual land tapping for mana ----------
function onLandGroupTap(p, group, untapped) {
  if (uiMode === 'target' && G.pending) {
    // let a grouped land satisfy a target (first untapped, else first)
    const pm = untapped[0] || group[0];
    const opt = (G.pending.options || []).find(o => o.type === 'perm' && o.pid === pm.pid);
    if (opt) { setUiMode('idle'); answer(opt); return; }
  }
  if (p !== H || !canTapForMana()) { openZoomPerm(group[0]); return; }
  if (untapped.length === 0) { toast('Queste terre sono già tutte tappate'); return; }
  if (untapped.length === 1) { tapLands(untapped); return; }
  ask({
    player: H, kind: 'option',
    title: 'Quante ' + cdb(group[0].key).name + ' vuoi tappare?',
    options: untapped.map((_, i) => ({ label: 'Tappa ' + (i + 1), value: i + 1 }))
      .concat([{ label: 'Tutte (' + untapped.length + ')', value: untapped.length }])
      .filter((o, i, arr) => arr.findIndex(x => x.value === o.value) === i),
    cancellable: true,
    cb: k => { if (k) tapLands(untapped.slice(0, k)); },
  });
}
function tapLands(lands) {
  const key = lands[0].key;
  const prod = landProduction(lands[0]);
  const pool = G.players[H].pool;
  if (prod.both) { // Izzet Boilerworks: {U}{R} each
    lands.forEach(l => { l.tapped = true; pool.U++; pool.R++; });
    log('Tappi ' + lands.length + ' ' + cdb(key).name + ': +' + lands.length + 'U +' + lands.length + 'R.', 'log-me');
    renderAll(); return;
  }
  if (key === 'Temple of Epiphany') { // choice of U or R
    ask({
      player: H, kind: 'option', title: 'Temple of Epiphany produce...',
      options: [{ label: 'Blu (U)', value: 'U' }, { label: 'Rosso (R)', value: 'R' }],
      cb: col => {
        lands.forEach(l => { l.tapped = true; pool[col]++; });
        log('Tappi ' + lands.length + ' Temple of Epiphany: +' + lands.length + col + '.', 'log-me');
        renderAll();
      },
    });
    return;
  }
  lands.forEach(l => { l.tapped = true; pool.U++; }); // plain blue source
  log('Tappi ' + lands.length + ' ' + cdb(key).name + ': +' + lands.length + 'U.', 'log-me');
  renderAll();
}
function onBoardCardTap(perm, d) {
  if (uiMode === 'target' && G.pending) {
    const opt = (G.pending.options || []).find(o => o.type === 'perm' && o.pid === perm.pid);
    if (opt) { setUiMode('idle'); answer(opt); }
    return;
  }
  // tap a single (ungrouped) land for mana
  if (isLandKey(perm.key) && !isCreatureOnField(perm) && perm.controller === H && canTapForMana()) {
    if (!perm.tapped) { tapLands([perm]); return; }
    openZoomPerm(perm); return;
  }
  if (uiMode === 'attack') {
    if (!uiCtx.eligible.includes(perm.pid)) return;
    const i = uiCtx.selected.indexOf(perm.pid);
    if (i >= 0) uiCtx.selected.splice(i, 1); else uiCtx.selected.push(perm.pid);
    d.classList.toggle('selected');
    renderActionBar();
    return;
  }
  if (uiMode === 'block') {
    onBlockTap(perm, d);
    return;
  }
  openZoomPerm(perm);
}
function onStackTap(item, d) {
  if (uiMode === 'target' && G.pending) {
    const opt = (G.pending.options || []).find(o => o.type === 'stack' && o.sid === item.id);
    if (opt) { setUiMode('idle'); answer(opt); }
    return;
  }
  openZoomKey(item.key, item.isCopy ? 'Copia sulla pila' : 'Sulla pila');
}

// ---------- blocking UI: tap your creature, then tap the attacker ----------
function onBlockTap(perm, d) {
  if (perm.controller === H && uiCtx.blockersAvail.includes(perm.pid)) {
    uiCtx.pickedBlocker = perm.pid;
    document.querySelectorAll('#my-field .tile').forEach(x => x.classList.remove('selected'));
    d.classList.add('selected');
    $('action-hint').textContent = 'Ora tocca l’attaccante da bloccare con ' + cdb(perm.key).name;
    return;
  }
  if (perm.controller === A && uiCtx.attackers.includes(perm.pid) && uiCtx.pickedBlocker) {
    if (hasFlying(perm) && !hasFlying(permOf(uiCtx.pickedBlocker))) {
      toast('Vola: può essere bloccato solo da creature volanti');
      return;
    }
    // remove blocker from any previous assignment
    Object.keys(uiCtx.map).forEach(k => { uiCtx.map[k] = uiCtx.map[k].filter(b => b !== uiCtx.pickedBlocker); });
    (uiCtx.map[perm.pid] = uiCtx.map[perm.pid] || []).push(uiCtx.pickedBlocker);
    uiCtx.pickedBlocker = null;
    $('action-hint').textContent = 'Blocchi assegnati: ' + Object.values(uiCtx.map).reduce((s, a) => s + a.length, 0) + '. Tocca un’altra creatura o conferma.';
    renderBlocksPreview();
  }
}
function renderBlocksPreview() {
  document.querySelectorAll('#my-field .tile').forEach(x => {
    x.classList.toggle('blocking', Object.values(uiCtx.map).some(a => a.includes(x.dataset.pid)));
    x.classList.remove('selected');
  });
}

// ---------- action bar ----------
function setUiMode(mode) {
  uiMode = mode;
  if (mode !== 'respond') { /* keep uiCtx for windows */ }
  renderAll();
}
function renderActionBar() {
  const hint = $('action-hint'), btn = $('btn-main'), hold = $('btn-hold');
  hold.classList.toggle('on', G.holdPriority);
  btn.classList.remove('hidden');
  btn.disabled = false;
  if (G.over) { btn.disabled = true; hint.textContent = ''; return; }
  if (G.pending && G.pending.player === A) { hint.textContent = "L'IA sta pensando…"; btn.disabled = true; btn.textContent = '…'; return; }
  switch (uiMode) {
    case 'main': {
      const ph = G.turn.phase;
      const pool = G.players[H].pool;
      hint.textContent = (pool.U || pool.R)
        ? 'Tocca una carta per giocarla (o tappa altre terre).'
        : 'Tocca le terre per il mana, poi la carta da lanciare.';
      btn.textContent = ph === 'main1' ? 'Combattimento' : 'Fine turno';
      btn.onclick = () => { if (legalSorcerySpeed(H)) setPhase(ph === 'main1' ? 'attack' : 'end'); };
      break;
    }
    case 'respond': {
      const top = G.stack[G.stack.length - 1];
      hint.textContent = uiCtx.hint || (top ? cdb(top.key).name + (top.controller === A ? " dell'IA" : '') + ' è sulla pila. Tappa le terre e rispondi, o passa.' : 'Puoi rispondere.');
      btn.textContent = 'Passa';
      btn.onclick = () => {
        if (uiCtx.window) { const f = uiCtx.windowPass; uiCtx = {}; setUiMode('idle'); f(); }
        else { setUiMode('idle'); passPriority(H); }
      };
      break;
    }
    case 'attack': {
      hint.textContent = 'Tocca le creature con cui attaccare (' + uiCtx.selected.length + ' scelte).';
      btn.textContent = uiCtx.selected.length ? 'Attacca (' + uiCtx.selected.length + ')' : 'Non attaccare';
      btn.onclick = () => { const sel = uiCtx.selected.slice(); uiCtx = {}; setUiMode('idle'); answer(sel); };
      break;
    }
    case 'block': {
      const n = Object.values(uiCtx.map).reduce((s, a) => s + a.length, 0);
      if (!uiCtx.pickedBlocker) hint.textContent = 'Tocca una tua creatura per bloccare (' + n + ' blocchi).';
      btn.textContent = n ? 'Conferma blocchi' : 'Nessun blocco';
      btn.onclick = () => { const m = uiCtx.map; uiCtx = {}; setUiMode('idle'); answer(m); };
      break;
    }
    case 'target': {
      hint.textContent = (G.pending && G.pending.title) || 'Scegli un bersaglio.';
      if (G.pending && G.pending.cancellable) {
        btn.textContent = 'Annulla';
        btn.onclick = () => { setUiMode('idle'); answer(null); };
      } else { btn.disabled = true; btn.textContent = '—'; }
      break;
    }
    default: {
      hint.textContent = G.turn.active === A ? "Turno dell'IA…" : '';
      btn.disabled = true;
      btn.textContent = '…';
    }
  }
}

// ---------- counts panel ----------
function renderCounts() {
  const el = $('counts-list');
  if (!el || $('counts-panel').classList.contains('hidden')) return;
  el.innerHTML = '';
  Object.keys(CARD_DB).forEach(k => {
    const pub = publicSeenCount(k);
    const mine = handOf(H).filter(i => keyOf(i) === k).length;
    const unknown = cdb(k).qty - pub - mine;
    const row = document.createElement('div');
    row.className = 'cnt-row' + (unknown <= 0 ? ' gone' : '');
    row.innerHTML = '<span>' + cdb(k).name + '</span><span>' + pub + ' viste · ' + mine + ' in mano · ' + unknown + ' ?</span>';
    el.appendChild(row);
  });
}

// ============================================================
// ZOOM MODAL
// ============================================================
function openZoomKey(key, note, actions) {
  const zc = $('zoom-card');
  zc.innerHTML = '';
  const data = cdb(key);
  const img = document.createElement('img');
  img.src = data.img;
  img.alt = data.name;
  img.onerror = () => {
    img.remove();
    const t = document.createElement('div');
    t.className = 'zoom-text';
    t.innerHTML = '<h3>' + data.name + ' ' + manaSymbols(data.cost) + '</h3><i>' + data.type + '</i>\n\n' + (data.text || '') + (data.power ? '\n\n' + data.power + '/' + data.toughness : '');
    zc.appendChild(t);
  };
  zc.appendChild(img);
  if (note) {
    const n = document.createElement('div');
    n.className = 'zoom-note';
    n.textContent = note;
    zc.appendChild(n);
  }
  const za = $('zoom-actions');
  za.innerHTML = '';
  (actions || []).forEach(a => {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' btn-primary' : '');
    b.textContent = a.label;
    b.onclick = () => { closeZoom(); a.fn(); };
    za.appendChild(b);
  });
  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = 'Chiudi';
  close.onclick = closeZoom;
  za.appendChild(close);
  $('zoom-modal').classList.remove('hidden');
  zoomApertoA = Date.now();
}
/* Quando si sono aperti la finestra della carta e il foglio delle scelte.
   Servono a ignorare il CLICK FANTASMA che il tocco si porta dietro: vedi
   bindUI. Il foglio ne ha bisogno quanto la finestra, perche' il menu della
   carta si apre con una PRESSIONE LUNGA — quindi mentre il dito e' ancora
   giu' — e il click in ritardo, arrivando dopo, cadrebbe dritto su una delle
   sue voci, scegliendola da sola. */
let zoomApertoA = 0, foglioApertoA = 0;
function closeZoom() { $('zoom-modal').classList.add('hidden'); }

/* ---------- l'anteprima dentro le scelte ----------
   Dove si SCEGLIE una carta (scartare, mettere sotto, cercare nel cimitero)
   non si puo' aprire una finestra a ogni tocco: con cinque carte da scartare
   sarebbero cinque finestre da chiudere. E non si puo' nemmeno lasciare la
   scelta su tessere da 66px, dove il testo di una magia non si legge.
   Quindi la carta toccata compare INGRANDITA li' sopra, senza coprire niente
   e senza niente da chiudere: immagine piu' grande a sinistra e, a destra, il
   testo della carta come TESTO VERO — che si legge a qualunque risoluzione,
   mentre la scritta dentro l'illustrazione no. Toccando l'anteprima si apre
   comunque la carta a tutto schermo. */
function mostraAnteprima(el, key) {
  if (!el) return;
  const d = cdb(key);
  el.classList.remove('hidden');
  el.dataset.key = key;
  el.innerHTML = '';
  const fig = document.createElement('div');
  fig.className = 'ant-card';
  const img = document.createElement('img');
  img.src = d.img;
  img.alt = d.name;
  img.onerror = () => img.remove();
  fig.appendChild(img);
  const txt = document.createElement('div');
  txt.className = 'ant-txt';
  const h = document.createElement('div');
  h.className = 'ant-nome';
  h.textContent = d.name;
  const c = document.createElement('span');
  c.className = 'ant-costo';
  c.textContent = manaSymbols(d.cost);
  h.appendChild(c);
  const t = document.createElement('div');
  t.className = 'ant-tipo';
  t.textContent = d.type + (d.power ? '  ·  ' + d.power + '/' + d.toughness : '');
  const p = document.createElement('div');
  p.className = 'ant-testo';
  p.textContent = d.text || '';
  txt.appendChild(h); txt.appendChild(t); txt.appendChild(p);
  el.appendChild(fig); el.appendChild(txt);
  el.onclick = () => openZoomKey(key);
  // il segno "scorri" si mette solo se c'e' davvero altro da leggere
  txt.classList.toggle('ha-altro', p.scrollHeight > p.clientHeight + 1);
}
function nascondiAnteprima(el) {
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
  el.onclick = null;
  delete el.dataset.key;
}
function openZoomHand(iid) {
  const k = keyOf(iid);
  const actions = [];
  if (castableFromHand(H, iid)) {
    actions.push({
      label: isLandKey(k) ? 'Gioca' : 'Lancia ' + manaSymbols(cdb(k).cost), primary: true,
      fn: () => {
        if (isLandKey(k)) playLand(H, iid);
        else castSpell(H, iid, ok => { if (!ok && uiMode === 'idle') setUiMode(G.prio || uiCtx.window ? 'respond' : 'main'); });
      },
    });
  }
  if (canCycle(H, iid)) actions.push({ label: 'Cicla (pesca 1)', fn: () => doCycle(H, iid) });
  let note = null;
  // if it's the right moment but the pool is short, nudge the player to tap lands
  if (!isLandKey(k) && actions.length === 0) {
    const cost = parseCost(cdb(k).cost);
    const timingOk = isSorceryKey(k) ? legalSorcerySpeed(H) : (legalSorcerySpeed(H) || uiModeAllowsInstant(H));
    if (timingOk && effectHasLegalUse(k, H) && !poolCovers(H, cost) && canPay(H, cost)) {
      note = 'Serve più mana: tappa le terre (' + manaSymbols(cdb(k).cost) + ') e riprova.';
    }
  }
  if (k === 'Memory Lapse') note = 'La magia neutralizzata va in cima alla libreria CONDIVISA: la pesca chi pesca per primo…';
  openZoomKey(k, note, actions);
}
function openZoomPerm(perm) {
  const actions = [];
  if (perm.controller === H && canSacTemple(perm) && (uiMode === 'main' || uiMode === 'respond')) {
    actions.push({ label: 'Sacrifica: {U}{U}', fn: () => sacTempleForMana(perm) });
  }
  let note = null;
  if (perm.key === 'Dandan' && abilitiesActive(perm)) {
    const w = dandanIslandWord(perm);
    note = 'Può attaccare solo se il difensore controlla una terra ' + (TYPE_IT[w] || w) + '. Sacrificato se il controllore non ne controlla.';
  }
  openZoomKey(perm.key, note, actions);
}

// ============================================================
// HUMAN CHOICE UI (prompt sheet / browser / inline)
// ============================================================
function hidePrompt() {
  $('prompt-sheet').classList.add('hidden');
  $('browser-modal').classList.add('hidden');
}
function showHumanChoice(spec) {
  switch (spec.kind) {
    case 'target': {
      if ((spec.options || []).every(o => o.type === 'gycard')) {
        showBrowser(spec.title, spec.options.map(o => o.iid), 1, iids => answer(spec.options.find(o => o.iid === iids[0])), spec.cancellable);
        return;
      }
      if ((spec.options || []).every(o => o.type === 'player')) {
        showSheet(spec.title, spec.options.map(o => ({ label: o.p === H ? 'Tu' : "L'IA", value: o })), v => answer(v), spec.cancellable);
        return;
      }
      setUiMode('target');
      return;
    }
    case 'option': {
      showSheet(spec.title, spec.options.map(o => ({ label: o.label, value: o.value, disabled: o.disabled })), v => answer(v), spec.cancellable, spec.searchable);
      return;
    }
    case 'yesno': {
      if (spec.showHand) {
        showCardSheet(spec.title, spec.showHand, [
          { label: 'Tieni', value: true }, { label: 'Mulligan', value: false },
        ], v => answer(v));
        return;
      }
      showSheet(spec.title, [{ label: 'Sì', value: true }, { label: 'No', value: false }], v => answer(v));
      return;
    }
    case 'scry': {
      showCardSheet(spec.title, [spec.card], [
        { label: 'Lascia in cima', value: false }, { label: 'Metti in fondo', value: true },
      ], v => answer(v));
      return;
    }
    case 'cards': {
      showCardPicker(spec, iids => answer(iids));
      return;
    }
    case 'order': {
      showOrderPicker(spec, order => answer(order));
      return;
    }
    case 'browse': {
      showBrowser(spec.title, spec.cards, spec.pick || 1, iids => answer(iids), false, spec.sortByName);
      return;
    }
    case 'attackers': {
      uiCtx = { eligible: spec.options.slice(), selected: [] };
      setUiMode('attack');
      return;
    }
    case 'blockers': {
      uiCtx = { attackers: spec.attackers, blockersAvail: spec.blockersAvail, map: {}, pickedBlocker: null };
      setUiMode('block');
      toast('Tocca una tua creatura, poi l’attaccante da bloccare');
      return;
    }
  }
}
function showSheet(title, options, cb, cancellable, searchable) {
  $('prompt-title').textContent = title;
  nascondiAnteprima($('prompt-zoom'));   // qui si scelgono parole, non carte
  const body = $('prompt-body');
  body.innerHTML = '';
  let filter = '';
  const renderOpts = () => {
    body.querySelectorAll('.opt-btn').forEach(x => x.remove());
    options.forEach(o => {
      if (filter && !o.label.toLowerCase().includes(filter)) return;
      const b = document.createElement('button');
      b.className = 'opt-btn';
      b.textContent = o.label;
      if (o.disabled) b.disabled = true;
      b.onclick = () => cb(o.value);
      body.appendChild(b);
    });
  };
  if (searchable && options.length > 8) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Filtra…';
    inp.className = 'opt-btn';
    inp.oninput = () => { filter = inp.value.toLowerCase(); renderOpts(); };
    body.appendChild(inp);
  }
  renderOpts();
  const acts = $('prompt-actions');
  acts.innerHTML = '';
  if (cancellable) {
    const c = document.createElement('button');
    c.className = 'btn';
    c.textContent = 'Annulla';
    c.onclick = () => cb(null);
    acts.appendChild(c);
  }
  $('prompt-sheet').classList.remove('hidden');
}
function showCardSheet(title, iids, options, cb) {
  $('prompt-title').textContent = title;
  const body = $('prompt-body');
  const ant = $('prompt-zoom');
  body.innerHTML = '';
  nascondiAnteprima(ant);
  if (iids.length) mostraAnteprima(ant, keyOf(iids[0]));
  iids.forEach(iid => {
    const d = cardEl(keyOf(iid));
    d.onclick = () => {
      body.querySelectorAll('.card').forEach(x => x.classList.remove('guardata'));
      d.classList.add('guardata');
      mostraAnteprima(ant, keyOf(iid));
    };
    body.appendChild(d);
  });
  const acts = $('prompt-actions');
  acts.innerHTML = '';
  options.forEach(o => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = o.label;
    b.onclick = () => cb(o.value);
    acts.appendChild(b);
  });
  $('prompt-sheet').classList.remove('hidden');
}
function showCardPicker(spec, cb) {
  $('prompt-title').textContent = spec.title;
  const body = $('prompt-body');
  const ant = $('prompt-zoom');
  body.innerHTML = '';
  nascondiAnteprima(ant);
  if (spec.zone.length) mostraAnteprima(ant, keyOf(spec.zone[0]));
  const selected = [];
  const confirm = document.createElement('button');
  const update = () => {
    confirm.textContent = 'Conferma (' + selected.length + '/' + spec.min + ')';
    confirm.disabled = selected.length < spec.min || selected.length > spec.max;
  };
  spec.zone.forEach(iid => {
    const d = cardEl(keyOf(iid));
    d.onclick = () => {
      mostraAnteprima(ant, keyOf(iid));   // toccata = vista, sempre
      const i = selected.indexOf(iid);
      if (i >= 0) { selected.splice(i, 1); d.classList.remove('selected'); d.querySelectorAll('.badge').forEach(x => x.remove()); }
      else if (selected.length < spec.max) { selected.push(iid); d.classList.add('selected'); }
      if (spec.ordered) {
        body.querySelectorAll('.card').forEach(x => x.querySelectorAll('.badge').forEach(y => y.remove()));
        body.querySelectorAll('.card').forEach(x => {
          const idx = selected.indexOf(x.dataset.iid);
          if (idx >= 0) addBadge(x, String(idx + 1), 0);
        });
      }
      update();
    };
    d.dataset.iid = iid;
    body.appendChild(d);
  });
  const acts = $('prompt-actions');
  acts.innerHTML = '';
  confirm.className = 'btn btn-primary';
  confirm.onclick = () => cb(selected.slice());
  acts.appendChild(confirm);
  update();
  $('prompt-sheet').classList.remove('hidden');
}
function showOrderPicker(spec, cb) {
  showCardPicker({ title: spec.title, zone: spec.cards, min: spec.cards.length, max: spec.cards.length, ordered: true }, cb);
}
function showBrowser(title, iids, pick, cb, cancellable, sortByName) {
  $('browser-title').textContent = title;
  const listEl = $('browser-list');
  const ant = $('browser-zoom');
  listEl.innerHTML = '';
  nascondiAnteprima(ant);
  let list = iids.slice();
  if (sortByName) list.sort((a, b) => cdb(keyOf(a)).name.localeCompare(cdb(keyOf(b)).name));
  if (list.length) mostraAnteprima(ant, keyOf(list[0]));
  const selected = [];
  const confirm = document.createElement('button');
  const update = () => {
    confirm.textContent = 'Conferma';
    confirm.disabled = selected.length !== pick;
  };
  list.forEach(iid => {
    const d = cardEl(keyOf(iid));
    d.onclick = () => {
      mostraAnteprima(ant, keyOf(iid));   // toccata = vista, sempre
      const i = selected.indexOf(iid);
      if (i >= 0) { selected.splice(i, 1); d.classList.remove('selected'); }
      else { if (selected.length >= pick) { const old = selected.shift(); listEl.querySelectorAll('.card').forEach(x => { if (x.dataset.iid === old) x.classList.remove('selected'); }); } selected.push(iid); d.classList.add('selected'); }
      update();
    };
    d.dataset.iid = iid;
    listEl.appendChild(d);
  });
  const acts = $('browser-actions');
  acts.innerHTML = '';
  if (cancellable) {
    const c = document.createElement('button');
    c.className = 'btn';
    c.textContent = 'Annulla';
    c.onclick = () => cb(null);
    acts.appendChild(c);
  }
  confirm.className = 'btn btn-primary';
  confirm.onclick = () => cb(selected.slice());
  acts.appendChild(confirm);
  update();
  $('browser-modal').classList.remove('hidden');
}

// ============================================================
// GAME START & MULLIGANS (London + one free mulligan each)
// ============================================================
function startGame() {
  G = freshGame();
  resetBoardUI();
  $('home-screen').classList.add('hidden');
  $('gameover-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  $('log-list').innerHTML = '';
  const starter = Math.random() < 0.5 ? H : A;
  G.turn.active = starter;
  log('Partita nuova: 80 carte condivise, mescolate. Inizia ' + (starter === H ? 'il giocatore' : "l'IA") + '.', 'log-turn');
  drawCards(H, 7, () => drawCards(A, 7, () => mulliganPhase(H, () => mulliganPhase(A, () => {
    log('— Turno 1: ' + (starter === H ? 'tuo' : "dell'IA") + ' —', 'log-turn');
    setPhase('untap');
  }))));
}
function mulliganPhase(p, next) {
  const decide = () => {
    if (p === A) {
      const lands = handOf(A).filter(iid => isLandKey(keyOf(iid))).length;
      const keep = lands >= 2 && lands <= 5;
      if (!keep && G.players[A].mulls < 3) doMull();
      else keepHand();
      return;
    }
    ask({
      player: H, kind: 'yesno', showHand: handOf(H).slice(),
      title: 'Tieni questa mano? (mulligan ' + G.players[p].mulls + (G.players[p].mulls === 0 ? ' — il primo è gratis' : '') + ')',
      cb: keep => { if (keep) keepHand(); else doMull(); },
    });
  };
  const doMull = () => {
    G.players[p].mulls++;
    handOf(p).slice().forEach(iid => { zoneRemove(iid); G.library.push(iid); });
    shuffle(G.library);
    log(nameIt(p) + ': mulligan (' + G.players[p].mulls + ').', p === H ? 'log-me' : 'log-ai');
    drawCards(p, 7, decide);
  };
  const keepHand = () => {
    const nBottom = Math.max(0, G.players[p].mulls - 1); // first mulligan is free
    if (nBottom === 0 || handOf(p).length <= nBottom) { next(); return; }
    if (p === A) {
      aiPickCards({ zone: handOf(A).slice(), min: nBottom }).forEach(iid => toLibraryBottom(iid));
      next();
      return;
    }
    ask({
      player: H, kind: 'cards', zone: handOf(H).slice(), min: nBottom, max: nBottom,
      title: 'Metti ' + nBottom + ' carta/e in fondo alla libreria',
      cb: iids => { (iids || []).forEach(iid => toLibraryBottom(iid)); next(); },
    });
  };
  renderAll();
  decide();
}

// ============================================================
// PERSISTENCE
// ============================================================
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SET_KEY));
    if (s && typeof s === 'object') return { reshuffle: !!s.reshuffle, bluff: s.bluff || 'normal' };
  } catch (e) { /* corrupt: fall through */ }
  return { reshuffle: false, bluff: 'normal' };
}
function saveSettings() {
  if (G) G.settings = { reshuffle: $('set-reshuffle').checked, bluff: $('set-bluff').value };
  localStorage.setItem(SET_KEY, JSON.stringify({ reshuffle: $('set-reshuffle').checked, bluff: $('set-bluff').value }));
}
function saveGame() {
  if (!G || G.over || G.pending || G.stack.length > 0) return;
  try {
    const skip = ['pending', 'resume', 'prio'];
    const json = JSON.stringify(G, (k, v) => (skip.includes(k) ? null : v));
    localStorage.setItem(SAVE_KEY, json);
  } catch (e) { /* storage full: play on without autosave */ }
}
function loadGame() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { s = null; }
  if (!s || !s.turn || !s.players) { localStorage.removeItem(SAVE_KEY); toast('Salvataggio non valido'); return false; }
  G = s;
  resetBoardUI();
  G.pending = null; G.resume = null; G.prio = null;
  G.settings = loadSettings();
  permSeq = Object.keys(G.perms).reduce((m, pid) => Math.max(m, parseInt(pid.slice(1), 10) || 0), 0);
  $('home-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  $('log-list').innerHTML = '';
  (G.log || []).forEach(l => {
    const d = document.createElement('div');
    if (l.cls) d.className = l.cls;
    d.textContent = l.msg;
    $('log-list').appendChild(d);
  });
  uiMode = 'idle'; uiCtx = {};
  log('Partita ripresa.', 'log-turn');
  setPhase(G.turn.phase === 'setup' ? 'untap' : G.turn.phase);
  return true;
}

// ============================================================
// GAME OVER SCREEN
// ============================================================
function showGameOver() {
  const win = G.over.winner === H;
  $('go-title').textContent = win ? 'Vittoria!' : 'Sconfitta';
  $('go-title').className = win ? 'win' : 'lose';
  $('go-reason').textContent = G.over.reason;
  $('go-stats').innerHTML =
    '<span>Turni giocati: <b>' + G.turn.n + '</b></span>' +
    '<span>Danni inflitti da te: <b>' + G.stats.dmgByHuman + '</b></span>' +
    '<span>Danni inflitti dall\'IA: <b>' + G.stats.dmgByAI + '</b></span>' +
    '<span>Magie neutralizzate: <b>' + G.stats.countered + '</b></span>' +
    '<span>Carte rimaste in libreria: <b>' + G.library.length + '</b></span>';
  $('gameover-screen').classList.remove('hidden');
}

// ============================================================
// GRAVEYARD VIEWER (with flashback)
// ============================================================
function openGraveyard() {
  if (!G) return;
  if (G.graveyard.length === 0) { toast('Il cimitero condiviso è vuoto'); return; }
  showBrowser('Cimitero condiviso (' + G.graveyard.length + ')', G.graveyard.slice().reverse(), 1, iids => {
    hidePrompt();
    if (!iids || !iids[0]) return;
    const iid = iids[0];
    const actions = [];
    if (canFlashback(H, iid)) actions.push({ label: 'Flashback {2}{R}', primary: true, fn: () => castFlashback(H, iid) });
    openZoomKey(keyOf(iid), 'Nel cimitero condiviso', actions);
  }, true);
}

// ============================================================
// INIT / BINDINGS
// ============================================================
function bindUI() {
  $('btn-new').onclick = startGame;
  $('btn-resume').onclick = () => { if (!loadGame()) $('btn-resume').classList.add('hidden'); };
  $('btn-rules').onclick = () => $('rules-recap').classList.toggle('hidden');
  $('btn-settings').onclick = () => $('settings-modal').classList.remove('hidden');
  $('btn-settings-close').onclick = () => { saveSettings(); $('settings-modal').classList.add('hidden'); };
  $('btn-again').onclick = startGame;
  $('btn-home').onclick = () => {
    $('gameover-screen').classList.add('hidden');
    $('game-screen').classList.add('hidden');
    $('home-screen').classList.remove('hidden');
    refreshResumeBtn();
  };
  $('tb-menu').onclick = () => $('menu-modal').classList.remove('hidden');
  $('btn-menu-close').onclick = () => $('menu-modal').classList.add('hidden');
  $('btn-menu-concede').onclick = () => {
    $('menu-modal').classList.add('hidden');
    if (G && !G.over) gameOver(A, 'Hai conceduto la partita.');
  };
  $('pile-gy').onclick = openGraveyard;
  $('pile-lib').onclick = () => toast('Libreria condivisa: ' + (G ? G.library.length : 80) + ' carte. L\'ordine è segreto.');
  $('tb-log').onclick = () => { $('log-panel').classList.toggle('hidden'); $('counts-panel').classList.add('hidden'); };
  $('tb-counts').onclick = () => { $('counts-panel').classList.toggle('hidden'); $('log-panel').classList.add('hidden'); renderCounts(); };
  document.querySelectorAll('.panel-close').forEach(b => {
    b.onclick = () => $(b.dataset.close).classList.add('hidden');
  });
  $('btn-hold').onclick = () => {
    if (!G) return;
    G.holdPriority = !G.holdPriority;
    toast(G.holdPriority ? 'Tieni la priorità: ti fermerai a ogni occasione' : 'Priorità automatica');
    renderAll();
  };
  /* IL CLICK FANTASMA. Su un telefono, dopo un tocco il browser manda un
     `click` in ritardo (~300ms) che colpisce cio' che si trova in quel punto
     IN QUEL MOMENTO. La carta si apriva a schermo intero proprio sotto il
     dito, e il click in ritardo la trovava li': a schermo restava un lampo.
     E non e' solo lo sfondo — sotto il dito puo' esserci "Chiudi", o
     peggio "Lancia", e la carta partiva da sola.
     Quindi la finestra IGNORA TUTTO per i primi 400ms: si intercetta in fase
     di cattura, prima che l'evento arrivi ai pulsanti. Col mouse il problema
     non esiste (il click punta al bersaglio comune di premuta e rilascio,
     cioe' la carta), ed e' per questo che il banco di prova va fatto col
     `touchscreen` e non col mouse. */
  const zm = $('zoom-modal');
  zm.addEventListener('click', e => {
    if (Date.now() - zoomApertoA < 400) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  $('prompt-sheet').addEventListener('click', e => {
    if (Date.now() - foglioApertoA < 400) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  // lo sfondo chiude solo se il dito ci si e' anche APPOGGIATO sopra
  let giuSulloSfondo = false;
  zm.addEventListener('pointerdown', e => { giuSulloSfondo = (e.target === zm); });
  zm.addEventListener('click', e => {
    if (e.target === zm && giuSulloSfondo) closeZoom();
    giuSulloSfondo = false;
  });
  // settings initial values
  const s = loadSettings();
  $('set-reshuffle').checked = s.reshuffle;
  $('set-bluff').value = s.bluff;
}
function refreshResumeBtn() {
  const has = !!localStorage.getItem(SAVE_KEY);
  $('btn-resume').classList.toggle('hidden', !has);
}
function isCapacitorNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
document.addEventListener('DOMContentLoaded', () => {
  if (isCapacitorNative()) document.body.classList.add('capacitor');
  bindUI();
  refreshResumeBtn();
});

// debug handle (?debug)
if (location.search.includes('debug')) {
  window.FF = {
    get G() { return G; },
    H, A, CARD_DB,
    startGame, drawCards, castSpell, playLand, setPhase, checkState,
    doCycle, canCycle, castFlashback, canFlashback, sacTempleForMana,
    castableFromHand, effectHasLegalUse, legalSorcerySpeed, poolCovers, canPay,
    // perche' una carta in mano non si puo' lanciare, a parole
    perche: iid => castableFromHand(H, iid) ? '(si puo lanciare)' : spiegaPerchéNo(iid),
    // i bersagli che una carta troverebbe adesso
    bersagliDi: key => {
      const eff = cardEffects[key];
      if (!eff) return '(nessun effetto scriptato)';
      if (eff.modes) return 'modi: ' + eff.modes(H).map(m => (m.legal ? '✔ ' : '✘ ') + m.label).join(' | ');
      if (!eff.targets) return '(non ha bersagli)';
      return eff.targets(H, null).map(t => targetName(t)).join(', ') || '(nessuno)';
    },
    cheat: {
      draw: n => drawCards(H, n || 1, () => {}),
      /* Le tre leve che servono al collaudo carta per carta (tools/carte.js):
         portare in mano una carta PRECISA, avere mana a sufficienza, e
         mettere qualcosa nel cimitero o sulla pila. Senza queste, provare
         Mystic Retrieval o Memory Lapse vorrebbe dire giocare finche' non
         capitano. Non toccano le regole: spostano carte fra le zone. */
      /* Trova una copia di `key` DOVUNQUE sia: libreria, cimitero, mano
         dell'altro. Cercarla solo in libreria rendeva il collaudo un terno al
         lotto — di Brainstorm ce ne sono due in ottanta carte, e se erano
         gia' nelle mani d'apertura la prova falliva senza che ci fosse
         niente di rotto nel gioco. */
      trova: (key, escludi) => {
        const ok = x => keyOf(x) === key && !(escludi || []).includes(x);
        return G.library.find(ok) || G.graveyard.find(ok)
          || handOf(A).find(ok) || handOf(H).find(ok);
      },
      give: (key, n, p) => {
        p = p === undefined ? H : p;
        const out = [];
        for (let i = 0; i < (n || 1); i++) {
          const iid = window.FF.cheat.trova(key, out);
          if (!iid) break;
          // se e' gia' in mano va bene com'e': serviva una copia, ce l'ho
          if (!handOf(p).includes(iid)) toHand(iid, p);
          out.push(iid);
        }
        renderAll();
        return out;
      },
      /* `mana(n)` vuol dire "n mana PRONTI DA SPENDERE", non "n terre in
         campo": il giocatore umano paga dalla riserva, non dalle terre
         stappate (le tappa a mano), quindi mettere solo le terre lascerebbe
         la riserva a zero e ogni prova fallirebbe per mana mancante. */
      mana: (n, p) => {
        p = p === undefined ? H : p;
        n = n || 5;
        for (let i = 0; i < n; i++) {
          const iid = G.library.find(x => keyOf(x) === 'Island');
          if (!iid) break;
          zoneRemove(iid);
          newPerm(p, { iid, key: 'Island' });
        }
        G.players[p].pool.U += n;
        renderAll();
      },
      // tappa tutte le terre di un giocatore: serve al collaudo per lasciare
      // all'IA le sue Isole (senza, i suoi Dandan si sacrificano) ma non il
      // mana per rispondere, altrimenti neutralizza la carta in prova
      tappa: p => {
        fieldOf(p === undefined ? A : p).forEach(x => { if (isLandKey(x.key)) x.tapped = true; });
        renderAll();
      },
      pool: (u, r, p) => {
        p = p === undefined ? H : p;
        G.players[p].pool.U += (u || 0);
        G.players[p].pool.R += (r || 0);
        renderAll();
      },
      gy: (key, n) => {
        for (let i = 0; i < (n || 1); i++) {
          const iid = G.library.find(x => keyOf(x) === key)
            || handOf(A).find(x => keyOf(x) === key)
            || handOf(H).find(x => keyOf(x) === key);
          if (!iid) break;
          toGraveyard(iid);
        }
        renderAll();
      },
      // una magia dell'IA sulla pila, per provare le neutralizzazioni
      pila: key => {
        const iid = window.FF.cheat.trova(key || 'Brainstorm');
        if (!iid) return null;
        zoneRemove(iid);
        G.cards[iid].owner = A;
        const item = { id: 's' + Math.random().toString(36).slice(2, 8), iid, key: keyOf(iid), controller: A, targets: [], mode: null, chosen: {}, isCopy: false, countered: false };
        G.stack.push(item);
        renderAll();
        return item.id;
      },
      lands: () => { for (let i = 0; i < 4; i++) { const iid = G.library.find(x => keyOf(x) === 'Island'); if (iid) { zoneRemove(iid); newPerm(H, { iid, key: 'Island' }); } } renderAll(); },
      // solo per il collaudo: porta il campo al caso peggiore senza dover
      // giocare venti turni. Non tocca le regole, sposta solo delle carte.
      board: (o) => {
        o = o || {};
        const put = (p, key, n) => {
          for (let i = 0; i < n; i++) {
            const iid = G.library.find(x => keyOf(x) === key);
            if (!iid) return;
            zoneRemove(iid);
            const pm = newPerm(p, { iid, key });
            if (o.tap && i % 2 === 0) pm.tapped = true;
          }
        };
        const LK = ['Island', 'Halimar Depths', 'Remote Isle', 'Izzet Boilerworks', 'Temple of Epiphany', 'Svyelunite Temple', 'Lonely Sandbar', 'Mystic Sanctuary'];
        [[H, o.myLands || 0], [A, o.aiLands || 0]].forEach(([p, n]) => {
          put(p, 'Island', Math.max(0, n - (o.kinds || 0)));
          for (let i = 1; i <= (o.kinds || 0) && i < LK.length; i++) put(p, LK[i], 1);
        });
        put(H, 'Dandan', o.myCrea || 0);
        put(A, 'Dandan', o.aiCrea || 0);
        if (o.hand) drawCards(H, o.hand, () => renderAll());
        renderAll();
      },
    },
  };
}
