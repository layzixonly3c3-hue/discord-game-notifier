import express from 'express';
import 'dotenv/config';
import { verifyKeyMiddleware, InteractionType, InteractionResponseType } from 'discord-interactions';

const app = express();

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const BRAWL_STARS_API_KEY = process.env.BRAWL_STARS_API_KEY;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;

// Seuil minimum de trophées (sur un brawler) pour qu'une partie soit notifiée.
// Modifiable via la variable d'environnement MIN_TROPHIES_THRESHOLD (par défaut 2500).
const MIN_TROPHIES_THRESHOLD = parseInt(process.env.MIN_TROPHIES_THRESHOLD || '2500', 10);

// PLAYER_TAGS : liste de tags séparés par des virgules dans les variables d'environnement
const PLAYER_TAGS = (process.env.PLAYER_TAGS || '')
  .split(',')
  .map((t) => t.trim().replace(/^#/, '').toUpperCase())
  .filter(Boolean);

const BS_API_BASE = 'https://bsproxy.royaleapi.dev/v1';
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

// Vérifie que le tag existe vraiment côté Brawl Stars avant de l'ajouter
async function validateTagExists(tag) {
  await bsFetch(`/players/%23${tag}`);
}

const RESULT_COLORS = {
  victory: 0xf1c40f,
  defeat: 0xe74c3c,
  draw: 0x95a5a6
};

function formatPlayerLine(p) {
  if (!p) return '• Inconnu';
  const brawler = p.brawler?.name || '?';
  const trophies = typeof p.brawler?.trophies === 'number' ? p.brawler.trophies : '?';
  return `• ${p.name} (${p.tag} | ${brawler} | ${trophies})`;
}

// Parcourt tous les joueurs d'une partie (teams ou players) et renvoie le
// nombre de trophées le plus élevé trouvé sur un brawler.
function getMaxTrophiesInBattle(battle) {
  let allPlayers = [];

  if (Array.isArray(battle.teams)) {
    for (const team of battle.teams) {
      allPlayers.push(...team);
    }
  } else if (Array.isArray(battle.players)) {
    allPlayers = battle.players;
  }

  let max = 0;
  for (const p of allPlayers) {
    const trophies = p?.brawler?.trophies;
    if (typeof trophies === 'number' && trophies > max) {
      max = trophies;
    }
  }
  return max;
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
    teamLines = b.players.map(formatPlayerLine);
  }

  const fields = [
    { name: '🗺️ Map', value: map, inline: false },
    { name: '🔍 Target Player', value: `${playerName} (${myTag})`, inline: false },
    { name: '🏆 Result', value: resultText, inline: false },
    { name: '🎯 Mode', value: mode, inline: false }
  ];

  if (teamLines.length > 0) fields.push({ name: '👥 Team', value: teamLines.join('\n'), inline: false });
  if (enemyLines.length > 0) fields.push({ name: '⚔️ Enemies', value: enemyLines.join('\n'), inline: false });

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

  const mostRecentTime = items[0].battleTime;
  const lastSeen = lastSeenBattleTime.get(tag);

  if (lastSeen === undefined) {
    lastSeenBattleTime.set(tag, mostRecentTime);
    return;
  }

  const newBattles = items.filter((item) => item.battleTime > lastSeen).reverse();
  if (newBattles.length === 0) return;

  const playerName = await fetchPlayerName(tag);

  for (const battle of newBattles) {
    const maxTrophies = getMaxTrophiesInBattle(battle.battle || {});

    // On ne notifie que si au moins un joueur de la partie a le seuil de trophées requis
    if (maxTrophies >= MIN_TROPHIES_THRESHOLD) {
      await sendDiscordEmbed(buildBattleEmbed(playerName, tag, battle));
    }
  }

  lastSeenBattleTime.set(tag, mostRecentTime);
}

// ---------- Intégration commandes Discord ----------

async function getRenderEnvVars() {
  const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
    headers: { Authorization: `Bearer ${RENDER_API_KEY}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render API ${res.status} (lecture) : ${text}`);
  }
  return res.json();
}

async function setRenderEnvVars(envVarsArray) {
  const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(envVarsArray)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render API ${res.status} (écriture) : ${text}`);
  }
}

async function triggerRenderDeploy() {
  const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render API ${res.status} (déploiement) : ${text}`);
  }
}

