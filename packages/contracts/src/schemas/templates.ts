import { z } from 'zod';

export const TemplateSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  icon: z.string().nullable(),
  bodyJson: z.string(),
  bodyHtml: z.string(),
  variables: z.unknown().default([]),
  createdBy: z.string().uuid(),
  isGlobal: z.boolean(),
  spaceKey: z.string().nullable(),
  useCount: z.number(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const TemplateSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  icon: z.string().nullable(),
  isGlobal: z.boolean(),
  useCount: z.number(),
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
});

export const CreateTemplateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  icon: z.string().max(10).optional(),
  bodyJson: z.string().min(1),
  bodyHtml: z.string().min(1),
  variables: z.array(z.unknown()).optional(),
  isGlobal: z.boolean().optional(),
  spaceKey: z.string().optional(),
});

export const UpdateTemplateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  icon: z.string().max(10).optional(),
  bodyJson: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  variables: z.array(z.unknown()).optional(),
  isGlobal: z.boolean().optional(),
  spaceKey: z.string().nullable().optional(),
});

export const UseTemplateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  spaceKey: z.string().optional(),
});

export const TemplateListQuerySchema = z.object({
  category: z.string().optional(),
  scope: z.enum(['all', 'global', 'mine']).default('all'),
});

export type Template = z.infer<typeof TemplateSchema>;
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;
export type UseTemplateInput = z.infer<typeof UseTemplateSchema>;
export type TemplateListQuery = z.infer<typeof TemplateListQuerySchema>;
