/**
 * Bidirectional MCP tool-name mapping.
 *
 * OpenCode exposes MCP tools natively as `sanitize(server)_sanitize(tool)`
 * (see McpCatalog.toolName), e.g. `linear_list_issues`.
 * The Command Code gateway/CLI expects `mcp__<server>__<tool>`
 * (see uniqueRegistryToolName in the `cmd` CLI bundle).
 *
 * Without this mapping the gateway agent never recognizes OpenCode's MCP
 * tools as MCP (they must start with `mcp__`), and OpenCode cannot dispatch
 * gateway-emitted `mcp__*` tool calls to its own MCP clients.
 */

/** Same sanitize both ecosystems use: [^a-zA-Z0-9_-] → "_" */
const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Sanitized MCP server names, longest first for unambiguous prefix match. */
let serverNames: string[] = [];

/** Exact wire → native pairs seen this process (handles ambiguous names). */
const wireToNative = new Map<string, string>();

/**
 * Register MCP server names from the merged OpenCode config (`mcp:` keys).
 * Called once from the plugin config hook; cheap to re-call.
 */
export function setMcpServers(names: string[]): void {
  serverNames = [...new Set(names.map(sanitize).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
}

export function getMcpServers(): readonly string[] {
  return serverNames;
}

function nativeFromParts(server: string, tool: string): string {
  return `${server}_${tool}`;
}

/**
 * OpenCode native tool name → Command Code wire name.
 * Non-MCP tools pass through unchanged.
 */
export function toWireName(nativeName: string): string {
  if (!nativeName || nativeName.startsWith("mcp__")) return nativeName;
  for (const server of serverNames) {
    const prefix = `${server}_`;
    if (nativeName.startsWith(prefix) && nativeName.length > prefix.length) {
      const wire = `mcp__${server}__${nativeName.slice(prefix.length)}`;
      wireToNative.set(wire, nativeName);
      return wire;
    }
  }
  return nativeName;
}

/**
 * Command Code wire name → OpenCode native tool name.
 * Unknown / non-MCP names pass through unchanged.
 */
export function toNativeName(wireName: string): string {
  if (!wireName.startsWith("mcp__")) return wireName;
  const known = wireToNative.get(wireName);
  if (known) return known;
  const rest = wireName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return wireName;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!serverNames.includes(server)) return wireName;
  const native = nativeFromParts(server, tool);
  wireToNative.set(wireName, native);
  return native;
}

/** True when the native OpenCode tool name belongs to a configured MCP server. */
export function isNativeMcpName(nativeName: string): boolean {
  if (!nativeName) return false;
  if (nativeName.startsWith("mcp__") || nativeName.startsWith("mcp_")) {
    return true;
  }
  for (const server of serverNames) {
    if (nativeName.startsWith(`${server}_`)) return true;
  }
  return false;
}

/** Test helper. */
export function resetMcpNamesForTests(): void {
  serverNames = [];
  wireToNative.clear();
}
