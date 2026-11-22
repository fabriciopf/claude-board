/**
 * Where the Board may listen (card #223). The API has no authentication yet, so listening outside the
 * loopback hands every device on the network `PATCH /api/config` (`claudeBin` = remote code execution)
 * and the approval of cards. Pure functions, so the rule is covered by tests without opening a socket.
 */

/** The explicit opt-in to listen outside the loopback. `--allow-remote` is the old name, still accepted. */
export const INSECURE_LAN_FLAG = '--insecure-lan';
export const LEGACY_REMOTE_FLAG = '--allow-remote';

/** Allowlist: only addresses known to be the local machine. Anything else (0.0.0.0, ::, a LAN IP, a name) is remote. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1') return true;
  return /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h);
}

export type BindDecision =
  | { allowed: true; loopback: true }
  | { allowed: true; loopback: false; warning: string }
  | { allowed: false; error: string };

export function checkBind(host: string, args: string[]): BindDecision {
  if (isLoopbackHost(host)) return { allowed: true, loopback: true };
  const optedIn = args.includes(INSECURE_LAN_FLAG) || args.includes(LEGACY_REMOTE_FLAG);
  if (!optedIn) {
    return {
      allowed: false,
      error:
        `recusando escutar em ${host}: a API do Board não tem autenticação, e qualquer aparelho da rede poderia trocar a configuração ` +
        `(o claudeBin vira execução de código nesta máquina) e aprovar cards. Use host 127.0.0.1, ` +
        `ou passe ${INSECURE_LAN_FLAG} para aceitar o risco numa rede em que você confia.`,
    };
  }
  return {
    allowed: true,
    loopback: false,
    warning:
      `ATENÇÃO: escutando em ${host} sem autenticação (${INSECURE_LAN_FLAG}). Qualquer aparelho que alcance esta porta ` +
      `pode mudar a configuração, rodar comandos nesta máquina e aprovar cards. Use só numa rede em que você confia.`,
  };
}
