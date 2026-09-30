// Renders assets/character-sheet.svg: GitHub stats as a D&D 5e stat block.
// Usage: GITHUB_TOKEN=... node scripts/character-sheet.mjs [login]

import { writeFile, mkdir } from 'node:fs/promises';

const LOGIN = process.argv[2] ?? 'RamonGebben';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = new URL('../assets/character-sheet.svg', import.meta.url);

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const QUERY = `
  query ($login: String!, $cursor: String) {
    user(login: $login) {
      name
      createdAt
      followers { totalCount }
      starredRepositories { totalCount }
      contributionsCollection {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        contributionCalendar {
          totalContributions
          weeks { contributionDays { contributionCount } }
        }
      }
      repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { stargazerCount primaryLanguage { name } }
      }
    }
  }
`;

async function graphql(variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GitHub API error: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data.user;
}

async function fetchUser(login) {
  const user = await graphql({ login });
  const repos = [...user.repositories.nodes];
  let { pageInfo } = user.repositories;
  while (pageInfo.hasNextPage) {
    const next = await graphql({ login, cursor: pageInfo.endCursor });
    repos.push(...next.repositories.nodes);
    pageInfo = next.repositories.pageInfo;
  }
  return { ...user, repos };
}

function longestStreak(calendar) {
  let best = 0;
  let current = 0;
  for (const week of calendar.weeks) {
    for (const day of week.contributionDays) {
      current = day.contributionCount > 0 ? current + 1 : 0;
      best = Math.max(best, current);
    }
  }
  return best;
}

// Log-scales a raw count onto the 3–30 ability score range: 0 → 8, `ref` → 20.
function abilityScore(value, ref) {
  const score = Math.round(8 + (12 * Math.log1p(value)) / Math.log1p(ref));
  return Math.min(30, Math.max(3, score));
}

const modifier = (score) => Math.floor((score - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
const fmt = (n) => n.toLocaleString('en-US');

function buildSheet(user) {
  const contributions = user.contributionsCollection;
  const stars = user.repos.reduce((sum, repo) => sum + repo.stargazerCount, 0);
  const languageCounts = new Map();
  for (const repo of user.repos) {
    const name = repo.primaryLanguage?.name;
    if (name) languageCounts.set(name, (languageCounts.get(name) ?? 0) + 1);
  }
  const topLanguages = [...languageCounts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const years = new Date().getFullYear() - new Date(user.createdAt).getFullYear();
  const wisdom = contributions.totalPullRequestReviewContributions + contributions.totalIssueContributions;
  const streak = longestStreak(contributions.contributionCalendar);

  return {
    name: user.name ?? LOGIN,
    armorClass: user.followers.totalCount,
    hitPoints: contributions.contributionCalendar.totalContributions,
    pullRequests: contributions.totalPullRequestContributions,
    abilities: [
      { key: 'STR', value: contributions.totalCommitContributions, ref: 1000, label: 'commits' },
      { key: 'DEX', value: languageCounts.size, ref: 12, label: 'languages' },
      { key: 'CON', value: streak, ref: 30, label: 'day streak' },
      { key: 'INT', value: user.repositories.totalCount, ref: 100, label: 'repos' },
      { key: 'WIS', value: wisdom, ref: 50, label: 'critiques' },
      { key: 'CHA', value: stars, ref: 500, label: 'stars earned' },
    ].map((a) => ({ ...a, score: abilityScore(a.value, a.ref) })),
    skills: topLanguages.map(([name, count]) => `${name} ${signed(count)}`).join(', '),
    perception: user.starredRepositories.totalCount,
    challenge: years,
  };
}

const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderSvg(sheet) {
  const W = 520;
  const PAD = 28;
  const colWidth = (W - PAD * 2) / 6;
  const rule = (y) =>
    `<polygon points="${PAD},${y} ${W - PAD},${y + 2} ${PAD},${y + 4}" fill="#9c2b1b"/>`;
  const property = (y, label, value) =>
    `<text x="${PAD}" y="${y}" class="prop"><tspan class="label">${label}</tspan> ${escape(value)}</text>`;

  const abilities = sheet.abilities
    .map((a, i) => {
      const cx = PAD + colWidth * i + colWidth / 2;
      return `
    <text x="${cx}" y="188" class="label" text-anchor="middle">${a.key}</text>
    <text x="${cx}" y="208" class="prop" text-anchor="middle">${a.score} (${signed(modifier(a.score))})</text>
    <text x="${cx}" y="224" class="hint" text-anchor="middle">${fmt(a.value)} ${a.label}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="352" viewBox="0 0 ${W} 352" role="img" aria-labelledby="title">
  <title id="title">${escape(sheet.name)}'s character sheet</title>
  <style>
    text { font-family: Georgia, 'Times New Roman', serif; fill: #1f1a17; }
    .name { font-size: 26px; font-variant: small-caps; font-weight: bold; fill: #7a1f12; letter-spacing: 0.5px; }
    .type { font-size: 14px; font-style: italic; }
    .prop { font-size: 14px; fill: #58180d; }
    .label { font-size: 14px; font-weight: bold; fill: #7a1f12; }
    .hint { font-size: 10px; font-style: italic; fill: #6b5e52; }
  </style>
  <rect x="3" y="3" width="${W - 6}" height="346" rx="6" fill="#fdf1dc" stroke="#e0b44c" stroke-width="3"/>
  <rect x="3" y="3" width="${W - 6}" height="8" rx="3" fill="#e0b44c"/>
  <rect x="3" y="341" width="${W - 6}" height="8" rx="3" fill="#e0b44c"/>

  <text x="${PAD}" y="50" class="name">${escape(sheet.name)}</text>
  <text x="${PAD}" y="72" class="type">Medium humanoid (full stack artificer), chaotic good</text>
  ${rule(84)}
  ${property(110, 'Armor Class', `${fmt(sheet.armorClass)} (followers)`)}
  ${property(130, 'Hit Points', `${fmt(sheet.hitPoints)} (contributions this year)`)}
  ${property(150, 'Speed', `30 ft., ${fmt(sheet.pullRequests)} pull requests`)}
  ${rule(162)}
  ${abilities}
  ${rule(238)}
  ${property(264, 'Skills', sheet.skills)}
  ${property(284, 'Senses', `passive Perception ${fmt(sheet.perception)} (repos starred)`)}
  ${property(304, 'Languages', 'Common, Dutch, Undercommon (regex)')}
  ${property(324, 'Challenge', `${sheet.challenge} (years on GitHub)`)}
</svg>
`;
}

const user = await fetchUser(LOGIN);
const sheet = buildSheet(user);
await mkdir(new URL('../assets/', import.meta.url), { recursive: true });
await writeFile(OUT, renderSvg(sheet));
console.log(`Wrote ${OUT.pathname}`);
console.log(sheet.abilities.map((a) => `${a.key} ${a.score} (${a.value} ${a.label})`).join('\n'));
