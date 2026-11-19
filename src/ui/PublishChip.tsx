import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PublishEntry, PublishState } from '../shared/domain';

const STATUS_TEXT: Record<PublishEntry['status'], string> = {
  pending: 'na fila',
  publishing: 'publicando',
  published: 'publicada',
  failed: 'falhou',
};

/** "Publicação pendente (N)" in the header: the Board's own delivered branches waiting to go live (D42). */
export function PublishChip({ publish, running, onOpen, notify }: { publish: PublishState | null; running: number; onOpen: (cardId: number) => void; notify: (msg: string, error?: boolean) => void }) {
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

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
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
                    <button className="btn small" onClick={() => void act(() => api.post(`/api/publish/${e.id}/retry`))}>
                      Tentar de novo
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {(publish.pending > 0 || publish.phase === 'waiting') && (
            <div className="publish-now">
              <button className="btn small primary" onClick={() => void act(() => api.post('/api/publish/now'))}>
                Publicar agora
              </button>
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
