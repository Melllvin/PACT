import type { z } from 'zod';
import {
  ipcEvents,
  ipcRequests,
  toIpcError,
  type IpcEnvelope,
  type IpcEvent,
  type IpcEventChannel,
  type IpcOutput,
  type IpcRequestChannel,
} from '../../shared/ipc';

// contracts/ipc.md — every request is validated on entry and on exit; errors become envelopes.

type ServiceInput<C extends IpcRequestChannel> = z.output<(typeof ipcRequests)[C]['input']>;
/**
 * Channels without a result may be served by functions returning void; their output is still
 * validated against the contract (z.undefined) before replying.
 */
type ServiceOutput<C extends IpcRequestChannel> =
  undefined extends IpcOutput<C> ? unknown : IpcOutput<C>;
export type IpcServices = {
  [C in IpcRequestChannel]?: (
    input: ServiceInput<C>,
  ) => ServiceOutput<C> | Promise<ServiceOutput<C>>;
};

/** The part of Electron's ipcMain used here (injectable for tests). */
type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: { senderFrame: { url: string } | null }, input: unknown) => unknown,
  ): void;
};

export function registerHandlers(
  ipcMain: IpcMainLike,
  services: IpcServices,
  { isTrustedSender }: { isTrustedSender: (url: string) => boolean },
): void {
  for (const channel of Object.keys(services) as IpcRequestChannel[]) {
    const service = services[channel] as ((input: unknown) => unknown) | undefined;
    if (!service) continue;
    const { input: inputSchema, output: outputSchema } = ipcRequests[channel];

    ipcMain.handle(channel, async (event, rawInput): Promise<IpcEnvelope<unknown>> => {
      if (!event.senderFrame || !isTrustedSender(event.senderFrame.url)) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'Origine refusée' } };
      }
      const input = inputSchema.safeParse(rawInput);
      if (!input.success) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: input.error.message } };
      }
      try {
        const output = outputSchema.safeParse(await service(input.data));
        if (!output.success) {
          return { ok: false, error: { code: 'INTERNAL', message: 'Réponse invalide' } };
        }
        return { ok: true, data: output.data };
      } catch (error) {
        return { ok: false, error: toIpcError(error) };
      }
    });
  }
}

type EventTarget = { send(channel: string, payload: unknown): void };

/** Sends a validated event to every window; an invalid payload is a programming error. */
export function createEventEmitter(targets: () => EventTarget[]) {
  return <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>): void => {
    const data = ipcEvents[channel].parse(payload);
    for (const target of targets()) target.send(channel, data);
  };
}
