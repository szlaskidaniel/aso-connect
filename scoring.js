/**
 * Compute popularity score (1-100) from iTunes search results.
 * Uses a 6-signal composite model.
 */
export function computePopularity(results, keyword) {
  if (!results || results.length === 0) return 0;

  const appCount = results.length;

  // Signal 1: Result count (0-25 pts)
  const resultCountScore = Math.min(25, (appCount / 25) * 25);

  // Signal 2: Leader strength - rating volume of top apps (0-30 pts)
  const topApps = results.slice(0, 5);
  const avgTopRatings = topApps.reduce((s, a) => s + (a.userRatingCount || 0), 0) / Math.max(topApps.length, 1);
  const leaderScore = Math.min(30, (Math.log10(Math.max(avgTopRatings, 1)) / Math.log10(1000000)) * 30);

  // Signal 3: Title match density - how many apps use keyword in title (0-20 pts)
  const kwLower = keyword.toLowerCase();
  const titleMatches = results.filter(a => (a.trackName || '').toLowerCase().includes(kwLower)).length;
  const titleMatchScore = Math.min(20, (titleMatches / Math.max(appCount, 1)) * 20 * 1.5);

  // Signal 4: Market depth - strong apps deep in results (0-10 pts)
  const deepApps = results.slice(10);
  const deepAvgRatings = deepApps.reduce((s, a) => s + (a.userRatingCount || 0), 0) / Math.max(deepApps.length, 1);
  const depthScore = Math.min(10, (Math.log10(Math.max(deepAvgRatings, 1)) / Math.log10(100000)) * 10);

  // Signal 5: Specificity penalty (-5 to -30) - generic terms inflate counts
  const wordCount = keyword.trim().split(/\s+/).length;
  const specificityPenalty = wordCount === 1 && appCount >= 20 ? -10 : 0;

  // Signal 6: Exact phrase bonus (0-15 pts) - multi-word exact matches
  const exactMatches = results.filter(a =>
    (a.trackName || '').toLowerCase().includes(kwLower) ||
    (a.description || '').toLowerCase().includes(kwLower)
  ).length;
  const exactBonus = wordCount > 1 ? Math.min(15, (exactMatches / Math.max(appCount, 1)) * 15) : 0;

  const raw = resultCountScore + leaderScore + titleMatchScore + depthScore + specificityPenalty + exactBonus;
  return Math.max(1, Math.min(100, Math.round(raw)));
}

/**
 * Compute difficulty score (1-100) from iTunes search results.
 * Uses a 7-factor weighted system.
 */
export function computeDifficulty(results, keyword) {
  if (!results || results.length === 0) return 0;

  const appCount = results.length;
  const kwLower = keyword.toLowerCase();

  // Factor 1: Rating volume (30%) - how many ratings competitors have
  const avgRatings = results.reduce((s, a) => s + (a.userRatingCount || 0), 0) / Math.max(appCount, 1);
  const ratingVolumeScore = Math.min(100, (Math.log10(Math.max(avgRatings, 1)) / Math.log10(500000)) * 100);

  // Factor 2: Dominant players (20%) - apps with 100K+ ratings
  const dominantCount = results.filter(a => (a.userRatingCount || 0) >= 100000).length;
  const dominantScore = Math.min(100, (dominantCount / Math.max(appCount, 1)) * 100 * 2);

  // Factor 3: Rating quality (10%) - average star ratings
  const avgRating = results.reduce((s, a) => s + (a.averageUserRating || 0), 0) / Math.max(appCount, 1);
  const qualityScore = Math.min(100, (avgRating / 5) * 100);

  // Factor 4: Market maturity (10%) - how long competitors have been live
  const now = Date.now();
  const avgAgeYears = results.reduce((s, a) => {
    const age = (now - new Date(a.releaseDate || now).getTime()) / (1000 * 60 * 60 * 24 * 365);
    return s + age;
  }, 0) / Math.max(appCount, 1);
  const maturityScore = Math.min(100, (avgAgeYears / 5) * 100);

  // Factor 5: Publisher diversity (10%) - few publishers = more entrenched
  const publishers = new Set(results.map(a => a.sellerName || a.artistName || ''));
  const diversityScore = Math.max(0, 100 - (publishers.size / Math.max(appCount, 1)) * 100);

  // Factor 6: App count (10%) - total relevant results
  const appCountScore = Math.min(100, (appCount / 25) * 100);

  // Factor 7: Content relevance (10%) - how well competitors match keyword
  const relevantCount = results.filter(a =>
    (a.trackName || '').toLowerCase().includes(kwLower) ||
    (a.description || '').toLowerCase().slice(0, 200).includes(kwLower)
  ).length;
  const relevanceScore = Math.min(100, (relevantCount / Math.max(appCount, 1)) * 100);

  const weighted =
    ratingVolumeScore * 0.30 +
    dominantScore     * 0.20 +
    qualityScore      * 0.10 +
    maturityScore     * 0.10 +
    diversityScore    * 0.10 +
    appCountScore     * 0.10 +
    relevanceScore    * 0.10;

  return Math.max(1, Math.min(100, Math.round(weighted)));
}

/**
 * Classify a keyword based on popularity + difficulty.
 */
export function classify(popularity, difficulty) {
  const opportunity = Math.round((popularity * (100 - difficulty)) / 100);

  if (popularity >= 40 && difficulty <= 35) return { label: 'Sweet Spot', opportunity };
  if (popularity >= 25 && difficulty <= 25) return { label: 'Hidden Gem', opportunity };
  if (popularity >= 60 && difficulty <= 55) return { label: 'Good Target', opportunity };
  if (difficulty >= 75) return { label: 'High Competition', opportunity };
  if (popularity < 20) return { label: 'Low Volume', opportunity };
  return { label: 'Moderate', opportunity };
}

/**
 * Difficulty human label.
 */
export function difficultyLabel(score) {
  if (score < 16) return 'Very Easy';
  if (score < 36) return 'Easy';
  if (score < 56) return 'Moderate';
  if (score < 76) return 'Hard';
  if (score < 91) return 'Very Hard';
  return 'Extreme';
}
