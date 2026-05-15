import type { FC } from 'hono/jsx';
import { Layout } from './layout.js';
import type { AvailableListing } from '../db/schemas.js';

export interface ListingsPageProps {
  listings: AvailableListing[];
  showAll: boolean;
}

function formatDate(d: Date): string {
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ListingRow: FC<{ l: AvailableListing }> = ({ l }) => {
  const isSelected = Boolean(l.planId);
  return (
    <div class="card">
      <div class="row" style="gap:12px;">
        <div style="flex:1;">
          <div style="font-weight:600; font-size:16px;">{l.title}</div>
          <div class="muted" style="font-size:13px;">
            {l.company ?? 'Unknown company'} ·{' '}
            ingested {formatDate(l.receivedAt)}
            {isSelected ? ' · ' : null}
            {isSelected ? <span class="badge finalized">Selected</span> : null}
          </div>
          {l.summary ? (
            <div style="font-size:14px; margin-top:8px; white-space:pre-wrap;">{l.summary}</div>
          ) : null}
        </div>
        <div>
          {isSelected && l.planId ? (
            <a class="btn small" href={`/plans/${l.planId}`}>Open plan</a>
          ) : (
            <a class="btn small" href={`/plans/new/cover-letter?listingId=${encodeURIComponent(l.id)}`}>
              Plan a cover letter
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

export const ListingsPage: FC<ListingsPageProps> = ({ listings, showAll }) => {
  return (
    <Layout title="Available listings">
      <div class="row" style="margin-bottom:16px;">
        <h2 style="margin:0;">Available listings</h2>
        <span class="spacer" />
        {showAll ? (
          <a class="btn small secondary" href="/listings">Show unselected only</a>
        ) : (
          <a class="btn small secondary" href="/listings?all=1">Show all</a>
        )}
      </div>
      <p class="muted" style="margin-top:-8px;">
        Listings PI ingested that DREK pulled from Neurocore. Use these
        when you want to plan a cover letter for a listing that wasn't
        automatically flagged as requiring video. Selecting a listing here
        prefills the new-plan form with the listing data.
      </p>

      {listings.length === 0 ? (
        <div class="empty">
          {showAll
            ? 'No listings have been ingested yet. Hit "Check now" on the dashboard to poll Neurocore.'
            : 'Nothing pending. Either every ingested listing has been selected, or none have arrived yet.'}
        </div>
      ) : (
        listings.map((l) => <ListingRow l={l} />)
      )}
    </Layout>
  );
};
