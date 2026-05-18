import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type {
  Plan,
  Deliverable,
  PublishMetadata,
  ChapterMarker,
} from '../db/schemas.js';

export interface PublishMetadataViewProps {
  plan: Plan;
  deliverable: Deliverable;
  metadata: PublishMetadata | null;
  selectedTitleText: string | null;
  flash?: LayoutProps['flash'];
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const EmptyState: FC<{ plan: Plan; deliverable: Deliverable; canGenerate: boolean }> = ({
  plan,
  deliverable,
  canGenerate,
}) => {
  return (
    <div
      style="text-align:center; padding:48px 24px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:10px;"
    >
      <div style="font-size:16px; color:var(--ink-3); margin-bottom:16px;">
        No publishing metadata yet
      </div>
      <div style="font-size:14px; color:var(--ink-4); margin-bottom:20px;">
        {canGenerate
          ? 'Generate the YouTube upload package — description, chapters, tags, pinned comment, and end-screen suggestion.'
          : 'You need a selected title AND a selected thumbnail before publishing metadata can be generated.'}
      </div>
      {canGenerate ? (
        <button
          class="btn accent"
          type="button"
          hx-post={`/deliverables/${deliverable.id}/generate-publish-metadata`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-disabled-elt="this"
          hx-indicator="#metadata-indicator"
        >
          Generate publish metadata
        </button>
      ) : (
        <a class="btn secondary" href={`/plans/${plan.id}`}>
          Back to plan
        </a>
      )}
      <div
        id="metadata-indicator"
        class="pipeline-indicator"
        style="margin-top:16px;"
      >
        Calling LLM — usually 20-60 seconds…
      </div>
    </div>
  );
};

const ChaptersBlock: FC<{ chapters: ChapterMarker[] }> = ({ chapters }) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Chapters · {chapters.length}</h3>
      <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px;">
        {chapters.map((ch) => (
          <div class="row" style="gap:12px; align-items:flex-start;">
            <span
              style="font-family:ui-monospace,monospace; font-size:13px; color:var(--ink-3); min-width:60px; font-variant-numeric:tabular-nums;"
            >
              {formatTimestamp(ch.timestampSeconds)}
            </span>
            <span style="font-size:14px; color:var(--ink-2); flex:1;">{ch.label}</span>
          </div>
        ))}
      </div>
      <div class="muted" style="font-size:12px; margin-top:10px;">
        Timestamps computed from scene durations. Labels are LLM-suggested — edit in the description block below if needed.
      </div>
    </div>
  );
};

const DescriptionBlock: FC<{
  deliverable: Deliverable;
  description: string;
}> = ({ deliverable, description }) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Description · {description.length} / 5000 chars</h3>
      <form
        hx-patch={`/deliverables/${deliverable.id}/publish`}
        hx-target="body"
        hx-swap="outerHTML"
        hx-disabled-elt="find button"
        style="display:flex; flex-direction:column; gap:8px;"
      >
        <textarea
          name="description"
          rows={14}
          maxLength={5000}
          style="font-family:ui-monospace,monospace; font-size:13px; line-height:1.5; resize:vertical; width:100%;"
        >{description}</textarea>
        <div class="row">
          <button class="btn secondary" type="submit">
            Save description
          </button>
        </div>
      </form>
    </div>
  );
};

const TagsBlock: FC<{ deliverable: Deliverable; tags: string[] }> = ({
  deliverable,
  tags,
}) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Tags · {tags.length}</h3>
      <form
        hx-patch={`/deliverables/${deliverable.id}/publish`}
        hx-target="body"
        hx-swap="outerHTML"
        hx-disabled-elt="find button"
        style="display:flex; flex-direction:column; gap:8px;"
      >
        <input
          type="text"
          name="tagsCsv"
          value={tags.join(', ')}
          style="font-family:ui-monospace,monospace; font-size:13px; width:100%;"
        />
        <div class="muted" style="font-size:12px;">
          Comma-separated. 10-15 tags, each 1-50 chars.
        </div>
        <div class="row">
          <button class="btn secondary" type="submit">
            Save tags
          </button>
        </div>
      </form>
      <div style="margin-top:10px; display:flex; gap:6px; flex-wrap:wrap;">
        {tags.map((t) => (
          <span class="feature-chip">{t}</span>
        ))}
      </div>
    </div>
  );
};

