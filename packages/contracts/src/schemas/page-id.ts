import { z } from 'zod';

export const PagePrimaryKeySchema = z
  .union([z.string().regex(/^\d+$/, 'Invalid page ID'), z.number()])
  .pipe(z.coerce.number<string | number>().int().positive().max(2_147_483_647));
