import { randomUUID } from "node:crypto";
import { resolveSupervisorToken } from "@rakazo/core";
import Docker from "dockerode";
import { expect, it } from "vitest";
import { resolveDockerSocketPath, supervisorApp } from "./index.js";

// Uses a cached image and a disposable container without mounts, ports or network access.
it.skipIf(process.env.VERIFY_DOCKER_DELETION !== "1")(
  "deletes only the owned container and confirms absence through the real Docker client",
  async () => {
    const socketPath = resolveDockerSocketPath();
    const docker = socketPath ? new Docker({ socketPath }) : new Docker();
    const home = `deletion-test-${randomUUID()}`;
    const space = randomUUID();
    const create = () =>
      docker.createContainer({
        Image: process.env.DOCKER_DELETION_TEST_IMAGE ?? "busybox:1",
        name: home,
        Cmd: ["sleep", "300"],
        Labels: { "rakazo.managed": "true", "rakazo.botId": home, "rakazo.spaceId": space },
        HostConfig: { NetworkMode: "none" },
      });
    const container = await create();
    let replacement: Docker.Container | undefined;
    const remove = (botId: string = home, spaceId: string = space) =>
      supervisorApp.request(`/computers/${container.id}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": botId,
          "x-rakazo-space-id": spaceId,
        },
      });
    try {
      await container.start();
      expect((await remove("another-home")).status).toBe(403);
      expect((await remove(home, "another-space")).status).toBe(403);
      expect((await container.inspect()).State.Running).toBe(true);
      expect((await remove()).status).toBe(200);
      await expect(container.inspect()).rejects.toMatchObject({ statusCode: 404 });
      expect((await remove()).status).toBe(404);
      replacement = await create();
      await replacement.start();
      expect(replacement.id).not.toBe(container.id);
      expect((await remove()).status).toBe(404);
      expect((await replacement.inspect()).State.Running).toBe(true);
    } finally {
      for (const owned of [container, replacement]) {
        await owned?.remove({ force: true }).catch((error: unknown) => {
          if (
            !error ||
            typeof error !== "object" ||
            !("statusCode" in error) ||
            error.statusCode !== 404
          )
            throw error;
        });
      }
    }
  },
);