async function getCurrentPlayerTags() {
  const current = await getRenderEnvVars();
  const currentMap = {};
  for (const item of current) {
    currentMap[item.envVar.key] = item.envVar.value;
  }
  const tags = (currentMap.PLAYER_TAGS || '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  return { currentMap, tags };
}

async function addPlayerTagToRender(newTag) {
  const { currentMap, tags } = await getCurrentPlayerTags();

  if (tags.includes(newTag)) {
    throw new Error('Ce joueur est déjà suivi.');
  }

  tags.push(newTag);
  currentMap.PLAYER_TAGS = tags.join(',');

  const payload = Object.entries(currentMap).map(([key, value]) => ({ key, value }));
  await setRenderEnvVars(payload);

  // Déclenche explicitement un nouveau déploiement pour que le serveur
  // recharge bien la nouvelle valeur de PLAYER_TAGS en mémoire.
  await triggerRenderDeploy();
}

async function removePlayerTagFromRender(tagToRemove) {
  const { currentMap, tags } = await getCurrentPlayerTags();

  if (!tags.includes(tagToRemove)) {
    throw new Error("Ce joueur n'est pas suivi.");
  }

  const updatedTags = tags.filter((t) => t !== tagToRemove);
  currentMap.PLAYER_TAGS = updatedTags.join(',');

  const payload = Object.entries(currentMap).map(([key, value]) => ({ key, value }));
  await setRenderEnvVars(payload);

  await triggerRenderDeploy();
}

async function editOriginalInteractionResponse(interactionToken, content) {
  const url = `https://discord.com/api/v10/webhooks/${DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

app.post('/interactions', verifyKeyMiddleware(DISCORD_PUBLIC_KEY), async (req, res) => {
  const interaction = req.body;

  if (interaction.type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interaction.data;

    // ---------- /ajouter-joueur ----------
    if (name === 'ajouter-joueur') {
      const tagOption = options?.find((o) => o.name === 'tag');
      const rawTag = (tagOption?.value || '').trim().replace(/^#/, '').toUpperCase();

      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        if (!rawTag) throw new Error('Tag vide ou invalide.');
        await validateTagExists(rawTag);
        await addPlayerTagToRender(rawTag);
        await editOriginalInteractionResponse(
          interaction.token,
          `✅ Joueur **${rawTag}** ajouté au suivi ! Le bot redémarre (~1 min) pour prendre en compte le changement.`
        );
      } catch (err) {
        console.error('Erreur ajout joueur :', err.message);
        await editOriginalInteractionResponse(interaction.token, `❌ Erreur : ${err.message}`);
      }
      return;
    }

    // ---------- /retirer-joueur ----------
    if (name === 'retirer-joueur') {
      const tagOption = options?.find((o) => o.name === 'tag');
      const rawTag = (tagOption?.value || '').trim().replace(/^#/, '').toUpperCase();

      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        if (!rawTag) throw new Error('Tag vide ou invalide.');
        await removePlayerTagFromRender(rawTag);
        await editOriginalInteractionResponse(
          interaction.token,
          `✅ Joueur **${rawTag}** retiré du suivi ! Le bot redémarre (~1 min) pour prendre en compte le changement.`
        );
      } catch (err) {
        console.error('Erreur retrait joueur :', err.message);
        await editOriginalInteractionResponse(interaction.token, `❌ Erreur : ${err.message}`);
      }
      return;
    }

    // ---------- /liste-joueurs ----------
    if (name === 'liste-joueurs') {
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        const { tags } = await getCurrentPlayerTags();

        if (tags.length === 0) {
          await editOriginalInteractionResponse(interaction.token, '📋 Aucun joueur suivi actuellement.');
          return;
        }

        // Récupère les noms en parallèle, avec repli sur le tag si erreur
        const names = await Promise.all(
          tags.map(async (tag) => {
            const name = await fetchPlayerName(tag);
            return `• ${name} (#${tag})`;
          })
        );

        // Discord limite les messages à 2000 caractères : on découpe si besoin
        const header = `📋 **${tags.length} joueur(s) suivi(s) :**\n`;
        let content = header;
        const chunks = [];

        for (const line of names) {
          if ((content + line + '\n').length > 1900) {
            chunks.push(content);
            content = '';
          }
          content += line + '\n';
        }
        chunks.push(content);

        await editOriginalInteractionResponse(interaction.token, chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APPLICATION_ID}/${interaction.token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: chunks[i] })
          });
        }
      } catch (err) {
        console.error('Erreur liste joueurs :', err.message);
        await editOriginalInteractionResponse(interaction.token, `❌ Erreur : ${err.message}`);
      }
      return;
    }

    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❓ Commande inconnue.' }
    });
  }

  return res.status(400).json({ error: "Type d'interaction non géré." });
});

app.use(express.json());

app.get('/', (req, res) => {
  res.send('✅ Bot de notification Brawl Stars en ligne.');
});

app.get('/check', async (req, res) => {
  if (PLAYER_TAGS.length === 0) {
    return res.status(400).json({ error: 'Aucun tag configuré dans la variable PLAYER_TAGS.' });
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
  console.log(`Seuil de trophées minimum pour notifier : ${MIN_TROPHIES_THRESHOLD}`);
  console.log(`Joueurs suivis : ${PLAYER_TAGS.join(', ') || '(aucun)'}`);
});
