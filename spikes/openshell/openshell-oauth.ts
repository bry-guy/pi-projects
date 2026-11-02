// pi stays in Anthropic OAuth mode (its key contains sk-ant-oat), but the request
// leaves with OpenShell's placeholder, which the sandbox proxy swaps for the real
// token. OpenShell only rewrites a header that is exactly `<scheme> <placeholder>`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const MARK = "sk-ant-oat01-openshell";
export default function (_pi: ExtensionAPI) {
  const placeholder = process.env.OPENSHELL_ANTHROPIC_PLACEHOLDER;
  const g = globalThis as any;
  if (!placeholder || g.__openshellOauth) return;
  g.__openshellOauth = true;
  const orig = g.fetch.bind(g);
  g.fetch = (input: any, init?: any) => {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (h.get("authorization") !== `Bearer ${MARK}`) return orig(input, init);
    h.set("authorization", `Bearer ${placeholder}`);
    return orig(input, { ...init, headers: h });
  };
}
