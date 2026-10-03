import { ChannelStateStore } from "../../src/broker/channel-state.ts";
import { atomicLeaseWrite } from "../../src/registry/leases.ts";
const store = new ChannelStateStore(process.argv[2], { write(path, contents) {
  atomicLeaseWrite(path, contents);
  if (path.endsWith(".bak")) process.kill(process.pid, "SIGKILL");
} });
store.commit("default", "example", "unacknowledged", 1);
throw new Error("fault was not reached");
