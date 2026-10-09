const prefix = 'livetalking-studio:projection-url:';

export function validProjectionUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/whip' || url.search || url.hash) return '';
    return url.toString();
  } catch { return ''; }
}

export function projectionPreference(storage, profileId, value) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profileId || '')) return '';
  const key = prefix + profileId;
  try {
    if (value === undefined) return validProjectionUrl(storage.getItem(key));
    const url = validProjectionUrl(value);
    if (url) storage.setItem(key, url);
    else if (!String(value || '').trim()) storage.removeItem(key);
    return url;
  } catch { return ''; }
}
