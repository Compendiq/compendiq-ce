import {
  PageConnectionsSchema,
  type ConnectionItem,
  type ConnectionReason,
  type PageConnections,
} from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { authorizedPageIds } from '../../../core/services/authorized-pages.js';
import {
  buildUnambiguousTitleIndex,
  extractInternalLinks,
  getInternalHosts,
} from './link-extractor.js';

type RelationshipType =
  | 'embedding_similarity'
  | 'label_overlap'
  | 'explicit_link'
  | 'parent_child';

interface RelationshipRow {
  target_id: number;
  relationship_type: RelationshipType;
  score: number;
}

interface PageRow {
  id: number;
  confluence_id: string | null;
  title: string;
  body_html: string | null;
  parent_id: string | null;
  labels: string[] | null;
}

interface CandidateEvidence {
  page: PageRow;
  relationships: RelationshipRow[];
}

function referencesParent(child: PageRow, parent: PageRow): boolean {
  if (child.parent_id === null) return false;
  return child.parent_id === String(parent.id)
    || (parent.confluence_id !== null && child.parent_id === parent.confluence_id);
}

function sharedLabels(source: PageRow, target: PageRow): string[] {
  const targetLabels = new Set(target.labels ?? []);
  return [...new Set(source.labels ?? [])]
    .filter((label) => targetLabels.has(label))
    .sort((left, right) => left.localeCompare(right));
}

function labelOverlapScore(source: PageRow, target: PageRow, labels: string[]): number {
  const denominator = Math.max(source.labels?.length ?? 0, target.labels?.length ?? 0);
  return denominator === 0 ? 0 : labels.length / denominator;
}

function connectionItem(page: PageRow, reasons: ConnectionReason[]): ConnectionItem {
  return { pageId: String(page.id), title: page.title, reasons };
}

function byNumericPageId(left: ConnectionItem, right: ConnectionItem): number {
  return Number(left.pageId) - Number(right.pageId);
}

/**
 * Read the persisted relationship graph without presenting stale structural
 * evidence as fact. Stored rows choose candidates; current bodies, hierarchy,
 * labels and ACLs decide what may be returned and how it is described.
 */
export async function getPageConnections(
  userId: string,
  sourcePageId: number,
): Promise<PageConnections | null> {
  const sourceAccess = await authorizedPageIds(userId, [sourcePageId]);
  if (!sourceAccess.has(sourcePageId)) return null;

  const sourceResult = await query<PageRow>(
    `SELECT id, confluence_id, title, body_html, parent_id, labels
       FROM pages
      WHERE id = $1 AND deleted_at IS NULL`,
    [sourcePageId],
  );
  const source = sourceResult.rows[0];
  if (!source) return null;

  const relationshipResult = await query<RelationshipRow>(
    `SELECT CASE
              WHEN pr.page_id_1 = $1 THEN pr.page_id_2
              ELSE pr.page_id_1
            END AS target_id,
            pr.relationship_type,
            pr.score
       FROM page_relationships pr
      WHERE pr.page_id_1 = $1 OR pr.page_id_2 = $1`,
    [sourcePageId],
  );

  const candidateIds = [...new Set(
    relationshipResult.rows
      .map((row) => row.target_id)
      .filter((id) => id !== sourcePageId),
  )];
  const accessibleIds = await authorizedPageIds(userId, candidateIds);
  if (accessibleIds.size === 0) {
    return PageConnectionsSchema.parse({ linked: [], section: [], related: [] });
  }

  const pagesResult = await query<PageRow>(
    `SELECT id, confluence_id, title, body_html, parent_id, labels
       FROM pages
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
    [[...accessibleIds]],
  );
  const pagesById = new Map(pagesResult.rows.map((page) => [page.id, page] as const));
  const evidenceById = new Map<number, CandidateEvidence>();
  for (const relationship of relationshipResult.rows) {
    const page = pagesById.get(relationship.target_id);
    if (!page) continue;
    const evidence = evidenceById.get(page.id) ?? { page, relationships: [] };
    evidence.relationships.push(relationship);
    evidenceById.set(page.id, evidence);
  }

  const hasExplicitEvidence = relationshipResult.rows.some(
    (row) => row.relationship_type === 'explicit_link' && accessibleIds.has(row.target_id),
  );
  let titleToId = new Map<string, number>();
  if (hasExplicitEvidence) {
    const titleRows = await query<{ id: number; title: string }>(
      'SELECT id, title FROM pages WHERE deleted_at IS NULL AND title IS NOT NULL',
    );
    titleToId = buildUnambiguousTitleIndex(titleRows.rows);
  }
  const internalHosts = getInternalHosts();
  const sourceLinks = new Set(
    extractInternalLinks(source.body_html, titleToId, internalHosts)
      .map((link) => link.targetPageId),
  );

  const linked: ConnectionItem[] = [];
  const section: ConnectionItem[] = [];
  const relatedRanked: Array<{ item: ConnectionItem; evidenceScore: number }> = [];

  for (const { page, relationships } of evidenceById.values()) {
    const relationshipTypes = new Set(relationships.map((row) => row.relationship_type));
    const linkedReasons: ConnectionReason[] = [];
    if (relationshipTypes.has('explicit_link')) {
      const targetLinks = new Set(
        extractInternalLinks(page.body_html, titleToId, internalHosts)
          .map((link) => link.targetPageId),
      );
      if (sourceLinks.has(page.id)) {
        linkedReasons.push({ type: 'explicit_link', direction: 'outgoing' });
      }
      if (targetLinks.has(source.id)) {
        linkedReasons.push({ type: 'explicit_link', direction: 'incoming' });
      }
    }

    const sectionReasons: ConnectionReason[] = [];
    if (relationshipTypes.has('parent_child')) {
      if (referencesParent(source, page)) {
        sectionReasons.push({ type: 'parent_child', direction: 'parent' });
      }
      if (referencesParent(page, source)) {
        sectionReasons.push({ type: 'parent_child', direction: 'child' });
      }
    }

    if (linkedReasons.length > 0) linked.push(connectionItem(page, linkedReasons));
    if (sectionReasons.length > 0) section.push(connectionItem(page, sectionReasons));
    if (linkedReasons.length > 0 || sectionReasons.length > 0) continue;

    const relatedReasons: ConnectionReason[] = [];
    const persistedEvidenceScores: number[] = [];
    const similarityScores = relationships
      .filter((row) => row.relationship_type === 'embedding_similarity')
      .map((row) => Number(row.score));
    if (similarityScores.length > 0) {
      const score = Math.max(...similarityScores);
      relatedReasons.push({ type: 'embedding_similarity', score });
      persistedEvidenceScores.push(score);
    }

    const labels = sharedLabels(source, page);
    const labelRows = relationships.filter((row) => row.relationship_type === 'label_overlap');
    if (labelRows.length > 0 && labels.length > 0) {
      relatedReasons.push({
        type: 'label_overlap',
        labels,
        score: labelOverlapScore(source, page, labels),
      });
      persistedEvidenceScores.push(...labelRows.map((row) => Number(row.score)));
    }

    if (relatedReasons.length > 0) {
      relatedRanked.push({
        item: connectionItem(page, relatedReasons),
        evidenceScore: Math.max(...persistedEvidenceScores),
      });
    }
  }

  linked.sort(byNumericPageId);
  section.sort(byNumericPageId);
  relatedRanked.sort((left, right) =>
    right.evidenceScore - left.evidenceScore || byNumericPageId(left.item, right.item));

  return PageConnectionsSchema.parse({
    linked,
    section,
    related: relatedRanked.slice(0, 5).map(({ item }) => item),
  });
}
