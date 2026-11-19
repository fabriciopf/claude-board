import path from 'node:path';
import { paths, protectedBranchList, type Config } from '../config.js';
import { imageRefs } from '../shared/images.js';
import { readList } from '../service/split.js';
import { STATUS_LABELS, STATUS_SHORT_LABELS, type App, type CardDetail, type CardRef, type Label, type Repository } from '../shared/domain.js';

export type PromptKind = 'first' | 'reply' | 'adjust' | 'comment' | 'retry' | 'requeue' | 'moved';

/** Branches a run never pushes to, whatever the policy, as prose. Mirrors the patterns in runner.ts. */
function protectedProse(config: Config): string {
  const list = protectedBranchList(config.protectedBranches);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}` : list[0];
}

const prRules = (PROTECTED: string): Record<Config['prPolicy'], string> => ({
  none: 'Não faça push nem abra PR. Deixe os commits na branch local do card; o usuário decide o que sobe.',
  push_branch: `Push liberado quando o card pedir (na descrição ou num comentário do usuário): da branch do card (cb/*) ou para a branch que o card nomear, como a de um PR já aberto (\`git push origin HEAD:refs/heads/<branch>\`). Sem pedido no card, deixe os commits na branch local. Nunca faça push forçado nem push para ${PROTECTED}. Não abra PR; atualizar a descrição de um PR já aberto (\`gh pr edit\`) vale quando o card pedir.`,
  open_pr: `Push e PR liberados quando o card pedir (na descrição ou num comentário do usuário): faça push da branch do card (cb/*) ou para a branch que o card nomear, como a de um PR já aberto (\`git push origin HEAD:refs/heads/<branch>\`), e abra ou atualize o PR que o card pedir (novo sempre como rascunho). Sem pedido no card, deixe os commits na branch local. Nunca faça push forçado nem push para ${PROTECTED}. Anexe o PR com card_link.`,
});

export interface PromptInput {
  config: Config;
  detail: CardDetail;
  apps: App[];
  labels: Label[];
  /** Registered repositories, to name the ones the card is about (D70). */
  repositories?: Repository[];
  cwd: string;
  /** Folder Claude Code starts in (the VS Code workspace), when different from where the card's work happens. */
  startDir?: string;
  branch: string | null;
  /** Set on the first run of a card whose description is a list: Claude decides whether to split it. */
  split?: SplitHint | null;
  /** The other tasks of the card this one was split from. */
  siblings?: CardRef[];
}

export interface SplitHint {
  items: number;
  /** There is text around the list (the shared context). */
  context: boolean;
}

/** A card qualifies for the split question on its first run: option on, not a task itself, not split yet, a list of 2+ items. */
export function splitCandidate(detail: CardDetail, config: Config): SplitHint | null {
  if (!config.autoSplit || detail.card.parentId || detail.subtasks.length) return null;
  const shape = readList(detail.card.descriptionMd);
  return shape ? { items: shape.items.length, context: !!(shape.preamble || shape.trailing) } : null;
}

function splitSection({ items, context }: SplitHint): string {
  return `## Antes de começar: uma tarefa ou várias?

A descrição traz uma lista de ${items} itens${context ? ' com um texto de contexto em volta' : ''}. Antes de qualquer outro trabalho, decida se esses itens são tarefas independentes ou partes de uma tarefa só.

- **Tarefas independentes:** cada item é uma entrega que se revisa sozinha, não depende do resultado de outro item e pode ser feita ao mesmo tempo que os outros, numa sessão própria. Chame card_split com uma tarefa por item; junte numa tarefa só os itens que dependem um do outro ou mexem nos mesmos arquivos. Dê a cada tarefa um título curto e uma descrição que se sustente sem as outras, e passe o texto comum em "context". Não faça o trabalho das tarefas: depois do card_split, encerre. O Board cria um card para cada tarefa, roda todos em paralelo, e este card acompanha o andamento.
- **Uma tarefa só:** os itens são passos em sequência, requisitos ou critérios de aceite da mesma entrega. Não chame card_split; faça a tarefa normalmente.

Se a descrição pedir para não dividir, não divida.`;
}

