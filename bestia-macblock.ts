#!/usr/bin/env bun
// MacBlock task runner and in-cluster watchdog.
// Keep opsfile.yml as command plumbing; keep Kubernetes/state logic here.

import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const APP = "bestia-macblock";
const LABEL_KEY = "app.kubernetes.io/name";
const MANAGED_LABEL = "bestia.nuvolaris.io/macblock-managed";
const SYSTEM_NAMESPACE = releaseEnv("BESTIA_MACBLOCK_NAMESPACE_SYSTEM", "kube-system");
const TARGET_NAMESPACE = releaseEnv("BESTIA_MACBLOCK_NAMESPACE_TARGET", "nuvolaris");
const API_URL = releaseEnv("BESTIA_MACBLOCK_API_URL", "https://api.nuvolaris.io/v1/serials_check");
const DEFAULT_IMAGE = "ghcr.io/nuvolaris/macblock:0.1.0";
const DEFAULT_ADDON_PATH = "/var/lib/rancher/k3s/server/manifests/bestia-macblock.yaml";
const STATE_CONFIGMAP = "bestia-macblock-state";
const SECRET_NAME = "bestia-macblock-auth";
const STATE_KEY = "state.json";
const API_KEY_SECRET_KEY = "api-key";
const SCHEMA_VERSION = 1;

type RunOptions = {
  allowFail?: boolean;
  capture?: boolean;
  input?: string;
  quiet?: boolean;
};

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type K8sObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }>;
    [key: string]: unknown;
  };
  spec?: Record<string, any>;
  status?: unknown;
  [key: string]: unknown;
};

type Snapshot = {
  deployments: Record<string, number>;
  statefulsets: Record<string, number>;
  replicasets: Record<string, number>;
  cronjobs: Record<string, boolean | null>;
  hpas: Record<string, K8sObject>;
};

type MacBlockState = {
  schema_version: number;
  consecutive_failures: number;
  last_success_at: string;
  last_failure_at: string;
  last_failure_reason: string;
  blocked: boolean;
  blocked_at: string;
  last_authorized_lease_until: string;
  snapshots: Snapshot;
};

type GpuIdentifier = {
  index: number;
  name: string;
  uuid: string;
  serial: string;
  pci_bus_id: string;
  source?: string;
};

type VerifyResult = {
  authorized: boolean;
  hardFailure: boolean;
  reason: string;
  leaseId?: string;
  leaseSignature?: string;
  validUntil?: string;
};

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function devOverridesEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(env("BESTIA_MACBLOCK_DEV_OVERRIDES", "").toLowerCase());
}

function releaseEnv(name: string, fallback: string): string {
  if (!devOverridesEnabled()) {
    return fallback;
  }
  return env(name, fallback);
}

function releaseOrDevConfig(name: string, fallback: string): string {
  if (!devOverridesEnabled()) {
    return fallback;
  }
  return envOrConfig(name, fallback);
}

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function nowIso(): string {
  return new Date().toISOString();
}

function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  const capture = options.capture || options.input !== undefined || options.quiet;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
    stdio: capture ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "pipe"],
  });

  if (result.error) {
    if (options.allowFail) {
      return { status: 127, stdout: "", stderr: String(result.error.message || result.error) };
    }
    die(`${command} failed to start: ${result.error.message}`);
  }

  const status = result.status ?? 0;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (status !== 0 && !options.allowFail) {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    die(`${command} ${args.join(" ")} failed${detail}`);
  }
  return { status, stdout, stderr };
}

function kubectl(args: string[], options: RunOptions = {}): RunResult {
  return run("kubectl", args, options);
}

function kubectlNs(namespace: string, args: string[], options: RunOptions = {}): RunResult {
  return kubectl(["-n", namespace, ...args], options);
}

function kubectlJson<T>(namespace: string, args: string[]): T {
  const result = kubectlNs(namespace, [...args, "-o", "json"], { capture: true });
  return parseJson<T>(result.stdout, `kubectl ${args.join(" ")}`);
}

function parseJson<T>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    die(`Cannot parse ${context} JSON: ${error}`);
  }
}

function commandExists(command: string): boolean {
  return run("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
    allowFail: true,
    quiet: true,
  }).status === 0;
}

function cleanOpsOutput(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("DEBUG:"))
    .filter((line) => !line.startsWith("[DEBUG:"))
    .filter((line) => !line.startsWith("config has key with same name"));
  return lines[lines.length - 1] || "";
}

function getConfig(name: string): string {
  if (!commandExists("ops")) {
    return "";
  }
  const result = run("ops", ["-config", name], { allowFail: true, capture: true });
  return result.status === 0 ? cleanOpsOutput(result.stdout) : "";
}

function envOrConfig(name: string, fallback = ""): string {
  const fromEnv = env(name);
  if (fromEnv) {
    return fromEnv;
  }
  const fromConfig = getConfig(name);
  return fromConfig || fallback;
}

