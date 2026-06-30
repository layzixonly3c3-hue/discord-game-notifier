import express from 'express';
import 'dotenv/config';

const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const BRAWL_STARS_API_KEY = process.env.BRAWL_STARS_API_KEY;

// PLAYER_TAGS : liste de tags séparés par des virgules dans les variables d'environnement
// Exemple : "QPY88C2PR,8YYUUQR8R"  (avec ou sans #, peu importe)
const PLAYER_TAGS = (process.env.PLAYER_TAGS || '')
  .split(',')
  .map((t) => t.trim().replace(/^#/, '').toUpperCase())
  .filter(Boolean);

// On passe par le proxy RoyaleAPI car l'API officielle Brawl Stars exige une IP fixe
// whitelistée, ce que les hébergeurs gratuits (Render, etc.) ne fournissent pas.
const BS_API_BASE = 'https://bsproxy.royaleapi.dev/v1';

// Mémorise le timestamp de la dernière partie connue pour chaque joueur.
// ⚠️ Stocké en mémoire : remis à zéro si le serveur redémarre (acceptable pour un usage perso).
const lastSeenBattleTime = new Map();

async function bsFetch(path) {
  const res = await fetch(`${BS_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${BRAWL_STARS_API_KEY}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API Brawl Stars ${res.status} sur ${path} : ${text}`);
  }
  return res.json();
}

async function fetchBattleLog(tag) {
  return bsFetch(`/players/%23${tag}/battlelog`);
}

async function fetchPlayerName(tag) {
  try {
    const data = await bsFetch(`/players/%23${tag}`);
    return data.name || tag;
  } catch {
    return tag;
  }
}

// Couleurs Discord (décimal) selon le résultat
const RESULT_COLORS = {
  victory: 0xf1c40f, // doré
  defeat: 0xe74c3c,  // rouge
  draw: 0x95a5a6     // gris
};

function formatPlayerLine(p) {
  if (!p) return '• Inconnu';
  const brawler = p.brawler?.name || '?';
  const trophies = typeof p.brawler?.trophies === 'number' ? p.brawler.trophies : '?';
  return `• ${p.name} (${p.tag} | ${brawler} | ${trophies})`;
}

function buildBattleEmbed(playerName, tag, item) {
  const b = item.battle || {};
  const mode = b.mode || item.event?.mode || 'mode inconnu';
  const map = item.event?.map || 'carte inconnue';
  const myTag = `#${tag}`;

  let resultText = 'Match terminé';
  if (b.result === 'victory') resultText = 'Victoire';
  else if (b.result === 'defeat') resultText = 'Défaite';
  else if (b.result === 'draw') resultText = 'Égalité';

  // Sépare les équipes (mode 3v3) en "Team" (celle du joueur suivi) et "Enemies"
  let teamLines = [];
  let enemyLines = [];

  if (Array.isArray(b.teams)) {
    for (const team of b.teams) {
      const isMyTeam = team.some((p) => p.tag === myTag);
      const lines = team.map(formatPlayerLine);
      if (isMyTeam) teamLines.push(...lines);
      else enemyLines.push(...lines);
    }
  } else if (Array.isArray(b.players)) {
    // Modes sans équipes (ex: Solo Showdown) : tout le monde dans une seule liste
    teamLines = b.players.map(formatPlayerLine);
  }

  const fields = [
    { name: '🗺️ Map', value: map, inline: false },
    { name: '🔍 Target Player', value: `${playerName} (${myTag})`, inline: false },
    { name: '🏆 Result', value: resultText, inline: false },
    { name: '🎯 Mode', value: mode, inline: false }
  ];

  if (teamLines.length > 0) {
    fields.push({ name: '👥 Team', value: teamLines.join('\n'), inline: false });
  }
  if (enemyLines.length > 0) {
    fields.push({ name: '⚔️ Enemies', value: enemyLines.join('\n'), inline: false });
  }

  return {
    title: '⚔️ Brawl Stars Match',
    color: RESULT_COLORS[b.result] ?? 0x5865f2,
    fields,
    timestamp: new Date().toISOString()
  };
}

async function sendDiscordEmbed(embed) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord a répondu ${res.status} : ${text}`);
  }
}

async function checkPlayer(tag) {
  const log = await fetchBattleLog(tag);
  const items = log.items || [];
  if (items.length === 0) return;

  // Le combat le plus récent est en premier dans la réponse de l'API
  const mostRecentTime = items[0].battleTime;
  const lastSeen = lastSeenBattleTime.get(tag);

  if (lastSeen === undefined) {
    // Premier check pour ce joueur : on mémorise sans notifier (évite le spam au démarrage)
    lastSeenBattleTime.set(tag, mostRecentTime);
    return;
  }

  // Nouvelles parties depuis le dernier check, remises dans l'ordre chronologique
  const newBattles = items.filter((item) => item.battleTime > lastSeen).reverse();
  if (newBattles.length === 0) return;

  const playerName = await fetchPlayerName(tag);

  for (const battle of newBattles) {
    await sendDiscordEmbed(buildBattleEmbed(playerName, tag, battle));
  }

  lastSeenBattleTime.set(tag, mostRecentTime);
}

app.get('/', (req, res) => {
  res.send('✅ Bot de notification Brawl Stars en ligne.');
});

// Cette route doit être appelée régulièrement par un service externe
// (ex: cron-job.org) pour déclencher la vérification des nouvelles parties.
app.get('/check', async (req, res) => {
  if (PLAYER_TAGS.length === 0) {
    return res.status(400).json({ error: "Aucun tag configuré dans la variable PLAYER_TAGS." });
  }
  if (!BRAWL_STARS_API_KEY) {
    return res.status(500).json({ error: "BRAWL_STARS_API_KEY n'est pas définie." });
  }

  const results = [];
  for (const tag of PLAYER_TAGS) {
    try {
      await checkPlayer(tag);
      results.push({ tag, status: 'ok' });
    } catch (err) {
      console.error(`Erreur pour le tag ${tag} :`, err.message);
      results.push({ tag, status: 'error', error: err.message });
    }
  }

  res.json({ checked: results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Joueurs suivis : ${PLAYER_TAGS.join(', ') || '(aucun)'}`);
});
