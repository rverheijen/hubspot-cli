export async function listUsers(client) {
  const users = [];
  let after = undefined;

  while (true) {
    const response = await client.settings.users.usersApi.getPage({ after, limit: 100 });
    for (const u of response.results || []) {
      users.push({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        roleIds: u.roleIds,
        teamIds: u.teamIds,
        superAdmin: u.superAdmin,
        active: u.active,
        primaryTeamId: u.primaryTeamId,
      });
    }
    if (!response.paging?.next?.after) break;
    after = response.paging.next.after;
  }

  return users;
}
