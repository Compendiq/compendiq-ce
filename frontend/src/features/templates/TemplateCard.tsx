import { m } from 'framer-motion';
import { Eye, Play, FileText } from 'lucide-react';
import { cn } from '../../shared/lib/cn';

export interface Template {
  id: number;
  title: string;
  description: string;
  category: string;
  useCount: number;
  icon?: string;
  bodyHtml: string;
  createdAt: string;
}

const categoryColors: Record<string, string> = {
  meetings: 'bg-blue-500/15 text-blue-400',
  operations: 'bg-amber-500/15 text-amber-400',
  documentation: 'bg-emerald-500/15 text-emerald-400',
  engineering: 'bg-purple-500/15 text-purple-400',
};

interface TemplateCardProps {
  template: Template;
  index: number;
  onUse: (template: Template) => void;
  onPreview: (template: Template) => void;
}

export function TemplateCard({ template, index, onUse, onPreview }: TemplateCardProps) {
  const colorClass = categoryColors[template.category.toLowerCase()] ?? 'bg-foreground/10 text-muted-foreground';

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="nm-card flex flex-col p-5 hover:border-primary/30 transition-colors"
      data-testid={`template-card-${template.id}`}
    >
      {/* Header row */}
      <div className="flex items-start gap-3 mb-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileText size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-foreground">{template.title}</h3>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide', colorClass)}>
              {template.category}
            </span>
            {template.useCount > 0 && (
              <span className="text-[11px] text-muted-foreground">
                Used {template.useCount} time{template.useCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="mb-4 flex-1 text-sm text-muted-foreground line-clamp-2">
        {template.description}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onUse(template)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          data-testid={`template-use-${template.id}`}
        >
          <Play size={14} />
          Use
        </button>
        <button
          onClick={() => onPreview(template)}
          className="nm-card flex items-center gap-1.5 px-3 py-2 text-sm hover:bg-foreground/5 transition-colors"
          data-testid={`template-preview-${template.id}`}
        >
          <Eye size={14} />
          Preview
        </button>
      </div>
    </m.div>
  );
}
