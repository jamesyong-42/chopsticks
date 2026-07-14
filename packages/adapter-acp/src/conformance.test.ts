import { runAgentSessionConformance, type AgentSessionHarness } from '@vibecook/chopsticks-testing/conformance';
import { createAcpSession } from './driver.js';
import { scriptedAcpConnector } from './scripted-connector.js';

const SID = '019f5e50-ce8b-7152-abcd-00000000c0de';
const REPLY = 'pong';

runAgentSessionConformance('acp', async (): Promise<AgentSessionHarness> => {
  const session = await createAcpSession({
    cwd: '/x',
    connector: scriptedAcpConnector({ sessionId: SID, reply: REPLY }),
  });
  return {
    session,
    reply: REPLY,
    driveTurn: async () => {
      const done = new Promise<void>((resolve) => {
        const off = session.onEvent((e) => {
          if (e.event.type === 'turn.completed') {
            off();
            resolve();
          }
        });
      });
      await session.submitPrompt({ text: 'go' });
      await done;
    },
  };
});
