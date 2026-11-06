/**
 * In-page replacements for confirm() and prompt(). The native ones can be silently disabled
 * (embedded browsers, or after "prevent this page from creating dialogs"): confirm() then returns
 * false and prompt() throws, so the action just doesn't happen.
 */

interface Opts { ok?: string; cancel?: string; danger?: boolean }

function open(message: string, input: string | null, opts: Opts): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dialog-backdrop';
    back.innerHTML = '<div class="dialog" role="dialog" aria-modal="true"><div class="msg"></div>' +
      '<input type="text" /><div class="row"><button data-r="cancel"></button><button data-r="ok" class="accent"></button></div></div>';
    back.querySelector('.msg')!.textContent = message;
    const field = back.querySelector('input')!;
    if (input === null) field.remove(); else field.value = input;
    const ok = back.querySelector<HTMLButtonElement>('[data-r="ok"]')!;
    const cancel = back.querySelector<HTMLButtonElement>('[data-r="cancel"]')!;
    ok.textContent = opts.ok ?? 'OK';
    cancel.textContent = opts.cancel ?? 'Cancel';
    if (opts.danger) ok.classList.add('danger');

    const done = (result: string | null) => {
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(result);
    };
    const accept = () => done(input === null ? '' : field.value.trim() || null);
    // Capture phase: keys typed here must not reach the app's shortcuts (1–9, Space, H…).
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); accept(); }
    };
    window.addEventListener('keydown', onKey, true);
    ok.onclick = accept;
    cancel.onclick = () => done(null);
    back.onclick = (e) => { if (e.target === back) done(null); };

    document.body.appendChild(back);
    if (input === null) ok.focus(); else { field.focus(); field.select(); }
  });
}

/** Ask a yes/no question. Resolves true for OK. */
export async function ask(message: string, opts: Opts = {}): Promise<boolean> {
  return (await open(message, null, opts)) !== null;
}

/** Ask for a line of text. Resolves null if cancelled or left empty. */
export function askText(message: string, value = '', opts: Opts = {}): Promise<string | null> {
  return open(message, value, opts);
}
