import test from 'node:test';
import assert from 'node:assert/strict';
import { installProductAgent } from '../../src/main/agent/integration-setup.js';
import type { MainIpcContext } from '../../src/main/ipc/context.js';

test('Agent wiring is lazy until Electron browser services exist, and guards reinstall on reopen',()=>{
  let created=false;let guards=0;let pageLocks=0;
  const context={
    db:{}, productMutations:{}, productWorkflows:{},remoteProducts:{},
    get browser(){if(!created) throw new Error('browser not created');return {};},
    get automation(){if(!created) throw new Error('automation not created');return {
      setRunVbkPageExclusive(){pageLocks+=1;},setAgentWriteGuard(){guards+=1;},setProductMutations(){},
    };},
  } as unknown as MainIpcContext;
  const configure=installProductAgent(context);
  assert.ok(context.agentCore);assert.equal(guards,0);
  created=true;configure();configure();
  assert.equal(guards,2);assert.equal(pageLocks,2);
});
