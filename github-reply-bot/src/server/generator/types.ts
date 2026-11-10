import type { GeneratorProvider, ReplyLanguage, TriggerKind } from '../../shared/types';
import type { ChangedFile } from '../github/types';

export interface GenerationInput {
  kind: 'issue' | 'pull_request';
  trigger: TriggerKind;
  action: string;
  repo: { owner: string; name: string };
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
  files: ChangedFile[];
  totalChangedFiles: number;
  language: ReplyLanguage;
  maxReplyChars: number;
  templateBody?: string;
  mention: boolean;
}

export interface GenerationResult {
  body: string;
  templateName: string;
  fallbackUsed: boolean;
  provider: GeneratorProvider;
}

export interface ReplyGenerator {
  generate(input: GenerationInput): Promise<GenerationResult>;
}
