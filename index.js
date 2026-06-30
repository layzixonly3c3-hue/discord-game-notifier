import express from 'express';
import 'dotenv/config';

const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!DISCORD_WEBHOOK_URL) {
  console.error("⚠️  La variable d'environnement DISCORD_WEBHOOK_URL n'est pas définie.");
}

// Route de test pour vérifier que le serveur tourne
app.get('/', (req, res) => {
  res.send('✅ Le serveur de notification est en ligne.');
});

// Route appelée par l'API/webhook du jeu quand une partie est terminée
app.post('/game-complete', async (req, res) => {
  try {
    // Adapte ces champs au format réel envoyé par l'API du jeu
    const { player, game, score } = req.body;

    if (!player) {
      return res.status(400).json({ error: "Le champ 'player' est requis dans le JSON envoyé." });
    }

    let content = `🎮 **${player}** vient de terminer une partie`;
    if (game) content += ` de *${game}*`;
    if (score !== undefined) content += ` avec un score de **${score}**`;
    content += ' !';

    const discordResponse = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });

    if (!discordResponse.ok) {
      const errText = await discordResponse.text();
      throw new Error(`Discord a répondu ${discordResponse.status} : ${errText}`);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur lors de l\'envoi vers Discord :', err.message);
    res.status(500).json({ error: 'Échec de l\'envoi de la notification.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
