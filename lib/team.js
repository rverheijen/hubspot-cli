export async function listTeams(client) {
  const teams = [];
  let after = undefined;

  while (true) {
    const response = await client.settings.users.teamsApi.getAll({ after, limit: 100 });
    for (const t of response.results || []) {
      teams.push({
        id: t.id,
        name: t.name,
        memberIds: t.memberIds,
        primary: t.primary,
      });
    }
    if (!response.paging?.next?.after) break;
    after = response.paging.next.after;
  }

  return teams;
}
