const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PLAYERS_PATH = path.join(ROOT, 'data', 'players.json');

const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
const sessions = new Map();

const formations = {
  '4-3-3': ['LW', 'ST', 'RW', 'CM1', 'CM2', 'CM3', 'LB', 'CB1', 'CB2', 'RB', 'GK'],
  '4-4-2': ['LM', 'ST1', 'ST2', 'RM', 'CM1', 'CM2', 'LB', 'CB1', 'CB2', 'RB', 'GK'],
  '3-5-2': ['ST1', 'ST2', 'LM', 'CM1', 'CDM', 'CM2', 'RM', 'CB1', 'CB2', 'CB3', 'GK'],
  '4-2-4': ['LW', 'ST1', 'ST2', 'RW', 'CM1', 'CM2', 'LB', 'CB1', 'CB2', 'RB', 'GK']
};

const slotPositionMap = {
  LW: 'LW', RW: 'RW', ST: 'ST', ST1: 'ST', ST2: 'ST', CF: 'ST',
  LM: 'LM', RM: 'RM', CAM: 'CAM', CM: 'CM', CM1: 'CM', CM2: 'CM', CM3: 'CM', CDM: 'CDM',
  LB: 'LB', RB: 'RB', CB: 'CB', CB1: 'CB', CB2: 'CB', CB3: 'CB', GK: 'GK'
};

const formationMods = {
  '4-3-3': { attack: 2, defense: 0, midfield: 1 },
  '4-4-2': { attack: 1, defense: 1, midfield: 0 },
  '3-5-2': { attack: 1, defense: -1, midfield: 3 },
  '4-2-4': { attack: 4, defense: -3, midfield: -1 }
};

const slotWeights = { GK: 1, CB: 1, LB: .95, RB: .95, CDM: 1, CM: 1, CAM: 1, LM: .98, RM: .98, LW: .98, RW: .98, ST: 1.02 };
const attackWeights = { ST: 1, LW: .85, RW: .85, CAM: .75, LM: .65, RM: .65, CM: .45, CDM: .25, LB: .30, RB: .30, CB: .08, GK: .02 };
const defenseWeights = { GK: .90, CB: 1, LB: .80, RB: .80, CDM: .75, CM: .35, LM: .25, RM: .25, CAM: .15, LW: .12, RW: .12, ST: .08 };
const midfieldWeights = { CM: 1, CDM: 1, CAM: 1, LM: .65, RM: .65, LB: .40, RB: .40, LW: .35, RW: .35, ST: .25, CB: .20, GK: .05 };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 64) {
        reject(new Error('Body terlalu besar'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('JSON tidak valid')); }
    });
  });
}

function randomId() {
  return crypto.randomBytes(16).toString('hex');
}

function randInt(max) {
  return crypto.randomInt(0, max);
}

function randFloat() {
  return randInt(1_000_000_000) / 1_000_000_000;
}

function uniform(min, max) {
  return min + randFloat() * (max - min);
}

function normal(mean = 0, sigma = 1) {
  const u1 = Math.max(randFloat(), Number.EPSILON);
  const u2 = randFloat();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sigma;
}

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function normalizePosition(value) {
  return slotPositionMap[value] || value;
}

function playerPositions(player) {
  return new Set([player.position, ...(player.alt || [])]);
}

function positionFit(slot, player) {
  const target = normalizePosition(slot);
  const options = playerPositions(player);
  if (options.has(target)) return 1;

  const attackers = ['ST', 'CF', 'LW', 'RW', 'LM', 'RM', 'CAM'];
  const midfielders = ['CAM', 'CM', 'CDM', 'LM', 'RM'];
  const defenders = ['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM'];

  if (target === 'ST' && [...options].some(p => ['ST', 'CF', 'LW', 'RW', 'CAM'].includes(p))) return .85;
  if (attackers.includes(target) && [...options].some(p => attackers.includes(p))) return .70;
  if (midfielders.includes(target) && [...options].some(p => midfielders.includes(p))) return .70;
  if (defenders.includes(target) && [...options].some(p => defenders.includes(p))) return .70;
  return .20;
}

function isCompatible(slot, player) {
  return positionFit(slot, player) >= .70;
}

function sessionHasAvailableRole(session) {
  if (!session || !session.activeOffer || !Array.isArray(session.currentOffer)) return false;
  const usedPlayerIds = new Set(Object.values(session.squad || {}).map(player => player.id));
  const openSlots = (session.slots || []).filter(slot => !session.squad[slot]);
  if (!openSlots.length) return false;

  return session.currentOffer.some(playerId => {
    if (usedPlayerIds.has(playerId)) return false;
    const player = players.find(item => item.id === playerId);
    if (!player) return false;
    return openSlots.some(slot => isCompatible(slot, player));
  });
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    teamCode: player.teamCode,
    flag: player.flag,
    year: player.year,
    position: player.position,
    alt: player.alt || [],
    ovr: player.ovr,
    pac: player.pac,
    sho: player.sho,
    pas: player.pas,
    dri: player.dri,
    def: player.def,
    phy: player.phy,
    div: player.div,
    han: player.han,
    kic: player.kic,
    ref: player.ref,
    spd: player.spd,
    pos: player.pos
  };
}

function publicSquad(squad) {
  const output = {};
  for (const [slot, player] of Object.entries(squad || {})) {
    output[slot] = publicPlayer(player);
  }
  return output;
}

function getTeamYears() {
  const map = new Map();
  for (const p of players) {
    const key = `${p.teamCode}_${p.year}`;
    if (!map.has(key)) map.set(key, { team: p.team, teamCode: p.teamCode, flag: p.flag, year: p.year });
  }
  return [...map.values()];
}

