#!/usr/bin/env node
/**
 * Generates static, dark-theme GitHub stats cards into assets/stats/.
 *
 * Why: public stats services (e.g. github-readme-stats' shared Vercel instance)
 * are best-effort and frequently rate-limited or down. These cards are plain SVG
 * files committed to this repository, so they always render on GitHub.
 *
 * Usage:
 *   GITHUB_TOKEN=<token with public read access> node scripts/generate-stats.mjs
 *
 * In GitHub Actions the built-in GITHUB_TOKEN is enough (see
 * .github/workflows/profile-stats.yml). No personal token is stored in the repo.
 *
 * Zero dependencies: requires Node.js 18+ (global fetch).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USER = process.env.PROFILE_USER || 'acharj1296';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'stats');

if (!TOKEN) {
  console.error('GITHUB_TOKEN (or GH_TOKEN) must be set. It is never written to disk.');
  process.exit(1);
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'acharj1296-profile-stats',
  'X-GitHub-Api-Version': '2022-11-28',
};

// ---------- GitHub API helpers ----------

async function rest(endpoint) {
  const res = await fetch(`https://api.github.com${endpoint}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${endpoint} failed with HTTP ${res.status}`);
  return res.json();
}

async function restAll(endpoint) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const batch = await rest(`${endpoint}${sep}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(json.errors ?? res.status)}`);
  }
  return json.data;
}

// ---------- Data collection ----------

const CONTRIBUTIONS_QUERY = `
query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
            contributionLevel
          }
        }
      }
    }
  }
}`;

async function collect() {
  const profile = await rest(`/users/${USER}`);
  const repos = (await restAll(`/users/${USER}/repos?type=owner&sort=updated`)).filter((r) => !r.fork);

  const stars = repos.reduce((sum, r) => sum + r.stargazers_count, 0);

  const languageBytes = new Map();
  for (const repo of repos) {
    const langs = await rest(`/repos/${USER}/${repo.name}/languages`);
    for (const [name, bytes] of Object.entries(langs)) {
      languageBytes.set(name, (languageBytes.get(name) ?? 0) + bytes);
    }
  }

  const data = await graphql(CONTRIBUTIONS_QUERY, { login: USER });
  const collection = data.user.contributionsCollection;
  const calendar = collection.contributionCalendar;
  const days = calendar.weeks
    .flatMap((week) => week.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    profile: {
      publicRepos: profile.public_repos,
      followers: profile.followers,
      stars,
    },
    languages: [...languageBytes.entries()].sort((a, b) => b[1] - a[1]),
    contributions: {
      total: calendar.totalContributions,
      commits: collection.totalCommitContributions,
      pullRequests: collection.totalPullRequestContributions,
      issues: collection.totalIssueContributions,
    },
    weeks: calendar.weeks,
    days,
  };
}

// ---------- Derived values ----------

function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Today may not have any contributions yet; in that case start counting from yesterday.
  let index = days.length - 1;
  if (index >= 0 && days[index].contributionCount === 0) index -= 1;
  let current = 0;
  for (; index >= 0 && days[index].contributionCount > 0; index -= 1) current += 1;
  return { current, longest };
}

// ---------- SVG helpers ----------

const LANGUAGE_COLORS = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  CSS: '#a855f7',
  HTML: '#e34c26',
  Python: '#3572a5',
  Java: '#b07219',
  Dockerfile: '#5b7083',
  Shell: '#89e051',
  Go: '#00add8',
};
const FALLBACK_COLORS = ['#22d3ee', '#34d399', '#f472b6', '#facc15', '#60a5fa', '#fb923c'];

const LEVEL_COLORS = {
  NONE: '#17152b',
  FIRST_QUARTILE: '#3b1f73',
  SECOND_QUARTILE: '#6d28d9',
  THIRD_QUARTILE: '#a855f7',
  FOURTH_QUARTILE: '#22d3ee',
};

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (n) => Number(n).toLocaleString('en-US');

const CARD_STYLE = `
  .sans { font-family: 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif; }
  .mono { font-family: 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', 'Courier New', monospace; }
  .title { font: 600 13px 'JetBrains Mono', 'Fira Code', Consolas, monospace; fill: #22d3ee; letter-spacing: 0.5px; }
  .label { font: 400 13px 'Segoe UI', Inter, Roboto, Arial, sans-serif; fill: #9ca3af; }
  .value { font: 700 26px 'Segoe UI', Inter, Roboto, Arial, sans-serif; fill: #f3f4f6; }
  .big { font: 800 42px 'Segoe UI', Inter, Roboto, Arial, sans-serif; }
  .small { font: 400 12px 'JetBrains Mono', Consolas, monospace; fill: #6b7280; }
  .grow { transform-box: fill-box; transform-origin: left center; animation: grow 1.2s ease-out both; }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @media (prefers-reduced-motion: reduce) { .grow { animation: none; } }
`;

function card({ width, height, title, label, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
  <title>${esc(label)}</title>
  <style>${CARD_STYLE}</style>
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#a855f7"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="#0a0a12" stroke="#2d2550"/>
  <rect x="24" y="0" width="${width - 48}" height="2" fill="url(#accent)" opacity="0.8"/>
  <text class="title" x="24" y="36">${esc(title)}</text>
  ${body}
</svg>
`;
}

function overviewCard(data) {
  const items = [
    ['Public repositories', data.profile.publicRepos],
    ['Stars earned', data.profile.stars],
    ['Followers', data.profile.followers],
    ['Commits (last year)', data.contributions.commits],
    ['Pull requests (last year)', data.contributions.pullRequests],
    ['Issues (last year)', data.contributions.issues],
  ];
  const body = items
    .map(([label, value], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 24 + col * 200;
      const y = 74 + row * 44;
      return `<text class="label" x="${x}" y="${y}">${esc(label)}</text>
  <text class="value" x="${x}" y="${y + 22}">${fmt(value)}</text>`;
    })
    .join('\n  ');
  return card({
    width: 440,
    height: 226,
    title: 'GITHUB STATS',
    label: `GitHub statistics for ${USER}`,
    body: `${body}
  <text class="small" x="24" y="210">Live data from the GitHub API. Activity counts cover 12 months.</text>`,
  });
}

function languagesCard(data) {
  const total = data.languages.reduce((sum, [, bytes]) => sum + bytes, 0);
  const top = data.languages.slice(0, 6);
  if (top.length === 0 || total === 0) {
    return card({
      width: 440,
      height: 226,
      title: 'TOP LANGUAGES',
      label: 'Top programming languages',
      body: `<text class="label" x="24" y="90">No language data available yet.</text>`,
    });
  }
  let x = 24;
  const barWidth = 392;
  let segments = '';
  top.forEach(([name, bytes], i) => {
    const w = Math.max(2, (bytes / total) * barWidth);
    const color = LANGUAGE_COLORS[name] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    segments += `<rect class="grow" x="${x.toFixed(2)}" y="58" width="${w.toFixed(2)}" height="12" fill="${color}" style="animation-delay: ${(i * 0.1).toFixed(1)}s"/>`;
    x += w;
  });
  const legend = top
    .map(([name, bytes], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = 24 + col * 200;
      const cy = 102 + row * 30;
      const color = LANGUAGE_COLORS[name] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
      const pct = ((bytes / total) * 100).toFixed(1);
      return `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${color}"/>
  <text class="label" x="${cx + 18}" y="${cy}" style="fill: #e5e7eb">${esc(name)}</text>
  <text class="small" x="${cx + 170}" y="${cy}" text-anchor="end" style="fill: #9ca3af">${pct}%</text>`;
    })
    .join('\n  ');
  return card({
    width: 440,
    height: 226,
    title: 'TOP LANGUAGES',
    label: 'Top programming languages across public repositories',
    body: `<rect x="24" y="58" width="${barWidth}" height="12" rx="6" fill="#17152b"/>
  ${segments}
  ${legend}`,
  });
}

function streakCard(data) {
  const { current, longest } = streaks(data.days);
  const metrics = [
    ['Current streak', `${current} ${current === 1 ? 'day' : 'days'}`, '#22d3ee'],
    ['Longest streak', `${longest} ${longest === 1 ? 'day' : 'days'}`, '#a855f7'],
    ['Contributions (last year)', fmt(data.contributions.total), '#34d399'],
  ];
  const body = metrics
    .map(([label, value, color], i) => {
      const cx = 147 + i * 293;
      return `<text class="big" x="${cx}" y="98" text-anchor="middle" style="fill: ${color}">${esc(value)}</text>
  <text class="label" x="${cx}" y="126" text-anchor="middle">${esc(label)}</text>`;
    })
    .join('\n  ');
  return card({
    width: 880,
    height: 150,
    title: 'CONTRIBUTION STREAK',
    label: `Contribution streak for ${USER}`,
    body: `${body}
  <line x1="293" y1="60" x2="293" y2="130" stroke="#2d2550"/>
  <line x1="586" y1="60" x2="586" y2="130" stroke="#2d2550"/>`,
  });
}

function activityCard(data) {
  const cell = 11;
  const pitch = 14;
  const x0 = 56;
  const y0 = 66;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let cells = '';
  let labels = '';
  let lastMonth = -1;
  data.weeks.forEach((week, col) => {
    week.contributionDays.forEach((day) => {
      const date = new Date(`${day.date}T00:00:00Z`);
      const row = date.getUTCDay();
      const color = LEVEL_COLORS[day.contributionLevel] ?? LEVEL_COLORS.NONE;
      cells += `<rect x="${x0 + col * pitch}" y="${y0 + row * pitch}" width="${cell}" height="${cell}" rx="2" fill="${color}"><title>${esc(day.date)}: ${day.contributionCount} contributions</title></rect>`;
    });
    const first = week.contributionDays[0];
    if (first) {
      const month = new Date(`${first.date}T00:00:00Z`).getUTCMonth();
      if (month !== lastMonth && new Date(`${first.date}T00:00:00Z`).getUTCDate() <= 7) {
        labels += `<text class="small" x="${x0 + col * pitch}" y="${y0 - 12}">${monthNames[month]}</text>`;
        lastMonth = month;
      }
    }
  });

  const dayLabels = [
    [1, 'Mon'],
    [3, 'Wed'],
    [5, 'Fri'],
  ]
    .map(([row, name]) => `<text class="small" x="24" y="${y0 + row * pitch + 9}">${name}</text>`)
    .join('');

  const legendColors = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE']
    .map((level, i) => `<rect x="${760 + i * 16}" y="162" width="11" height="11" rx="2" fill="${LEVEL_COLORS[level]}"/>`)
    .join('');

  return card({
    width: 880,
    height: 200,
    title: 'CONTRIBUTION ACTIVITY',
    label: `Contribution activity graph for ${USER}, last 12 months`,
    body: `${labels}
  ${dayLabels}
  ${cells}
  <text class="small" x="700" y="172">Less</text>
  ${legendColors}
  <text class="small" x="842" y="172">More</text>`,
  });
}

// ---------- Main ----------

const data = await collect();
await mkdir(OUT_DIR, { recursive: true });

const files = {
  'overview.svg': overviewCard(data),
  'languages.svg': languagesCard(data),
  'streak.svg': streakCard(data),
  'activity.svg': activityCard(data),
};

for (const [name, svg] of Object.entries(files)) {
  await writeFile(path.join(OUT_DIR, name), svg, 'utf8');
  console.log(`wrote assets/stats/${name}`);
}
