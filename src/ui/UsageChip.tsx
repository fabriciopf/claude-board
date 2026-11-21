import { useEffect, useState } from 'react';
import type { UsageSnapshot } from '../shared/domain';

function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * "Sessão 5h: 38% · reset em 1h12", from the last reading the Board got from Claude Code. `inline` renders it
 * as the second half of the runner pill ("rodando x de y", D83) instead of a pill of its own.
 */
export function UsageChip({ usage, inline = false }: { usage: UsageSnapshot | null; inline?: boolean }) {
  const base = inline ? 'usage-part' : 'counter usage';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, []);

  const w = usage?.fiveHour;
  if (!usage || !w) {
    return (
      <span className={base} title="O Board lê o uso do plano quando roda uma execução do Claude Code.">
        Sessão 5h: <strong>—</strong>
        <span className="muted small">sem leitura ainda</span>
      </span>
    );
  }

  const age = now - new Date(usage.observedAt).getTime();
  const resetMs = w.resetsAt * 1000 - now;
  const read = `lido há ${duration(age)}`;
  const weekly = usage.sevenDay ? ` Semana: ${Math.round(usage.sevenDay.utilization * 100)}%, renova ${new Date(usage.sevenDay.resetsAt * 1000).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : '';

  if (resetMs <= 0) {
    return (
      <span className={base} title={`A janela de 5h renovou às ${clock(w.resetsAt)}. O uso atual aparece na próxima execução.${weekly}`}>
        Sessão 5h: <strong>janela renovada</strong>
        <span className="muted small">às {clock(w.resetsAt)}</span>
      </span>
    );
  }

  const pct = Math.round(w.utilization * 100);
  const tone = pct >= 95 ? ' danger' : pct >= 80 ? ' attention' : '';
  return (
    <span
      className={base + tone}
      title={`Uso da janela de 5h do seu plano, na última execução do Board (${read}). Renova às ${clock(w.resetsAt)}.${weekly}`}
    >
      Sessão 5h: <strong>{pct}%</strong>
      <span className="usage-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      reset em <strong>{duration(resetMs)}</strong>
      <span className="muted small">· {read}</span>
    </span>
  );
}
