import { EventEmitter } from 'node:events';

/** Message pushed to the UI through SSE. */
export interface BusMessage {
  type: string;
  cardId?: number;
  executionId?: number;
  data?: Record<string, unknown>;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(msg: BusMessage): void {
    this.emitter.emit('message', msg);
  }

  subscribe(fn: (msg: BusMessage) => void): () => void {
    this.emitter.on('message', fn);
    return () => this.emitter.off('message', fn);
  }
}
