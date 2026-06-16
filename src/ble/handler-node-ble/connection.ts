import { EventEmitter } from 'events';
import NodeBle from 'node-ble';
import { bleLog, errMsg } from '../types.js';
import type { Adapter } from './dbus.js';

// node-ble attaches a PropertiesChanged listener to every BLE device proxy it
// creates during discovery. In a busy BLE environment (20+ nearby devices),
// after several scan cycles the default Node.js limit of 10 listeners per
// EventEmitter is exceeded, triggering warnings and congesting the event loop.
// Setting defaultMaxListeners = 0 disables the limit (0 = unlimited) so the
// warning never fires. The connection is reset after every idle scan cycle
// (see scan.ts) to keep actual accumulation bounded.
EventEmitter.defaultMaxListeners = 0;

/**
 * Persistent D-Bus connection + adapter, reused across scan cycles in
 * continuous mode. Same client owns the discovery session across cycles;
 * same adapter proxy means stopDiscovery() always matches startDiscovery().
 * Minimizes the start/stop cycling that triggers the BlueZ Discovering desync
 * (bluez/bluez#807, bluez/bluer#47).
 */
let persistentConn: { bluetooth: NodeBle.Bluetooth; destroy: () => void } | null = null;
let persistentAdapter: Adapter | null = null;

export function getConnection(): { bluetooth: NodeBle.Bluetooth; destroy: () => void } {
  if (!persistentConn) {
    persistentConn = NodeBle.createBluetooth();
    bleLog.debug('D-Bus connection established');
  }
  return persistentConn;
}

export async function getAdapter(bleAdapter?: string): Promise<Adapter> {
  const conn = getConnection();
  if (!persistentAdapter) {
    if (bleAdapter) {
      bleLog.debug(`Using adapter: ${bleAdapter}`);
      persistentAdapter = await conn.bluetooth.getAdapter(bleAdapter);
    } else {
      persistentAdapter = await conn.bluetooth.defaultAdapter();
    }
  }
  return persistentAdapter;
}

export function resetConnection(): void {
  persistentAdapter = null;
  if (persistentConn) {
    try {
      // Access the underlying socket before calling destroy() so we can unref
      // it afterward. node-ble's destroy() calls dbus.disconnect() which only
      // calls stream.end() — a half-close that waits for bluetoothd to send
      // its own FIN. When bluetoothd is wedged that FIN never arrives, leaving
      // the socket ref'd and keeping the event loop alive past the shutdown
      // grace window. Unreffing it lets the process exit naturally once all
      // other handles have drained.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (persistentConn as any).bluetooth?.dbus?._connection
        ?.stream as { unref?: () => void } | undefined;
      persistentConn.destroy();
      stream?.unref?.();
    } catch {
      /* ignore */
    }
    persistentConn = null;
    bleLog.debug('D-Bus connection reset');
  }
}

/** Returns true if the error indicates a stale or broken D-Bus connection. */
export function isStaleConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return (
    msg.includes('interface not found') ||
    msg.includes('not found in proxy') ||
    msg.includes('connection closed') ||
    msg.includes('The name is not activatable') ||
    msg.includes('was not provided')
  );
}

export function isDbusConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('ENOENT') && msg.includes('bus_socket');
}

export function dbusError(): Error {
  return new Error(
    'Cannot connect to D-Bus. Bluetooth is not accessible.\n' +
      'If running in Docker, mount the D-Bus socket:\n' +
      '  -v /var/run/dbus:/var/run/dbus:ro\n' +
      'On the host, ensure bluetoothd is running:\n' +
      '  sudo systemctl start bluetooth',
  );
}

/** Extract the numeric index from an hci adapter name (e.g., 'hci1' -> 1). */
export function parseHciIndex(adapterName?: string): number {
  if (!adapterName) return 0;
  const match = adapterName.match(/^hci(\d+)$/);
  return match ? Number(match[1]) : 0;
}
