import fs from "node:fs/promises";
import path from "node:path";

// One-time, opt-in install of the owner-approved animated Discord emoji pack.
// Existing server emojis are NEVER removed, replaced, renamed, or edited.
export const DISCORD_ANIMATED_EMOJI_FILES = Object.freeze([
  "sng_alert.gif",
  "sng_baby_licking_logo.gif",
  "sng_baby_sipping.gif",
  "sng_checkout.gif",
  "sng_crown.gif",
  "sng_drop_confirmed_phone.gif",
  "sng_fast.gif",
  "sng_fire.gif",
  "sng_frog_binoculars.gif",
  "sng_frog_hyped.gif",
  "sng_frog_money.gif",
  "sng_frog_rubbing_hands.gif",
  "sng_frog_shocked.gif",
  "sng_frog_sideeye.gif",
  "sng_frog_sipping.gif",
  "sng_frog_sleeping.gif",
  "sng_frog_smoking_glasses.gif",
  "sng_frog_star_eyes.gif",
  "sng_frog_suspicious.gif",
  "sng_hand_rubbing_logo.gif",
  "sng_hype.gif",
  "sng_logo_blastoff.gif",
  "sng_logo_burnout.gif",
  "sng_no_drop_phone_throw.gif",
  "sng_no_drop_robot.gif",
  "sng_orbit.gif",
  "sng_pulse.gif",
  "sng_sparkle.gif",
  "sng_spiderman_pointing.gif",
  "sng_spin.gif"
]);

const MAX_DISCORD_EMOJI_BYTES = 256 * 1024;
const FILES_FOLDER = new URL("./discord-animated-emojis/", import.meta.url);

export async function installDiscordAnimatedEmojis({guildId, api, dataDir, log = console}) {
  if (process.env.DISCORD_EMOJI_PACK_UPLOAD_ONCE !== "1") {
    return {enabled: false, expected: DISCORD_ANIMATED_EMOJI_FILES.length};
  }
  if (!/^\d{17,22}$/.test(String(guildId || "")) || typeof api !== "function") {
    throw new Error("Discord animated emoji installer requires a configured guild and bot API.");
  }

  // No change to existing names or images. Name comparisons are case-insensitive.
  const current = await api(`/guilds/${guildId}/emojis`);
  if (!Array.isArray(current)) throw new Error("Discord did not return its emoji list.");
  const known = new Set(current.map(item => String(item?.name || "").toLowerCase()));
  const report = {
    enabled: true,
    expected: DISCORD_ANIMATED_EMOJI_FILES.length,
    guildId: String(guildId),
    created: [],
    alreadyPresent: [],
    failed: [],
    completedAt: null
  };
  for (const file of DISCORD_ANIMATED_EMOJI_FILES) {
    const name = file.slice(0, -4);
    if (known.has(name.toLowerCase())) {
      report.alreadyPresent.push(name);
      continue;
    }
    try {
      // Filenames are hard-coded above; no user path input is accepted.
      const bytes = await fs.readFile(new URL(file, FILES_FOLDER));
      if (!bytes.length || bytes.length > MAX_DISCORD_EMOJI_BYTES) {
        throw new Error(`GIF file size ${bytes.length} exceeds the Discord emoji limit`);
      }
      const created = await api(`/guilds/${guildId}/emojis`, "POST", {
        name,
        image: `data:image/gif;base64,${bytes.toString("base64")}`
      });
      if (!created?.id) throw new Error("Discord did not confirm an emoji ID");
      known.add(name.toLowerCase());
      report.created.push({name, id: String(created.id)});
      log.info?.(`Discord emoji uploaded: ${name} (${created.id})`);
    } catch (error) {
      report.failed.push({name, error: String(error?.message || error).slice(0, 220)});
      log.error?.(`Discord emoji upload failed: ${name}: ${error?.message || error}`);
      // Missing permissions block every remaining emoji. Avoid noisy repeated errors.
      if (/HTTP 403\b/.test(String(error?.message || error))) break;
    }
  }
  report.completedAt = new Date().toISOString();
  const summary = {
    expected: report.expected,
    created: report.created.length,
    alreadyPresent: report.alreadyPresent.length,
    failed: report.failed.length,
    failures: report.failed,
    completedAt: report.completedAt
  };
  try {
    if (dataDir) {
      await fs.mkdir(dataDir, {recursive: true});
      const destination = path.join(dataDir, "discord-animated-emoji-upload-20261027.json");
      await fs.writeFile(destination, JSON.stringify(report, null, 2) + "\n", {encoding: "utf8", mode: 0o600});
    }
  } catch (error) {
    log.warn?.("Could not persist Discord emoji upload report:", error?.message || error);
  }
  log.info?.(`Discord animated emoji upload summary: ${JSON.stringify(summary)}`);
  return report;
}