const refLine = (t: CardRef) => `- #${t.id} ${t.title} (${STATUS_SHORT_LABELS[t.status]})`;

/** Where the card sits in a split: the card it came from and its sibling tasks, or the tasks it was split into. */
function splitContext({ detail, siblings }: PromptInput): string {
  if (detail.parent) {
    const others = siblings?.length ? `\n\nAs outras tarefas rodam em paralelo, cada uma no seu card e na sua sessão; faça só a sua parte e não mexa no que é delas:\n\n${siblings.map(refLine).join('\n')}` : '';
    return `\n\n### Card de origem\n\nEste card é uma das tarefas em que o card #${detail.parent.id} ("${detail.parent.title}") foi dividido.${others}`;
  }
  if (detail.subtasks.length) {
    return `\n\n### Tarefas deste card\n\nEste card foi dividido; cada tarefa tem card e sessão próprios:\n\n${detail.subtasks.map(refLine).join('\n')}`;
  }
  return '';
}

/**
 * Appended to Claude Code's system prompt. Claude Code records the system prompt on the first
 * request and reuses it on every resume (--system-prompt-snapshot), so only stable rules go here;
 * the card context goes in the user turn, which is always fresh.
 */
export function buildSystemPrompt({ config, detail, cwd, branch, startDir }: PromptInput): string {
  const where =
    startDir && startDir !== cwd
      ? `\n\nA sessão começa em ${startDir}, a raiz do workspace do VS Code, para carregar o mesmo CLAUDE.md, as mesmas skills e as mesmas configurações. O trabalho deste card acontece em ${cwd}: use caminhos absolutos ou entre nessa pasta antes de cada comando.`
      : '';
  const card = detail.card;
  return `# Você está executando uma tarefa do Claude Board

O Claude Board é o quadro de tarefas do usuário. Ninguém acompanha esta execução em tempo real: você trabalha sozinho e conversa com o usuário pelas ferramentas MCP do servidor "claude-board". Esta execução é do card #${card.id}, então pode omitir o "id" nas chamadas. Se uma ferramenta do "claude-board" falhar com ECONNREFUSED ("Unable to connect"), o Board está reiniciando e esta execução continua: espere uns 10 segundos (por exemplo, com um comando que só espera) e chame de novo.${where}

${config.userProfile.trim() ? `Perfil do usuário: ${config.userProfile.trim()}

` : ''}## Regras

1. Reporte o andamento pelo MCP: card_comment para progresso relevante (não para cada passo), card_checklist_add e card_checklist_check para quebrar a tarefa em passos. card_get mostra o card atualizado.
2. Se faltar uma decisão ou informação que só o usuário tem, chame card_ask_user com a pergunta (e opções, quando couber) e ENCERRE a execução logo em seguida. Não invente a resposta e não fique esperando.
3. Se a tarefa depender de outra pessoa, de deploy ou de acesso, chame card_wait_third_party com o motivo e encerre.
4. Ao terminar, chame card_submit_for_review com um resumo: o que foi feito, onde está (arquivos, branch, links) e o que o usuário precisa conferir. Nunca mova o card para "Concluída": só o usuário aprova.
5. Trabalhe dentro de ${cwd}. Não apague nem altere nada fora desse diretório. Antes de qualquer ação irreversível fora dele, chame card_ask_user.${branch ? `\n6. O diretório é um worktree próprio na branch ${branch}; a branch principal do repositório não é tocada.` : ''}
${branch ? '7' : '6'}. Git: ${prRules(protectedProse(config))[config.prPolicy]}
${branch ? '8' : '7'}. Se uma permissão for negada, não tente contornar: diga no card_ask_user o que precisaria e por quê.${
    card.sessionName
      ? ''
      : `\n${branch ? '9' : '8'}. Antes de começar o trabalho, chame card_rename com um nome curto para a tarefa (até 60 caracteres, em português, sem número de card). Ele vira o título do card e o nome desta sessão; o título e a descrição originais ficam guardados no card.`
  }
`;
}

