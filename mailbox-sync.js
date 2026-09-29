// Safe diagnostics never return provider responses, addresses, or credentials.
export function mailboxFailureReason(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (error?.authenticationFailed || /AUTHENTICATIONFAILED|EAUTH|AUTH_FAILED/.test(code) || /invalid credentials|authentication failed|login failed|invalid login/i.test(message)) return "authentication_failed";
  if (code === "UNSUPPORTED_PROVIDER") return "unsupported_provider";
  if (/TIMEOUT|ETIMEDOUT/i.test(code) || /timed? out|timeout/i.test(message)) return "connection_timeout";
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return "dns_failed";
  if (/CERT|TLS|SSL/i.test(code)) return "tls_failed";
  if (/ECONN|Closed|NoConnection|Socket/i.test(code)) return "connection_closed";
  if (error?.responseStatus === "NO" || error?.responseStatus === "BAD") return "mailbox_command_rejected";
  return "mailbox_scan_failed";
}
export function normalizeImapPassword(email, password) {
  const value = String(password || "");
  if (/@(?:gmail|googlemail)\.com$/i.test(String(email || ""))) {
    const compact = value.replace(/\s/g, "");
    if (/^[a-z]{16}$/i.test(compact)) return compact;
  }
  return value;
}
export function protectImapClient(client) {
  client.on("error", error => { client.successMailboxError = error; });
  return client;
}
export function savedSuccessMailboxes(entries, sinceAt) {
  const seen = new Set();
  return entries.filter(entry => {
    const email = String(entry.email || "").trim().toLowerCase();
    if (!email || !entry.password || seen.has(email)) return false;
    seen.add(email); return true;
  }).map(entry => ({ email: String(entry.email).trim().toLowerCase(), password: entry.password,
    signedUpAt: sinceAt, profileSlot: null, profileName: "Saved email login" }));
}
