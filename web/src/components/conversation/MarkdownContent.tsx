import { useRef, useEffect, useCallback } from 'react';
import { Streamdown } from 'streamdown';

interface MarkdownContentProps {
  content: string;
  mode?: 'streaming' | 'static';
}

export function MarkdownContent({ content, mode = 'streaming' }: MarkdownContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Track processed code blocks to avoid O(n²) reprocessing
  const processedBlocksRef = useRef(new WeakSet<HTMLPreElement>());
  // Track cleanup functions for event listeners
  const cleanupFnsRef = useRef<Array<() => void>>([]);
  // Debounce timer for mutation observer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup function - removes all event listeners
  const cleanup = useCallback(() => {
    cleanupFnsRef.current.forEach(fn => fn());
    cleanupFnsRef.current = [];
  }, []);

  // Add copy button to a single code block
  const addCopyButtonToBlock = useCallback((pre: HTMLPreElement) => {
    // Skip if already processed
    if (processedBlocksRef.current.has(pre)) return;
    processedBlocksRef.current.add(pre);

    // Create wrapper for positioning if not already wrapped
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

    // Create click handler
    const handleClick = async () => {
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
    };

    copyBtn.addEventListener('click', handleClick);

    // Track cleanup function for this button
    cleanupFnsRef.current.push(() => {
      copyBtn.removeEventListener('click', handleClick);
    });

    pre.parentElement?.appendChild(copyBtn);
  }, []);

  // Add copy buttons to all new code blocks
  const addCopyButtons = useCallback(() => {
    if (!containerRef.current) return;

    const codeBlocks = containerRef.current.querySelectorAll('pre');
    codeBlocks.forEach((pre) => {
      addCopyButtonToBlock(pre);
    });
  }, [addCopyButtonToBlock]);

  // Debounced version of addCopyButtons for mutation observer
  const debouncedAddCopyButtons = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      addCopyButtons();
    }, 50); // Small debounce to batch rapid mutations
  }, [addCopyButtons]);

  // Run after content changes
  useEffect(() => {
    // Small delay to ensure Streamdown has rendered
    const timer = setTimeout(addCopyButtons, 100);
    return () => clearTimeout(timer);
  }, [content, addCopyButtons]);

  // Observe for dynamic content updates (debounced)
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new MutationObserver(() => {
      debouncedAddCopyButtons();
    });

    observer.observe(containerRef.current, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [debouncedAddCopyButtons]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
      processedBlocksRef.current = new WeakSet();
    };
  }, [cleanup]);

  if (!content.trim()) return null;

  return (
    <div ref={containerRef} className="markdown-content text-sm">
      <Streamdown mode={mode}>
        {content}
      </Streamdown>
    </div>
  );
}
