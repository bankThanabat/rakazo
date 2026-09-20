import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({ inspect: vi.fn(), remove: vi.fn(), networkInspect: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return docker;
    }
    getNetwork() {
      return { inspect: docker.networkInspect };
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  vi.resetAllMocks();
  docker.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  docker.remove.mockResolvedValue(undefined);
  docker.networkInspect.mockRejectedValue({ statusCode: 404 });
});

function remove(headers: { "x-rakazo-bot-id"?: string; "x-rakazo-space-id"?: string } = {}) {
  return supervisorApp.request("/computers/example-container", {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      ...headers,
    },
  });
}

describe("computer deletion confirmation", () => {
  it.each(["inspect", "remove"] as const)("does not confirm a Docker %s failure", async (step) => {
    docker[step].mockRejectedValue(new Error("Synthetic daemon outage"));
    const response = await remove();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "computer failed to delete" });
    expect(docker.networkInspect).not.toHaveBeenCalled();
  });

  it.each(["inspect", "remove"] as const)("confirms a missing container from %s", async (step) => {
    docker[step].mockRejectedValue({ statusCode: 404 });
    const response = await remove();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "computer not found" });
  });

  it.each([401, 403, 409, 429, 500, "404"])(
    "does not confuse Docker status %s with confirmed absence",
    async (statusCode) => {
      docker.inspect.mockRejectedValue({ statusCode });
      expect((await remove()).status).toBe(500);
      expect(docker.remove).not.toHaveBeenCalled();
      docker.inspect.mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
        },
      });
      docker.remove.mockRejectedValue({ statusCode });
      expect((await remove()).status).toBe(500);
      expect(docker.networkInspect).not.toHaveBeenCalled();
    },
  );

  it("allows retry after an unconfirmed removal", async () => {
    docker.remove.mockRejectedValueOnce(new Error("Synthetic removal outage"));
    expect((await remove()).status).toBe(500);
    expect((await remove()).status).toBe(200);
    expect(docker.remove).toHaveBeenCalledTimes(2);
  });

  it("confirms successful removal", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(docker.remove).toHaveBeenCalledExactlyOnceWith({ force: true });
  });

  it.each([
    { "x-rakazo-bot-id": "" },
    { "x-rakazo-space-id": "" },
    { "x-rakazo-bot-id": "other-home" },
    { "x-rakazo-space-id": "other-space" },
  ])("rejects a missing or different owner %j", async (headers) => {
    const response = await remove(headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid computer identity" });
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.networkInspect).not.toHaveBeenCalled();
  });
});
