# Container Monitor

A small local Node app that lists currently running Docker containers and checks whether each container image tag points to a newer registry digest.

## Run

```sh
npm run dev
```

Open <http://localhost:4173>.

By default, Dockge stack links point to <http://localhost:5001>. Set another Dockge base URL if needed:

```sh
DOCKGE_URL=https://dockge.example.com npm run dev
```

## Run In Docker

```sh
docker compose up -d
```

Set `DOCKGE_URL` to the Dockge URL that your browser should open.
Set `REGISTRY_TIMEOUT_MS` if a registry is slow or causes checks to hang.
Set `CHECK_UPDATES=false` only when you want to show containers without checking remote registries.

The compose file mounts this folder into the container, so updating from git only needs a pull and a stack restart in Dockge. No rebuild step is required.

The container runs as root so it can read the mounted Docker socket. This is needed because the app asks Docker which containers are running.

## Local Deploy Script

Local deploy scripts are intentionally ignored by git. You can add one of these files without it being committed:

- `deploy.sh`
- `deploy.local.sh`
- `deploy.<name>.sh`

## How It Checks Updates

The app reads running containers with `docker ps`, inspects each local image digest with `docker image inspect`, then checks the remote registry manifest digest for the same image tag. If the digests differ, the app marks the container as having an update available.

Images from registries that require private credentials, images built only locally, or images without digest metadata may show as `Unknown`.

For Docker Compose containers, the app reads the `com.docker.compose.project` label and links it to the matching Dockge stack.

## Troubleshooting

If `/api/containers` returns a `500`, run this inside the container:

```sh
sudo docker exec container-monitor wget -qO- http://localhost:4173/api/diagnostics
```

The diagnostics endpoint shows the app user, Docker CLI path, Docker socket permissions, and whether `docker ps` works from the Node process.
