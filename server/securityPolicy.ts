export type SecurityLevel = "none" | "normal" | "high" | "ultimate";

export type EdgeEnforcementConfig = {
  level: SecurityLevel;
  firewall: { enabled: boolean; denyPrivateNetworks: boolean; rules: Array<{ field: "ip" | "country" | "path"; operator: "equals" | "contains" | "in"; value: string; action: "allow" | "deny" }> };
  waf: { enabled: boolean; owaspCoreRules: boolean; sensitivity: "off" | "balanced" | "strict" };
  rateLimit: { enabled: boolean; requestsPerMinute: number; rules: Array<{ path: string; method: "ANY" | "GET" | "POST" | "PUT" | "DELETE"; threshold: number; windowSeconds: number; action: "throttle" | "block" }> };
  botProtection: { enabled: boolean; challengeThreshold: "off" | "suspicious" | "aggressive" };
  tls: { minimumVersion: "TLSv1.2" | "TLSv1.3"; hsts: boolean; securityHeaders: boolean };
};

const configs: Record<SecurityLevel, EdgeEnforcementConfig> = {
  none: { level: "none", firewall: { enabled: false, denyPrivateNetworks: false, rules: [] }, waf: { enabled: false, owaspCoreRules: false, sensitivity: "off" }, rateLimit: { enabled: false, requestsPerMinute: 0, rules: [] }, botProtection: { enabled: false, challengeThreshold: "off" }, tls: { minimumVersion: "TLSv1.2", hsts: false, securityHeaders: false } },
  normal: { level: "normal", firewall: { enabled: true, denyPrivateNetworks: true, rules: [] }, waf: { enabled: true, owaspCoreRules: true, sensitivity: "balanced" }, rateLimit: { enabled: true, requestsPerMinute: 600, rules: [] }, botProtection: { enabled: true, challengeThreshold: "suspicious" }, tls: { minimumVersion: "TLSv1.2", hsts: true, securityHeaders: true } },
  high: { level: "high", firewall: { enabled: true, denyPrivateNetworks: true, rules: [] }, waf: { enabled: true, owaspCoreRules: true, sensitivity: "strict" }, rateLimit: { enabled: true, requestsPerMinute: 240, rules: [] }, botProtection: { enabled: true, challengeThreshold: "suspicious" }, tls: { minimumVersion: "TLSv1.3", hsts: true, securityHeaders: true } },
  ultimate: { level: "ultimate", firewall: { enabled: true, denyPrivateNetworks: true, rules: [] }, waf: { enabled: true, owaspCoreRules: true, sensitivity: "strict" }, rateLimit: { enabled: true, requestsPerMinute: 60, rules: [] }, botProtection: { enabled: true, challengeThreshold: "aggressive" }, tls: { minimumVersion: "TLSv1.3", hsts: true, securityHeaders: true } },
};

export function resolveSecurityPolicy(level: SecurityLevel): EdgeEnforcementConfig {
  return structuredClone(configs[level]);
}

export function diffSecurityPolicy(before: EdgeEnforcementConfig, after: EdgeEnforcementConfig) {
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
  const walk = (left: Record<string, unknown>, right: Record<string, unknown>, prefix = "") => {
    for (const key of Array.from(new Set([...Object.keys(left), ...Object.keys(right)]))) {
      const path = prefix ? `${prefix}.${key}` : key;
      const oldValue = left[key];
      const newValue = right[key];
      if (oldValue && newValue && typeof oldValue === "object" && typeof newValue === "object") walk(oldValue as Record<string, unknown>, newValue as Record<string, unknown>, path);
      else if (oldValue !== newValue) changes.push({ path, before: oldValue, after: newValue });
    }
  };
  walk(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
  return changes;
}
