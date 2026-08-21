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
import { cn } from '../../shared/lib/cn';
import { Button } from '../../shared/components/Button';
import { SkillsIcon } from '../../shared/components/SkillsIcon';

export type CreateSkillAction = 'create-spec' | 'create-guide' | 'create-notes' | 'create-postmortem' | 'create-custom';
export type AssistantAction = 'ask' | ImprovementType | 'diagram' | 'generate' | CreateSkillAction;

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

const CREATE_SKILL_ACTIONS: ActionDefinition[] = CREATE_SKILLS.map((skill) => ({
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
  includeGenerate = false,
  disabled = false,
  className,
}: {
  includeGenerate?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { mode, setMode, improvementType, setImprovementType, createSkill, setCreateSkill } = useAiContext();
  const selected = resolveAssistantAction(mode, improvementType, createSkill);
  const definitions = [
    CHAT_ACTION,
    ...IMPROVEMENT_ACTIONS,
    ...CREATE_SKILL_ACTIONS,
    DIAGRAM_ACTION,
    ...(includeGenerate ? [GENERATE_ACTION] : []),
  ];
  const current = definitions.find((action) => action.id === selected) ?? CHAT_ACTION;
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
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            Assistant chat
          </DropdownMenu.Label>
          <ActionItem action={CHAT_ACTION} selected={selected === 'ask'} onSelect={selectAction} />

          <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            Rewrite skills
          </DropdownMenu.Label>
          {IMPROVEMENT_ACTIONS.map((action) => (
            <ActionItem key={action.id} action={action} selected={selected === action.id} onSelect={selectAction} />
          ))}

          <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            Create skills
          </DropdownMenu.Label>
          {CREATE_SKILL_ACTIONS.map((action) => (
            <ActionItem key={action.id} action={action} selected={selected === action.id} onSelect={selectAction} />
          ))}
          <ActionItem action={DIAGRAM_ACTION} selected={selected === 'diagram'} onSelect={selectAction} />
          {includeGenerate && (
            <ActionItem action={GENERATE_ACTION} selected={selected === 'generate'} onSelect={selectAction} />
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
