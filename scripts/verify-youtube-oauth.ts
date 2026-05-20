/**
 * verify-youtube-oauth.ts — sanity check the YouTube OAuth credentials
 * sitting in .env BEFORE we build the real M30 client around them.
 *
 * Reads YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN,
 * YOUTUBE_CHANNEL_ID. Mints an access token. Calls one Data API endpoint
 * and one Analytics API endpoint. Prints green / red per step so you can
 * tell exactly where it broke.
 *
 * Run:
 *   npx tsx scripts/verify-youtube-oauth.ts
 *
 * Zero side effects — read-only API calls, no Firestore writes, no DREK
 * dependencies. Standalone on purpose.
 */
import 'dotenv/config';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ok(msg: string) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}
function fail(msg: string, detail?: unknown) {
  console.log(`${RED}✗${RESET} ${msg}`);
  if (detail) console.log(`  ${DIM}${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}${RESET}`);
}
function step(n: number, msg: string) {
  console.log(`\n${DIM}[${n}]${RESET} ${msg}`);
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

async function exchangeRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token exchange ${res.status}: ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

async function main() {
  console.log(`\n${DIM}DREK — YouTube OAuth verification${RESET}\n`);

  // Step 1: env presence
  step(1, 'Checking .env for required values');
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  const channelId = process.env.YOUTUBE_CHANNEL_ID;

  const missing: string[] = [];
  if (!clientId) missing.push('YOUTUBE_CLIENT_ID');
  if (!clientSecret) missing.push('YOUTUBE_CLIENT_SECRET');
  if (!refreshToken) missing.push('YOUTUBE_REFRESH_TOKEN');
  if (!channelId) missing.push('YOUTUBE_CHANNEL_ID');
  if (missing.length > 0) {
    fail(`Missing env vars: ${missing.join(', ')}`);
    console.log(`\n${RED}Fix .env and re-run.${RESET}\n`);
    process.exit(1);
  }
  ok('All four env vars present');

  // Sanity-check shapes
  if (!clientId!.endsWith('.apps.googleusercontent.com')) {
    fail(`YOUTUBE_CLIENT_ID does not look right (should end in .apps.googleusercontent.com)`, clientId);
  } else {
    ok(`Client ID shape OK (${clientId!.slice(0, 12)}...)`);
  }
  if (!clientSecret!.startsWith('GOCSPX-')) {
    fail(`YOUTUBE_CLIENT_SECRET does not look right (should start with GOCSPX-)`);
  } else {
    ok('Client secret shape OK');
  }
  if (!channelId!.startsWith('UC') || channelId!.length !== 24) {
    fail(`YOUTUBE_CHANNEL_ID does not look right (should be 24 chars starting with UC)`, channelId);
  } else {
    ok(`Channel ID shape OK (${channelId})`);
  }

  // Step 2: refresh -> access token
  step(2, 'Exchanging refresh token for access token');
  let accessToken: string;
  try {
    const tok = await exchangeRefreshToken(clientId!, clientSecret!, refreshToken!);
    accessToken = tok.access_token;
    ok(`Got access token (expires in ${tok.expires_in}s, scopes: ${tok.scope ?? 'unknown'})`);
  } catch (err) {
    fail('Refresh token exchange failed', (err as Error).message);
    console.log(`\n${RED}Most likely cause: bad client ID/secret OR refresh token was revoked.${RESET}`);
    console.log(`${DIM}Mint a fresh refresh token via OAuth Playground and try again.${RESET}\n`);
    process.exit(1);
  }

  // Step 3: YouTube Data API — channel info
  step(3, 'Calling YouTube Data API — channels.list');
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(channelId!)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      fail(`Data API ${res.status}`, body);
      process.exit(1);
    }
    const items = body.items as Array<{ snippet: { title: string }; statistics: { subscriberCount?: string; videoCount?: string } }>;
    if (!items || items.length === 0) {
      fail('Data API returned no items — wrong YOUTUBE_CHANNEL_ID?');
      process.exit(1);
    }
    const ch = items[0]!;
    ok(`Channel: "${ch.snippet.title}" — ${ch.statistics.subscriberCount ?? '?'} subs, ${ch.statistics.videoCount ?? '?'} videos`);
  } catch (err) {
    fail('Data API call failed', (err as Error).message);
    process.exit(1);
  }

  // Step 4: YouTube Analytics API — last 7 days views
  step(4, 'Calling YouTube Analytics API — last 7 days');
  try {
    const endDate = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      ids: `channel==${channelId!}`,
      startDate: start,
      endDate,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration',
    });
    const res = await fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      fail(`Analytics API ${res.status}`, body);
      console.log(`\n${RED}Common cause: yt-analytics.readonly scope wasn't granted when you authorized in OAuth Playground.${RESET}`);
      console.log(`${DIM}Revoke at https://myaccount.google.com/permissions and re-mint the refresh token with BOTH scopes checked.${RESET}\n`);
      process.exit(1);
    }
    const rows = (body.rows as Array<[number, number, number]> | undefined) ?? [];
    if (rows.length === 0) {
      ok('Analytics API responded (no data for last 7 days — that\'s normal for a quiet channel)');
    } else {
      const [views, minutes, avgDuration] = rows[0]!;
      ok(`Last 7 days: ${views} views, ${minutes} watch-minutes, ${avgDuration}s avg view duration`);
    }
  } catch (err) {
    fail('Analytics API call failed', (err as Error).message);
    process.exit(1);
  }

  console.log(`\n${GREEN}All four checks green. OAuth is wired correctly — M30 can be built.${RESET}\n`);
}

main().catch((err) => {
  console.error(`\n${RED}Unexpected error:${RESET} ${(err as Error).message}\n`);
  process.exit(1);
});