function calculateChemistry(session) {
  const entries = Object.entries(session.squad || {});
  if (!entries.length) return 0;

  const selected = entries.map(([, p]) => p);
  const teamYearCounts = new Map();
  const nationCounts = new Map();
  const yearCounts = new Map();

  for (const p of selected) {
    teamYearCounts.set(`${p.teamCode}_${p.year}`, (teamYearCounts.get(`${p.teamCode}_${p.year}`) || 0) + 1);
    nationCounts.set(p.teamCode, (nationCounts.get(p.teamCode) || 0) + 1);
    yearCounts.set(String(p.year), (yearCounts.get(String(p.year)) || 0) + 1);
  }

  let fitGoodCount = 0;
  const values = entries.map(([slot, p]) => {
    const fit = positionFit(slot, p);
    if (fit >= .85) fitGoodCount++;

    const sameTeamYear = (teamYearCounts.get(`${p.teamCode}_${p.year}`) || 1) - 1;
    const sameNation = (nationCounts.get(p.teamCode) || 1) - 1;
    const sameEra = (yearCounts.get(String(p.year)) || 1) - 1;
    const avgLink = clamp(0, 100, 45 + sameTeamYear * 6 + sameNation * 3 + sameEra * 2);
    const cluster = Math.min(1, .15 * sameNation + .10 * sameTeamYear + .06 * sameEra);
    return clamp(0, 100, 100 * (.50 * fit + .35 * (avgLink / 100) + .15 * cluster));
  });

  const base = values.reduce((sum, value) => sum + value, 0) / values.length;
  const naturalBonus = fitGoodCount >= 9 ? 3 : 0;
  const outPenalty = entries.filter(([slot, p]) => positionFit(slot, p) < .65).length * 2;
  return Math.round(clamp(0, 100, base + naturalBonus - outPenalty));
}

function effectiveAttr(value, chem) {
  return clamp(1, 99, value + ((chem - 50) / 12.5));
}

function calculateSquadOVR(session) {
  const entries = Object.entries(session.squad || {});
  if (!entries.length) return 0;
  const chem = calculateChemistry(session) || 50;
  let total = 0;
  let weightSum = 0;
  for (const [slot, p] of entries) {
    const pos = normalizePosition(slot);
    const weight = slotWeights[pos] || 1;
    total += effectiveAttr(p.ovr, chem) * weight;
    weightSum += weight;
  }
  return Math.round(total / Math.max(weightSum, 1));
}

function playerAttackSkill(player, chem) {
  const pac = effectiveAttr(player.pac || 50, chem);
  const sho = effectiveAttr(player.sho || 30, chem);
  const pas = effectiveAttr(player.pas || 50, chem);
  const dri = effectiveAttr(player.dri || 50, chem);
  const phy = effectiveAttr(player.phy || 50, chem);
  if (player.position === 'GK') return .60 * (player.kic || pas) + .25 * (player.pos || player.ovr) + .15 * (player.spd || pac);
  return .30 * sho + .25 * dri + .20 * pas + .15 * pac + .10 * phy;
}

function playerDefenseSkill(player, chem) {
  const pac = effectiveAttr(player.pac || 50, chem);
  const sho = effectiveAttr(player.sho || 30, chem);
  const pas = effectiveAttr(player.pas || 50, chem);
  const dri = effectiveAttr(player.dri || 50, chem);
  const def = effectiveAttr(player.def || 50, chem);
  const phy = effectiveAttr(player.phy || 50, chem);
  if (player.position === 'GK') {
    return .30 * (player.ref || def) + .25 * (player.pos || player.ovr) + .20 * (player.div || def) + .15 * (player.han || phy) + .05 * (player.spd || pac) + .05 * (player.kic || pas);
  }
  return .40 * def + .22 * phy + .16 * pac + .10 * pas + .07 * dri + .05 * sho;
}

function playerMidfieldSkill(player, chem) {
  const pac = effectiveAttr(player.pac || 50, chem);
  const sho = effectiveAttr(player.sho || 30, chem);
  const pas = effectiveAttr(player.pas || 50, chem);
  const dri = effectiveAttr(player.dri || 50, chem);
  const def = effectiveAttr(player.def || 50, chem);
  const phy = effectiveAttr(player.phy || 50, chem);
  if (player.position === 'GK') return .50 * (player.kic || pas) + .30 * (player.pos || player.ovr) + .20 * (player.han || phy);
  return .34 * pas + .24 * dri + .15 * phy + .12 * def + .10 * pac + .05 * sho;
}

function teamAverages(session) {
  const entries = Object.entries(session.squad || {});
  if (!entries.length) return { attack: 76, defense: 76, midfield: 76, chemistry: 55, ovr: 78 };

  const chem = calculateChemistry(session) || 50;
  let attack = 0, attackWeight = 0;
  let defense = 0, defenseWeight = 0;
  let midfield = 0, midfieldWeight = 0;

  for (const [slot, p] of entries) {
    const pos = normalizePosition(slot);
    const aw = attackWeights[pos] || .25;
    const dw = defenseWeights[pos] || .25;
    const mw = midfieldWeights[pos] || .25;
    attack += playerAttackSkill(p, chem) * aw;
    defense += playerDefenseSkill(p, chem) * dw;
    midfield += playerMidfieldSkill(p, chem) * mw;
    attackWeight += aw;
    defenseWeight += dw;
    midfieldWeight += mw;
  }

  const chemMod = .94 + .12 * (chem / 100);
  const mods = formationMods[session.formation] || { attack: 0, defense: 0, midfield: 0 };
  return {
    attack: round1(clamp(1, 99, (attack / attackWeight) * chemMod + mods.attack)),
    defense: round1(clamp(1, 99, (defense / defenseWeight) * chemMod + mods.defense)),
    midfield: round1(clamp(1, 99, (midfield / midfieldWeight) * chemMod + mods.midfield)),
    chemistry: chem,
    ovr: calculateSquadOVR(session)
  };
}

