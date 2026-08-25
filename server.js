const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 4173);
const DOCKGE_URL = (process.env.DOCKGE_URL || "http://localhost:5001").replace(/\/$/, "");
const REGISTRY_TIMEOUT_MS = Number(process.env.REGISTRY_TIMEOUT_MS || 8000);
const CHECK_UPDATES = process.env.CHECK_UPDATES !== "false";
const PUBLIC_DIR = path.join(__dirname, "public");
const MANIFEST_ACCEPT =
  "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json";

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        error.command = [command, ...args].join(" ");
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Registry request timed out after ${REGISTRY_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseImage(image) {
  if (!image || image === "scratch") return null;

  const withoutDigest = image.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const tag = hasTag ? withoutDigest.slice(lastColon + 1) : "latest";
  const name = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const parts = name.split("/");
  const first = parts[0] || "";
  const hasRegistry = first.includes(".") || first.includes(":") || first === "localhost";
  const registry = hasRegistry ? first : "registry-1.docker.io";
  let repository = hasRegistry ? parts.slice(1).join("/") : parts.join("/");

  if (!repository) return null;
  if (registry === "registry-1.docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }

  return { registry, repository, tag };
}

async function dockerHubToken(repository) {
  const url = new URL("https://auth.docker.io/token");
  url.searchParams.set("service", "registry.docker.io");
  url.searchParams.set("scope", `repository:${repository}:pull`);
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Docker Hub auth failed (${response.status})`);
  const data = await response.json();
  return data.token;
}

function parseAuthenticateHeader(header) {
  const params = {};
  const [, values = ""] = header.match(/^Bearer\s+(.+)$/i) || [];
  for (const part of values.match(/(\w+)="([^"]+)"/g) || []) {
    const [, key, value] = part.match(/(\w+)="([^"]+)"/) || [];
    if (key) params[key] = value;
  }
  return params;
}

async function registryToken(authenticateHeader) {
  const params = parseAuthenticateHeader(authenticateHeader);
  if (!params.realm) throw new Error("Registry requires authentication");

  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  if (params.scope) url.searchParams.set("scope", params.scope);

  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Registry auth failed (${response.status})`);

  const data = await response.json();
  return data.token || data.access_token;
}

async function fetchManifestDigest(parsed) {
  const url = `https://${parsed.registry}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;
  const headers = { accept: MANIFEST_ACCEPT };

  if (parsed.registry === "registry-1.docker.io") {
    headers.authorization = `Bearer ${await dockerHubToken(parsed.repository)}`;
  }

  let response = await fetchWithTimeout(url, { method: "HEAD", headers });
  if (response.status === 401 && response.headers.get("www-authenticate")) {
    const token = await registryToken(response.headers.get("www-authenticate"));
    headers.authorization = `Bearer ${token}`;
    response = await fetchWithTimeout(url, { method: "HEAD", headers });
  }
  if (!response.ok || !response.headers.get("docker-content-digest")) {
    response = await fetchWithTimeout(url, { method: "GET", headers });
  }
  if (!response.ok) throw new Error(`Registry check failed (${response.status})`);

  const digest = response.headers.get("docker-content-digest");
  if (!digest) throw new Error("Registry did not return a content digest");
  return digest;
}

async function imageRepoDigests(imageRef) {
  const raw = await run("docker", ["image", "inspect", imageRef, "--format", "{{json .RepoDigests}}"]);
  return JSON.parse(raw || "[]");
}

async function containerImageId(containerId) {
  try {
    return await run("docker", ["inspect", containerId, "--format", "{{.Image}}"]);
  } catch {
    return null;
  }
}

async function localImageDigest(image, parsed, containerId) {
  const imageId = await containerImageId(containerId);
  const imageRefs = [...new Set([image, imageId].filter(Boolean))];
  const repositoryAliases = new Set([
    parsed.repository,
    parsed.repository.replace(/^library\//, "")
  ]);
  const registryAliases = new Set([
    parsed.registry,
    parsed.registry === "registry-1.docker.io" ? "docker.io" : parsed.registry
  ]);

  for (const imageRef of imageRefs) {
    try {
      const repoDigests = await imageRepoDigests(imageRef);
      const match = repoDigests.find((digest) => {
        const [repo] = digest.split("@");
        const parts = repo.split("/");
        const registry = parts.length > 1 ? parts[0] : "";
        const repository = registryAliases.has(registry) ? parts.slice(1).join("/") : repo;
        return repositoryAliases.has(repository);
      });
      const digest = (match || "").split("@")[1] || null;
      if (digest) {
        return {
          digest,
          imageId,
          inspectedRef: imageRef
        };
      }
    } catch {
      // Keep trying other references. A running container may outlive its tag.
    }
  }

  return {
    digest: null,
    imageId,
    inspectedRef: null
  };
}

async function containerLabels(containerId) {
  try {
    const raw = await run("docker", ["inspect", containerId, "--format", "{{json .Config.Labels}}"]);
    return JSON.parse(raw || "{}") || {};
  } catch {
    return {};
  }
}

function parseDockerPsOutput(output) {
  if (!output) return [];
  return output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function dockerPsContainers() {
  const attempts = [
    {
      args: ["ps", "--format", "json"],
      parse: parseDockerPsOutput
    },
    {
      args: ["ps", "--format", "{{json .}}"],
      parse: parseDockerPsOutput
    },
    {
      args: ["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Command}}\t{{.Ports}}\t{{.Status}}"],
      parse: (output) => output.split("\n").filter(Boolean).map((line) => {
        const [ID, Names, Image, Command, Ports, Status] = line.split("\t");
        return { ID, Names, Image, Command, Ports, Status };
      })
    }
  ];
  const errors = [];

  for (const attempt of attempts) {
    try {
      return attempt.parse(await run("docker", attempt.args));
    } catch (error) {
      errors.push([
        `docker ${attempt.args.join(" ")}`,
        error.stderr?.trim(),
        error.stdout?.trim(),
        error.message
      ].filter(Boolean).join("\n"));
    }
  }

  throw new Error(errors.join("\n\n"));
}

function dockgeStackUrl(stackName) {
  if (!stackName) return null;
  return `${DOCKGE_URL}/compose/${encodeURIComponent(stackName)}`;
}

async function containerRows() {
  try {
    var containers = await dockerPsContainers();
  } catch (error) {
    error.message = [
      "Docker check failed while listing running containers.",
      error.message,
      "Inside Docker, make sure /var/run/docker.sock is mounted and the app user can read it."
    ].filter(Boolean).join("\n");
    throw error;
  }

  return Promise.all(containers.map(async (container) => {
    const image = container.Image;
    const parsed = parseImage(image);
    const labels = await containerLabels(container.ID);
    const stackName = labels["com.docker.compose.project"] || null;
    const row = {
      id: container.ID,
      name: container.Names,
      image,
      command: container.Command,
      ports: container.Ports,
      status: container.Status,
      registry: parsed?.registry || null,
      repository: parsed?.repository || null,
      tag: parsed?.tag || null,
      stackName,
      dockgeUrl: dockgeStackUrl(stackName),
      updateState: "unknown",
      localDigest: null,
      localImageId: null,
      localImageInspectRef: null,
      remoteDigest: null,
      note: ""
    };

    if (!parsed) {
      row.note = "This image cannot be checked against a registry.";
      return row;
    }

    if (!CHECK_UPDATES) {
      row.note = "Update checks are disabled.";
      return row;
    }

    try {
      const [localDigestValue, remoteDigestValue] = await Promise.all([
        localImageDigest(image, parsed, container.ID),
        fetchManifestDigest(parsed)
      ]);

      row.localDigest = localDigestValue.digest;
      row.localImageId = localDigestValue.imageId;
      row.localImageInspectRef = localDigestValue.inspectedRef;
      row.remoteDigest = remoteDigestValue;

      if (!localDigestValue.digest) {
        row.updateState = "unknown";
        row.note = localDigestValue.imageId
          ? "No local repo digest found on the container image ID. The image may be locally built, imported, or missing registry metadata."
          : "No local image ID or repo digest found. The image may be locally built, imported, or missing registry metadata.";
      } else if (localDigestValue.digest === remoteDigestValue) {
        row.updateState = "current";
        row.note = "Local image digest matches the registry.";
      } else {
        row.updateState = "outdated";
        row.note = "The registry tag points to a newer digest.";
      }
    } catch (error) {
      row.updateState = "unknown";
      row.note = error.message;
    }

    return row;
  }));
}

async function dockerDiagnostics() {
  const checks = await Promise.all([
    run("id", []).then((output) => ({ name: "id", ok: true, output })).catch((error) => ({ name: "id", ok: false, output: error.message })),
    run("which", ["docker"]).then((output) => ({ name: "which docker", ok: true, output })).catch((error) => ({ name: "which docker", ok: false, output: error.message })),
    run("ls", ["-l", "/var/run/docker.sock"]).then((output) => ({ name: "docker socket", ok: true, output })).catch((error) => ({ name: "docker socket", ok: false, output: error.message })),
    run("docker", ["version", "--format", "{{json .Client.Version}}"]).then((output) => ({ name: "docker client", ok: true, output })).catch((error) => ({ name: "docker client", ok: false, output: error.stderr || error.message })),
    run("docker", ["ps", "--format", "json"]).then((output) => ({ name: "docker ps format json", ok: true, output: output || "No running containers" })).catch((error) => ({ name: "docker ps format json", ok: false, output: error.stderr || error.message })),
    run("docker", ["ps", "--format", "{{json .}}"]).then((output) => ({ name: "docker ps go json", ok: true, output: output || "No running containers" })).catch((error) => ({ name: "docker ps go json", ok: false, output: error.stderr || error.message })),
    dockerPsContainers().then((containers) => ({ name: "app docker ps fallback", ok: true, output: `${containers.length} running containers` })).catch((error) => ({ name: "app docker ps fallback", ok: false, output: error.message }))
  ]);

  return {
    checkedAt: new Date().toISOString(),
    checks
  };
}

async function handleApi(req, res) {
  if (req.url === "/api/diagnostics") {
    json(res, 200, await dockerDiagnostics());
    return;
  }

  if (req.url !== "/api/containers") {
    json(res, 404, { error: "Not found" });
    return;
  }

  try {
    const rows = await containerRows();
    json(res, 200, {
      checkedAt: new Date().toISOString(),
      containers: rows
    });
  } catch (error) {
    json(res, 500, {
      error: "Unable to read Docker containers",
      detail: error.message
    });
  }
}

async function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : new URL(req.url, "http://local").pathname;
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream";

    res.writeHead(200, { "content-type": contentType });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Docker update monitor running at http://localhost:${PORT}`);
});
