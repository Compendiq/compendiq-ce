export type CreateSkillId = 'spec' | 'guide' | 'notes' | 'postmortem' | 'custom';

export interface CreateSkill {
  id: CreateSkillId;
  name: string;
  shortName: string;
  description: string;
  promptTemplate: string;
  suggestedPrompt: string;
  backendTemplate?: string;
  customPromptKey?: string;
}

export const CREATE_SKILLS: CreateSkill[] = [
  {
    id: 'spec',
    name: 'Technical Spec / RFC',
    shortName: 'Tech Spec',
    description: 'Architecture, requirements, API contracts & rollout',
    promptTemplate: 'Draft a technical specification and RFC for: ',
    suggestedPrompt: 'Draft a technical specification and RFC for a distributed real-time notification service with WebSocket connection management and Redis pub/sub.',
    backendTemplate: 'spec',
    customPromptKey: 'generate_spec',
  },
  {
    id: 'guide',
    name: 'How-To Guide / Runbook',
    shortName: 'Runbook',
    description: 'Prerequisites, step-by-step procedures & verification',
    promptTemplate: 'Write a step-by-step how-to runbook for: ',
    suggestedPrompt: 'Write a step-by-step how-to runbook for zero-downtime database migration and failover procedure with automated health verification.',
    backendTemplate: 'guide',
    customPromptKey: 'generate_guide',
  },
  {
    id: 'notes',
    name: 'Meeting Notes & Actions',
    shortName: 'Meeting Notes',
    description: 'Agenda, decisions made, discussion & action items table',
    promptTemplate: 'Generate structured meeting notes for: ',
    suggestedPrompt: 'Generate structured meeting notes for Q3 Architecture Sync: Multi-region active-active deployment strategy and latency SLAs.',
    backendTemplate: 'notes',
    customPromptKey: 'generate_notes',
  },
  {
    id: 'postmortem',
    name: 'Incident Post-Mortem',
    shortName: 'Post-Mortem',
    description: 'Timeline, root cause analysis, impact & follow-ups',
    promptTemplate: 'Create an incident post-mortem report for: ',
    suggestedPrompt: 'Create an incident post-mortem report for INC-4092: Authentication API latency spike and connection pool exhaustion during peak traffic.',
    backendTemplate: 'postmortem',
    customPromptKey: 'generate_postmortem',
  },
  {
    id: 'custom',
    name: 'Custom Topic / Free Prompt',
    shortName: 'Custom Draft',
    description: 'Describe any document, outline, or knowledge base article',
    promptTemplate: '',
    suggestedPrompt: 'Draft an onboarding guide for new backend engineers covering environment setup, repository layout, and CI/CD deployment workflow.',
    backendTemplate: 'custom',
    customPromptKey: 'generate',
  },
];

export function getCreateSkill(id: string): CreateSkill | undefined {
  return CREATE_SKILLS.find((s) => s.id === id);
}