function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= randFloat();
  } while (p > L);
  return k - 1;
}

function scoreSide(att, oppDef, mid, oppMid, chem, oppChem, tempoRng) {
  const sigma = 6 + .04 * (100 - chem);
  const luck = normal(0, sigma);
  const scorePoints = 50 + .70 * (att - oppDef) + .20 * (mid - oppMid) + .05 * (chem - oppChem) + tempoRng + luck;
  const xg = clamp(.15, 4.5, 1.30 * Math.exp((scorePoints - 50) / 23));
  return { goals: poisson(xg), xg, scorePoints };
}

function simulateMatch(teamA, teamB, knockout = false) {
  const tempo = normal(0, 3);
  const a = scoreSide(teamA.attack, teamB.defense, teamA.midfield, teamB.midfield, teamA.chemistry, teamB.chemistry, tempo);
  const b = scoreSide(teamB.attack, teamA.defense, teamB.midfield, teamA.midfield, teamB.chemistry, teamA.chemistry, tempo);

  let aGoals = a.goals;
  let bGoals = b.goals;
  let decidedBy = '90 menit';

  if (knockout && aGoals === bGoals) {
    const aEt = poisson(a.xg * .33 * uniform(.82, 1.05));
    const bEt = poisson(b.xg * .33 * uniform(.82, 1.05));
    aGoals += aEt;
    bGoals += bEt;
    decidedBy = 'extra time';
  }

  if (knockout && aGoals === bGoals) {
    const aQuality = teamA.ovr + teamA.chemistry * .08 + normal(0, 5);
    const bQuality = teamB.ovr + teamB.chemistry * .08 + normal(0, 5);
    if (aQuality >= bQuality) aGoals += 1;
    else bGoals += 1;
    decidedBy = 'penalti';
  }

  return { aGoals, bGoals, aXg: a.xg, bXg: b.xg, decidedBy };
}

function makeCpu(userOvr, stageIndex) {
  const stageDifficulty = -8 + 1.7 * stageIndex + .10 * stageIndex * stageIndex;
  const target = clamp(60, 98, userOvr + stageDifficulty + uniform(-1.5, 1.5));
  const styles = [
    { name: 'Balanced', attack: 0, defense: 0, midfield: 0 },
    { name: 'Attacking', attack: 3, defense: -2, midfield: 0 },
    { name: 'Defensive', attack: -2, defense: 3, midfield: -1 },
    { name: 'Possession', attack: -1, defense: 0, midfield: 3 },
    { name: 'Counter', attack: 2, defense: 1, midfield: -2 },
    { name: 'Physical', attack: 0, defense: 2, midfield: -1 }
  ];
  const style = styles[randInt(styles.length)];
  return {
    name: style.name,
    ovr: round1(target),
    attack: round1(clamp(1, 99, target + style.attack + normal(0, 1.5))),
    defense: round1(clamp(1, 99, target + style.defense + normal(0, 1.5))),
    midfield: round1(clamp(1, 99, target + style.midfield + normal(0, 1.5))),
    chemistry: Math.round(clamp(60, 100, 72 + 3 * stageIndex + normal(0, 5)))
  };
}

function initStats(session) {
  const stats = {};
  for (const [slot, p] of Object.entries(session.squad)) {
    stats[p.id] = {
      id: p.id,
      name: p.name,
      slot,
      position: normalizePosition(slot),
      ovr: p.ovr,
      goals: 0,
      assists: 0,
      matches: 0,
      ratingTotal: 0,
      bestSingle: 0
    };
  }
  return stats;
}

