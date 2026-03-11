# Confluence article images are not fully mirrored into the app

## Summary

Inline images are only partially supported today.

The app already handles one narrow case correctly:
- images attached to the same Confluence page
- stored locally under `ATTACHMENTS_DIR`
- served through `GET /api/attachments/:pageId/:filename`

But the real product requirement is broader:
- same-page Confluence attachment images must sync and render
- cross-page Confluence attachment images must sync and render
- external URL images must be mirrored into app-owned storage and rendered from there

We should keep the current filesystem-plus-volume storage model for now. This issue is not blocked on S3/MinIO.

## Current State

The current pipeline already exists:
- sync fetches page XHTML, converts it to HTML, and downloads page-local attachments
- attachments are cached on disk
- the backend serves attachment files through an authenticated route
- the frontend rewrites protected attachment URLs to authenticated blob URLs before rendering

Relevant code:
- [sync-service.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/sync-service.ts#L217)
- [attachment-handler.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/attachment-handler.ts#L237)
- [attachments.ts](/home/simon/Documents/ai-kb-creator/backend/src/routes/attachments.ts#L9)
- [ArticleViewer.tsx](/home/simon/Documents/ai-kb-creator/frontend/src/shared/components/ArticleViewer.tsx#L211)

## Confirmed Gaps

### 1. Cross-page attachment images resolve to the wrong page

The XHTML-to-HTML converter rewrites any attachment-backed image to the current page ID:

- [content-converter.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/content-converter.ts#L142)

That works only when the image attachment belongs to the page being synced. Confluence storage format also supports attachment references owned by another page. In those cases:
- the generated `/api/attachments/{pageId}/{filename}` URL points at the wrong page
- sync looks only at the current page’s attachments
- on-demand cache miss fetches also look only at the current page’s attachments

Related code:
- [attachment-handler.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/attachment-handler.ts#L257)
- [attachment-handler.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/attachment-handler.ts#L312)

### 2. External URL images are not mirrored into local storage

For `ri:url` images, the converter currently keeps the remote URL directly:

- [content-converter.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/content-converter.ts#L150)

That means:
- sync does not download the image
- rendering still depends on the external host at view time
- the image is not stored in the app
- the app cannot guarantee availability or retention of the asset

This is a direct mismatch with the desired behavior.

### 3. Images inside rich link bodies can be dropped during conversion

`ac:link` conversion currently flattens the link body to text content:

- [content-converter.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/content-converter.ts#L117)
- [content-converter.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/content-converter.ts#L123)

If a Confluence page stores an image inside `ac:link-body`, the image markup is lost before rendering. This is separate from attachment syncing and needs to be fixed in the converter.

### 4. External image mirroring must respect SSRF protections

If we mirror external URL images, downloads must go through the existing SSRF guard:

- [ssrf-guard.ts](/home/simon/Documents/ai-kb-creator/backend/src/utils/ssrf-guard.ts#L53)

This is required so the backend does not become a general-purpose fetch proxy for internal/private network targets.

## Things That Are Already Fixed

The previous version of this issue was stale in several places.

These are not current blockers:
- draw.io XML/bare-name fallback mismatch: current code already caches fallback draw.io sources as `{name}.png`
  - [attachment-handler.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/attachment-handler.ts#L166)
- image filename parsing via fragile regex: current code already uses JSDOM-based parsing
  - [attachment-handler.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/attachment-handler.ts#L211)
- missing attachment retry for unchanged pages: current sync already retries missing attachments
  - [sync-service.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/sync-service.ts#L196)
  - [sync-service.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/sync-service.ts#L261)
- frontend leaves unauthenticated image URLs in place: current viewer removes `src` first and applies an error state on failure
  - [ArticleViewer.tsx](/home/simon/Documents/ai-kb-creator/frontend/src/shared/components/ArticleViewer.tsx#L229)

## Storage Decision

Do not introduce S3/MinIO as part of this fix.

Rationale:
- the repo already persists attachment storage locally
- production already mounts a persistent Docker volume
- a single backend instance does not need object storage to solve this problem

Relevant code and config:
- [attachment-handler.ts](/home/simon/Documents/ai-kb-creator/backend/src/services/attachment-handler.ts#L7)
- [docker-compose.yml](/home/simon/Documents/ai-kb-creator/docker/docker-compose.yml#L36)
- [ARCHITECTURE-DECISIONS.md](/home/simon/Documents/ai-kb-creator/docs/ARCHITECTURE-DECISIONS.md#L938)

S3-compatible storage should only be considered later if we need:
- multiple backend replicas sharing the same binary asset store
- ephemeral compute nodes without stable local disk
- storage separation beyond a Docker volume

## Proposed Implementation

1. Extend XHTML parsing so image references capture enough metadata to identify:
- same-page attachments
- cross-page attachments
- external URL images

2. Change sync so it downloads and stores all article images, not only same-page attachments:
- resolve the true owner page for attachment-backed images
- download cross-page attachment images from the correct Confluence page
- download external URL images into app storage, subject to SSRF validation

3. Rewrite converted HTML so all mirrored images point to app-owned URLs:
- same-page images -> local attachment route
- cross-page images -> local attachment route keyed by the stored asset location
- external URL images -> local attachment route keyed by stored asset location

4. Preserve rich link-body markup instead of flattening it to plain text.

5. Add test coverage for:
- same-page attachment images
- cross-page attachment images
- external URL image mirroring
- linked-image bodies
- blocked external URLs via SSRF rules

## Acceptance Criteria

- A synced Confluence page with same-page attachment images renders those images from app-owned storage.
- A synced Confluence page referencing an image attachment from another Confluence page renders that image from app-owned storage.
- A synced Confluence page using `ri:url` images downloads and stores those images locally, then renders them from app-owned storage.
- Images remain available after backend restart when the Docker volume is preserved.
- External image mirroring is blocked for disallowed internal/private targets.
- Images embedded inside rich Confluence link bodies are preserved and rendered.

## Sources

- Atlassian Confluence Storage Format:
  https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html
- Docker volume persistence docs:
  https://docs.docker.com/get-started/docker-concepts/running-containers/persisting-container-data/
- MinIO quickstart, for future object-storage consideration only:
  https://github.com/minio/minio/blob/master/README.md?plain=1#L14#minio-quickstart-guide
