export type OpenCodeGlobalEvent = {
  directory?: string;
  payload?: OpenCodeEvent;
  [key: string]: unknown;
};

export type OpenCodeEvent = {
  type: string;
  properties?: {
    part?: OpenCodePart;
    delta?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeFilePart
  | OpenCodeToolPart
  | OpenCodePatchPart
  | OpenCodeSnapshotPart
  | OpenCodeReasoningPart
  | OpenCodeGenericPart;

export type OpenCodeQuestionRequest = {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type OpenCodeQuestionInfo = {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
};

export type OpenCodeQuestionOption = {
  label: string;
  description: string;
};

export type OpenCodeBasePart = {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  [key: string]: unknown;
};

export type OpenCodeTextPart = OpenCodeBasePart & {
  type: 'text';
  text: string;
};

export type OpenCodeReasoningPart = OpenCodeBasePart & {
  type: 'reasoning';
  text: string;
};

export type OpenCodeFilePart = OpenCodeBasePart & {
  type: 'file';
  mime?: string;
  filename?: string;
  url: string;
};

export type OpenCodeToolPart = OpenCodeBasePart & {
  type: 'tool';
  tool?: string;
  callID?: string;
  state?: unknown;
};

export type OpenCodePatchPart = OpenCodeBasePart & {
  type: 'patch';
  hash?: string;
  files?: string[];
};

export type OpenCodeSnapshotPart = OpenCodeBasePart & {
  type: 'snapshot';
  snapshot?: string;
};

export type OpenCodeGenericPart = OpenCodeBasePart & {
  type: string;
};