function weightedPick(items, weightFn) {
  const weights = items.map(item => Math.max(0.01, weightFn(item)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let r = randFloat() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function addUserMatchStats(session, stats, goalsFor, goalsAgainst, won) {
  const entries = Object.entries(session.squad);
  const scorerRole = { ST: 1, LW: .75, RW: .75, CAM: .55, LM: .45, RM: .45, CM: .30, CDM: .15, LB: .10, RB: .10, CB: .12, GK: .01 };
  const assistRole = { CAM: 1, CM: .80, LW: .85, RW: .85, LM: .75, RM: .75, ST: .35, CDM: .45, LB: .40, RB: .40, CB: .10, GK: .05 };
  const matchGoals = {};
  const matchAssists = {};

  for (let g = 0; g < goalsFor; g++) {
    const scorerEntry = weightedPick(entries, ([slot, p]) => {
      const pos = normalizePosition(slot);
      return (scorerRole[pos] || .2) * (.55 * (p.sho || 20) + .20 * (p.pac || 50) + .15 * (p.dri || 50) + .10 * (p.phy || 50));
    });
    const scorer = scorerEntry[1];
    stats[scorer.id].goals++;
    matchGoals[scorer.id] = (matchGoals[scorer.id] || 0) + 1;

    if (randFloat() <= .75) {
      const possibleAssists = entries.filter(([, p]) => p.id !== scorer.id);
      const assistEntry = weightedPick(possibleAssists, ([slot, p]) => {
        const pos = normalizePosition(slot);
        return (assistRole[pos] || .2) * (.50 * (p.pas || 50) + .25 * (p.dri || 50) + .15 * (p.pac || 50) + .10 * (p.sho || 20));
      });
      stats[assistEntry[1].id].assists++;
      matchAssists[assistEntry[1].id] = (matchAssists[assistEntry[1].id] || 0) + 1;
    }
  }

  for (const [slot, p] of entries) {
    const s = stats[p.id];
    const pos = normalizePosition(slot);
    const cleanSheetBonus = goalsAgainst === 0 ? (['GK', 'CB', 'LB', 'RB'].includes(pos) ? 1 : (['CDM', 'CM'].includes(pos) ? .5 : 0)) : 0;
    const concededWeight = { GK: 1, CB: .8, LB: .7, RB: .7, CDM: .45, CM: .25, CAM: .1, LW: .05, RW: .05, ST: 0 }[pos] || .1;
    const rating = clamp(1, 10,
      6 + .85 * (matchGoals[p.id] || 0) + .45 * (matchAssists[p.id] || 0) + .35 * cleanSheetBonus + .20 * (won ? 1 : -0.5) - .25 * goalsAgainst * concededWeight + .02 * (p.ovr - 75) + normal(0, .25)
    );
    s.matches++;
    s.ratingTotal += rating;
    s.bestSingle = Math.max(s.bestSingle, rating);
  }
}

function awardSummary(stats) {
  const list = Object.values(stats).map(s => ({ ...s, avgRating: s.matches ? s.ratingTotal / s.matches : 0 }));
  const eligible = list.filter(s => s.matches >= Math.max(1, Math.ceil(Math.max(...list.map(x => x.matches), 1) * .4)));
  const topPlayer = [...eligible].sort((a, b) => {
    const aScore = .60 * a.avgRating + .20 * Math.min(10, a.goals * 2) + .10 * Math.min(10, a.assists * 2.5) + .10 * (a.ovr / 10);
    const bScore = .60 * b.avgRating + .20 * Math.min(10, b.goals * 2) + .10 * Math.min(10, b.assists * 2.5) + .10 * (b.ovr / 10);
    return bScore - aScore || b.avgRating - a.avgRating || b.goals - a.goals || b.assists - a.assists || b.ovr - a.ovr;
  })[0];
  const topScorer = [...list].sort((a, b) => b.goals - a.goals || b.assists - a.assists || b.avgRating - a.avgRating || b.ovr - a.ovr)[0];
  const bestRating = [...eligible].sort((a, b) => b.avgRating - a.avgRating || b.bestSingle - a.bestSingle)[0];
  return {
    topPlayer: topPlayer ? topPlayer.name : 'Belum ada pemain',
    topScorer: topScorer ? `${topScorer.name} (${topScorer.goals} gol)` : 'Belum ada pemain',
    bestRating: bestRating ? `${round1(bestRating.avgRating)}` : '-'
  };
}

function resultTitle(champion, eliminatedStage) {
  if (champion) return 'Juara Dunia';
  if (eliminatedStage === 'Babak Grup') return 'Gagal Grup';
  if (eliminatedStage === 'Round of 32') return 'Round of 32';
  if (eliminatedStage === 'Round of 16') return 'Round of 16';
  if (eliminatedStage === 'Quarter Final') return 'Quarter Finalis';
  if (eliminatedStage === 'Semi Final') return 'Semi Finalis';
  if (eliminatedStage === 'Final') return 'Finalis';
  return 'Hasil Turnamen';
}

function simulateTournament(session) {
  if (session.lastResult) return session.lastResult;
  if (Object.keys(session.squad).length < session.slots.length) {
    throw new Error('Lengkapi 11 slot pemain sebelum simulasi turnamen.');
  }

  const team = teamAverages(session);
  const stats = initStats(session);
  const run = [];
  let scored = 0;
  let conceded = 0;
  let eliminated = null;
  let champion = false;

  const groupCpus = [makeCpu(team.ovr, 0), makeCpu(team.ovr, 1), makeCpu(team.ovr, 2)];
  const table = [
    { id: 'USER', pts: 0, gf: 0, ga: 0, gd: 0, team },
    ...groupCpus.map((cpu, index) => ({ id: `CPU${index}`, pts: 0, gf: 0, ga: 0, gd: 0, team: cpu }))
  ];

  function addTableResult(a, b, ag, bg) {
    a.gf += ag; a.ga += bg; a.gd = a.gf - a.ga;
    b.gf += bg; b.ga += ag; b.gd = b.gf - b.ga;
    if (ag > bg) a.pts += 3;
    else if (bg > ag) b.pts += 3;
    else { a.pts += 1; b.pts += 1; }
  }

  for (let i = 0; i < 3; i++) {
    const match = simulateMatch(team, groupCpus[i], false);
    scored += match.aGoals;
    conceded += match.bGoals;
    addUserMatchStats(session, stats, match.aGoals, match.bGoals, match.aGoals > match.bGoals);
    addTableResult(table[0], table[i + 1], match.aGoals, match.bGoals);
  }

  for (let i = 1; i < table.length; i++) {
    for (let j = i + 1; j < table.length; j++) {
      const match = simulateMatch(table[i].team, table[j].team, false);
      addTableResult(table[i], table[j], match.aGoals, match.bGoals);
    }
  }

  table.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || randFloat() - .5);
  const userRank = table.findIndex(row => row.id === 'USER') + 1;

  if (userRank <= 2) {
    run.push({ stage: 'Babak Grup', status: userRank === 1 ? 'Menang grup' : 'Lolos grup', reached: true, success: true });
  } else {
    eliminated = 'Babak Grup';
    run.push({ stage: 'Babak Grup', status: `Tersingkir posisi ${userRank}`, reached: true, success: false });
  }

  const knockouts = [
    { name: 'Round of 32', stageIndex: 3 },
    { name: 'Round of 16', stageIndex: 4 },
    { name: 'Quarter Final', stageIndex: 5 },
    { name: 'Semi Final', stageIndex: 6 },
    { name: 'Final', stageIndex: 7 }
  ];

  if (!eliminated) {
    for (const round of knockouts) {
      const cpu = makeCpu(team.ovr, round.stageIndex);
      const match = simulateMatch(team, cpu, true);
      scored += match.aGoals;
      conceded += match.bGoals;
      addUserMatchStats(session, stats, match.aGoals, match.bGoals, match.aGoals > match.bGoals);

      if (match.aGoals > match.bGoals) {
        run.push({ stage: round.name, status: `Lolos ${match.aGoals}-${match.bGoals}`, reached: true, success: true });
        if (round.name === 'Final') champion = true;
      } else {
        eliminated = round.name;
        run.push({ stage: round.name, status: `Tersingkir ${match.aGoals}-${match.bGoals}`, reached: true, success: false });
        break;
      }
    }
  }

  for (const round of knockouts) {
    if (!run.some(item => item.stage === round.name)) {
      run.push({ stage: round.name, status: 'Tidak tercapai', reached: false, success: false });
    }
  }

  const awards = awardSummary(stats);
  const result = {
    resultTitle: resultTitle(champion, eliminated),
    eliminatedStage: eliminated || (champion ? 'Juara' : 'Hasil'),
    champion,
    squadRating: team.ovr,
    formation: session.formation,
    scored,
    conceded,
    attackAvg: team.attack,
    defenseAvg: team.defense,
    midfieldAvg: team.midfield,
    chemistry: team.chemistry,
    run,
    ...awards,
    squad: publicSquad(session.squad)
  };

  session.lastResult = result;
  return result;
}



const slotCoordinates = {
  '4-3-3': {
    LW: [20, 12], ST: [50, 12], RW: [80, 12],
    CM1: [18, 39], CM2: [50, 39], CM3: [82, 39],
    LB: [15, 64], CB1: [38, 64], CB2: [62, 64], RB: [85, 64], GK: [50, 86]
  },
  '4-4-2': {
    ST1: [38, 13], ST2: [62, 13],
    LM: [16, 39], CM1: [38, 39], CM2: [62, 39], RM: [84, 39],
    LB: [15, 64], CB1: [38, 64], CB2: [62, 64], RB: [85, 64], GK: [50, 86]
  },
  '3-5-2': {
    ST1: [38, 12], ST2: [62, 12],
    LM: [13, 37], CM1: [32, 37], CDM: [50, 47], CM2: [68, 37], RM: [87, 37],
    CB1: [30, 65], CB2: [50, 65], CB3: [70, 65], GK: [50, 86]
  },
  '4-2-4': {
    LW: [16, 12], ST1: [38, 12], ST2: [62, 12], RW: [84, 12],
    CM1: [38, 43], CM2: [62, 43],
    LB: [15, 64], CB1: [38, 64], CB2: [62, 64], RB: [85, 64], GK: [50, 86]
  }
};

const slotLabels = {
  ST1: 'ST', ST2: 'ST', CB1: 'CB', CB2: 'CB', CB3: 'CB', CM1: 'CM', CM2: 'CM', CM3: 'CM'
};

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function labelSlot(slot) {
  return slotLabels[slot] || slot;
}

function availableSlotsFor(session, player) {
  return (session.slots || [])
    .filter(slot => !session.squad[slot] && isCompatible(slot, player))
    .sort((a, b) => positionFit(b, player) - positionFit(a, player));
}

function currentOfferPlayers(session, query = '') {
  const normalized = String(query || '').trim().toLowerCase();
  return (session.currentOffer || [])
    .map(id => players.find(player => player.id === id))
    .filter(Boolean)
    .filter(player => {
      if (!normalized) return true;
      return [player.name, player.team, player.teamCode, player.position, String(player.year)]
        .join(' ')
        .toLowerCase()
        .includes(normalized);
    });
}

function renderPlayerStatsHtml(player) {
  if (player.position === 'GK') {
    return `
      <span><small>DIV</small>${player.div ?? player.def}</span>
      <span><small>HAN</small>${player.han ?? player.phy}</span>
      <span><small>KIC</small>${player.kic ?? player.pas}</span>
      <span><small>REF</small>${player.ref ?? player.def}</span>
      <span><small>SPD</small>${player.spd ?? player.pac}</span>
      <span><small>POS</small>${player.pos ?? player.ovr}</span>
    `;
  }

  return `
    <span><small>PAC</small>${player.pac}</span>
    <span><small>SHO</small>${player.sho}</span>
    <span><small>PAS</small>${player.pas}</span>
    <span><small>DRI</small>${player.dri}</span>
    <span><small>DEF</small>${player.def}</span>
    <span><small>PHY</small>${player.phy}</span>
  `;
}

function renderPlayerListHtml(session, query = '') {
  const offerPlayers = currentOfferPlayers(session, query);

  if (!(session.currentOffer || []).length) {
    return '<div class="empty-panel">Tekan <strong>PUTAR</strong> untuk membuka pilihan tim dan tahun.</div>';
  }

  if (!offerPlayers.length) {
    return '<p class="pick-hint">Tidak ada pemain yang cocok.</p>';
  }

  const usedPlayerIds = new Set(Object.values(session.squad || {}).map(player => player.id));

  return offerPlayers.map(player => {
    const picked = usedPlayerIds.has(player.id);
    const slots = availableSlotsFor(session, player);
    const hasRoleSlot = slots.length > 0;
    const targetable = hasRoleSlot && !picked;
    const reason = picked ? 'Sudah dipilih' : (!hasRoleSlot ? 'Role penuh' : '');
    const slotPreview = slots.slice(0, 4).map(labelSlot).join(', ');

    return `
      <button
        type="button"
        class="player-row ${targetable ? 'is-targetable' : ''} ${picked ? 'is-picked' : ''} ${session.pendingPlayerId === player.id ? 'is-pending' : ''}"
        data-action="open-slot-picker"
        data-player-id="${escapeHtml(player.id)}"
        ${picked || !hasRoleSlot ? 'disabled' : ''}
      >
        <div>
          <h3 class="player-name">${escapeHtml(player.name)}</h3>
          <p class="player-meta"><b>${escapeHtml(player.position)}</b> · ${escapeHtml(player.teamCode)} · ${player.year}${slotPreview ? ` · slot: ${escapeHtml(slotPreview)}` : ''}</p>
          <div class="player-stats">${renderPlayerStatsHtml(player)}</div>
          ${reason ? `<span class="disabled-reason">${escapeHtml(reason)}</span>` : '<span class="slot-note">Role tersedia</span>'}
        </div>
        <strong class="player-ovr">${player.ovr}</strong>
      </button>
    `;
  }).join('');
}

function renderPitchHtml(session, pendingPlayerId = null) {
  const coords = slotCoordinates[session.formation] || {};
  const pendingPlayer = pendingPlayerId ? players.find(item => item.id === pendingPlayerId) : null;

  return (session.slots || []).map(slot => {
    const [x, y] = coords[slot] || [50, 50];
    const picked = session.squad[slot];
    const slotOpen = !picked;
    const canUseForPending = Boolean(pendingPlayer && slotOpen && isCompatible(slot, pendingPlayer));
    const blockedForPending = Boolean(pendingPlayer && !canUseForPending);

    return `
      <button
        type="button"
        class="pitch-slot ${picked ? 'is-filled' : ''} ${canUseForPending ? 'is-slot-choice' : ''} ${blockedForPending ? 'is-blocked-choice' : ''}"
        data-action="${canUseForPending ? 'pick-slot' : 'select-slot'}"
        data-player-id="${pendingPlayer ? escapeHtml(pendingPlayer.id) : ''}"
        data-slot="${escapeHtml(slot)}"
        style="left:${x}%;top:${y}%"
        ${blockedForPending ? 'disabled' : ''}
      >
        <span class="pitch-circle">${picked ? picked.ovr : (canUseForPending ? '✓' : '+')}</span>
        <small>${labelSlot(slot)}</small>
        ${picked ? `<span class="slot-name">${escapeHtml(picked.name)}</span>` : ''}
      </button>
    `;
  }).join('');
}

function slotFitLabel(slot, player) {
  const fit = positionFit(slot, player);
  if (fit >= 1) return 'Role utama';
  if (fit >= .85) return 'Role natural';
  if (fit >= .70) return 'Role cocok';
  return 'Tidak cocok';
}

function renderSlotPickerHtml(session, playerId = null) {
  const player = playerId ? players.find(item => item.id === playerId) : null;

  if (!player) {
    return `
      <div id="slotPicker" class="slot-picker is-hidden" role="dialog" aria-live="polite" aria-labelledby="slotPickerTitle">
        <div class="slot-picker-head">
          <div>
            <small>PILIH ROLE SLOT</small>
            <strong id="slotPickerTitle">Pilih slot pemain</strong>
            <p id="slotPickerMeta">Slot yang cocok akan muncul di sini.</p>
          </div>
          <button id="btnCancelSlotPicker" data-action="cancel-slot-picker" type="button" aria-label="Batalkan pilihan slot">×</button>
        </div>
        <div id="slotPickerGrid" class="slot-picker-grid"></div>
      </div>
    `;
  }

  const slots = availableSlotsFor(session, player);

  return `
    <div id="slotPicker" class="slot-picker" role="dialog" aria-live="polite" aria-labelledby="slotPickerTitle">
      <div class="slot-picker-head">
        <div>
          <small>PILIH ROLE SLOT</small>
          <strong id="slotPickerTitle">${escapeHtml(player.name)}</strong>
          <p id="slotPickerMeta">${escapeHtml(player.position)} · ${escapeHtml(player.teamCode)} ${player.year} · pilih salah satu slot kosong yang cocok.</p>
        </div>
        <button id="btnCancelSlotPicker" data-action="cancel-slot-picker" type="button" aria-label="Batalkan pilihan slot">×</button>
      </div>
      <div id="slotPickerGrid" class="slot-picker-grid">
        ${slots.map(slot => `
          <button
            type="button"
            class="slot-option"
            data-action="pick-slot"
            data-player-id="${escapeHtml(player.id)}"
            data-slot="${escapeHtml(slot)}"
          >
            <strong>${labelSlot(slot)}</strong>
            <span>${slotFitLabel(slot, player)}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderRunListHtml(run = []) {
  return (run || []).map(item => `
    <div class="run-item ${item.reached && item.success ? '' : 'fail'}">
      <div class="run-icon">${item.reached && item.success ? '✓' : '×'}</div>
      <strong>${escapeHtml(item.stage)}</strong>
      <span>${escapeHtml(item.status)}</span>
    </div>
  `).join('');
}

function renderResultSquadHtml(squad = {}) {
  const entries = Object.entries(squad || {});
  if (!entries.length) return '<p class="pick-hint">Belum ada skuad.</p>';

  return entries.map(([slot, player]) => `
    <div class="result-player">
      <span>${labelSlot(slot)}</span>
      <b>${escapeHtml(player.name)}</b>
      <strong>${player.ovr}</strong>
    </div>
  `).join('');
}

function hasOtherYearForTeam(teamCode, currentYear = null) {
  if (!teamCode) return false;
  return getTeamYears().some(item => item.teamCode === teamCode && item.year !== currentYear);
}

function buildControlPatches(session) {
  const pickedCount = Object.keys(session.squad || {}).length;
  const totalSlots = (session.slots || []).length;
  const complete = Boolean(totalSlots && pickedCount >= totalSlots);
  const deadOffer = Boolean(session.activeOffer && (session.currentOffer || []).length && !sessionHasAvailableRole(session));
  const canPutar = Boolean(session.id && !complete && (!session.activeOffer || deadOffer));
  const canPutarSemua = Boolean(session.id && !complete && session.activeOffer && !session.usedPutarSemua);
  const current = session.currentTeamYear || {};
  const canPutarTahun = Boolean(session.id && !complete && session.activeOffer && !session.usedPutarTahun && hasOtherYearForTeam(current.teamCode, current.year));
  const spinLabel = deadOffer ? 'PUTAR LAGI' : (session.activeOffer ? 'PILIH PEMAIN DULU' : 'PUTAR');

  return {
    text: {
      '#roundText': `${Math.min(pickedCount + 1, totalSlots)}/${totalSlots}`,
      '#emptySlotsText': String(totalSlots - pickedCount),
      '#pitchCounter': `${pickedCount}/${totalSlots}`,
      '#btnSpinTeam .spin-label': spinLabel
    },
    classes: {
      '#btnSimulate': complete ? { remove: ['is-hidden'] } : { add: ['is-hidden'] },
      '#respinActions': session.activeOffer ? { remove: ['is-hidden'] } : { add: ['is-hidden'] }
    },
    props: {
      '#btnSpinTeam': { disabled: !canPutar },
      '#btnRespinAll': { disabled: !canPutarSemua },
      '#btnRespinTeam': { disabled: !canPutarTahun }
    }
  };
}

function mergePatchObjects(...items) {
  const out = { text: {}, html: {}, classes: {}, props: {} };
  for (const item of items) {
    if (!item) continue;
    for (const key of ['text', 'html', 'classes', 'props']) {
      Object.assign(out[key], item[key] || {});
    }
    if (item.screen) out.screen = item.screen;
    if (item.draftId) out.draftId = item.draftId;
    if (item.formation) out.formation = item.formation;
  }
  return out;
}

function draftPatches(session, extra = {}) {
  return mergePatchObjects(
    buildControlPatches(session),
    {
      html: {
        '#pitchBoard': renderPitchHtml(session, session.pendingPlayerId),
        '#playerList': renderPlayerListHtml(session),
        '#slotPicker': renderSlotPickerHtml(session, session.pendingPlayerId)
      }
    },
    extra
  );
}

function sendPatch(res, patches, extra = {}) {
  return sendJson(res, 200, { patches, ...extra });
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActionAt > 45 * 60 * 1000) sessions.delete(id);
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000);

async function handleApi(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Metode tidak diizinkan.' });
    const body = await readBody(req);

    if (req.url === '/api/draft/start') {
      const formation = formations[body.formation] ? body.formation : '4-3-3';
      const draftId = randomId();
      const session = {
        id: draftId,
        formation,
        slots: formations[formation],
        squad: {},
        currentOffer: [],
        currentTeamYear: null,
        pendingPlayerId: null,
        activeOffer: false,
        usedPutarSemua: false,
        usedPutarTahun: false,
        createdAt: Date.now(),
        lastActionAt: Date.now(),
        lastSpinAt: 0,
        lastResult: null
      };
      sessions.set(draftId, session);

      const patches = draftPatches(session, {
        text: {
          '#draftFormationText': formation,
          '#teamCodeText': '?',
          '#yearText': '?',
          '#teamNameText': 'Tim',
          '#pitchStatusText': 'Belum ada slot dipilih',
          '#teamFlagBadge': 'WC',
          '#teamFullName': 'Tim belum dipilih',
          '#teamSquadYear': 'Putar dulu untuk membuka daftar pemain.'
        },
        classes: {
          '#teamInfo': { add: ['is-hidden'] },
          '#respinActions': { add: ['is-hidden'] },
          '#btnSimulate': { add: ['is-hidden'] }
        }
      });

      return sendPatch(res, patches, { draftId, formation });
    }

    if (req.url === '/api/draft/spin-team') {
      const session = sessions.get(body.draftId);
      if (!session) return sendJson(res, 404, { error: 'Draft tidak ditemukan. Mulai ulang draft.' });

      const now = Date.now();
      if (now - session.lastSpinAt < 850) {
        return sendJson(res, 429, { error: 'Terlalu cepat. Tunggu sebentar sebelum putar lagi.' });
      }

      const mode = ['normal', 'all', 'year'].includes(body.mode) ? body.mode : 'normal';
      const teamYears = getTeamYears();
      let picked;

      if (mode === 'normal') {
        if (session.activeOffer && sessionHasAvailableRole(session)) {
          return sendJson(res, 400, { error: 'Pilih 1 pemain dulu sebelum putaran berikutnya.' });
        }
        session.usedPutarSemua = false;
        session.usedPutarTahun = false;
        picked = teamYears[randInt(teamYears.length)];
      }

      if (mode === 'all') {
        if (!session.activeOffer) return sendJson(res, 400, { error: 'Tekan PUTAR terlebih dahulu.' });
        if (session.usedPutarSemua) return sendJson(res, 400, { error: 'PUTAR SEMUA hanya bisa dipakai sekali pada putaran ini.' });
        session.usedPutarSemua = true;
        picked = teamYears[randInt(teamYears.length)];
      }

      if (mode === 'year') {
        if (!session.activeOffer || !session.currentTeamYear) return sendJson(res, 400, { error: 'Tekan PUTAR terlebih dahulu.' });
        if (session.usedPutarTahun) return sendJson(res, 400, { error: 'PUTAR TAHUN hanya bisa dipakai sekali pada putaran ini.' });
        const sameTeamYears = teamYears.filter(item => item.teamCode === session.currentTeamYear.teamCode && item.year !== session.currentTeamYear.year);
        if (!sameTeamYears.length) return sendJson(res, 400, { error: 'Tim ini tidak punya pilihan tahun lain.' });
        session.usedPutarTahun = true;
        picked = sameTeamYears[randInt(sameTeamYears.length)];
      }

      const pool = players.filter(p => p.teamCode === picked.teamCode && p.year === picked.year);
      if (!pool.length) return sendJson(res, 404, { error: 'Data pemain untuk tim dan tahun ini tidak ditemukan.' });

      session.currentTeamYear = picked;
      session.currentOffer = pool.map(p => p.id);
      session.pendingPlayerId = null;
      session.activeOffer = true;
      session.lastSpinAt = now;
      session.lastActionAt = now;

      const patches = draftPatches(session, {
        text: {
          '#teamCodeText': picked.teamCode,
          '#yearText': String(picked.year),
          '#teamNameText': 'Team',
          '#teamFlagBadge': picked.teamCode.slice(0, 2),
          '#teamFullName': picked.team,
          '#teamSquadYear': `${picked.year} squad`,
          '#pitchStatusText': 'Belum ada slot dipilih'
        },
        classes: {
          '#teamInfo': { remove: ['is-hidden'] }
        }
      });

      return sendPatch(res, patches);
    }

    if (req.url === '/api/draft/open-slot-picker') {
      const session = sessions.get(body.draftId);
      if (!session) return sendJson(res, 404, { error: 'Draft tidak ditemukan. Mulai ulang draft.' });

      const player = players.find(item => item.id === body.playerId);
      if (!player) return sendJson(res, 404, { error: 'Pemain tidak ditemukan.' });

      if (!session.activeOffer || !session.currentOffer.includes(player.id)) {
        return sendJson(res, 403, { error: 'Pemain ini bukan hasil putaran aktif. Tekan PUTAR lagi.' });
      }

      const alreadyUsed = Object.values(session.squad || {}).some(p => p.id === player.id);
      if (alreadyUsed) return sendJson(res, 400, { error: 'Pemain ini sudah dipilih.' });

      const slots = availableSlotsFor(session, player);
      if (!slots.length) return sendJson(res, 400, { error: 'Semua role/slot yang cocok untuk pemain ini sudah penuh.' });

      session.pendingPlayerId = player.id;
      session.lastActionAt = Date.now();

      const patches = draftPatches(session, {
        text: {
          '#pitchStatusText': `Pilih slot untuk ${player.name}`
        }
      });

      return sendPatch(res, patches);
    }

    if (req.url === '/api/draft/cancel-slot-picker') {
      const session = sessions.get(body.draftId);
      if (!session) return sendJson(res, 404, { error: 'Draft tidak ditemukan. Mulai ulang draft.' });
      session.pendingPlayerId = null;
      session.lastActionAt = Date.now();

      return sendPatch(res, draftPatches(session, {
        text: {
          '#pitchStatusText': 'Belum ada slot dipilih'
        }
      }));
    }

    if (req.url === '/api/draft/search') {
      const session = sessions.get(body.draftId);
      if (!session) return sendJson(res, 404, { error: 'Draft tidak ditemukan. Mulai ulang draft.' });
      session.lastActionAt = Date.now();
      return sendPatch(res, {
        html: {
          '#playerList': renderPlayerListHtml(session, body.query || '')
        }
      });
    }

    if (req.url === '/api/draft/pick') {
      const session = sessions.get(body.draftId);
      if (!session) return sendJson(res, 404, { error: 'Draft tidak ditemukan. Mulai ulang draft.' });

      const slot = String(body.slot || '');
      if (!session.slots.includes(slot)) return sendJson(res, 400, { error: 'Slot formasi tidak valid.' });
      if (session.squad[slot]) return sendJson(res, 400, { error: `Slot ${slot} sudah terisi.` });

      const player = players.find(p => p.id === body.playerId);
      if (!player) return sendJson(res, 404, { error: 'Pemain tidak ditemukan.' });
      if (!session.activeOffer || !session.currentOffer.includes(player.id)) return sendJson(res, 403, { error: 'Pemain ini bukan hasil putaran aktif. Tekan PUTAR lagi.' });
      if (!isCompatible(slot, player)) return sendJson(res, 400, { error: `Pemain tidak cocok untuk slot ${slot}.` });

      const alreadyUsed = Object.values(session.squad).some(p => p.id === player.id);
      if (alreadyUsed) return sendJson(res, 400, { error: 'Pemain ini sudah dipilih.' });

      session.squad[slot] = player;
      session.currentOffer = [];
      session.activeOffer = false;
      session.currentTeamYear = null;
      session.pendingPlayerId = null;
      session.usedPutarSemua = false;
      session.usedPutarTahun = false;
      session.lastActionAt = Date.now();
      session.lastResult = null;

      const patches = draftPatches(session, {
        text: {
          '#pitchStatusText': `${labelSlot(slot)} · ${player.name}`
        },
        classes: {
          '#respinActions': { add: ['is-hidden'] }
        }
      });

      return sendPatch(res, patches);
    }

    if (req.url === '/api/match/simulate') {
      const session = sessions.get(body.draftId);
      if (!session) return sendJson(res, 404, { error: 'Draft tidak ditemukan. Mulai ulang draft.' });
      session.lastActionAt = Date.now();
      const result = simulateTournament(session);

      return sendPatch(res, {
        screen: 'result',
        text: {
          '#resultTitle': result.resultTitle || result.eliminatedStage || 'Hasil Turnamen',
          '#resultRating': String(result.squadRating),
          '#resultFormation': result.formation,
          '#resultScored': String(result.scored),
          '#resultConceded': String(result.conceded),
          '#resultAttack': String(result.attackAvg),
          '#resultDefense': String(result.defenseAvg),
          '#awardTopPlayer': result.topPlayer,
          '#awardTopScorer': result.topScorer,
          '#awardBestRating': String(result.bestRating)
        },
        html: {
          '#runList': renderRunListHtml(result.run),
          '#resultSquadList': renderResultSquadHtml(result.squad)
        }
      });
    }

    return sendJson(res, 404, { error: 'Endpoint tidak ditemukan.' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Terjadi kesalahan server.' });
  }
}

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';

  const safePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, '');
  const absolute = path.join(PUBLIC_DIR, safePath);

  if (!absolute.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(absolute, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackErr, fallback) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallback);
      });
      return;
    }

    const ext = path.extname(absolute).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`World Champions Draft berjalan di http://localhost:${PORT}`);
  console.log('Tekan CTRL + C untuk menghentikan server.');
});
