import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LangflowCustomerRuntime } from "./customer-runtime.js";

// Opt in to the local review service only. No model or customer-provider calls.
const baseUrl = "http://127.0.0.1:17860/api/v1";
describe.skipIf(process.env.VERIFY_LANGFLOW !== "1")("Langflow publication identity", () => {
  it("reconciles a lost create response by its preallocated ID without overwriting or deleting another owner", async () => {
    const publicationId = randomUUID();
    const staffId = `publication-check-${randomUUID()}`;
    let token: string | undefined;
    let keyId: string | undefined;
    let runtime: LangflowCustomerRuntime | undefined;
    const api = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${baseUrl}/${route}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Local runtime ${method} failed (${response.status})`);
      return response;
    };
    try {
      token = ((await (await api("auto_login")).json()) as { access_token: string }).access_token;
      const key = (await (await api("api_key/", "POST", { name: staffId })).json()) as {
        id: string;
        api_key: string;
      };
      keyId = key.id;
      runtime = new LangflowCustomerRuntime({ baseUrl, apiKey: key.api_key });
      expect(await runtime.identity(AbortSignal.timeout(30_000))).toMatch(
        /^langflow-user:[a-f0-9-]{36}$/,
      );
      const lostResponse = new LangflowCustomerRuntime(
        { baseUrl, apiKey: key.api_key },
        async (url, init) => {
          const response = await fetch(url, init);
          if (init?.method === "POST" && String(url).endsWith("/flows/") && response.ok) {
            await response.arrayBuffer();
            throw new Error("Synthetic response loss after remote creation");
          }
          return response;
        },
      );
      const input = {
        publicationId,
        staffId,
        instructions: "Synthetic approved shop instructions",
        signal: AbortSignal.timeout(30_000),
      };
      await expect(lostResponse.publish(input)).rejects.toThrow("Synthetic response loss");
      const created = await (await api(`flows/${publicationId}`)).json();
      expect(created).toMatchObject({
        id: publicationId,
        name: `Customer ${staffId} ${publicationId}`,
        access_type: "PRIVATE",
        data: {
          nodes: [
            {
              data: {
                node: {
                  template: {
                    instructions: { value: input.instructions },
                  },
                },
              },
            },
          ],
        },
      });
      // POST must reject an existing ID, never turn a retry into a revision overwrite.
      await expect(
        runtime.publish({ ...input, instructions: "Unexpected replacement" }),
      ).rejects.toThrow();
      expect(await (await api(`flows/${publicationId}`)).json()).toEqual(created);
      await expect(
        runtime.removePublication({
          publicationId,
          staffId: "another-staff-member",
          signal: AbortSignal.timeout(30_000),
        }),
      ).rejects.toThrow();
      expect(await (await api(`flows/${publicationId}`)).json()).toEqual(created);
      await runtime.removePublication({
        publicationId,
        staffId,
        signal: AbortSignal.timeout(30_000),
      });
      await expect(api(`flows/${publicationId}`)).rejects.toThrow("Local runtime GET failed (404)");
      await runtime.removePublication({
        publicationId,
        staffId,
        signal: AbortSignal.timeout(30_000),
      });
    } finally {
      const errors: unknown[] = [];
      try {
        await runtime?.removePublication({
          publicationId,
          staffId,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        errors.push(error);
      }
      try {
        if (keyId) {
          await api(`api_key/${keyId}`, "DELETE");
          const remaining = (await (await api("api_key/")).json()) as {
            api_keys: Array<{ id: string }>;
          };
          expect(remaining.api_keys.some((key) => key.id === keyId)).toBe(false);
        }
      } catch (error) {
        errors.push(error);
      }
      expect(errors).toEqual([]);
    }
  }, 120_000);
});
