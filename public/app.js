const rowsEl = document.querySelector("#rows");
const stateEl = document.querySelector("#state");
const refreshButton = document.querySelector("#refresh");
const checkedAtEl = document.querySelector("#checked-at");
const showMockupsEl = document.querySelector("#show-mockups");
const filterTabs = [...document.querySelectorAll(".tab")];

const counters = {
  action: document.querySelector("#action"),
  all: document.querySelector("#all"),
  current: document.querySelector("#current"),
  unknown: document.querySelector("#unknown")
};

const mockContainers = [
  {
    id: "mock-current",
    name: "photo-library",
    image: "example/photo-library:1.8",
    status: "Up 3 days",
    registry: "example.com",
    repository: "photo-library",
    tag: "1.8",
    updateState: "current",
    localDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    remoteDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    note: "Mockup example: this app is already running the newest image."
  },
  {
    id: "mock-outdated",
    name: "recipe-box",
    image: "example/recipe-box:2.1",
    status: "Up 6 weeks",
    registry: "example.com",
    repository: "recipe-box",
    tag: "2.1",
    updateState: "outdated",
    localDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    remoteDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    note: "Mockup example: the registry tag points to a newer image."
  },
  {
    id: "mock-unknown",
    name: "local-dashboard",
    image: "local-dashboard:dev",
    status: "Up 12 minutes",
    registry: null,
    repository: "local-dashboard",
    tag: "dev",
    updateState: "unknown",
    localDigest: null,
    remoteDigest: null,
    note: "Mockup example: this might be locally built or from a registry that cannot be checked."
  }
];

let realContainers = [];
let activeFilter = "action";

function shortDigest(digest) {
  if (!digest) return "No digest";
  return digest.length > 24 ? `${digest.slice(0, 18)}...${digest.slice(-8)}` : digest;
}

function shortImageRef(ref) {
  if (!ref) return "Unavailable";
  return ref.length > 32 ? `${ref.slice(0, 24)}...${ref.slice(-8)}` : ref;
}

function stateLabel(state) {
  return {
    current: "Up to date",
    outdated: "Update available",
    unknown: "Could not check"
  }[state] || "Could not check";
}

function imageName(row) {
  if (!row.repository) return row.image;
  const repo = row.repository.replace(/^library\//, "");
  return `${repo}:${row.tag || "latest"}`;
}

function runtimeText(status) {
  const match = String(status || "").match(/^Up\s+(.+?)(?:\s+\(|$)/i);
  return match ? `Running for ${match[1]}` : status;
}

function repositoryUrl(row) {
  if (!row.registry || !row.repository) return null;
  if (row.registry === "registry-1.docker.io") {
    return `https://hub.docker.com/r/${row.repository.replace(/^library\//, "library/")}`;
  }
  return `https://${row.registry}/${row.repository}`;
}

function technicalDetails(row) {
  const repoUrl = repositoryUrl(row);
  return [
    { label: "Container ID", value: row.id },
    { label: "Stack", value: row.stackName || "Not a Compose stack" },
    { label: "Full image", value: row.image },
    { label: "Repository", value: repoUrl ? row.repository : "Unknown", href: repoUrl },
    { label: "Local image ID", value: shortImageRef(row.localImageId) },
    { label: "Local inspect ref", value: shortImageRef(row.localImageInspectRef || row.image) },
    { label: "Registry", value: [row.registry, row.repository, row.tag].filter(Boolean).join(" / ") || "Unknown" },
    { label: "Local digest", value: shortDigest(row.localDigest) },
    { label: "Remote digest", value: shortDigest(row.remoteDigest) }
  ];
}

function stackAction(row) {
  if (!row.dockgeUrl || row.updateState === "current") return "";
  const label = row.updateState === "outdated" ? "Update" : "Open stack";
  return `<a class="stack-action" href="${escapeHtml(row.dockgeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setCounters(containers) {
  counters.action.textContent = containers.filter((row) => row.updateState !== "current").length;
  counters.all.textContent = containers.length;
  counters.current.textContent = containers.filter((row) => row.updateState === "current").length;
  counters.unknown.textContent = containers.filter((row) => row.updateState === "unknown").length;
}

function filterContainers(containers) {
  if (activeFilter === "all") {
    return containers;
  }
  if (activeFilter === "action") {
    return containers.filter((row) => row.updateState === "outdated" || row.updateState === "unknown");
  }
  return containers.filter((row) => row.updateState === activeFilter);
}

function renderRows(containers) {
  rowsEl.innerHTML = containers.map((row) => `
    <article class="app-card ${escapeHtml(row.updateState)}">
      <div class="row-top">
        <div class="name">${escapeHtml(row.name)}${row.id?.startsWith("mock-") ? '<span class="mock-badge">Mockup</span>' : ""}</div>
        <span class="pill ${escapeHtml(row.updateState)}">${stateLabel(row.updateState)}</span>
      </div>
      <div class="app-main">
        <div class="meta">
          <span>${escapeHtml(imageName(row))}</span>
          <span>${escapeHtml(runtimeText(row.status))}</span>
          ${stackAction(row) ? `<span class="meta-action">${stackAction(row)}</span>` : ""}
        </div>
      </div>
      <details>
        <summary>Technical details</summary>
        <p>${escapeHtml(row.note)}</p>
        <dl>
          ${technicalDetails(row).map((detail) => {
            const value = detail.href
              ? `<a href="${escapeHtml(detail.href)}" target="_blank" rel="noreferrer">${escapeHtml(detail.value)}</a>`
              : escapeHtml(detail.value);
            return `<div><dt>${escapeHtml(detail.label)}</dt><dd>${value}</dd></div>`;
          }).join("")}
        </dl>
      </details>
    </article>
  `).join("");
}

function visibleContainers() {
  return showMockupsEl.checked ? [...realContainers, ...mockContainers] : realContainers;
}

function render() {
  const containers = visibleContainers();
  const filteredContainers = filterContainers(containers);
  setCounters(containers);
  filterTabs.forEach((tab) => {
    const active = tab.dataset.filter === activeFilter;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });

  if (filteredContainers.length === 0) {
    rowsEl.hidden = true;
    stateEl.hidden = false;
    stateEl.textContent = containers.length === 0
      ? "No running Docker apps found."
      : "No apps match this filter.";
    return;
  }

  renderRows(filteredContainers);
  stateEl.hidden = true;
  rowsEl.hidden = false;
}

async function refresh() {
  refreshButton.disabled = true;
  stateEl.hidden = false;
  rowsEl.hidden = true;
  stateEl.textContent = "Checking Docker...";

  try {
    const response = await fetch("/api/containers");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || data.error || "Unable to check Docker");
    }

    realContainers = data.containers;
    checkedAtEl.textContent = `Checked ${new Date(data.checkedAt).toLocaleString()}`;
    render();
  } catch (error) {
    stateEl.textContent = error.message;
    realContainers = [];
    setCounters([]);
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", refresh);
showMockupsEl.addEventListener("change", render);
filterTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeFilter = tab.dataset.filter;
    render();
  });
});
refresh();
