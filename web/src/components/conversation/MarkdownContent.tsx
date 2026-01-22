import { useRef, useEffect, useCallback } from 'react';
import { Streamdown } from 'streamdown';

interface MarkdownContentProps {
  content: string;
  mode?: 'streaming' | 'static';
}

export function MarkdownContent({ content, mode = 'streaming' }: MarkdownContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Add copy buttons to code blocks after render
  const addCopyButtons = useCallback(() => {
    if (!containerRef.current) return;

    const codeBlocks = containerRef.current.querySelectorAll('pre');
    codeBlocks.forEach((pre) => {
      // Skip if already has a copy button
      if (pre.querySelector('.code-copy-btn')) return;

      // Create wrapper for positioning
      if (!pre.parentElement?.classList.contains('code-block-wrapper')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        pre.parentElement?.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
      }

      // Create copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.innerHTML = `
        <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span class="copy-text">Copy</span>
      `;
      copyBtn.title = 'Copy code';

      copyBtn.addEventListener('click', async () => {
        const code = pre.querySelector('code')?.textContent || pre.textContent || '';
        try {
          await navigator.clipboard.writeText(code);
          // Show success state
          const copyIcon = copyBtn.querySelector('.copy-icon') as HTMLElement;
          const checkIcon = copyBtn.querySelector('.check-icon') as HTMLElement;
          const copyText = copyBtn.querySelector('.copy-text') as HTMLElement;

          if (copyIcon && checkIcon && copyText) {
            copyIcon.style.display = 'none';
            checkIcon.style.display = 'block';
            copyText.textContent = 'Copied!';
            copyBtn.classList.add('copied');

            setTimeout(() => {
              copyIcon.style.display = 'block';
              checkIcon.style.display = 'none';
              copyText.textContent = 'Copy';
              copyBtn.classList.remove('copied');
            }, 2000);
          }
        } catch (err) {
          console.error('Failed to copy:', err);
        }
      });

      pre.parentElement?.appendChild(copyBtn);
    });
  }, []);

  // Run after content changes
  useEffect(() => {
    // Small delay to ensure Streamdown has rendered
    const timer = setTimeout(addCopyButtons, 100);
    return () => clearTimeout(timer);
  }, [content, addCopyButtons]);

  // Also observe for dynamic content updates
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new MutationObserver(() => {
      addCopyButtons();
    });

    observer.observe(containerRef.current, {
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [addCopyButtons]);

  if (!content.trim()) return null;

  return (
    <div ref={containerRef} className="markdown-content">
      <Streamdown mode={mode}>
        {content}
      </Streamdown>
    </div>
  );
}
