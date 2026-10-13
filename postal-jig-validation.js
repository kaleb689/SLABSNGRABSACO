// USPS-based ZIP+4 and candidate mailing-city verification for a customer's real address.
// Original shipping addresses are never changed by these lookup helpers.
const cityName = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const postalCache = new Map();
let oauthToken = null;
let oauthExpiry = 0;

export function uspsAddressLookupConfigured(env = process.env) {
  return Boolean(env.USPS_CLIENT_ID && env.USPS_CLIENT_SECRET);
}

function addressInput(input) {
  const address = String(input?.address || '').trim();
  const address2 = String(input?.address2 || '').trim();
  const city = String(input?.city || '').trim();
  const state = String(input?.state || '').trim().toUpperCase();
  const zip = String(input?.zip || '').trim();
  const country = String(input?.country || 'US').trim().toUpperCase();
  if (!address || !city || !/^[A-Z]{2}$/.test(state) || !/^\d{5}(?:-\d{4})?$/.test(zip) ||
      !['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(country)) {
    const error = new Error('A complete US street address, city, two-letter state, and valid ZIP are required.');
    error.code = 'INVALID_ADDRESS';
    throw error;
  }
  return { address, address2, city, state, zip, country: input?.country || 'US' };
}

async function jsonRequest(fetchFn, url, options = {}) {
  let response;
  try {
    response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(8500) });
  } catch {
    const error = new Error('USPS address verification is temporarily unreachable.');
    error.code = 'POSTAL_UNAVAILABLE';
    throw error;
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? 'USPS address credentials are not authorized for Addresses 3.0.'
      : response.status === 404 ? 'USPS could not verify this mailing address.'
      : 'USPS address verification is unavailable.');
    error.code = response.status === 404 ? 'ADDRESS_NOT_FOUND' : 'POSTAL_UNAVAILABLE';
    throw error;
  }
  return response.json();
}

async function uspsToken(fetchFn, env) {
  if (oauthToken && Date.now() < oauthExpiry) return oauthToken;
  const tokenData = await jsonRequest(fetchFn, 'https://apis.usps.com/oauth2/v3/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.USPS_CLIENT_ID, client_secret: env.USPS_CLIENT_SECRET })
  });
  if (!tokenData?.access_token) throw new Error('USPS did not provide an access token.');
  oauthToken = tokenData.access_token;
  oauthExpiry = Date.now() + Math.max(30, Number(tokenData.expires_in || 3600) - 90) * 1000;
  return oauthToken;
}

function uspsUrl(endpoint, address) {
  const q = new URLSearchParams({streetAddress: address.address, city: address.city, state: address.state, ZIPCode: address.zip.slice(0, 5)});
  if (address.address2) q.set('secondaryAddress', address.address2);
  return `https://apis.usps.com/addresses/v3/${endpoint}?${q}`;
}

async function uspsAddress(fetchFn, token, address) {
  return jsonRequest(fetchFn, uspsUrl('address', address), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
}

function verifiedAddress(data, address) {
  const postal = data?.address;
  if (!postal || postal.state?.toUpperCase() !== address.state ||
      String(postal.ZIPCode || '') !== address.zip.slice(0, 5) || !/^\d{4}$/.test(String(postal.ZIPPlus4 || ''))) return null;
  if (data?.additionalInfo?.DPVConfirmation && data.additionalInfo.DPVConfirmation !== 'Y') return null;
  return { zip: `${postal.ZIPCode}-${postal.ZIPPlus4}`, city: cityName(postal.city), street: cityName(postal.streetAddress), secondary: cityName(postal.secondaryAddress) };
}

function sameDeliveryPoint(base, candidate) {
  return Boolean(candidate && candidate.zip === base.zip && candidate.street === base.street &&
    candidate.secondary === base.secondary);
}

export async function lookupPostalJigOptions(input, { env = process.env, fetchFn = fetch } = {}) {
  const address = addressInput(input);
  if (!uspsAddressLookupConfigured(env)) {
    const error = new Error('USPS address verification is not configured. Set USPS_CLIENT_ID and USPS_CLIENT_SECRET on Render.');
    error.code = 'POSTAL_NOT_CONFIGURED';
    throw error;
  }
  const cacheKey = JSON.stringify([address.address, address.address2, address.city, address.state, address.zip].map(cityName));
  const cached = postalCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return structuredClone(cached.result);
  const token = await uspsToken(fetchFn, env);
  const base = verifiedAddress(await uspsAddress(fetchFn, token, address), address);
  if (!base) {
    const error = new Error('USPS did not confirm a deliverable address with a ZIP+4. No postal JIG was created.');
    error.code = 'ADDRESS_NOT_VERIFIED';
    throw error;
  }
  const options = [];
  if (address.zip !== base.zip) {
    options.push({id:'zip.four', group:'ZIP formatting', label:'Use verified USPS ZIP+4', address:{...address, zip:base.zip}, verified:true});
  }
  // ZIP-only directory results are suggestions, never proof of delivery.
  // Every suggested city must resolve back to the exact same USPS delivery point.
  const candidates = new Set();
  try {
    const preferred = await jsonRequest(fetchFn,
      `https://apis.usps.com/addresses/v3/city-state?ZIPCode=${encodeURIComponent(address.zip.slice(0, 5))}`,
      {headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
    for (const record of [preferred, ...(Array.isArray(preferred?.cities) ? preferred.cities : [])]) {
      if (record?.city && (!record.state || String(record.state).toUpperCase() === address.state)) candidates.add(cityName(record.city));
    }
  } catch { /* Primary address verification already succeeded. */ }
  try {
    const places = await jsonRequest(fetchFn, `https://api.zippopotam.us/us/${encodeURIComponent(address.zip.slice(0, 5))}`);
    for (const place of Array.isArray(places?.places) ? places.places : []) {
      if (place['place name'] && (!place['state abbreviation'] || place['state abbreviation'] === address.state))
        candidates.add(cityName(place['place name']));
    }
  } catch { /* Optional candidate source; not USPS verification. */ }
  candidates.delete(cityName(address.city));
  for (const candidateCity of [...candidates].slice(0, 8)) {
    try {
      const check = verifiedAddress(await uspsAddress(fetchFn, token, {...address, city:candidateCity}), address);
      if (!sameDeliveryPoint(base, check)) continue;
      options.push({id:`city.alternate:${candidateCity}`, group:'Mailing cities', label:`Use USPS-matched city: ${candidateCity}`,
        address:{...address, city:candidateCity}, verified:true});
    } catch { /* Never offer unverified candidates. */ }
  }
  const result = {verified:true, source:'USPS Addresses 3.0', standardizedZIPPlus4:base.zip, options};
  if (postalCache.size > 200) postalCache.delete(postalCache.keys().next().value);
  postalCache.set(cacheKey, {result, expires:Date.now() + 20 * 60 * 1000});
  return structuredClone(result);
}

export async function selectedPostalJigs(address, selectedIds = [], settings = {}) {
  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  if (!selected.includes('zip.four') && !selected.includes('city.alternate')) return [];
  const result = await lookupPostalJigOptions(address, settings);
  return result.options.filter(option => selected.includes(option.id.split(':')[0]));
}
