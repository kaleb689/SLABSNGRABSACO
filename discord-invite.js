const API = "https://discord.com/api/v10";
const normalizeChannelName = name => String(name || "").split(/[|│┃┊｜]/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

export async function getCommunityInvite({ token, channelId, request = fetch }) {
  if (!token || !/^\d{17,22}$/.test(String(channelId || ""))) {
    throw new Error("Discord bot or success channel is not configured.");
  }
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  async function discord(path, options = {}) {
    const response = await request(`${API}${path}`, {
      ...options, headers, signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Discord invite request failed (HTTP ${response.status}).`);
    return response.json();
  }
  const successChannel = await discord(`/channels/${channelId}`);
  if (!/^\d{17,22}$/.test(String(successChannel.guild_id || ""))) {
    throw new Error("The configured Discord channel is not in a server.");
  }
  const channels = await discord(`/guilds/${successChannel.guild_id}/channels`);
  const intro = channels.find(channel => channel.type === 0 &&
    normalizeChannelName(channel.name) === "introslabsngrabsaco");
  if (!intro) throw new Error("The Discord intro channel is unavailable.");

  const invites = await discord(`/channels/${intro.id}/invites`);
  const reusable = invites.find(invite => invite.code && invite.max_age === 0 &&
    invite.max_uses === 0 && !invite.temporary && !invite.expires_at);
  const invite = reusable || await discord(`/channels/${intro.id}/invites`, {
    method: "POST", body: JSON.stringify({ max_age: 0, max_uses: 0, temporary: false, unique: false })
  });
  if (!/^[A-Za-z0-9-]{2,64}$/.test(String(invite.code || ""))) {
    throw new Error("Discord did not provide a valid invite code.");
  }
  return `https://discord.gg/${invite.code}`;
}
