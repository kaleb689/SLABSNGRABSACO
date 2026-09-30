const emailKey = value => String(value || '').trim().toLowerCase();
export function updateMatchingImap(secrets, previousEmail, email, password, updatedAt, connectionStatus = null) {
 const current = emailKey(secrets?.acoEmail);
 if (!current || ![emailKey(previousEmail), emailKey(email)].includes(current)) return null;
 return { ...secrets, acoEmail: emailKey(email), acoPassword: password || secrets.acoPassword || '', imapUpdatedAt: updatedAt, imapConnectionStatus: connectionStatus };
}
export function effectiveAdminImap(secrets, entries) {
 const original = secrets || {};
 const email = emailKey(original.acoEmail);
 const entry = entries.filter(item => emailKey(item.email) === email && item.password)
  .sort((a,b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0];
 if (!entry || (original.imapUpdatedAt && Date.parse(original.imapUpdatedAt) > Date.parse(entry.updatedAt || entry.createdAt || 0))) return secrets;
 return { ...original, acoEmail: entry.email, acoPassword: entry.password, imapUpdatedAt: entry.updatedAt || entry.createdAt, imapConnectionStatus: entry.connectionStatus || null };
}