/** Pasted images (D57): the markdown points to /images/<name>; Claude opens the file on disk with Read. */
function imagesContext(description: string, comments: CardDetail['comments']): string {
  const names = imageRefs([description, ...comments.filter((c) => c.author === 'user').map((c) => c.bodyMd)].join('\n'));
  if (!names.length) return '';
  const list = names.map((n) => `- ${path.join(paths.images(), n)}`).join('\n');
  return `\n\n### Imagens coladas no card\n\nA descrição ou os comentários do usuário trazem imagens (os links /images/...). Abra cada uma com a ferramenta Read antes de começar:\n\n${list}`;
}

function cardContext(input: PromptInput): string {
  const { config, detail, apps, labels, repositories = [], cwd, branch } = input;
  const card = detail.card;
  const app = apps.find((a) => a.id === card.appId);
  const appLine = app ? `\n- Projeto: ${app.name}${app.path ? ` (pasta ${app.path})` : ''}` : '';
  const labelNames = card.labelIds
    .map((id) => labels.find((l) => l.id === id)?.name)
    .filter(Boolean)
    .join(', ');
  const repositoryNames = (card.repositoryIds ?? [])
    .map((id) => repositories.find((x) => x.id === id)?.name)
    .filter(Boolean)
    .join(', ');
  const repositoryLine = repositoryNames ? `\n- Repositórios: ${repositoryNames}` : '';
  const checklist = detail.checklist.length ? detail.checklist.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n') : '(vazio)';
  const links = card.links.length ? card.links.map((l) => `- ${l.kind}: ${l.title ? `${l.title} — ` : ''}${l.value}`).join('\n') : '(nenhum)';
  const comments = detail.comments
    .filter((c) => c.author !== 'system')
    .slice(-config.recentCommentsInPrompt)
    .map((c) => `- [${c.author === 'claude' ? 'Claude' : 'Usuário'}${c.kind !== 'comment' ? `, ${c.kind}` : ''}] ${c.bodyMd.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n');
  return `## Card #${card.id}: ${card.title}

- Lista: ${STATUS_LABELS[card.status]}${labelNames ? ` · Labels: ${labelNames}` : ''}${appLine}${repositoryLine}
- Prioridade: ${card.priority}${card.dueDate ? ` · Prazo: ${card.dueDate}` : ''}
- Diretório de trabalho: ${cwd}${branch ? ` (branch ${branch})` : ''}

### Descrição

${card.descriptionMd.trim() || '(sem descrição: use o título)'}${imagesContext(card.descriptionMd, detail.comments)}${splitContext(input)}

### Checklist

${checklist}

### Links

${links}

### Últimos comentários

${comments || '(nenhum)'}`;
}

/** The user turn sent on stdin. */
export function buildUserPrompt(kind: PromptKind, input: PromptInput, nextPrompt: string | null): string {
  const card = input.detail.card;
  switch (kind) {
    case 'first':
      return `Execute o card #${card.id}.\n\n${input.split ? `${splitSection(input.split)}\n\n` : ''}${cardContext(input)}`;
    case 'reply':
      return `Resposta do usuário à sua pergunta:\n\n${nextPrompt ?? ''}\n\nContinue a tarefa a partir daqui.`;
    case 'adjust':
      return `O usuário revisou e pediu ajustes:\n\n${nextPrompt ?? ''}\n\nFaça os ajustes e entregue de novo com card_submit_for_review.`;
    case 'comment':
      return `O usuário comentou no card depois da sua entrega:\n\n${nextPrompt ?? ''}\n\nAtenda ao comentário e entregue de novo com card_submit_for_review. Se o comentário só pedir informação, responda no card com card_comment antes de entregar.`;
    case 'retry':
      return `${nextPrompt ?? 'Continue a tarefa de onde parou.'}\n\nEstado atual do card:\n\n${cardContext(input)}`;
    case 'moved':
      return `Continue o card #${card.id} numa sessão nova. As execuções anteriores rodaram noutra pasta, sem o workspace; agora você tem o CLAUDE.md, as skills e o código do workspace. Os comentários abaixo trazem o que já foi feito e perguntado.${nextPrompt ? `\n\nÚltima mensagem do usuário:\n\n${nextPrompt}` : ''}\n\n${cardContext(input)}`;
    case 'requeue':
      return `O usuário colocou o card de volta na fila. O card pode ter mudado; continue a partir do estado atual:\n\n${cardContext(input)}`;
  }
}
