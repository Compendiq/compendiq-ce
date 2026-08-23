/* eslint-disable react-refresh/only-export-components */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  BookOpen,
  Check,
  ClipboardList,
  FileCode2,
  FilePlus2,
  GitBranch,
  ListPlus,
  ListTree,
  ScanText,
  ShieldAlert,
  SpellCheck2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAiContext, type Mode } from './AiContext';
import {
  IMPROVEMENT_DESCRIPTIONS,
  IMPROVEMENT_TYPES,
  type ImprovementType,
} from './improvement-types';
import { CREATE_SKILLS, type CreateSkillId } from './create-skills';
import { type AssistantAction, type CreateSkillAction } from './assistant-actions';
import { cn } from '../../shared/lib/cn';
import { Button } from '../../shared/components/Button';
import { SkillsIcon } from '../../shared/components/SkillsIcon';

// Both types moved to the leaf module (#1361) so `AiContext` can read the
// allow-lists without closing an import cycle through this component.
// Re-exported here for the callers that already import them from this path.
export type { AssistantAction, CreateSkillAction };

interface ActionDefinition {
  id: AssistantAction;
  label: string;
  description: string;
  Icon: LucideIcon | typeof SkillsIcon;
}

const IMPROVEMENT_ICONS: Record<ImprovementType, LucideIcon> = {
  grammar: SpellCheck2,
  structure: ListTree,
  clarity: ScanText,
  technical: Wrench,
  completeness: ListPlus,
};

const CREATE_SKILL_ICONS: Record<CreateSkillId, LucideIcon> = {
  spec: FileCode2,
  guide: BookOpen,
  notes: ClipboardList,
  postmortem: ShieldAlert,
  custom: FilePlus2,
};

const CHAT_ACTION: ActionDefinition = {
  id: 'ask',
  label: 'Q&A',
  description: 'Ask your synced knowledge base',
  Icon: SkillsIcon,
};

const IMPROVEMENT_ACTIONS: ActionDefinition[] = IMPROVEMENT_TYPES.map((type) => ({
  id: type,
  label: type.charAt(0).toUpperCase() + type.slice(1),
  description: IMPROVEMENT_DESCRIPTIONS[type],
  Icon: IMPROVEMENT_ICONS[type],
}));

// Renamed from CREATE_SKILL_ACTIONS (#1361): `assistant-actions.ts` now exports
// that name for the list of create-skill IDS, which is what a surface's
// allow-list carries. These are the menu's rendered definitions.
const CREATE_SKILL_DEFINITIONS: ActionDefinition[] = CREATE_SKILLS.map((skill) => ({
  id: `create-${skill.id}` as CreateSkillAction,
  label: skill.shortName,
  description: skill.description,
  Icon: CREATE_SKILL_ICONS[skill.id],
}));

const DIAGRAM_ACTION: ActionDefinition = {
  id: 'diagram',
  label: 'Diagram',
  description: 'Turn the open page into a Mermaid diagram',
  Icon: GitBranch,
};

const GENERATE_ACTION: ActionDefinition = {
  id: 'generate',
  label: 'Generate',
  description: 'Create a new page from a prompt',
  Icon: FilePlus2,
};

export function resolveAssistantAction(
  mode: Mode,
  improvementType: ImprovementType,
  createSkill?: CreateSkillId,
): AssistantAction {
  if (mode === 'improve') return improvementType;
  if (mode === 'generate') {
    return createSkill ? (`create-${createSkill}` as CreateSkillAction) : 'generate';
  }
  return mode;
}

export function applyAssistantAction(
  action: AssistantAction,
  setMode: (mode: Mode) => void,
  setImprovementType: (type: ImprovementType) => void,
  setCreateSkill?: (skill: CreateSkillId) => void,
) {
  if (IMPROVEMENT_TYPES.includes(action as ImprovementType)) {
    setImprovementType(action as ImprovementType);
    setMode('improve');
    return;
  }
  if (action.startsWith('create-')) {
    const skillId = action.replace('create-', '') as CreateSkillId;
    setCreateSkill?.(skillId);
    setMode('generate');
    return;
  }
  if (action === 'generate') {
    setCreateSkill?.('custom');
    setMode('generate');
    return;
  }
  setMode(action as Mode);
}

