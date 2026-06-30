async function addPlayerTagToRender(newTag) {
  const current = await getRenderEnvVars();
  const currentMap = {};
  for (const item of current) {
    currentMap[item.envVar.key] = item.envVar.value;
  }

  const existingTags = (currentMap.PLAYER_TAGS || '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (existingTags.includes(newTag)) {
    throw new Error('Ce joueur est déjà suivi.');
  }

  existingTags.push(newTag);
  currentMap.PLAYER_TAGS = existingTags.join(',');

  const payload = Object.entries(currentMap).map(([key, value]) => ({ key, value }));
  await setRenderEnvVars(payload);
}
