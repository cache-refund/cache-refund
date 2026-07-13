import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { readFinalActionKey } from "../src/keymenu.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode = vi.fn((raw: boolean) => {
    this.isRaw = raw;
    return this;
  });
  resume = vi.fn(() => this);
  pause = vi.fn(() => this);
}

describe("readFinalActionKey", () => {
  it.each([
    ["\r", "copy-image"],
    ["r", "copy-report"],
    ["s", "show-paths"],
    ["x", "x"],
    ["b", "bluesky"],
    ["l", "linkedin"],
    ["q", "quit"],
    ["\u001b", "quit"],
    ["\u0003", "quit"],
  ] as const)("maps %j to %s and restores terminal state", async (key, expected) => {
    const input = new FakeInput();
    const promise = readFinalActionKey(input);
    input.emit("data", Buffer.from(key));
    await expect(promise).resolves.toBe(expected);
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.pause).toHaveBeenCalledOnce();
  });

  it("ignores unknown keys until a valid action arrives", async () => {
    const input = new FakeInput();
    const promise = readFinalActionKey(input);
    input.emit("data", Buffer.from("?"));
    input.emit("data", Buffer.from("r"));
    await expect(promise).resolves.toBe("copy-report");
  });

  it("restores terminal state when the input ends", async () => {
    const input = new FakeInput();
    const promise = readFinalActionKey(input);
    input.emit("end");
    await expect(promise).resolves.toBe("quit");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("restores terminal state when the input errors", async () => {
    const input = new FakeInput();
    const promise = readFinalActionKey(input);
    input.emit("error", new Error("closed"));
    await expect(promise).resolves.toBe("quit");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });
});