function ActionItem({ action, selected, onSelect }: {
  action: ActionDefinition;
  selected: boolean;
  onSelect: (action: AssistantAction) => void;
}) {
  const { Icon } = action;
  return (
    <DropdownMenu.Item
      onSelect={() => onSelect(action.id)}
      className={cn(
        'flex cursor-pointer select-none items-start gap-2.5 rounded-md px-2.5 py-2 outline-none text-foreground transition-colors',
        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        selected && 'bg-accent/60 font-medium',
      )}
      data-testid={`assistant-action-${action.id}`}
    >
      <Icon size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{action.label}</span>
        <span className="block text-xs leading-4 text-muted-foreground">{action.description}</span>
      </span>
      {selected && <Check size={14} className="mt-0.5 shrink-0 text-foreground" aria-hidden />}
    </DropdownMenu.Item>
  );
}

export function AssistantActionSelect({
  actions,
  disabled = false,
  className,
}: {
  /**
   * The allow-list this surface offers — `AI_HOME_ACTIONS` on `/ai`,
   * `DOCK_ACTIONS` in the article dock (#1361). It replaced a boolean
   * `includeGenerate`, which could only ever describe one of the several
   * differences between the surfaces, and which said nothing at all about the
   * five create skills #1401 added to both.
   */
  actions: readonly AssistantAction[];
  disabled?: boolean;
  className?: string;
}) {
  const { mode, setMode, improvementType, setImprovementType, createSkill, setCreateSkill } = useAiContext();
  const selected = resolveAssistantAction(mode, improvementType, createSkill);
  // A selection this surface does not offer reads as Q&A rather than as a
  // trigger naming an action Send cannot run — the same fallback the old
  // `includeGenerate` form applied to Generate, generalised.
  const available = actions.includes(selected) ? selected : 'ask';
  const chatActions = actions.includes('ask') ? [CHAT_ACTION] : [];
  const rewriteActions = IMPROVEMENT_ACTIONS.filter((action) => actions.includes(action.id));
  const createActions = [...CREATE_SKILL_DEFINITIONS, DIAGRAM_ACTION, GENERATE_ACTION]
    .filter((action) => actions.includes(action.id));
  const definitions = [...chatActions, ...rewriteActions, ...createActions];
  const current = definitions.find((action) => action.id === available) ?? CHAT_ACTION;
  const { Icon } = current;

  const selectAction = (action: AssistantAction) => {
    applyAssistantAction(action, setMode, setImprovementType, setCreateSkill);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="secondary"
          size="icon"
          disabled={disabled}
          aria-label={`Selected action: ${current.label}`}
          title={`Selected action: ${current.label}`}
          className={cn(
            'h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground',
            className,
          )}
          data-testid="assistant-action-select"
        >
          <Icon size={16} aria-hidden />
          <span className="sr-only">{current.label}</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="nm-card-elevated z-50 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-80 overflow-y-auto p-1.5"
        >
          {chatActions.length > 0 && (
            <>
              <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                Assistant chat
              </DropdownMenu.Label>
              {chatActions.map((action) => (
                <ActionItem key={action.id} action={action} selected={available === action.id} onSelect={selectAction} />
              ))}
            </>
          )}

          {/* A section header with no items under it is worse than a shorter
              menu, so each group — and the rule above it — renders only when
              this surface's allow-list carries something for it. */}
          {rewriteActions.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                Rewrite skills
              </DropdownMenu.Label>
              {rewriteActions.map((action) => (
                <ActionItem key={action.id} action={action} selected={available === action.id} onSelect={selectAction} />
              ))}
            </>
          )}

          {createActions.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
              {/* Both shipped surfaces carry the create skills, so this reads
                  "Create skills" exactly as dev does today; the fallback is for
                  a surface that offers only Diagram and/or Generate, where that
                  label would name items it does not contain. */}
              <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                {createActions.some((action) => action.id.startsWith('create-')) ? 'Create skills' : 'Create'}
              </DropdownMenu.Label>
              {createActions.map((action) => (
                <ActionItem key={action.id} action={action} selected={available === action.id} onSelect={selectAction} />
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
