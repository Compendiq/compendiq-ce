import { z } from 'zod';

export const SpaceSchema = z.object({
  id: z.number(),
  spaceKey: z.string(),
  spaceName: z.string(),
  description: z.string().nullable(),
  homepageId: z.string().nullable(),
  /**
   * #352 (AC-4): admin/space-owner override of the Confluence-derived
   * homepage. Persisted as `spaces.custom_home_page_id` (FK → pages.id);
   * exposed on the wire as a number or null. When non-null, the
   * `homepageId` field above is the stringified form of this value;
   * otherwise it falls back to the Confluence-derived home page.
   */
  customHomePageId: z.number().nullable().optional(),
  lastSynced: z.string().nullable(),
  pageCount: z.number().optional(),
});

export type Space = z.infer<typeof SpaceSchema>;
