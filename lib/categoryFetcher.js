const RSS_BASE = 'https://rss.applemarketingtools.com/api/v2';
const LEGACY_RSS_BASE = 'https://itunes.apple.com';

export async function fetchOverallChart(country, chartType, limit = 100) {
  const url = `${RSS_BASE}/${country}/apps/${chartType}/${limit}/apps.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS API error: ${res.status} for ${url}`);
  const data = await res.json();

  const results = (data.feed?.results || []).map((app, i) => ({
    bundleId: app.id,
    name: app.name,
    rank: i + 1,
  }));

  return results;
}

export async function fetchGenreChart(country, genreId, chartType, limit = 200) {
  const rssType = chartType === 'top-free' ? 'topfreeapplications'
    : chartType === 'top-paid' ? 'toppaidapplications'
    : chartType === 'top-grossing' ? 'topgrossingapplications'
    : 'topfreeapplications';

  const url = `${LEGACY_RSS_BASE}/${country}/rss/${rssType}/limit=${limit}/genre=${genreId}/json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Legacy RSS API error: ${res.status} for ${url}`);
  const data = await res.json();

  const entries = data.feed?.entry || [];
  return entries.map((entry, i) => ({
    bundleId: entry['im:bundleId']?.label || entry.id?.attributes?.['im:bundleId'] || null,
    name: entry['im:name']?.label || '',
    rank: i + 1,
  }));
}

export async function fetchCategoryRank(bundleId, country, genreId, chartType) {
  const chart = genreId
    ? await fetchGenreChart(country, genreId, chartType)
    : await fetchOverallChart(country, chartType);

  const entry = chart.find(app => app.bundleId === bundleId);

  return {
    rank: entry ? entry.rank : null,
    totalResults: chart.length,
  };
}