const PinnedCommentBlock: FC<{
  deliverable: Deliverable;
  pinnedComment: string;
}> = ({ deliverable, pinnedComment }) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Pinned comment · {pinnedComment.length} / 500</h3>
      <form
        hx-patch={`/deliverables/${deliverable.id}/publish`}
        hx-target="body"
        hx-swap="outerHTML"
        hx-disabled-elt="find button"
        style="display:flex; flex-direction:column; gap:8px;"
      >
        <textarea
          name="pinnedComment"
          rows={3}
          maxLength={500}
          style="font-family:inherit; font-size:14px; line-height:1.5; resize:vertical; width:100%;"
        >{pinnedComment}</textarea>
        <div class="row">
          <button class="btn secondary" type="submit">
            Save pinned comment
          </button>
        </div>
      </form>
    </div>
  );
};

const EndScreenBlock: FC<{
  deliverable: Deliverable;
  endScreenSuggestion: string;
}> = ({ deliverable, endScreenSuggestion }) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">End-screen suggestion · {endScreenSuggestion.length} / 500</h3>
      <form
        hx-patch={`/deliverables/${deliverable.id}/publish`}
        hx-target="body"
        hx-swap="outerHTML"
        hx-disabled-elt="find button"
        style="display:flex; flex-direction:column; gap:8px;"
      >
        <textarea
          name="endScreenSuggestion"
          rows={2}
          maxLength={500}
          style="font-family:inherit; font-size:14px; line-height:1.5; resize:vertical; width:100%;"
        >{endScreenSuggestion}</textarea>
        <div class="row">
          <button class="btn secondary" type="submit">
            Save end-screen
          </button>
        </div>
      </form>
    </div>
  );
};

const ActionStrip: FC<{
  deliverable: Deliverable;
  hasMetadata: boolean;
}> = ({ deliverable, hasMetadata }) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <div class="row" style="gap:10px; flex-wrap:wrap; align-items:center;">
        {hasMetadata ? (
          <>
            <a
              class="btn accent"
              href={`/deliverables/${deliverable.id}/publish/bundle`}
              target="_blank"
            >
              View upload bundle (text)
            </a>
            <button
              class="btn secondary"
              type="button"
              hx-post={`/deliverables/${deliverable.id}/generate-publish-metadata`}
              hx-target="body"
              hx-swap="outerHTML"
              hx-confirm="Discard current metadata and regenerate? Inline edits will be lost."
              hx-disabled-elt="this"
              hx-indicator="#metadata-indicator"
            >
              Regenerate metadata
            </button>
            <span class="spacer" />
            <span class="muted" style="font-size:12px;">
              The upload-bundle page is a plain-text dump you can copy straight into the YouTube Studio upload form.
            </span>
          </>
        ) : null}
      </div>
      <div
        id="metadata-indicator"
        class="pipeline-indicator"
        style="margin-top:12px;"
      >
        Calling LLM — usually 20-60 seconds…
      </div>
    </div>
  );
};

export const PublishMetadataView: FC<PublishMetadataViewProps> = ({
  plan,
  deliverable,
  metadata,
  selectedTitleText,
  flash,
}) => {
  const canGenerate =
    !!deliverable.selectedTitleVariantId && !!deliverable.selectedThumbnailConceptId;

  return (
    <Layout title={`Publish · ${deliverable.title}`} flash={flash}>
      <div style="margin-bottom:16px;">
        <a href={`/plans/${plan.id}`} class="muted" style="font-size:14px;">
          ← Back to plan
        </a>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h1 style="margin:0 0 6px;font-size:22px;">Publish · {deliverable.title}</h1>
        <div style="font-size:14px; color:var(--ink-3); margin-bottom:6px;">
          Deliverable: <strong>{deliverable.title}</strong> ({deliverable.kind})
        </div>
        {selectedTitleText ? (
          <div style="font-size:14px; color:var(--ink-2);">
            Selected title: <em>{selectedTitleText}</em>
          </div>
        ) : (
          <div style="font-size:13px; color:var(--danger);">
            ⚠ No title selected yet.
          </div>
        )}
      </div>

      <ActionStrip deliverable={deliverable} hasMetadata={!!metadata} />

      {metadata ? (
        <>
          <DescriptionBlock deliverable={deliverable} description={metadata.description} />
          <ChaptersBlock chapters={metadata.chapters} />
          <TagsBlock deliverable={deliverable} tags={metadata.tags} />
          <PinnedCommentBlock
            deliverable={deliverable}
            pinnedComment={metadata.pinnedComment}
          />
          <EndScreenBlock
            deliverable={deliverable}
            endScreenSuggestion={metadata.endScreenSuggestion}
          />
        </>
      ) : (
        <EmptyState
          plan={plan}
          deliverable={deliverable}
          canGenerate={canGenerate}
        />
      )}
    </Layout>
  );
};