function boolValue(value: string, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberValue(name: string, fallback: number): number {
  const value = releaseOrDevConfig(name, String(fallback));
  if (!/^[0-9]+$/.test(value)) {
    die(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function initialState(): MacBlockState {
  return {
    schema_version: SCHEMA_VERSION,
    consecutive_failures: 0,
    last_success_at: "",
    last_failure_at: "",
    last_failure_reason: "",
    blocked: false,
    blocked_at: "",
    last_authorized_lease_until: "",
    snapshots: {
      deployments: {},
      statefulsets: {},
      replicasets: {},
      cronjobs: {},
      hpas: {},
    },
  };
}

function stateConfigMapExists(): boolean {
  return kubectlNs(SYSTEM_NAMESPACE, ["get", "configmap", STATE_CONFIGMAP], {
    allowFail: true,
    quiet: true,
  }).status === 0;
}

function ensureStateConfigMap(): void {
  if (stateConfigMapExists()) {
    return;
  }
  kubectlNs(SYSTEM_NAMESPACE, [
    "create",
    "configmap",
    STATE_CONFIGMAP,
    `--from-literal=${STATE_KEY}=${JSON.stringify(initialState())}`,
  ]);
}

function loadState(): MacBlockState {
  if (!stateConfigMapExists()) {
    ensureStateConfigMap();
  }
  const cm = kubectlJson<any>(SYSTEM_NAMESPACE, ["get", "configmap", STATE_CONFIGMAP]);
  const raw = cm.data?.[STATE_KEY] || "";
  if (!raw) {
    return initialState();
  }
  try {
    const parsed = JSON.parse(raw) as MacBlockState;
    return {
      ...initialState(),
      ...parsed,
      snapshots: {
        ...initialState().snapshots,
        ...(parsed.snapshots || {}),
      },
    };
  } catch {
    console.error(`WARN: ${STATE_CONFIGMAP}/${STATE_KEY} is invalid; using empty in-memory state.`);
    return initialState();
  }
}

function saveState(state: MacBlockState): void {
  ensureStateConfigMap();
  state.schema_version = SCHEMA_VERSION;
  kubectlNs(SYSTEM_NAMESPACE, [
    "patch",
    "configmap",
    STATE_CONFIGMAP,
    "--type=merge",
    "-p",
    JSON.stringify({ data: { [STATE_KEY]: JSON.stringify(state) } }),
  ]);
}

function secretApiKey(): string {
  const result = kubectlNs(SYSTEM_NAMESPACE, [
    "get",
    "secret",
    SECRET_NAME,
    "-o",
    `jsonpath={.data.${API_KEY_SECRET_KEY}}`,
  ], { allowFail: true, capture: true });
  if (result.status !== 0 || !result.stdout.trim()) {
    return "";
  }
  return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
}

function configuredApiKey(required: boolean): string {
  const apiKey = envOrConfig("BESTIA_MACBLOCK_API_KEY", "") || secretApiKey();
  if (required && !apiKey) {
    die(`BESTIA_MACBLOCK_API_KEY is required when ${SYSTEM_NAMESPACE}/${SECRET_NAME} does not exist.`);
  }
  return apiKey;
}

function hostName(): string {
  const result = run("hostname", [], { allowFail: true, capture: true });
  return result.stdout.trim() || env("HOSTNAME", "unknown");
}

function archName(): string {
  const result = run("uname", ["-m"], { allowFail: true, capture: true });
  const arch = result.stdout.trim();
  if (arch === "x86_64") {
    return "amd64";
  }
  if (arch === "aarch64") {
    return "arm64";
  }
  return arch || "unknown";
}

function discoverGpus(): GpuIdentifier[] {
  const simulated = simulatedGpus();
  if (simulated.length > 0) {
    return simulated;
  }

  const result = run("nvidia-smi", [
    "--query-gpu=index,name,uuid,serial,pci.bus_id",
    "--format=csv,noheader",
  ], { allowFail: true, capture: true });

  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (result.status === 0 && rows.length > 0) {
    return rows.map((line, fallbackIndex) => {
      const parts = line.split(",").map((part) => part.trim());
      const index = Number(parts[0]);
      return {
        index: Number.isFinite(index) ? index : fallbackIndex,
        name: parts[1] || "NVIDIA GPU",
        uuid: parts[2] || "",
        serial: parts[3] || "",
        pci_bus_id: parts[4] || "",
        source: "nvidia-smi",
      };
    });
  }

  return discoverPhysicalMacFallbacks();
}

function simulatedGpus(): GpuIdentifier[] {
  if (!devOverridesEnabled()) {
    return [];
  }
  const raw = env("BESTIA_MACBLOCK_SIMULATED_GPU_JSON", "");
  if (!raw) {
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    die(`BESTIA_MACBLOCK_SIMULATED_GPU_JSON is invalid JSON: ${error}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item, index) => ({
    index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
    name: String(item.name || "MacBlock simulated GPU"),
    uuid: String(item.uuid || `GPU-simulated-${index}`),
    serial: String(item.serial || `SIMULATED-${index}`),
    pci_bus_id: String(item.pci_bus_id || ""),
    source: "simulated-dev",
  }));
}

function discoverPhysicalMacFallbacks(): GpuIdentifier[] {
  const netRoot = "/sys/class/net";
  if (!existsSync(netRoot)) {
    return [];
  }
  const ignored = /^(lo|docker|veth|br-|cni|flannel|tailscale|zt|wg|tun|tap)/;
  const devices: GpuIdentifier[] = [];
  for (const name of readdirSync(netRoot)) {
    if (ignored.test(name)) {
      continue;
    }
    const devicePath = join(netRoot, name, "device");
    const addressPath = join(netRoot, name, "address");
    if (!existsSync(devicePath) || !existsSync(addressPath)) {
      continue;
    }
    const mac = readFileSync(addressPath, "utf8").trim();
    if (!mac || mac === "00:00:00:00:00:00") {
      continue;
    }
    devices.push({
      index: devices.length,
      name: `physical-nic:${name}`,
      uuid: "",
      serial: `MAC:${mac}`,
      pci_bus_id: "",
      source: "physical-mac",
    });
  }
  return devices;
}

function buildPayload(gpus: GpuIdentifier[]): Record<string, unknown> {
  return {
    installation_id: envOrConfig("BESTIA_MACBLOCK_INSTALLATION_ID", hostName()),
    cluster_uid: clusterUid(),
    node_name: env("NODE_NAME", hostName()),
    hostname: hostName(),
    arch: archName(),
    watchdog_version: "0.1.0",
    bestia_version: envOrConfig("BESTIA_VERSION", ""),
    timestamp: nowIso(),
    gpus,
  };
}

function clusterUid(): string {
  const result = kubectl(["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"], {
    allowFail: true,
    capture: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function verifyAuthorization(apiKey: string, payload: Record<string, unknown>): Promise<VerifyResult> {
  if (!apiKey) {
    return { authorized: false, hardFailure: true, reason: "missing_api_key" };
  }

  const controller = new AbortController();
  const timeoutSeconds = numberValue("BESTIA_MACBLOCK_TIMEOUT_SECONDS", 10);
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return { authorized: false, hardFailure: true, reason: `http_${response.status}` };
    }
    if (response.status >= 500) {
      return { authorized: false, hardFailure: false, reason: `http_${response.status}` };
    }
    if (!response.ok) {
      return { authorized: false, hardFailure: true, reason: `http_${response.status}` };
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { authorized: false, hardFailure: true, reason: "invalid_json_response" };
    }

    if (data.authorized !== true) {
      return {
        authorized: false,
        hardFailure: true,
        reason: String(data.reason || data.status || "denied"),
      };
    }

    const validUntil = String(data.valid_until || "");
    const leaseId = String(data.lease_id || "");
    const leaseSignature = String(data.lease_signature || "");
    if (!validUntil || Number.isNaN(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.now()) {
      return { authorized: false, hardFailure: true, reason: "invalid_lease_expiration" };
    }
    if (!leaseId || !leaseSignature) {
      return { authorized: false, hardFailure: true, reason: "missing_lease_signature" };
    }
    if (!verifyLeaseSignature(payload, leaseId, validUntil, leaseSignature)) {
      return { authorized: false, hardFailure: true, reason: "invalid_lease_signature" };
    }

    return {
      authorized: true,
      hardFailure: false,
      reason: String(data.reason || "ok"),
      leaseId,
      leaseSignature,
      validUntil,
    };
  } catch (error) {
    return { authorized: false, hardFailure: false, reason: `request_failed:${String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function verifyLeaseSignature(
  payload: Record<string, unknown>,
  leaseId: string,
  validUntil: string,
  signature: string,
): boolean {
  const publicKeyPem = envOrConfig("BESTIA_MACBLOCK_LEASE_PUBLIC_KEY_PEM", "").replace(/\\n/g, "\n");
  if (!publicKeyPem) {
    return true;
  }
  try {
    const canonical = [
      String(payload.installation_id || ""),
      String(payload.cluster_uid || ""),
      leaseId,
      validUntil,
      sha256(JSON.stringify(payload.gpus || [])),
    ].join(".");
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify("sha256", Buffer.from(canonical), key, Buffer.from(signature, "base64"));
  } catch (error) {
    console.error(`WARN: lease signature verification failed: ${error}`);
    return false;
  }
}

function hasValidLease(state: MacBlockState): boolean {
  return Boolean(state.last_authorized_lease_until)
    && !Number.isNaN(Date.parse(state.last_authorized_lease_until))
    && Date.parse(state.last_authorized_lease_until) > Date.now();
}

function itemName(item: K8sObject): string {
  return item.metadata?.name || "";
}

function itemReplicas(item: K8sObject): number {
  const replicas = item.spec?.replicas;
  return Number.isFinite(replicas) ? Number(replicas) : 1;
}

function listItems(namespace: string, resource: string): K8sObject[] {
  const result = kubectlNs(namespace, ["get", resource, "-o", "json"], {
    allowFail: true,
    capture: true,
  });
  if (result.status !== 0) {
    return [];
  }
  return parseJson<{ items?: K8sObject[] }>(result.stdout, `${resource} list`).items || [];
}

function hasController(item: K8sObject, kind: string): boolean {
  return Boolean((item.metadata?.ownerReferences || []).some((owner) => owner.kind === kind && owner.controller));
}

function scaleResource(namespace: string, type: string, name: string, replicas: number): void {
  kubectlNs(namespace, ["scale", `${type}/${name}`, `--replicas=${replicas}`], {
    allowFail: true,
  });
}

function patchResource(namespace: string, type: string, name: string, patch: Record<string, unknown>): void {
  kubectlNs(namespace, ["patch", type, name, "--type=merge", "-p", JSON.stringify(patch)], {
    allowFail: true,
  });
}

function sanitizeApplyObject(item: K8sObject): K8sObject {
  const copy = JSON.parse(JSON.stringify(item)) as K8sObject;
  delete copy.status;
  if (copy.metadata) {
    delete copy.metadata.uid;
    delete copy.metadata.resourceVersion;
    delete copy.metadata.generation;
    delete copy.metadata.creationTimestamp;
    delete copy.metadata.managedFields;
    delete copy.metadata.ownerReferences;
    if (copy.metadata.annotations) {
      delete copy.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];
    }
  }
  return copy;
}

function enforceBlock(state: MacBlockState, reason: string): MacBlockState {
  console.log(`MacBlock enforcement started for namespace ${TARGET_NAMESPACE}: ${reason}`);
  const next = { ...state, snapshots: { ...state.snapshots } };
  next.snapshots.deployments = { ...(state.snapshots.deployments || {}) };
  next.snapshots.statefulsets = { ...(state.snapshots.statefulsets || {}) };
  next.snapshots.replicasets = { ...(state.snapshots.replicasets || {}) };
  next.snapshots.cronjobs = { ...(state.snapshots.cronjobs || {}) };
  next.snapshots.hpas = { ...(state.snapshots.hpas || {}) };

  for (const item of listItems(TARGET_NAMESPACE, "deployment")) {
    const name = itemName(item);
    if (!name) continue;
    if (!(name in next.snapshots.deployments)) {
      next.snapshots.deployments[name] = itemReplicas(item);
    }
    annotateScaledResource("deployment", name);
    scaleResource(TARGET_NAMESPACE, "deployment", name, 0);
  }

  for (const item of listItems(TARGET_NAMESPACE, "statefulset")) {
    const name = itemName(item);
    if (!name) continue;
    if (!(name in next.snapshots.statefulsets)) {
      next.snapshots.statefulsets[name] = itemReplicas(item);
    }
    annotateScaledResource("statefulset", name);
    scaleResource(TARGET_NAMESPACE, "statefulset", name, 0);
  }

  for (const item of listItems(TARGET_NAMESPACE, "replicaset")) {
    const name = itemName(item);
    if (!name || hasController(item, "Deployment")) continue;
    if (!(name in next.snapshots.replicasets)) {
      next.snapshots.replicasets[name] = itemReplicas(item);
    }
    annotateScaledResource("replicaset", name);
    scaleResource(TARGET_NAMESPACE, "replicaset", name, 0);
  }

  for (const item of listItems(TARGET_NAMESPACE, "cronjob")) {
    const name = itemName(item);
    if (!name) continue;
    if (!(name in next.snapshots.cronjobs)) {
      next.snapshots.cronjobs[name] = typeof item.spec?.suspend === "boolean" ? item.spec.suspend : null;
    }
    patchResource(TARGET_NAMESPACE, "cronjob", name, {
      metadata: {
        annotations: {
          [MANAGED_LABEL]: "true",
          "bestia.nuvolaris.io/macblock-blocked-at": nowIso(),
        },
      },
      spec: { suspend: true },
    });
  }

  for (const item of listItems(TARGET_NAMESPACE, "hpa")) {
    const name = itemName(item);
    if (!name) continue;
    if (!(name in next.snapshots.hpas)) {
      next.snapshots.hpas[name] = sanitizeApplyObject(item);
    }
    kubectlNs(TARGET_NAMESPACE, ["delete", "hpa", name, "--ignore-not-found"], { allowFail: true });
  }

  const blockedAt = next.blocked_at || nowIso();
  next.blocked = true;
  next.blocked_at = blockedAt;
  next.last_failure_reason = reason;
  createEvent("Warning", "MacBlockBlocked", `MacBlock scaled ${TARGET_NAMESPACE} to zero: ${reason}`);
  return next;
}

function annotateScaledResource(type: string, name: string): void {
  patchResource(TARGET_NAMESPACE, type, name, {
    metadata: {
      annotations: {
        [MANAGED_LABEL]: "true",
        "bestia.nuvolaris.io/macblock-blocked-at": nowIso(),
      },
    },
  });
}

function restoreFromSnapshot(state: MacBlockState): MacBlockState {
  console.log(`MacBlock restore started for namespace ${TARGET_NAMESPACE}`);
  for (const [name, replicas] of Object.entries(state.snapshots.deployments || {})) {
    scaleResource(TARGET_NAMESPACE, "deployment", name, replicas);
  }
  for (const [name, replicas] of Object.entries(state.snapshots.statefulsets || {})) {
    scaleResource(TARGET_NAMESPACE, "statefulset", name, replicas);
  }
  for (const [name, replicas] of Object.entries(state.snapshots.replicasets || {})) {
    scaleResource(TARGET_NAMESPACE, "replicaset", name, replicas);
  }
  for (const [name, suspend] of Object.entries(state.snapshots.cronjobs || {})) {
    patchResource(TARGET_NAMESPACE, "cronjob", name, { spec: { suspend: suspend === null ? false : suspend } });
  }
  for (const item of Object.values(state.snapshots.hpas || {})) {
    kubectl(["apply", "-f", "-"], {
      allowFail: true,
      input: JSON.stringify(item),
      capture: true,
    });
  }

  const next = initialState();
  next.last_success_at = nowIso();
  next.last_authorized_lease_until = state.last_authorized_lease_until;
  createEvent("Normal", "MacBlockRestored", `MacBlock restored ${TARGET_NAMESPACE} from saved snapshot.`);
  return next;
}

function createEvent(type: "Normal" | "Warning", reason: string, message: string): void {
  const eventName = `${APP}.${Date.now()}`;
  const event = {
    apiVersion: "v1",
    kind: "Event",
    metadata: { name: eventName, namespace: SYSTEM_NAMESPACE },
    involvedObject: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: APP,
      namespace: SYSTEM_NAMESPACE,
    },
    type,
    reason,
    message,
    firstTimestamp: nowIso(),
    lastTimestamp: nowIso(),
    count: 1,
    source: { component: APP },
  };
  kubectl(["apply", "-f", "-"], {
    allowFail: true,
    input: JSON.stringify(event),
    capture: true,
  });
}

async function watchdogOnce(): Promise<void> {
  const apiKey = env("BESTIA_MACBLOCK_API_KEY", "");
  let state = loadState();
  const gpus = discoverGpus();
  const payload = buildPayload(gpus);
  const maxFailures = numberValue("BESTIA_MACBLOCK_MAX_FAILURES", 5);
  const autoRestore = boolValue(releaseOrDevConfig("BESTIA_MACBLOCK_AUTO_RESTORE", "true"), true);

  if (gpus.length === 0) {
    state.last_failure_at = nowIso();
    state.last_failure_reason = "no_gpu_or_physical_mac_identifier";
    state.consecutive_failures += hasValidLease(state) ? 0 : 1;
    if (state.consecutive_failures >= maxFailures && !hasValidLease(state)) {
      state = enforceBlock(state, state.last_failure_reason);
    }
    saveState(state);
    return;
  }

  const result = await verifyAuthorization(apiKey, payload);
  if (result.authorized) {
    state.consecutive_failures = 0;
    state.last_success_at = nowIso();
    state.last_failure_reason = "";
    state.last_authorized_lease_until = result.validUntil || "";
    if (state.blocked && autoRestore) {
      state = restoreFromSnapshot(state);
    }
    saveState(state);
    createEvent("Normal", "MacBlockAuthorized", "MacBlock authorization succeeded.");
    console.log(`MacBlock authorized ${gpus.length} identifier(s), lease valid until ${result.validUntil}`);
    return;
  }

  const leaseStillValid = hasValidLease(state);
  state.last_failure_at = nowIso();
  state.last_failure_reason = result.reason;
  if (result.hardFailure || !leaseStillValid) {
    state.consecutive_failures += 1;
  }
  if (state.consecutive_failures >= maxFailures && !hasValidLease(state)) {
    state = enforceBlock(state, result.reason);
  }
  saveState(state);
  console.log(`MacBlock verification failed: ${result.reason}; consecutive_failures=${state.consecutive_failures}`);
}

async function watchdogLoop(): Promise<void> {
  const intervalSeconds = numberValue("BESTIA_MACBLOCK_INTERVAL_SECONDS", 60);
  for (;;) {
    try {
      await watchdogOnce();
      writeFileSync("/tmp/bestia-macblock-ready", nowIso());
    } catch (error) {
      console.error(`MacBlock watchdog iteration failed: ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

function renderManifest(apiKey: string): string {
  const image = envOrConfig("BESTIA_MACBLOCK_IMAGE", DEFAULT_IMAGE);
  const runtimeClassRaw = envOrConfig("BESTIA_MACBLOCK_RUNTIME_CLASS", "nvidia");
  const runtimeClass = ["", "none", "disabled", "false"].includes(runtimeClassRaw.toLowerCase())
    ? ""
    : runtimeClassRaw;
  const runtimeClassLine = runtimeClass ? `      runtimeClassName: ${runtimeClass}\n` : "";
  const simulatedGpuJson = devOverridesEnabled() ? env("BESTIA_MACBLOCK_SIMULATED_GPU_JSON", "") : "";
  const simulatedGpuEnv = simulatedGpuJson
    ? `            - name: BESTIA_MACBLOCK_SIMULATED_GPU_JSON\n              value: ${JSON.stringify(simulatedGpuJson)}\n`
    : "";

  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${APP}
  namespace: ${SYSTEM_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: ${SYSTEM_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
type: Opaque
data:
  ${API_KEY_SECRET_KEY}: ${base64(apiKey)}
---
apiVersion: v1
kind: Role
metadata:
  name: ${APP}
  namespace: ${SYSTEM_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["${STATE_CONFIGMAP}"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["${SECRET_NAME}"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${APP}
  namespace: ${SYSTEM_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
subjects:
  - kind: ServiceAccount
    name: ${APP}
    namespace: ${SYSTEM_NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${APP}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${APP}
  namespace: ${TARGET_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "replicasets"]
    verbs: ["get", "list", "watch", "patch", "update"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale", "statefulsets/scale", "replicasets/scale"]
    verbs: ["get", "patch", "update"]
  - apiGroups: ["batch"]
    resources: ["cronjobs", "jobs"]
    verbs: ["get", "list", "watch", "patch", "update"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "watch", "create", "delete", "patch", "update"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${APP}
  namespace: ${TARGET_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
subjects:
  - kind: ServiceAccount
    name: ${APP}
    namespace: ${SYSTEM_NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${APP}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${APP}
  namespace: ${SYSTEM_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      ${LABEL_KEY}: ${APP}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP}
  namespace: ${SYSTEM_NAMESPACE}
  labels:
    ${LABEL_KEY}: ${APP}
spec:
  replicas: 1
  selector:
    matchLabels:
      ${LABEL_KEY}: ${APP}
  template:
    metadata:
      labels:
        ${LABEL_KEY}: ${APP}
      annotations:
        bestia.nuvolaris.io/macblock-image: "${image}"
    spec:
      serviceAccountName: ${APP}
      priorityClassName: system-cluster-critical
${runtimeClassLine}      tolerations:
        - key: "node-role.kubernetes.io/control-plane"
          operator: "Exists"
          effect: "NoSchedule"
        - key: "node-role.kubernetes.io/master"
          operator: "Exists"
          effect: "NoSchedule"
      containers:
        - name: watchdog
          image: ${image}
          imagePullPolicy: IfNotPresent
          command: ["bun", "/opt/bestia/macblock/bestia-macblock.ts", "watchdog-loop"]
          env:
            - name: BESTIA_MACBLOCK_API_URL
              value: "${API_URL}"
            - name: BESTIA_MACBLOCK_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ${SECRET_NAME}
                  key: ${API_KEY_SECRET_KEY}
            - name: BESTIA_MACBLOCK_MAX_FAILURES
              value: "${releaseOrDevConfig("BESTIA_MACBLOCK_MAX_FAILURES", "5")}"
            - name: BESTIA_MACBLOCK_INTERVAL_SECONDS
              value: "${releaseOrDevConfig("BESTIA_MACBLOCK_INTERVAL_SECONDS", "60")}"
            - name: BESTIA_MACBLOCK_TIMEOUT_SECONDS
              value: "${releaseOrDevConfig("BESTIA_MACBLOCK_TIMEOUT_SECONDS", "10")}"
            - name: BESTIA_MACBLOCK_NAMESPACE_TARGET
              value: "${TARGET_NAMESPACE}"
            - name: BESTIA_MACBLOCK_NAMESPACE_SYSTEM
              value: "${SYSTEM_NAMESPACE}"
            - name: BESTIA_MACBLOCK_AUTO_RESTORE
              value: "${releaseOrDevConfig("BESTIA_MACBLOCK_AUTO_RESTORE", "true")}"
            - name: NVIDIA_VISIBLE_DEVICES
              value: "all"
            - name: NVIDIA_DRIVER_CAPABILITIES
              value: "utility"
${simulatedGpuEnv}          volumeMounts:
            - name: tmp
              mountPath: /tmp
          readinessProbe:
            exec:
              command: ["test", "-f", "/tmp/bestia-macblock-ready"]
            initialDelaySeconds: 15
            periodSeconds: 20
          livenessProbe:
            exec:
              command: ["test", "-f", "/tmp/bestia-macblock-ready"]
            initialDelaySeconds: 60
            periodSeconds: 60
          resources:
            requests:
              cpu: 25m
              memory: 96Mi
            limits:
              cpu: 250m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: tmp
          emptyDir: {}
`;
}

function writeAddonManifest(manifest: string): string {
  const addonPath = envOrConfig("BESTIA_MACBLOCK_ADDON_PATH", DEFAULT_ADDON_PATH);
  const tmp = join(mkdtempSync(join(tmpdir(), "bestia-macblock-")), "bestia-macblock.yaml");
  writeFileSync(tmp, manifest);
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const command = isRoot ? "install" : "sudo";
  const args = isRoot
    ? ["-D", "-o", "root", "-g", "root", "-m", "0600", tmp, addonPath]
    : ["install", "-D", "-o", "root", "-g", "root", "-m", "0600", tmp, addonPath];
  run(command, args);
  return tmp;
}

function install(): void {
  prereqKubectl();
  if (kubectl(["get", "namespace", TARGET_NAMESPACE], { allowFail: true, quiet: true }).status !== 0) {
    die(`Namespace ${TARGET_NAMESPACE} not found. Install Nuvolaris before MacBlock.`);
  }
  const apiKey = configuredApiKey(true);
  ensureStateConfigMap();
  const manifest = renderManifest(apiKey);
  const tmpManifest = writeAddonManifest(manifest);
  kubectl(["apply", "-f", tmpManifest]);
  const rollout = kubectlNs(SYSTEM_NAMESPACE, ["rollout", "status", `deployment/${APP}`, "--timeout=15s"], {
    allowFail: true,
    capture: true,
  });
  if (rollout.status !== 0) {
    console.error(`WARN: ${APP} manifest applied, but rollout is not ready yet.`);
    console.error(rollout.stderr.trim() || rollout.stdout.trim());
  }
  console.log(`MacBlock installed as k3s AddOn: ${envOrConfig("BESTIA_MACBLOCK_ADDON_PATH", DEFAULT_ADDON_PATH)}`);
}

function validateUninstallKey(): void {
  const expected = envOrConfig("BESTIA_MACBLOCK_UNINSTALL_KEY_SHA256", "");
  const provided = env("BESTIA_MACBLOCK_UNINSTALL_KEY", "");
  if (!expected) {
    die("BESTIA_MACBLOCK_UNINSTALL_KEY_SHA256 is not configured; uninstall is locked.");
  }
  if (!provided || sha256(provided) !== expected) {
    die("Invalid BESTIA_MACBLOCK_UNINSTALL_KEY.");
  }
}

function uninstall(confirm: string): void {
  if (confirm !== "UNINSTALL") {
    die("Use --confirm=UNINSTALL to remove MacBlock.");
  }
  validateUninstallKey();
  const addonPath = envOrConfig("BESTIA_MACBLOCK_ADDON_PATH", DEFAULT_ADDON_PATH);
  if (existsSync(addonPath)) {
    kubectl(["delete", "-f", addonPath, "--ignore-not-found"], { allowFail: true });
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    run(isRoot ? "rm" : "sudo", isRoot ? ["-f", addonPath] : ["rm", "-f", addonPath], {
      allowFail: true,
    });
  } else {
    kubectlNs(SYSTEM_NAMESPACE, ["delete", "deployment,pdb,role,rolebinding,serviceaccount,secret,configmap", "-l", `${LABEL_KEY}=${APP}`, "--ignore-not-found"], { allowFail: true });
    kubectlNs(TARGET_NAMESPACE, ["delete", "role,rolebinding", "-l", `${LABEL_KEY}=${APP}`, "--ignore-not-found"], { allowFail: true });
  }
  console.log("MacBlock watchdog removed. Existing blocked Nuvolaris resources were not restored automatically.");
}

function prereqKubectl(): void {
  if (!commandExists("kubectl")) {
    die("kubectl is required.");
  }
  if (kubectl(["version", "--client"], { allowFail: true, quiet: true }).status !== 0) {
    die("kubectl is not usable.");
  }
  if (kubectl(["get", "namespace", SYSTEM_NAMESPACE], { allowFail: true, quiet: true }).status !== 0) {
    die(`Namespace ${SYSTEM_NAMESPACE} not found.`);
  }
}

function status(): void {
  prereqKubectl();
  const state = loadState();
  console.log(`MacBlock status`);
  console.log(`  API URL: ${API_URL}`);
  console.log(`  System namespace: ${SYSTEM_NAMESPACE}`);
  console.log(`  Target namespace: ${TARGET_NAMESPACE}`);
  console.log(`  Blocked: ${state.blocked}`);
  console.log(`  Consecutive failures: ${state.consecutive_failures}`);
  console.log(`  Last success: ${state.last_success_at || "-"}`);
  console.log(`  Last failure: ${state.last_failure_at || "-"}`);
  console.log(`  Last failure reason: ${state.last_failure_reason || "-"}`);
  console.log(`  Lease valid until: ${state.last_authorized_lease_until || "-"}`);
  console.log(`  Snapshot workloads: deployments=${Object.keys(state.snapshots.deployments || {}).length}, statefulsets=${Object.keys(state.snapshots.statefulsets || {}).length}, replicasets=${Object.keys(state.snapshots.replicasets || {}).length}, cronjobs=${Object.keys(state.snapshots.cronjobs || {}).length}, hpas=${Object.keys(state.snapshots.hpas || {}).length}`);
  kubectlNs(SYSTEM_NAMESPACE, ["get", "deploy", APP, "-o", "wide"], { allowFail: true });
  kubectlNs(TARGET_NAMESPACE, ["get", "deploy,statefulset,cronjob,hpa"], { allowFail: true });
}

function doctor(): void {
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["kubectl command", commandExists("kubectl"), "kubectl is required"]);
  checks.push(["system namespace", kubectl(["get", "namespace", SYSTEM_NAMESPACE], { allowFail: true, quiet: true }).status === 0, SYSTEM_NAMESPACE]);
  checks.push(["target namespace", kubectl(["get", "namespace", TARGET_NAMESPACE], { allowFail: true, quiet: true }).status === 0, TARGET_NAMESPACE]);
  checks.push(["state ConfigMap", stateConfigMapExists(), `${SYSTEM_NAMESPACE}/${STATE_CONFIGMAP}`]);
  checks.push(["auth Secret", kubectlNs(SYSTEM_NAMESPACE, ["get", "secret", SECRET_NAME], { allowFail: true, quiet: true }).status === 0, `${SYSTEM_NAMESPACE}/${SECRET_NAME}`]);
  checks.push(["watchdog Deployment", kubectlNs(SYSTEM_NAMESPACE, ["get", "deployment", APP], { allowFail: true, quiet: true }).status === 0, `${SYSTEM_NAMESPACE}/${APP}`]);
  checks.push(["target scale RBAC", kubectl(["auth", "can-i", "patch", "deployments/scale", "-n", TARGET_NAMESPACE, "--as", `system:serviceaccount:${SYSTEM_NAMESPACE}:${APP}`], { allowFail: true, quiet: true }).status === 0, "patch deployments/scale"]);
  checks.push(["GPU or physical MAC discovery", discoverGpus().length > 0, "nvidia-smi or physical NIC MAC"]);
  checks.push(["API URL configured", API_URL.startsWith("https://"), API_URL]);

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "OK" : "FAIL"}  ${name}: ${detail}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) {
    process.exit(1);
  }
}

async function verifyNow(): Promise<void> {
  prereqKubectl();
  const apiKey = configuredApiKey(true);
  const gpus = discoverGpus();
  if (gpus.length === 0) {
    die("No GPU or physical NIC identifier found.");
  }
  const payload = buildPayload(gpus);
  const result = await verifyAuthorization(apiKey, payload);
  if (!result.authorized) {
    die(`MacBlock verification failed: ${result.reason}`);
  }
  console.log(`MacBlock verification authorized; lease valid until ${result.validUntil}`);
}

function enforceCommand(confirm: string): void {
  if (confirm !== "BLOCK") {
    die("Use --confirm=BLOCK to force MacBlock enforcement.");
  }
  const state = enforceBlock(loadState(), "manual_enforce");
  saveState(state);
  console.log(`MacBlock enforcement completed for namespace ${TARGET_NAMESPACE}.`);
}

async function restoreCommand(confirm: string): Promise<void> {
  if (confirm !== "RESTORE") {
    die("Use --confirm=RESTORE to restore MacBlock-managed workloads.");
  }
  if (!boolValue(envOrConfig("BESTIA_MACBLOCK_RESTORE_SKIP_VERIFY", "false"), false)) {
    await verifyNow();
  }
  const restored = restoreFromSnapshot(loadState());
  saveState(restored);
  console.log(`MacBlock restore completed for namespace ${TARGET_NAMESPACE}.`);
}

function logs(): void {
  kubectlNs(SYSTEM_NAMESPACE, ["logs", `deployment/${APP}`, "--tail=200"], { allowFail: true });
  kubectlNs(SYSTEM_NAMESPACE, ["get", "events", "--field-selector", `involvedObject.name=${APP}`, "--sort-by=.lastTimestamp"], { allowFail: true });
}

function printHelp(): void {
  console.log(`Usage:
  bestia-macblock.ts install
  bestia-macblock.ts uninstall <confirm>
  bestia-macblock.ts status
  bestia-macblock.ts doctor
  bestia-macblock.ts verify
  bestia-macblock.ts enforce <confirm>
  bestia-macblock.ts restore <confirm>
  bestia-macblock.ts logs
  bestia-macblock.ts render-manifest
  bestia-macblock.ts watchdog-loop
`);
}

async function main(): Promise<void> {
  const [command, arg1] = process.argv.slice(2);
  switch (command) {
    case "install":
      install();
      break;
    case "uninstall":
      uninstall(arg1 || "");
      break;
    case "status":
      status();
      break;
    case "doctor":
      doctor();
      break;
    case "verify":
      await verifyNow();
      break;
    case "enforce":
      enforceCommand(arg1 || "");
      break;
    case "restore":
      await restoreCommand(arg1 || "");
      break;
    case "logs":
      logs();
      break;
    case "render-manifest":
      console.log(renderManifest(configuredApiKey(true)));
      break;
    case "watchdog-once":
      await watchdogOnce();
      break;
    case "watchdog-loop":
      await watchdogLoop();
      break;
    case "-h":
    case "--help":
    case "help":
    case undefined:
      printHelp();
      break;
    default:
      die(`Unknown command: ${command}`);
  }
}

main().catch((error) => die(String(error)));
