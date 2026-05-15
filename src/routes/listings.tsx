import { Hono } from 'hono';
import { listListings } from '../db/listings.js';
import { ListingsPage } from '../views/listings.js';

const app = new Hono();

/**
 * GET /listings[?all=1] — browse the available_listings collection.
 *
 * Default view shows only listings that haven't been selected for a
 * plan yet. ?all=1 shows everything (useful when Rick wants to look
 * back at what's been processed).
 */
app.get('/listings', async (c) => {
  const url = new URL(c.req.url);
  const showAll = url.searchParams.get('all') === '1';
  const listings = await listListings({
    ...(showAll ? {} : { unselectedOnly: true }),
    limit: 200,
  });
  return c.html(<ListingsPage listings={listings} showAll={showAll} />);
});

export default app;
