import { Streamdown } from 'streamdown';

interface MarkdownContentProps {
  content: string;
  mode?: 'streaming' | 'static';
}

export function MarkdownContent({ content, mode = 'streaming' }: MarkdownContentProps) {
  if (!content.trim()) return null;

  return (
    <Streamdown mode={mode}>
      {content}
    </Streamdown>
  );
}
