# Discord Game Notifier

Petit serveur qui reçoit un appel de l'API/webhook de ton jeu quand une partie
est terminée, et qui poste automatiquement un message dans un salon Discord.

## 1. Créer un Webhook Discord

1. Dans Discord, va dans le salon où tu veux recevoir les notifications.
2. Clique sur l'icône d'engrenage du salon → **Intégrations** → **Webhooks**.
3. Clique sur **Nouveau Webhook**, donne-lui un nom (ex: "Game Notifier").
4. Clique sur **Copier l'URL du webhook**. Garde-la précieusement, c'est ta
   `DISCORD_WEBHOOK_URL`.

## 2. Tester en local

```bash
npm install
cp .env.example .env
# Colle ton URL de webhook Discord dans le fichier .env
npm start
```

Le serveur tourne sur `http://localhost:3000`. Tu peux tester avec :

```bash
curl -X POST http://localhost:3000/game-complete \
  -H "Content-Type: application/json" \
  -d '{"player": "Alice", "game": "Mon Super Jeu", "score": 4200}'
```

Tu devrais voir le message apparaître dans ton salon Discord.

## 3. Déployer gratuitement (Render.com)

Render propose un tier gratuit pour les Web Services Node.js.

1. Mets ce projet sur un dépôt GitHub.
2. Va sur https://render.com → **New** → **Web Service**.
3. Connecte ton dépôt GitHub.
4. Configure :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Plan** : Free
5. Dans l'onglet **Environment**, ajoute la variable :
   - `DISCORD_WEBHOOK_URL` = (ton URL copiée à l'étape 1)
6. Déploie. Render te donne une URL du type
   `https://ton-app.onrender.com`.

⚠️ Sur le tier gratuit, le service "s'endort" après 15 min d'inactivité et met
quelques secondes à se réveiller au premier appel suivant. Pour un bot de
notification ponctuel, ce n'est généralement pas gênant.

## 4. Connecter l'API du jeu

Configure le webhook sortant de ton jeu pour qu'il envoie une requête `POST`
vers :

```
https://ton-app.onrender.com/game-complete
```

avec un corps JSON contenant au minimum :

```json
{
  "player": "NomDuJoueur",
  "game": "NomDuJeu",
  "score": 1234
}
```

Si l'API du jeu envoie les données sous un format différent (autres noms de
champs, structure imbriquée, etc.), adapte la lecture de `req.body` dans
`index.js` en conséquence.
