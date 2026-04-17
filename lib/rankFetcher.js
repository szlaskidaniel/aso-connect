const ITUNES_SEARCH = 'https://itunes.apple.com/search';

export async function fetchRank(bundleId, keyword, locale) {
  const country = localeToCountry(locale);
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(keyword)}&country=${country}&media=software&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes Search API error: ${res.status}`);
  const data = await res.json();
  const results = data.results || [];

  const index = results.findIndex(app => app.bundleId === bundleId);

  return {
    rank: index >= 0 ? index + 1 : null,
    totalResults: results.length,
  };
}

function localeToCountry(locale) {
  if (locale.length === 2) return locale.toLowerCase();
  const parts = locale.split(/[-_]/);
  return (parts[1] || parts[0]).toLowerCase();
}
