import { useEffect, useRef, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api } from './api';
import type { PublishEntry, PublishState } from '../shared/domain';

const STATUS_TEXT: Record<PublishEntry['status'], string> = {
  pending: 'na fila',
  publishing: 'publicando',
  published: 'publicada',
  failed: 'falhou',
};

/** "Publicação pendente (N)" in the header: the Board's own delivered branches waiting to go live (D42). */
export function PublishChip({
  publish,
  running,
  onOpen,
  notify,
  reload,
}: {
  publish: PublishState | null;
  running: number;
  onOpen: (cardId: number) => void;
  notify: (msg: string, error?: boolean) => void;
  /** Reloads the board, so the button stays busy until the list shows the new state (card #165). */
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!publish || (!publish.entries.length && publish.phase === 'idle')) return null;
  const busy = publish.phase !== 'idle';
  const failed = publish.entries.filter((e) => e.status === 'failed').length;
  const label = busy ? 'Publicando o Board' : publish.pending ? `Publicação pendente (${publish.pending})` : `Publicação falhou (${failed})`;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify(ok);
      await reload();
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  return (
    <div className="publish" ref={ref}>
      <button
        className={'counter publish-chip' + (failed && !publish.pending && !busy ? ' danger' : ' info')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Melhorias do próprio Board entregues e ainda não publicadas no Board em uso"
      >
        {busy && <span className="spinner" />}
        {label}
      </button>
      {open && (
        <div className="publish-pop" role="dialog" aria-label="Publicação do Board">
          {publish.detail && <p className="publish-detail">{publish.detail}</p>}
          <ul className="publish-list">
            {publish.entries.map((e) => (
              <li key={e.id}>
                <button className="btn link" onClick={() => onOpen(e.cardId)}>
                  #{e.cardId} {e.cardTitle}
                </button>
                <span className="muted small">
                  <code>{e.branch}</code> · {STATUS_TEXT[e.status]}
                  {e.kind === 'ui' ? ' · só tela' : e.kind === 'server' ? ' · reinicia o servidor' : ''}
                </span>
                {e.status === 'failed' && (
                  <>
                    {e.errorMd && <pre className="publish-error">{e.errorMd}</pre>}
                    <ActionButton className="btn small" busyLabel="Recolocando na fila…" onAction={() => act(() => api.post(`/api/publish/${e.id}/retry`), 'Publicação de volta na fila')}>
                      Tentar de novo
                    </ActionButton>
                  </>
                )}
              </li>
            ))}
          </ul>
          {(publish.pending > 0 || publish.phase === 'waiting') && (
            <div className="publish-now">
              <ActionButton className="btn small primary" disabled={busy} busyLabel="Iniciando…" onAction={() => act(() => api.post('/api/publish/now'), 'Publicação iniciada')}>
                {busy ? 'Publicando…' : 'Publicar agora'}
              </ActionButton>
              <span className="muted small">
                {running > 0
                  ? `${running === 1 ? 'A execução em curso continua' : `As ${running} execuções em curso continuam`} durante o reinício.`
                  : 'Nenhuma execução em curso.'}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
