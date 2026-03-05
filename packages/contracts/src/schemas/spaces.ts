import { z } from 'zod';

export const SpaceSchema = z.object({
  id: z.number(),
  spaceKey: z.string(),
  spaceName: z.string(),
  description: z.string().nullable(),
  homepageId: z.string().nullable(),
  lastSynced: z.string().nullable(),
  pageCount: z.number().optional(),
});

export type Space = z.infer<typeof SpaceSchema>;
